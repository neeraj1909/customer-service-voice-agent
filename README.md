# Fictional customer service — controlled text foundation

A local learning demo with two fictional customers. Look up an order, review and explicitly confirm an appointment change, or record a local handoff. The handoff is a local record: no person is contacted. This version uses fixed tools and form inputs; it has no language model, speech recognition, microphone, voice output, or real customer authentication. Do not expose it outside loopback or use real customer information.

## Run locally

Python 3.11+ and `uv` are required. Dependencies are pinned in `uv.lock`; the `--offline` commands work only after their distributions have been cached. Installing open-source dependencies may use the internet; the application makes no external provider calls.

```sh
uv sync --offline
DEMO_DB="$(mktemp /tmp/customer-service-demo-XXXXXX.sqlite3)"
export DEMO_DB
PYTHONPATH=src uv run --offline uvicorn customer_service.app:create_app --factory --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/>. Choose Asha, start a session, look up `ord-a-100`, review `appt-a-1` to `slot-2`, explicitly confirm, then record a local handoff. Try `ord-b-200` for a no-disclosure error. Stop the server with Ctrl-C. Remove the temporary database after stopping the server with `rm "$DEMO_DB"`; use an explicit path instead if you want to inspect or reuse it. Sessions are in-memory and lost on restart; do not use this demo for actual data.

```sh
uv run --offline pytest -q
uv run --offline ruff format --check .
uv run --offline ruff check .
```

The confirmation ID and stable idempotency key bind a change to the session and exact proposal. Replays in the same running process return the committed result; a restart invalidates sessions. The local SQLite database retains appointment and handoff state. Identifiers and keys use ASCII letters, digits and hyphens (1–80 and 1–128 characters respectively). A deterministic tool flow and text labels do not establish multilingual understanding, voice quality, acoustic interruption handling, or live latency.

The page also offers a controlled command conversation, not general language understanding. Supported exact examples are shown on screen in English (`order`, `slots`, `change`, `human`, `yes/no`), Devanagari (`ऑर्डर`, `समय`, `बदलें`, `मानव`, `हाँ/नहीं`) and Romanized Hindi-English (`mera order`, `slots dikhao`, `badlo`, `insaan`, `haan/nahin`). Unknown input does not authorize a tool or mutation. A failed or unresolved request may offer a local handoff; only an explicit affirmative records it. If a write response is lost, keep the page open and retry the exact same action; other actions remain blocked until the outcome is known. Reloading or restarting loses the in-memory session and retry handle, so do not interpret an interrupted response as a failed write. If the server has restarted and replay is rejected, inspect the local SQLite `appointments`, `handoffs`, and `operations` tables before starting a new session; the UI cannot recover the old session for you. These fixed commands do not establish broad language or speech ability.

Run the command and retry checks with `node --test web/test/*.test.mjs`.
