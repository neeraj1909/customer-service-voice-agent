import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from customer_service.app import create_app
from customer_service.realtime import MAX_SDP_BYTES, VoiceCalls, session_config


class FakeProvider:
    def __init__(self):
        self.offers = []
        self.hangups = []

    def create(self, offer):
        self.offers.append(offer)
        return "call_1", b"v=0\r\nanswer"

    def hangup(self, call_id):
        self.hangups.append(call_id)


def test_voice_requires_opt_in_and_session(tmp_path, monkeypatch):
    monkeypatch.delenv("REALTIME_ENABLED", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    provider = FakeProvider()
    with TestClient(create_app(tmp_path / "test.sqlite3", realtime_provider=provider)) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        assert client.post("/api/realtime/call", content=b"v=0").status_code == 401
        result = client.post(
            "/api/realtime/call",
            headers={"X-Session": session, "Content-Type": "application/sdp"},
            content=b"v=0\r\noffer",
        )
        assert result.status_code == 503
        assert not provider.offers


def test_voice_sdp_call_is_owned_and_hung_up(tmp_path, monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    provider = FakeProvider()
    with TestClient(create_app(tmp_path / "test.sqlite3", realtime_provider=provider)) as client:
        a = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        b = client.post("/api/sessions", json={"customer_id": "cust-b"}).json()["session_id"]
        headers = {"X-Session": a, "Content-Type": "application/sdp"}
        assert client.post("/api/realtime/call", headers=headers, content=b"no").status_code == 400
        assert (
            client.post(
                "/api/realtime/call", headers=headers, content=b"v=0" + b"a" * MAX_SDP_BYTES
            ).status_code
            == 413
        )
        response = client.post("/api/realtime/call", headers=headers, content=b"v=0\r\noffer")
        assert response.status_code == 200
        assert response.content == b"v=0\r\nanswer"
        call_id = response.headers["X-Call-ID"]
        assert (
            client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": b}).status_code
            == 404
        )
        assert (
            client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": a}).status_code
            == 204
        )
        assert (
            client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": a}).status_code
            == 204
        )
        assert (
            client.delete(f"/api/realtime/call/{call_id}", headers={"X-Session": b}).status_code
            == 404
        )
        assert provider.hangups == [call_id]


def test_voice_model_has_no_mutating_tools():
    assert {tool["name"] for tool in session_config()["tools"]} == {
        "lookup_order",
        "list_orders",
        "list_appointment_slots",
    }


def test_voice_config_respects_language_and_allows_interruption():
    config = session_config()
    instructions = config["instructions"]
    assert "explicit ongoing reply-language preference" in instructions
    assert "language of the current request" in instructions
    assert "cough, sniff or other non-speech sound" in instructions
    vad = config["audio"]["input"]["turn_detection"]
    assert vad["interrupt_response"] is True
    assert vad["threshold"] == 0.6


def test_invalid_provider_answer_is_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    class InvalidAnswer(FakeProvider):
        def create(self, offer):
            return "call_1", b""

    provider = InvalidAnswer()
    with TestClient(create_app(tmp_path / "test.sqlite3", realtime_provider=provider)) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        response = client.post(
            "/api/realtime/call",
            headers={"X-Session": session, "Content-Type": "application/sdp"},
            content=b"v=0",
        )
        assert response.status_code == 502
        assert provider.hangups == ["call_1"]


def test_hangup_can_be_retried_without_losing_ownership(tmp_path, monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    class FailingOnce(FakeProvider):
        def hangup(self, call_id):
            self.hangups.append(call_id)
            if len(self.hangups) == 1:
                raise OSError("failure")

    provider = FailingOnce()
    with TestClient(create_app(tmp_path / "test.sqlite3", realtime_provider=provider)) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": session, "Content-Type": "application/sdp"}
        assert client.post("/api/realtime/call", headers=headers, content=b"v=0").status_code == 200
        assert client.delete("/api/realtime/call/call_1", headers=headers).status_code == 502
        assert client.delete("/api/realtime/call/call_1", headers=headers).status_code == 204
        assert provider.hangups == ["call_1", "call_1"]


def test_cancelled_create_closes_late_provider_call(monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    started = threading.Event()
    release = threading.Event()

    class SlowProvider(FakeProvider):
        def create(self, offer):
            started.set()
            assert release.wait(3)
            return super().create(offer)

    provider = SlowProvider()

    async def exercise():
        calls = VoiceCalls(provider)
        task = asyncio.create_task(calls.create("session", b"v=0"))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert provider.hangups == ["call_1"]
        assert calls.pending == 0

    asyncio.run(exercise())


def test_expired_call_cleanup_keeps_retrying_until_provider_confirms(monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.setattr("customer_service.realtime.MAX_CALL_SECONDS", 0)
    monkeypatch.setattr("customer_service.realtime.EXPIRED_RETRY_SECONDS", 0.01)

    class FailsThreeTimes(FakeProvider):
        def hangup(self, call_id):
            self.hangups.append(call_id)
            if len(self.hangups) <= 3:
                raise OSError("temporary failure")

    async def exercise():
        provider = FailsThreeTimes()
        calls = VoiceCalls(provider)
        call_id, _ = await calls.create("session", b"v=0")
        await asyncio.wait_for(calls.calls[call_id][2], 2)
        assert provider.hangups == [call_id] * 4
        assert call_id not in calls.calls

    asyncio.run(exercise())
