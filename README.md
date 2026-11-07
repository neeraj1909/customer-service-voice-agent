# Fictional customer service — controlled text foundation

A local learning demo with two fictional customers. Look up an order, review and explicitly confirm an appointment change, or record a local handoff. The handoff is a local record: no person is contacted. The default path uses fixed commands and form inputs, with no conversational language model, microphone, voice output, or real customer authentication. Optional local prerecorded speech recognition and synthesis can be configured separately below. Do not expose it outside loopback or use real customer information.

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

The page also offers a controlled command conversation, not general language understanding. Select a conversation language to choose clarification messages for unrecognized input; recognized commands can switch the current language. Supported exact examples are shown on screen in English (`order`, `slots`, `change`, `human`, `yes/no`), Devanagari (`ऑर्डर`, `समय`, `बदलें`, `मानव`, `हाँ/नहीं`) and Romanized Hindi-English (`mera order`, `slots dikhao`, `badlo`, `insaan`, `haan/nahin`). Unknown input does not authorize a tool or mutation. A failed or unresolved request may offer a local handoff; only an explicit affirmative records it. If a write response is lost, keep the page open and retry the exact same action; other actions remain blocked until the outcome is known. Reloading or restarting loses the in-memory session and retry handle, so do not interpret an interrupted response as a failed write. If the server has restarted and replay is rejected, inspect the local SQLite `appointments`, `handoffs`, and `operations` tables before starting a new session; the UI cannot recover the old session for you. These fixed commands do not establish broad language or speech ability.

Run the command and retry checks with `node --test web/test/*.test.mjs`.

## Optional prerecorded local audio

This path is disabled by default. To opt in, point to an existing trusted local `whisper.cpp` CLI executable and model file (absolute paths) and start the same loopback server with the following additional environment variables:

```sh
export LOCAL_AUDIO_ENABLED=1
export LOCAL_WHISPER_CLI=/absolute/path/to/whisper-cli
export LOCAL_WHISPER_MODEL=/absolute/path/to/local-model.bin
```

Select a prerecorded mono 16 kHz PCM16 WAV (maximum 30 seconds and 8 MiB), transcribe locally, and review or edit the transcript. Copying it to the command input does not send it: explicitly press **Send** after checking it, especially for `yes`. Select English or experimental Hindi recognition explicitly. A small local Hindi probe produced incorrect transcription; Hindi speech quality is unverified. Hindi requires a multilingual model; the filename check only rejects some known English-only naming patterns and cannot verify model capabilities. The latest assistant text can be synthesized by an explicit button using an installed `libespeak-ng.so.1`; the page provides audio controls for playback. This is a buffered prerecorded fixture path, not live microphone, interruption, Hindi ASR or speech-quality evidence. Nothing falls back to a hosted provider; missing local dependencies result in an error. Configure only trusted binaries and models. Check licenses and data provenance before acquiring or redistributing any assets. Sessions, transcripts and local temporary audio are intended for fictional data only.

## Validation and evidence

The controlled evaluator and isolated browser journeys can be reproduced with:

```sh
uv lock --check --offline
uv run --offline ruff format --check .
uv run --offline ruff check .
uv run --offline pytest -q
node --test web/test/*.test.mjs
uv run --offline python scripts/evaluate.py --output /tmp/customer-service-eval.json
uv run --offline python scripts/e2e/run.py
```

The browser runner needs Chrome or Chromium and Node and uses a disposable profile, server and SQLite database. The evaluator last recorded 18/18 exact-command cases passing: 6 each in English, Hindi and Hinglish. All 18 human language and semantic reviews remain unreviewed. These results cover the controlled command grammar, not general conversational ability. See [evaluation and audio evidence](docs/evidence.md) for timing boundaries, failure cases and limitations.

For a local synthetic prerecorded audio end-to-end check with existing assets, use the opt-in command in [the E2E runbook](scripts/e2e/README.md). It prints the actual recognition result and corrects it before continuing: a pass does not mean ASR was accurate. In one browser run, synthetic “Order one hundred” was transcribed as “or at one point.” and needed manual correction. A separate synthetic Hindi sample also failed. No live microphone, acoustic interruption, natural speech quality or real-time latency was established.

A separate [Pipecat text-frame spike](docs/framework-spike.md) demonstrates the fictional order lookup in an isolated framework experiment. It does not add a framework or live transport to the application. No Docker container was needed for this local demo. Its loopback bind, fictional session selector and simple UI are learning boundaries, not production authentication or deployment.

The latest recorded validation passed 22 Python tests, 18 Node tests, offline Ruff and lock checks, two 18/18 controlled evaluations, and the durable browser E2E with synthetic audio and manual transcript correction. The separate Pipecat spike also passed in its network namespace. See [evidence](docs/evidence.md) for commands, artifacts and limitations. The current audio input inventory did not establish a working microphone; this remains a prerecorded audio demo.
