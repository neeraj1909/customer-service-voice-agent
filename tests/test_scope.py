import json

import pytest
from fastapi.testclient import TestClient

from customer_service.app import create_app
from customer_service.realtime import OpenAIProvider, session_config
from customer_service.scope import classify_scope


def provider_reply(value):
    return json.dumps(
        {
            "status": "completed",
            "output": [
                {"type": "message", "content": [{"type": "output_text", "text": json.dumps(value)}]}
            ],
        }
    ).encode(), ""


def test_scope_parser_accepts_valid_output_and_fails_closed(monkeypatch):
    value = {"decision": "allow", "safe_text": "Where is my order?", "language": "en"}
    monkeypatch.setattr(OpenAIProvider, "_request", lambda *args: provider_reply(value))
    assert classify_scope("key", "Order and capital?", "") == value
    value["safe_text"] = ""
    with pytest.raises(ValueError):
        classify_scope("key", "Order?", "")
    value.update(decision="redirect", safe_text="some unsolicited text")
    assert classify_scope("key", "Capital?", "")["safe_text"] == ""


def test_scope_endpoint_requires_session_and_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("REALTIME_ENABLED", "1")
    monkeypatch.setenv("OPENAI_API_KEY", "test")

    def unavailable(*args):
        raise TimeoutError()

    monkeypatch.setattr("customer_service.app.classify_scope", unavailable)
    with TestClient(create_app(tmp_path / "test.db")) as client:
        assert client.post("/api/realtime/scope", json={"transcript": "hello"}).status_code == 401
        session = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        response = client.post(
            "/api/realtime/scope", headers={"X-Session": session}, json={"transcript": "hello"}
        )
        assert response.status_code == 503
        assert "TimeoutError" not in response.text
