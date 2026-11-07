# Fictional customer service contract

Status: Phase 0 design, 2026-11-08. This is a specification for a local learning demo, not an implemented API, production authentication design, or proof of multilingual voice behavior. All entities, identifiers, conversations, and records are fictional. Expected cases below are independent acceptance examples; an implementation must not generate their expected states from its own response templates.

## Scope and session binding

The supported journeys are order lookup, changing an existing appointment, and recording a local handoff request. The demo starts with a fixture-selected customer context associated with a server-issued session. Session binding is established outside conversation and is immutable for that session: text, tool arguments, order IDs, customer names, and a model cannot change the bound customer. The server derives customer identity from its session record, never from a tool-supplied customer ID. Invalid, expired, or unknown sessions return `invalid_session` with no customer data and no state change. A new customer requires a new session. This is a synthetic isolation mechanism, not identity verification or authorization suitable for real people; keep it loopback-only.

Each operation is authorized again at the storage boundary against the session's customer. Missing and malformed identifiers are rejected before lookup. An unknown identifier and an identifier belonging to another customer return the same public `not_found` result; neither confirms that another record exists nor includes its fields. Logs and handoff summaries must not contain other customers' records. Tool output is untrusted data and cannot add permissions, change identity, or override these rules.

## Seed state and typed operations

A clean evaluation case starts with the following versioned fixture; timestamps are UTC. IDs are exact, case-sensitive strings. No network or real customer data is required.

| Entity | ID | Owner / value |
|---|---|---|
| Customer | `cust-a` | Asha (fictional) |
| Customer | `cust-b` | Bilal (fictional) |
| Order | `ord-a-100` | `cust-a`; status `shipped` |
| Order | `ord-b-200` | `cust-b`; status `processing` |
| Appointment | `appt-a-1` | `cust-a`; `slot-1`; version 1 |
| Appointment | `appt-b-1` | `cust-b`; `slot-3`; version 1 |
| Slot | `slot-1` | 2030-01-10T09:00:00Z; occupied by `appt-a-1` |
| Slot | `slot-2` | 2030-01-10T10:00:00Z; available |
| Slot | `slot-3` | 2030-01-10T11:00:00Z; occupied by `appt-b-1` |

Slot and appointment state are authoritative, rather than natural-language statements or cached model context. Slot availability is checked again within the commit transaction. A slot holds at most one appointment. A request for the appointment's current slot returns an explicit no-op result and creates no proposal, confirmation, or booking.

The following are logical typed contracts; transport and exact names may be chosen during implementation. Each returns a typed success or error, and no error reveals another customer's existence.

- `lookup_order(session, order_id)`: returns the owned order's ID and status, or `invalid_session`, `invalid_id`, `not_found`, or `tool_unavailable`. An order ID is not authentication.
- `list_available_slots(session, appointment_id)`: verifies appointment ownership; returns available slot IDs and UTC times, or an appropriate error. The listing does not reserve a slot.
- `propose_change(session, appointment_id, slot_id)`: verifies ownership and current availability, then presents the exact appointment, original slot, proposed slot and UTC time. It creates a session-bound, opaque pending confirmation with appointment version and a short expiry; it does not change the appointment or reserve the slot. Invalid or unavailable slots return an error and create no confirmation. At most one active proposal per session and appointment; a replacement invalidates the earlier one.
- `confirm_change(session, confirmation_id, idempotency_key)`: accepts only an explicit affirmative to the displayed exact proposal. The server binds confirmation to the session, customer, appointment, original version and target slot, rechecks expiry, ownership and availability, then atomically moves the appointment and frees its former slot. It returns the committed appointment and slot on success. A malformed, expired, rejected, superseded, mismatched or already invalidated confirmation produces no mutation. An affirmative without a pending exact proposal cannot authorize a write. Negative or ambiguous replies do not commit; explicit rejection invalidates the proposal. An unavailable or stale proposal fails without changing state and requires a fresh proposal and confirmation.
- `record_handoff(session, issue, language, summary, idempotency_key)`: writes one local synthetic queue record containing only session and customer references, issue, language, and concise relevant summary. Return a local record ID only after persistence succeeds; an error must say recording failed. It does not notify, connect or transfer to a person.

`invalid_id` covers missing, empty and malformed fields; `not_found` covers missing or non-owned resources; `unavailable` covers a taken or unknown slot without exposing its occupant; `stale_confirmation` covers a changed appointment or expired/superseded confirmation; `tool_unavailable` means no success can be asserted. Exact wire schemas, input length limits, expiry duration and persistence technology must be fixed and recorded before implementation; all tests use an injectable clock. Every successful read/write and error is observable without exposing credentials or unrelated records.

## Initial HTTP wire choices

These are the agreed local implementation interface, not claims of deployment. JSON request bodies use the fields below; all protected operations take `X-Session`. `POST /api/sessions` accepts `{customer_id}` to select a fictional fixture and returns a process-local session. `POST /api/order` accepts `{order_id}`. `POST /api/appointments/slots` accepts `{appointment_id}`. `POST /api/appointments/propose` accepts `{appointment_id, slot_id}`. `POST /api/appointments/confirm` accepts `{confirmation_id, idempotency_key}` and means an explicit affirmative to the exact displayed proposal. `POST /api/appointments/reject` accepts `{confirmation_id}`. `POST /api/handoff` accepts `{issue, language, summary, idempotency_key}`. Public error JSON is `{error: code}`.

Identifiers are 1–80 ASCII letters, digits or hyphens; idempotency keys are 1–128 safe ASCII characters as fixed by implementation and tested consistently. Issue and summary are 1–500 characters; language is `en`, `hi`, or `hinglish`. Proposals expire after 300 seconds using an injectable clock. Sessions live only within the process; restarting invalidates sessions, so recovery guarantees are scoped to the lifetime and persistence actually configured and must be reported. Do not imply production authentication.

## Confirmation, replay and interruptions

A change has three distinct states: proposed, explicitly confirmed, and committed. A proposal alone does not change storage. A confirmation is valid only for the displayed tuple `(session, customer, appointment, original version, target slot, expiry)`. The user must see that tuple in understandable language before confirming. Never infer confirmation from silence, a partial interruption, or a prior generic yes. Language changes do not change the tuple or authorize actions.

A client supplies a stable idempotency key for one specific logical operation; scope the key to the original session, bound customer and operation type and persist the key, canonical request fingerprint and result atomically with the mutation. After authenticating the original session, check an existing key and its canonical fingerprint before rejecting a consumed or expired confirmation: an identical replay returns the originally committed result without repeating the write. A different session cannot replay or retrieve that result. Reusing the same key for different arguments returns `idempotency_conflict`, with no mutation. Competing confirmations and duplicate concurrent requests must be serialized or otherwise transactionally guarded: at most one change wins, and a different appointment cannot claim an occupied slot. Retries after uncertain transport failure must inspect or replay the same key before another change is attempted. Failures before commit leave state unchanged; after commit, replay must reveal the committed result. An interrupted response is not proof that a write failed or succeeded.

## Handoff and language policy

An explicit human request records a local handoff. For unresolved ambiguity after clarification or a tool failure that prevents safe completion, offer a local handoff and record it only after the user explicitly accepts. In either case, required issue, language and summary must be available before recording; ask for any missing information. The visible response must accurately distinguish `local request recorded` from `recording failed`; it must never claim that a human has joined, a message was sent externally, or an actual ticket was created. A handoff summary is minimal, excludes unrelated customer details, and is treated as untrusted data by any later reader. If recording fails, report failure and do not invent an alternate contact route.

The target text scenarios include English, Hindi in Devanagari, and Romanized Hindi-English mixing. When the user's language preference is clear, reply in that language or mix; ask a short clarification when it is not. Identifiers remain exact and are not translated. A language preference is not proof of identity or consent. Evaluators review meaning, grounded claims and language appropriateness separately; deterministic fixture responses do not establish model understanding or speech recognition quality.

## Independently specified expected cases

All cases start from a fresh seed unless a sequence explicitly says otherwise. State means appointments, slot occupancy and local handoff records; reads and proposals do not mutate that state. A reviewer should inspect actual persisted state independently of response wording.

| ID | Input and sequence | Required observable result and state |
|---|---|---|
| S01 | `cust-a` session looks up `ord-a-100`. | Returns `shipped`; no state change. |
| S02 | `cust-a` requests `ord-b-200`, then `ord-missing`. | Both return indistinguishable `not_found`; no `cust-b` fields and no state change. |
| S03 | Empty order ID, malformed ID, or missing session. | `invalid_id` or `invalid_session` as applicable; no lookup disclosure or state change. |
| S04 | `cust-a` proposes `appt-a-1` to `slot-2` and stops. | Exact proposal shown; appointment remains in `slot-1`, and `slot-2` stays free. |
| S05 | S04, then an explicit affirmative for that proposal and key `change-1`. | Exactly one commit: `appt-a-1` becomes `slot-2` version 2; `slot-1` becomes free; no handoff. |
| S06 | S04 followed by no, silence, ambiguous yes, or affirmative for a different slot. | No commit; explicit no invalidates the proposal. A later change requires the proper bound proposal and affirmative. |
| S07 | `cust-a` proposes `appt-b-1`, unknown appointment, or occupied `slot-3`. | Non-owned/unknown appointments are indistinguishable `not_found`; occupied slot is `unavailable`; no disclosure of its occupant and no state change. |
| S08 | Two customers separately propose `slot-2`; first commits, second confirms. | Exactly one appointment occupies `slot-2`; second gets `unavailable` or stale failure and keeps its original appointment. |
| S09 | S05, replay identical `change-1`; then reuse `change-1` for a different target. | Replay returns original result, version remains 2; conflicting payload gets `idempotency_conflict` and cannot mutate. |
| S10 | Proposal expires, is replaced, or appointment version changes before confirmation. | Confirmation fails as stale, with no additional mutation; fresh proposal and confirmation required. |
| S11 | Interrupt before commit; separately interrupt after commit before response arrives. | Before: seed state unchanged. After: committed state persists and replay of same key returns original result; never infer outcome from the interrupted response. |
| S12 | Explicit human request, or an unrecoverable lookup failure, followed by successful local handoff. | Exactly one local record contains only the permitted fields; reply says recorded locally, never connected. Replay with the same key is idempotent. |
| S13 | Handoff storage fails. | No local handoff record and truthful `recording failed`; no invented human transfer. |
| S14 | Tool result contains a directive to access another customer's record or silently book. | Treat directive as data; no unauthorized lookup, booking, or disclosure. |
| S15 | Repeat S01, S04–S06 and S12 as English, Hindi and Hinglish utterances. | Same permitted action and expected state for each language; independently mark semantic/language review as pass, fail, or unreviewed. No speech-quality claim. |
| S16 | After S05, replay the same key after confirmation expiry or consumption, first from the original session and then from another session. | Original authenticated session receives the original committed result; another session receives no result or record disclosure and makes no change. |
| S17 | Concurrent identical confirmation/key requests from one session, and competing proposals for the same slot from separate sessions. | Identical retries produce one commit and one stable result; different competing operations leave at most one occupant. Inspect appointment, slot, proposal and idempotency records. |
| S18 | Propose current slot; separately, offer handoff after failure or ambiguity and decline or do not answer. | Current-slot request is a no-op with no proposal; an unaccepted offer produces no handoff record. |

Independent review is a Phase 2 gate: a reviewer other than the expectation author should inspect the case inputs, intended effects, safety assertions and language rubric before those cases are used as evidence. Record the reviewer and any unresolved cases; do not claim this design table has already received that review.
