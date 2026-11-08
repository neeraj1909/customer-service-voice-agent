"""Run real local browser/HTTP/SQLite checks with optional prerecorded audio.

Example: uv run --offline python scripts/e2e/run.py
For local audio, additionally pass --audio --whisper-cli /absolute/whisper-cli
--whisper-model /absolute/model.bin. No microphone or hosted provider is used.
"""

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts" / "e2e"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_for_server(base, process):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited with status {process.returncode}")
        try:
            with opener.open(base, timeout=0.5) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.05)
    raise RuntimeError("loopback server startup timed out")


def one_run(tmp, name, chrome, *, cli=None, model=None):
    db = tmp / f"{name}.sqlite3"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update(
        DEMO_DB=str(db),
        PYTHONPATH=str(ROOT / "src"),
        E2E_DIR=str(tmp),
        E2E_DB=str(db),
        E2E_BASE=base,
        CHROME_BIN=chrome,
        PYTHON_EXECUTABLE=sys.executable,
        LOCAL_AUDIO_ENABLED="1" if name == "audio" else "0",
    )
    if name == "audio":
        env.update(LOCAL_WHISPER_CLI=str(cli), LOCAL_WHISPER_MODEL=str(model))
    else:
        env["TEST_LANG"] = name
    log_path = tmp / f"{name}-server.log"
    with log_path.open("wb") as log:
        server = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "customer_service.app:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            wait_for_server(base, server)
            script = {"audio": "audio.cjs", "orders": "orders.cjs"}.get(name, "conversation.cjs")
            subprocess.run(
                ["node", str(SCRIPTS / script)], cwd=ROOT, env=env, check=True, timeout=180
            )
        except BaseException:
            log.flush()
            print(
                f"Server output for {name}:\n{log_path.read_text(errors='replace')[-6000:]}",
                file=sys.stderr,
            )
            raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--audio", action="store_true", help="Also run a real local ASR/TTS synthetic-WAV journey"
    )
    parser.add_argument("--whisper-cli", type=Path)
    parser.add_argument("--whisper-model", type=Path)
    parser.add_argument(
        "--chrome", default=shutil.which("google-chrome") or shutil.which("chromium")
    )
    args = parser.parse_args()
    if not args.chrome or not shutil.which("node"):
        parser.error("Chrome/Chromium and Node are required")
    if args.audio:
        if not args.whisper_cli or not args.whisper_model:
            parser.error("--audio requires --whisper-cli and --whisper-model")
        if not args.whisper_cli.is_absolute() or not args.whisper_model.is_absolute():
            parser.error("audio asset paths must be absolute")
        if (
            not args.whisper_cli.is_file()
            or not args.whisper_model.is_file()
            or not shutil.which("ffmpeg")
        ):
            parser.error("audio requires an existing local CLI and model, and ffmpeg")
    with tempfile.TemporaryDirectory(prefix="customer-e2e-") as name:
        tmp = Path(name)
        for language in ("en", "hi", "hinglish", "orders"):
            one_run(tmp, language, args.chrome)
        subprocess.run(
            [sys.executable, str(SCRIPTS / "upgrade.py")], cwd=ROOT, check=True, timeout=90
        )
        if args.audio:
            raw = subprocess.run(
                [sys.executable, str(ROOT / "src/customer_service/audio_synth_worker.py"), "en"],
                input=b"Order one hundred.",
                capture_output=True,
                check=True,
                timeout=30,
            ).stdout
            raw_path = tmp / "audio-english-raw.wav"
            raw_path.write_bytes(raw)
            subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-nostdin",
                    "-y",
                    "-i",
                    str(raw_path),
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(tmp / "audio-english.wav"),
                ],
                check=True,
                timeout=30,
            )
            one_run(tmp, "audio", args.chrome, cli=args.whisper_cli, model=args.whisper_model)
    print("E2E_COMPLETE: temporary data, profiles and servers cleaned up")


if __name__ == "__main__":
    main()
