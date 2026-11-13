# Baseline and GPT-Live: exploratory voice comparison

Run date: 13 November 2026. This is a narrow, synthetic-audio experiment, not a production benchmark or a comparison of equally guarded systems.

## Method

A local isolated server and an `aiortc` WebRTC client sent the same synthetic English greeting to each provider path. The baseline used `gpt-4o-mini-transcribe`, a `gpt-4.1-mini` transcript scope check, and `gpt-realtime`; the Live path used `gpt-live-1` with a `gpt-6-luna` delegated backend. Attempts were paired and their order randomized; Live ran first in 8 of 20 pairs. Each pair used a fresh isolated server and fictional Asha session. The client measured from the end of the synthetic PCM input to the first *received non-silent audio frame after that point*. No physical microphone or loudspeaker was used.

All 20 pairs completed: each arm created 20 sessions, received non-silent audio in all 20, and confirmed 20 closes. No trial failures were recorded. The harness directly handled Realtime control events and called the actual scope endpoint; it is not the production browser adapter. First-audio detection starts only after the fixture ends, so output that began earlier is **left-censored**: these numbers cannot establish exact first-speech onset when output overlaps the input.

## Observed timings

| Client-observed interval | Baseline p50 | Baseline p95 | GPT-Live p50 | GPT-Live p95 |
|---|---:|---:|---:|---:|
| PCM end to first qualifying received non-silent frame | 3,489.5 ms | 6,440 ms | 1,279 ms | 1,576 ms |
| VAD-stop event to transcription-complete event | 471.5 ms | 1,132 ms | Not separately observed | Not separately observed |
| Scope HTTP request to response | 1,206.5 ms | 4,030 ms | No equivalent gate | No equivalent gate |
| Scope response to original-audio deletion acknowledgment | 144 ms | 156 ms | Not applicable | Not applicable |
| Response request to first qualifying received non-silent frame | 589.5 ms | 760 ms | Not separately observed | Not separately observed |

Percentiles use nearest rank for p95; p50 is the median. Each reported number has 20 samples. These are event-arrival and received-frame measurements that include network and scheduling effects, not internal model STT, reasoning, or TTS durations. Live transcript fragments can arrive during the input and do not expose equivalent completed-stage boundaries. A short response or backchannel is counted as audio; this test does not establish time to a useful or correct answer.

The scope safeguards are materially different: the baseline waits for a separate transcript-based scope decision before requesting a response, while this exploratory Live mode has conversation instructions but no equivalent pre-response check. A faster measured Live response therefore cannot be attributed to the voice model alone or taken as a safety-equivalent result. Both retain customer-scoped, read-only application tools; tool and spoken-answer quality require separate checks.

## Separate order-lookup probe

A separate synthetic request intended to look up Asha's `ord-a-201`. In the repeat probe the baseline requested `ord-20201` and Live requested `ord-2201`; both lookups returned 404 and both produced speech asking for the ID to be checked. Both sessions closed with HTTP 204. In an earlier probe Live received a 200 tool result, but the exact argument was not recorded, so that result does not prove it retrieved the intended order. The probe mimicked the browser's tool-event routing; it did not exercise the actual browser adapter. This is an observed quality problem for that synthetic utterance, not an accuracy rate.

## Evidence and limits

- Sanitized per-pair results: `/tmp/mira-voice-comparison-20261113.jsonl`; runner: `/tmp/mira_comparison_runs.py`; media harness: `/tmp/mira_audio_compare.py`; synthetic fixture: `/tmp/mira_compare_hello.wav`. These are local temporary artifacts and can be removed by the operating system.
- Order probe outputs: `/tmp/mira-order-provider-check-repeat.txt` and `/tmp/mira-order-provider-check.txt`. These are local temporary artifacts.
- Later trial source hashes were recorded in `/tmp/mira-comparison-source-hashes.jsonl`; earlier trials do not have individual hash records. The experiment owner reported no model or session-configuration changes during the run.
- The latency run repeats one synthetic greeting. The separate order probe is described above. Neither establishes general speech recognition accuracy, Hindi or Hinglish quality, interruption handling, scope leakage, accessibility, natural conversations, or performance under load. Audio was received, not evaluated for semantic correctness or heard through a physical device.
- GPT-Live can speak while backend work runs. The app's experimental mode does not guarantee that off-topic speech is stopped before playback. Results must not be represented as safety parity.
