# Fictional customer service voice demo

A local learning demo with two fictional customers. Look up an order, review and explicitly confirm an appointment change, or record a local handoff. The handoff is a local record: no person is contacted. The default path uses fixed commands and form inputs. Optional local prerecorded audio and an opt-in, billable OpenAI Realtime voice path are described below. The fictional session selector is not customer authentication. Do not expose the service outside loopback or use real customer information.

## Run locally

Run from a full source checkout: the application reads the bundled `src/customer_service/fixtures/orders.json` and serves files from the repository’s `web/` directory. Wheel or other installed-distribution packaging of these assets has not been verified.

Python 3.11+ and `uv` are required. Dependencies are pinned in `uv.lock`; the `--offline` commands work only after their distributions have been cached. Installing dependencies may use the internet; the default application path makes no external provider calls. The optional Realtime path sends audio and fictional tool results to OpenAI and may incur charges.

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

## Fictional order data

The static fixture adds 48 wholly fictional orders to the two original orders: IDs `ord-a-201`–`ord-a-224` for Asha and `ord-b-201`–`ord-b-224` for Bilal. Each customer has eight additional orders in each of `processing`, `shipped`, and `delivered`. For example, in an Asha session, the commands `order ord-a-201`, `order ord-a-202`, and `order ord-a-203` look up those three statuses respectively. A Bilal order remains inaccessible from Asha's session. No runtime language model is needed for these static records or their lookup.

Each fictional order also has generated line items, quantities and INR prices. Prices are stored as integer paise (100 paise = ₹1); totals are computed from the line items. The items are deterministic demo data, not generated customer history. Ask Mira for all orders or an individual order's items and price. In the page, open **Look up an order** and choose **View all my orders**. History is scoped to the selected fictional customer. An additive one-time backfill adds missing items to matching seeded order IDs and preserves existing item rows and other service state. A missing item list is shown without a made-up total.

A one-time additive upgrade preserves existing orders: conflicting IDs are skipped, never overwritten, so an existing conflicting record may differ from the nominal fixture. The fixture is validated on startup; a local upgrade check verified that an existing conflicting record and other service state were preserved. The dataset proposal was generated by a `gpt-6.1-sol` worker through delegation on 2026-11-09; the records are synthetic and are not customer history or evidence of real-world distribution. The cost of the delegation was not independently established.

## Optional live voice (paid provider)

This path is disabled by default. It requires an OpenAI API key with Realtime access and a browser with microphone permission. ChatGPT account credits do not establish API access or billing availability. Export the API key securely in the shell without putting it in source control, then start the loopback server with:

```sh
export REALTIME_ENABLED=1
# Set OPENAI_API_KEY in your environment using your preferred secret manager.
DEMO_DB="$(mktemp /tmp/customer-service-voice-XXXXXX.sqlite3)"
export DEMO_DB
PYTHONPATH=src uv run --offline uvicorn customer_service.app:create_app --factory --host 127.0.0.1 --port 8001
```

If the server runs on a VM, forward the port from a terminal on your own computer, replacing the SSH destination as appropriate:

```sh
ssh -N -L 8001:127.0.0.1:8001 user@vm-host
```

Open <http://localhost:8001>, select a fictional customer, start a session, select **Start voice call**, and grant microphone permission. Try asking about `ord-a-201` for Asha. Select **End voice call** when finished. Keep the SSH terminal open while testing. The browser and provider need network access; the API key remains on the server. Audio and fictional tool results are sent to the provider and the call may be billable.

After 30 seconds of inactivity, the app releases the microphone. Use **Pause** or **Resume** below the voice status to pause or resume manually; Resume requests the microphone again, and Mira finishes any response already in progress while paused. After a response finishes generating, the inactivity timer can expire while playback is still draining; automatic pause stops playback as well as microphone capture. The live playback stream cannot replay audio missed while paused. The playback control timer shows incoming audio, not microphone recording. The connection remains open and still has the five-minute lifetime. If the connection fails, **Resume** opens a replacement provider call in the same fictional customer session and replays the approved user turns and completed audio transcripts retained in this page. Interrupted or unheard speech and tool state are not reconstructed exactly; a page reload, ending the call, or restarting the local server loses this in-memory recovery context. A failed provider hangup can prevent reconnection.

Choose a voice reply language before starting a call, or use **Match my question**. When sound interrupts an answer and the transcript is classified as noise, the app asks Mira to give a brief reminder of the topic and continue in the current language. This is a best-effort generated continuation: noise classification can be wrong, and the app cannot identify the exact last sentence heard. It does not use LiveKit. To prevent room noise or a cough from interrupting a long answer, select **Mute microphone** while Mira speaks and unmute it before speaking again. Headphones and a quiet room may also reduce accidental interruptions. A muted microphone cannot hear deliberate interruptions. The longer response budget can increase provider usage and still does not guarantee a complete answer. Fictional orders have no order dates, so the demo cannot establish which are most recent.

Mira is scoped to the fictional service: orders, prices, appointments, support handoff, using the demo, greetings, language preferences and related follow-ups. General-knowledge and other unrelated requests are redirected. For mixed requests, the independent check attempts to retain only the support part. Voice turns are transcribed and checked using OpenAI `gpt-4.1-mini` before a response; this adds latency and billable API usage. The original turn is removed from the conversation before the approved text is passed to Mira. If transcription or the check fails, no answer is generated; try again. The classifier can make mistakes, especially with ambiguous speech, mixed languages or adversarial input. Browser-mediated checks can be bypassed by a modified client and are not production security controls.

The Realtime tools are limited to customer-scoped order lookup and appointment-slot lookup. Appointment changes and local handoff remain explicit actions in the page; the voice model cannot perform those writes through its tools. A model can still make inaccurate or unsupported claims, so verify results and use the page's confirmation controls. The service allows two concurrent calls and attempts to end each call after five minutes; a provider hangup can fail. This is a local learning demo, and browser-mediated provider events are not a production security boundary. Real microphone, interruption, language quality, acoustic latency, and provider behavior need live validation; automated or simulated checks alone do not establish them.

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

The browser runner needs Chrome or Chromium and Node and uses a disposable profile, server and SQLite database. The evaluator recorded 26/26 exact-command cases passing. All 26 human language and semantic reviews remain unreviewed. These results cover the controlled command grammar, not general conversational ability. See [evaluation and audio evidence](docs/evidence.md) for timing boundaries, failure cases and limitations.

For a local synthetic prerecorded audio end-to-end check with existing assets, use the opt-in command in [the E2E runbook](scripts/e2e/README.md). It prints the actual recognition result and corrects it before continuing: a pass does not mean ASR was accurate. In one browser run, synthetic “Order one hundred” was transcribed as “or at one point.” and needed manual correction. A separate synthetic Hindi sample also failed. No live microphone, acoustic interruption, natural speech quality or real-time latency was established.

A separate [Pipecat text-frame spike](docs/framework-spike.md) demonstrates the fictional order lookup in an isolated framework experiment. It does not add a framework to the application. No Docker container was needed for this local demo. Its loopback bind, fictional session selector and simple UI are learning boundaries, not production authentication or deployment.

The previously recorded offline validation passed 32 Python tests, 19 Node tests, offline Ruff and lock checks, a 26/26 controlled evaluation, and the durable browser E2E with synthetic audio and manual transcript correction. The separate Pipecat spike also passed in its network namespace. See [evidence](docs/evidence.md) for commands, artifacts and limitations. Those offline results do not validate the optional live voice path.
