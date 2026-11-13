"""Opt-in GPT-Live signaling for the fictional comparison."""

import json
import os
import time

from fastapi import HTTPException
from websockets.sync.client import connect

from .realtime import CALL_ID, OpenAIProvider, VoiceCalls, session_config


def live_session_config():
    baseline = session_config()
    return {
        "model": "gpt-live-1",
        "instructions": (
            "Your name is Mira. This is a fictional customer service demo. "
            "Only discuss customer service, orders, appointments and support. "
            "Politely redirect unrelated requests. Match the customer's language unless they "
            "express an ongoing preference. Delegate order and appointment questions to the "
            "backend. Do not claim that an appointment was changed or a human contacted."
        ),
        "delegation": {
            "type": "responses",
            "responses": {
                "model": "gpt-6-luna",
                "instructions": baseline["instructions"],
                "tools": baseline["tools"],
                "tool_choice": "auto",
                "parallel_tool_calls": False,
            },
        },
    }


class LiveProvider(OpenAIProvider):
    def create(self, offer):
        payload = json.dumps(
            {
                "session": live_session_config(),
                "transport": {"type": "webrtc", "sdp": offer.decode("utf-8")},
            }
        ).encode()
        response, _ = self._request(
            "https://api.openai.com/v1/live/sessions", payload, "application/json"
        )
        result = json.loads(response)
        session_id = result["session"]["id"]
        if not isinstance(session_id, str) or not CALL_ID.fullmatch(session_id):
            raise ValueError("invalid session ID")
        transport = result.get("transport")
        if (
            not isinstance(transport, dict)
            or transport.get("type") != "webrtc"
            or not isinstance(transport.get("sdp"), str)
        ):
            # The manager can close a known session even when the answer is invalid.
            return session_id, b""
        return session_id, transport["sdp"].encode()

    def hangup(self, call_id):
        # Unlike the SIP hangup endpoint, sideband supports WebRTC sessions.
        if not CALL_ID.fullmatch(call_id):
            raise ValueError("invalid session ID")
        with connect(
            f"wss://api.openai.com/v1/live/sessions/{call_id}/attach",
            additional_headers={"Authorization": f"Bearer {self.key}"},
            open_timeout=10,
            close_timeout=2,
            max_size=2_000_000,
        ) as sideband:
            sideband.send(json.dumps({"type": "session.close"}))
            deadline = time.monotonic() + 10
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Live closure not confirmed")
                event = json.loads(sideband.recv(timeout=remaining))
                if event.get("type") == "session.closed":
                    return
                if event.get("type") == "error":
                    raise RuntimeError("Live closure failed")


class LiveCalls(VoiceCalls):
    def configured_provider(self):
        if os.getenv("LIVE_ENABLED") != "1" or not os.getenv("OPENAI_API_KEY"):
            raise HTTPException(503, "Live voice is not configured")
        return self.provider or LiveProvider(os.environ["OPENAI_API_KEY"])
