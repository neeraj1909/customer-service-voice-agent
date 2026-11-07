"""Loopback API for a controlled fictional service journey."""

import os
import secrets
import sqlite3
from pathlib import Path
from time import time

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from .domain import (
    AppointmentRequest,
    ConfirmationRequest,
    HandoffRequest,
    OrderRequest,
    ProposalRequest,
    RejectionRequest,
    SessionRequest,
)
from .tools import Store, ToolError

WEB = Path(__file__).resolve().parents[2] / "web"


def create_app(db_path: Path | None = None, clock=time):
    path = Path(db_path or os.environ.get("DEMO_DB", "demo.sqlite3"))
    store = Store(path, clock)
    sessions: dict[str, str] = {}
    app = FastAPI(title="Fictional local customer service")

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

    @app.post("/api/sessions")
    def create_session(body: SessionRequest):
        if body.customer_id not in {"cust-a", "cust-b"}:
            raise ToolError("invalid_id")
        token = secrets.token_hex(32)
        sessions[token] = body.customer_id
        return {"session_id": token, "customer_id": body.customer_id}

    @app.post("/api/order")
    def order(body: OrderRequest, context=current_session):
        return store.order(context[1], body.order_id)

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
