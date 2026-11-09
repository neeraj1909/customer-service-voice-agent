# Local browser end-to-end checks

From the repository root, run the controlled text journeys in English, Hindi and Hinglish:

```sh
uv run --offline python scripts/e2e/run.py
```

To also exercise a real prerecorded synthetic WAV through local Whisper and eSpeak NG, supply existing local assets explicitly:

```sh
uv run --offline python scripts/e2e/run.py --audio \
  --whisper-cli /absolute/path/to/whisper-cli \
  --whisper-model /absolute/path/to/multilingual-model.bin
```

The audio option requires `ffmpeg`, `libespeak-ng.so.1`, a local Whisper CLI and a compatible model; it does not download them or call a hosted provider. Chrome or Chromium and Node are required for both modes; use `--chrome /path/to/browser` when automatic discovery fails. Each journey starts a loopback-only server, fresh SQLite database and isolated headless browser profile in a temporary directory and cleans them up. It never uses the shared browser profile or a microphone.

The text checks verify the supported controlled commands, explicit consent, local handoff, and replay of a write whose actual response was deliberately lost. A separate browser journey checks new fixture orders for both customers, verifies that another customer's order and an unknown order produce the same 404, and inspects the SQLite state before and after reads. An additional real HTTP check upgrades a disposable legacy database containing edits, a fixture-ID collision, an appointment, handoff and operation, then verifies preserved state and two stable restarts. The audio check generates synthetic speech, prints the **actual** ASR result, manually corrects it to the controlled command, checks copy-versus-submit boundaries, and verifies local WAV synthesis and stale input/playback handling. An end-to-end pass after correction is not evidence that recognition was accurate, nor evidence of live microphone, interruption, natural conversation or model quality. Timings here are not a voice-latency benchmark.

The order journey also sends simulated voice-tool events through the browser adapter and checks the page audio element during overlapping speech events. These checks do not use a microphone or verify audible playback.
