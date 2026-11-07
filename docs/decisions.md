# Foundation decisions

Observed 2026-11-08. This is a local learning demo for fictional retail support. The authoritative project plan is [the Voice PRP](/home/neeraj/prp-plans/multilingual-customer-service-voice-agent/2026-11-08-multilingual-customer-service-voice-agent-plan.md); the parent portfolio plan orders Voice before the other projects.

## Workspace and ownership

- `/home/neeraj/Code/multilingual_customer_service_voice_agent` was empty and not a Git repository at inspection. New files belong to this project. Do not modify the reference assistant to implement this project.
- No applicable `AGENTS.md` was found at `/home`, `/home/neeraj`, `/home/neeraj/Code`, either project root, or within the target and tracked source tree inspected; the user's supplied instructions still apply. Check again if the workspace changes.
- The reference repository `/home/neeraj/Code/conversational-ai-for-astro` was clean under `git status --short` at commit `89892d7cc47c43958dbce249d4b8162449096f16`. Preserve any later user changes. Its public remote is `https://github.com/neeraj1909/personalized-memory-voice-assistant.git`.

## Reuse and licensing

No tracked `LICENSE`, `COPYING` or `NOTICE` file was found in the reference repository, and no license file was found within its first two levels. This scan is not a legal conclusion about ownership or third-party material. Treat the reference as design evidence; do not copy or redistribute its code until rights and applicable third-party notices are established. Inspect dependency and model-weights licenses independently. A public GitHub URL alone is not a license grant.

Selective patterns to evaluate independently:

- `web/realtime-call.js` has playback gating and lifecycle handling, but is coupled to a particular provider's events.
- `app/realtime_gateway.py` configures OpenAI Realtime and `ask_memory`; it cannot serve as the offline default. Its docstring explicitly warns direct client access is not a hard policy boundary.
- `app/local_asr.py` uses a separately configured local whisper.cpp executable and model for short buffered WAV clips; `app/local_tts.py` uses eSpeak NG. Their existence does not demonstrate an installed model, intelligibility, code-mixed quality, low latency, or an end-to-end voice path.
- `scripts/evaluate_golden.py` reports chat-request durations and API-reported context checks; it does not independently score reply/language quality or caller-heard voice latency.

## Design decisions and boundaries

Start with a deterministic controlled text workflow against seeded fictional data. The project-owned service controls customer scope, appointment confirmation, atomic idempotent changes and honest local handoff records. Treat adapter and tool output as untrusted and do not describe scripted responses as model inference. Validate real audio separately and mark it unverified until actually exercised. Reassess these provisional decisions when the blocked headed research lane is completed or explicitly waived.

No paid APIs, paid services, real customer data, public deployment or production-experience claim are authorized by the current plan. Local-only operation does not in itself prove absence of outbound connections: enforce and test the boundary in the implementation.
