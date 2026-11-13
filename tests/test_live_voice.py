import json

from fastapi.testclient import TestClient

from customer_service.app import create_app
from customer_service.live import LiveProvider, live_session_config


class FakeProvider:
    def __init__(self):
        self.hangups = []

    def create(self, offer):
        assert offer.startswith(b"v=0")
        return "live_123", b"v=0\r\nanswer"

    def hangup(self, call_id):
        self.hangups.append(call_id)


def test_live_session_uses_read_only_delegated_tools():
    config = live_session_config()
    assert config["model"] == "gpt-live-1"
    backend = config["delegation"]["responses"]
    assert backend["model"] == "gpt-6-luna"
    assert {tool["name"] for tool in backend["tools"]} == {
        "list_orders",
        "lookup_order",
        "list_appointment_slots",
    }


def test_live_session_requires_opt_in_and_owned_session(tmp_path, monkeypatch):
    provider = FakeProvider()
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    monkeypatch.delenv("LIVE_ENABLED", raising=False)
    with TestClient(create_app(tmp_path / "test.sqlite3", live_provider=provider)) as client:
        session_a = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()[
            "session_id"
        ]
        session_b = client.post("/api/sessions", json={"customer_id": "cust-b"}).json()[
            "session_id"
        ]
        headers_a = {"X-Session": session_a, "Content-Type": "application/sdp"}
        assert client.post("/api/live/call", headers=headers_a, content=b"v=0").status_code == 503
        monkeypatch.setenv("LIVE_ENABLED", "1")
        response = client.post("/api/live/call", headers=headers_a, content=b"v=0")
        assert response.status_code == 200
        assert response.headers["x-call-id"] == "live_123"
        assert response.content == b"v=0\r\nanswer"
        assert (
            client.delete("/api/live/call/live_123", headers={"X-Session": session_b}).status_code
            == 404
        )
        assert client.delete("/api/live/call/live_123", headers=headers_a).status_code == 204
        assert provider.hangups == ["live_123"]


def test_live_provider_uses_json_webrtc_contract(monkeypatch):
    provider = LiveProvider("test")
    calls = []

    def request(url, data, content_type):
        calls.append((url, json.loads(data), content_type))
        return json.dumps(
            {"session": {"id": "live_123"}, "transport": {"type": "webrtc", "sdp": "v=0\r\nanswer"}}
        ).encode(), ""

    monkeypatch.setattr(provider, "_request", request)
    assert provider.create(b"v=0\r\noffer") == ("live_123", b"v=0\r\nanswer")
    assert calls[0][0] == "https://api.openai.com/v1/live/sessions"
    assert calls[0][1]["transport"] == {"type": "webrtc", "sdp": "v=0\r\noffer"}
    assert calls[0][2] == "application/json"


def test_live_sideband_confirms_session_closed(monkeypatch):
    sent = []
    addresses = []

    class Sideband:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def send(self, payload):
            sent.append(json.loads(payload))

        def recv(self, timeout):
            assert timeout > 0
            return json.dumps({"type": "session.closed"})

    def fake_connect(address, **kwargs):
        addresses.append((address, kwargs))
        return Sideband()

    monkeypatch.setattr("customer_service.live.connect", fake_connect)
    LiveProvider("secret").hangup("live_123")
    assert addresses[0][0] == "wss://api.openai.com/v1/live/sessions/live_123/attach"
    assert sent == [{"type": "session.close"}]


def test_bad_live_answer_preserves_id_for_cleanup(monkeypatch):
    provider = LiveProvider("test")
    monkeypatch.setattr(
        provider,
        "_request",
        lambda *_: (b'{"session":{"id":"live_123"}}', ""),
    )
    assert provider.create(b"v=0") == ("live_123", b"")


def test_unconfirmed_live_close_is_not_reported_as_success(tmp_path, monkeypatch):
    class FailingProvider(FakeProvider):
        def hangup(self, call_id):
            self.hangups.append(call_id)
            raise OSError("sideband unavailable")

    provider = FailingProvider()
    monkeypatch.setenv("LIVE_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")
    with TestClient(create_app(tmp_path / "test.sqlite3", live_provider=provider)) as client:
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": session, "Content-Type": "application/sdp"}
        assert client.post("/api/live/call", headers=headers, content=b"v=0").status_code == 200
        assert client.delete("/api/live/call/live_123", headers=headers).status_code == 502
        assert provider.hangups == ["live_123"]
