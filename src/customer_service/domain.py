"""Small typed contracts for the fictional service."""

from typing import Literal

from pydantic import BaseModel, Field


class SessionRequest(BaseModel):
    customer_id: str


class OrderRequest(BaseModel):
    order_id: str


class AppointmentRequest(BaseModel):
    appointment_id: str


class ProposalRequest(AppointmentRequest):
    slot_id: str


class ConfirmationRequest(BaseModel):
    confirmation_id: str
    idempotency_key: str


class RejectionRequest(BaseModel):
    confirmation_id: str


class HandoffRequest(BaseModel):
    issue: str = Field(min_length=1, max_length=500)
    language: Literal["en", "hi", "hinglish"]
    summary: str = Field(min_length=1, max_length=500)
    idempotency_key: str
