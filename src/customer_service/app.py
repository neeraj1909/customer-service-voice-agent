"""Loopback API for a controlled fictional service journey."""

import os
import secrets
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from time import time

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response

from . import audio
from .domain import (
    AppointmentRequest,
    ConfirmationRequest,
    HandoffRequest,
    OrderRequest,
    ProposalRequest,
    RejectionRequest,
    SessionRequest,
    SynthesisRequest,
)
from .realtime import MAX_SDP_BYTES, VoiceCalls
from .tools import Store, ToolError

WEB = Path(__file__).resolve().parents[2] / "web"


def create_app(db_path: Path | None = None, clock=time, realtime_provider=None):
    path = Path(db_path or os.environ.get("DEMO_DB", "demo.sqlite3"))
    store = Store(path, clock)
    sessions: dict[str, str] = {}
    voice_calls = VoiceCalls(realtime_provider)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await voice_calls.close()

    app = FastAPI(title="Fictional local customer service", lifespan=lifespan)

    @app.exception_handler(audio.AudioError)
    async def audio_error(_request: Request, exc: audio.AudioError):
        return JSONResponse({"error": exc.code}, status_code=exc.status)

    @app.exception_handler(ToolError)
    async def tool_error(_request: Request, exc: ToolError):
        status = {
            "invalid_session": 401,
            "invalid_id": 400,
            "not_found": 404,
            "unavailable": 409,
            "stale_confirmation": 409,
            "idempotency_conflict": 409,
        }.get(exc.code, 503)
        return JSONResponse({"error": exc.code}, status_code=status)

    @app.exception_handler(sqlite3.Error)
    async def storage_error(_request: Request, _exc: sqlite3.Error):
        return JSONResponse(
            {
                "error": "tool_unavailable",
                "message": "Operation failed; no success can be asserted.",
            },
            status_code=503,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError):
        return JSONResponse({"error": "invalid_id"}, status_code=400)

    @app.middleware("http")
    async def loopback_only(request: Request, call_next):
        # Binding to loopback is mandatory; Host and Origin checks also reject browser DNS rebinding.
        host = request.headers.get("host", "").split(":")[0].lower()
        origin = request.headers.get("origin")
        if host not in {"127.0.0.1", "localhost", "testserver"} or (
            origin
            and origin
            not in {
                f"http://{request.headers.get('host')}",
                f"https://{request.headers.get('host')}",
            }
        ):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return await call_next(request)

    def session_customer(x_session: str = Header(default="")):
        customer = sessions.get(x_session)
        if customer is None:
            raise ToolError("invalid_session")
        return x_session, customer

    current_session = Depends(session_customer)

    @app.get("/")
    def index():
        return FileResponse(WEB / "index.html")

    @app.get("/app.js")
    def javascript():
        return FileResponse(WEB / "app.js", media_type="text/javascript")

    @app.get("/conversation.mjs")
    def conversation_module():
        return FileResponse(WEB / "conversation.mjs", media_type="text/javascript")

    @app.get("/realtime-voice.mjs")
    def realtime_voice_module():
        return FileResponse(WEB / "realtime-voice.mjs", media_type="text/javascript")

    @app.post("/api/sessions")
    def create_session(body: SessionRequest):
        if body.customer_id not in {"cust-a", "cust-b"}:
            raise ToolError("invalid_id")
        token = secrets.token_hex(32)
        sessions[token] = body.customer_id
        return {"session_id": token, "customer_id": body.customer_id}

    @app.post("/api/realtime/call")
    async def realtime_call(request: Request, context=current_session):
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/sdp"
        ):
            raise HTTPException(415, "Expected application/sdp")
        offer = bytearray()
        async for chunk in request.stream():
            offer.extend(chunk)
            if len(offer) > MAX_SDP_BYTES:
                raise HTTPException(413, "SDP offer too large")
        if not offer or not offer.startswith(b"v=0"):
            raise HTTPException(400, "Invalid SDP offer")
        call_id, answer = await voice_calls.create(context[0], bytes(offer))
        return Response(
            answer,
            media_type="application/sdp",
            headers={"X-Call-ID": call_id, "Cache-Control": "no-store"},
        )

    @app.delete("/api/realtime/call/{call_id}")
    async def end_realtime_call(call_id: str, context=current_session):
        await voice_calls.end(call_id, context[0])
        return Response(status_code=204)

    @app.post("/api/audio/transcribe")
    async def transcribe(request: Request, _context=current_session):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "audio/wav":
            raise audio.AudioError("invalid_audio_type", 415)
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > audio.MAX_AUDIO_BYTES:
                raise audio.AudioError("audio_too_large", 413)
            data.extend(chunk)
        language = request.headers.get("x-audio-language", "en")
        return {"text": await audio.transcribe(bytes(data), language), "language": language}

    @app.post("/api/audio/synthesize")
    async def synthesize(body: SynthesisRequest, _context=current_session):
        wav = await audio.synthesize(body.text, body.language)
        return Response(wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})

    @app.post("/api/order")
    def order(body: OrderRequest, context=current_session):
        return store.order(context[1], body.order_id)

    @app.post("/api/order-details")
    def order_details(body: OrderRequest, context=current_session):
        return store.order_details(context[1], body.order_id)

    @app.post("/api/orders")
    def order_history(context=current_session):
        return store.order_history(context[1])

    @app.post("/api/appointments/slots")
    def slots(body: AppointmentRequest, context=current_session):
        return {"slots": store.slots(context[1], body.appointment_id)}

    @app.post("/api/appointments/propose")
    def propose(body: ProposalRequest, context=current_session):
        return store.propose(*context, body.appointment_id, body.slot_id)

    @app.post("/api/appointments/confirm")
    def confirm(body: ConfirmationRequest, context=current_session):
        return store.confirm(*context, body.confirmation_id, body.idempotency_key)

    @app.post("/api/appointments/reject")
    def reject(body: RejectionRequest, context=current_session):
        return store.reject(context[0], body.confirmation_id)

    @app.post("/api/handoff")
    def handoff(body: HandoffRequest, context=current_session):
        return store.handoff(
            *context, body.issue, body.language, body.summary, body.idempotency_key
        )

    return app
