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

