"""Opt-in provider signaling for the fictional, read-only voice demo."""

import asyncio
import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.request
from collections import OrderedDict
from urllib.parse import urlsplit

from fastapi import HTTPException

MAX_SDP_BYTES = 200_000
MAX_CALLS = 2
MAX_CALL_SECONDS = 300
EXPIRED_RETRY_SECONDS = 30
CALL_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
logger = logging.getLogger(__name__)


def session_config():
    def tool(name, description, field):
        return {
            "type": "function",
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {field: {"type": "string"}},
                "required": [field],
                "additionalProperties": False,
            },
        }

    return {
        "type": "realtime",
        "model": "gpt-realtime",
        "instructions": (
            "Your name is Mira. You are a voice assistant for a fictional customer service demonstration. "
            "Only help with the fictional service: orders, prices, appointments, handoff, "
            "using the demo, greetings and relevant follow-up or language preferences. "
            "Politely redirect unrelated general knowledge or other unrelated requests to customer support; "
            "never answer the unrelated part, even when it is combined with a support question. "
            "For this call remember a customer's explicit ongoing reply-language preference until "
            "they change it. A request for one answer only applies only to that answer. "
            "Without an explicit preference, respond in the language of the current request: "
            "English in English, Hindi in Hindi, and mixed Hindi-English only when requested "
            "or when the customer's request is mixed. Do not infer a lasting preference "
            "from a single question or from quoted text. "
            "If an answer is interrupted by a cough, sniff or other non-speech sound and "
            "there is no new request, continue the unfinished answer from its context, "
            "without treating the sound as a question. If the user speaks, address their request. "
            "For order history, use list_orders. For an order's status, items or price, use "
            "lookup_order. The selected customer is already known; never ask for customer ID. "
            "Order IDs follow ord-a-201 style; interpret spoken letter names and dash as an exact ID, "
            "and ask for clarification if unsure. Prices are in paise: 100 paise equals one Indian rupee. "
            "When asked for all orders, report the count and offer to describe them in small groups. "
            "The fictional orders do not have order dates. Do not invent which are most recent; "
            "if asked for the last or latest orders, explain this and offer the last IDs in sorted order. "
            "For order status or appointment slots, call the matching tool and report only "
            "what it returns; never invent a result. Never claim an appointment was changed "
            "or a human was contacted. Explain that changes and local handoff requests "
            "must be made using the on-screen controls and that no human is connected. "
            "Customer data is fictional; do not ask for real personal information."
        ),
        "tools": [
            {
                "type": "function",
                "name": "list_orders",
                "description": "List all fictional orders and item prices for the selected customer.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
            tool(
                "lookup_order",
                "Look up a fictional order, including items, quantities and prices, for the selected customer.",
                "order_id",
            ),
            tool(
                "list_appointment_slots",
                "List slots for a fictional appointment.",
                "appointment_id",
            ),
        ],
        "audio": {
            "input": {
                "transcription": {"model": "gpt-4o-mini-transcribe"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.6,
                    "silence_duration_ms": 700,
                    "create_response": False,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": "marin"},
        },
        "max_output_tokens": 2048,
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class OpenAIProvider:
    """Only the fixed provider origin receives the server-held key."""

    def __init__(self, key):
        self.key = key
        self.opener = urllib.request.build_opener(_NoRedirect())

    def _request(self, url, data, content_type=None):
        headers = {"Authorization": f"Bearer {self.key}"}
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with self.opener.open(request, timeout=20) as response:
            return response.read(MAX_SDP_BYTES + 1), response.headers.get("Location", "")

    def create(self, offer):
        boundary = "voice-" + secrets.token_hex(16)
        session = json.dumps(session_config(), ensure_ascii=True).encode()
        body = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="sdp"\r\n'
                "Content-Type: application/sdp\r\n\r\n"
            ).encode()
            + offer
            + (
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="session"\r\n'
                "Content-Type: application/json\r\n\r\n"
            ).encode()
            + session
            + f"\r\n--{boundary}--\r\n".encode()
        )
        answer, location = self._request(
            "https://api.openai.com/v1/realtime/calls",
            body,
            f"multipart/form-data; boundary={boundary}",
        )
        path = urlsplit(location).path.rstrip("/")
        parts = path.split("/")
        if len(parts) < 4 or parts[-3:-1] != ["realtime", "calls"]:
            raise ValueError("invalid provider call location")
        call_id = parts[-1]
        if not CALL_ID.fullmatch(call_id):
            raise ValueError("invalid provider call ID")
        return call_id, answer

    def hangup(self, call_id):
        self._request(f"https://api.openai.com/v1/realtime/calls/{call_id}/hangup", b"")


class VoiceCalls:
    def __init__(self, provider=None):
        self.provider = provider
        self.calls = {}
        self.closed = OrderedDict()
        self.pending = 0
        self.lock = asyncio.Lock()
        self.ending = set()

    def configured_provider(self):
        if os.getenv("REALTIME_ENABLED") != "1" or not os.getenv("OPENAI_API_KEY"):
            raise HTTPException(503, "Realtime voice is not configured")
        return self.provider or OpenAIProvider(os.environ["OPENAI_API_KEY"])

    async def create(self, owner, offer):
        provider = self.configured_provider()
        async with self.lock:
            if len(self.calls) + self.pending >= MAX_CALLS:
                raise HTTPException(429, "Realtime call limit reached")
            self.pending += 1
        try:
            create_task = asyncio.create_task(asyncio.to_thread(provider.create, offer))
            try:
                call_id, answer = await asyncio.shield(create_task)
            except asyncio.CancelledError:
                # A thread cannot be cancelled once the provider request has started.
                # Wait for its result and close the created call before releasing the slot.
                try:
                    orphan_id, _ = await create_task
                    if CALL_ID.fullmatch(orphan_id):
                        await asyncio.to_thread(provider.hangup, orphan_id)
                except Exception:  # noqa: BLE001
                    logger.warning("Cancelled voice call cleanup could not be confirmed")
                raise
            except Exception as exc:
                raise HTTPException(502, "Voice provider unavailable") from exc
            if not CALL_ID.fullmatch(call_id) or not answer or len(answer) > MAX_SDP_BYTES:
                if CALL_ID.fullmatch(call_id):
                    try:
                        await asyncio.to_thread(provider.hangup, call_id)
                    except Exception:  # noqa: BLE001
                        logger.warning("Invalid voice call cleanup could not be confirmed")
                raise HTTPException(502, "Voice provider returned an invalid answer")
            async with self.lock:
                if call_id in self.calls:
                    raise HTTPException(502, "Duplicate voice call")
                task = asyncio.create_task(self._expire(call_id))
                self.calls[call_id] = (owner, provider, task)
            return call_id, answer
        finally:
            async with self.lock:
                self.pending -= 1

    async def _expire(self, call_id):
        await asyncio.sleep(MAX_CALL_SECONDS)
        while True:
            try:
                await self.end(call_id, None, expired=True)
                return
            except HTTPException as exc:
                if exc.status_code == 404:
                    return
                logger.warning("Expired voice call cleanup failed; will retry")
                await asyncio.sleep(EXPIRED_RETRY_SECONDS)

    async def end(self, call_id, owner, expired=False):
        async with self.lock:
            item = self.calls.get(call_id)
            if item is None and not expired and self.closed.get(call_id) == owner:
                return
            if item is None or (not expired and item[0] != owner):
                raise HTTPException(404, "Call not found")
            if call_id in self.ending:
                raise HTTPException(409, "Call hangup is already in progress")
            _, provider, task = item
            self.ending.add(call_id)
        try:
            await asyncio.to_thread(provider.hangup, call_id)
        except Exception as exc:
            raise HTTPException(502, "Provider hangup could not be confirmed") from exc
        else:
            async with self.lock:
                self.calls.pop(call_id, None)
                self.closed[call_id] = item[0]
                if len(self.closed) > 128:
                    self.closed.popitem(last=False)
                if task is not asyncio.current_task():
                    task.cancel()
        finally:
            async with self.lock:
                self.ending.discard(call_id)

    async def close(self):
        for call_id in list(self.calls):
            try:
                await self.end(call_id, None, expired=True)
            except HTTPException:
                pass
            item = self.calls.get(call_id)
            if item:
                item[2].cancel()
