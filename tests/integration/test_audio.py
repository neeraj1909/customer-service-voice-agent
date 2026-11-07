import io
import wave

from fastapi.testclient import TestClient

from customer_service.app import create_app


def pcm_wav():
    data = io.BytesIO()
    with wave.open(data, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 1600)
    return data.getvalue()


def test_audio_needs_session_and_missing_assets_fail_closed(tmp_path, monkeypatch):
    monkeypatch.delenv("LOCAL_WHISPER_CLI", raising=False)
    monkeypatch.delenv("LOCAL_WHISPER_MODEL", raising=False)
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        assert (
            client.post(
                "/api/audio/transcribe", content=pcm_wav(), headers={"Content-Type": "audio/wav"}
            ).status_code
            == 401
        )
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token, "Content-Type": "audio/wav"}
        result = client.post("/api/audio/transcribe", content=pcm_wav(), headers=headers)
        assert result.status_code == 503
        assert result.json()["error"] == "audio_unavailable"


def configure_stub(tmp_path, monkeypatch, script):
    cli = tmp_path / "whisper-cli"
    cli.write_text("#!/usr/bin/env python3\n" + script, encoding="utf-8")
    cli.chmod(0o700)
    model = tmp_path / "model.bin"
    model.write_bytes(b"fake local model")
    monkeypatch.setenv("LOCAL_AUDIO_ENABLED", "1")
    monkeypatch.setenv("LOCAL_WHISPER_CLI", str(cli))
    monkeypatch.setenv("LOCAL_WHISPER_MODEL", str(model))


def test_controlled_asr_is_review_only_and_passes_explicit_language(tmp_path, monkeypatch):
    import sqlite3

    configure_stub(
        tmp_path,
        monkeypatch,
        """\
import pathlib, sys
args = sys.argv[1:]
pathlib.Path(args[args.index('-of') + 1] + '.txt').write_text('human' if args[args.index('-l') + 1] == 'hi' else 'order ord-a-100')
""",
    )
    path = tmp_path / "demo.sqlite3"
    with TestClient(create_app(path)) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token, "Content-Type": "audio/wav", "X-Audio-Language": "hi"}
        result = client.post("/api/audio/transcribe", content=pcm_wav(), headers=headers)
        assert result.status_code == 200
        assert result.json() == {"text": "human", "language": "hi"}
        with sqlite3.connect(path) as db:
            assert db.execute("SELECT COUNT(*) FROM handoffs").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == 0
        assert client.post(
            "/api/audio/transcribe",
            content=pcm_wav(),
            headers={**headers, "X-Audio-Language": "auto"},
        ).json() == {"error": "invalid_audio_language"}


def test_invalid_wav_and_untrusted_language_are_rejected_before_inference(tmp_path, monkeypatch):
    configure_stub(tmp_path, monkeypatch, "raise SystemExit(42)\n")
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token, "Content-Type": "audio/wav"}
        assert client.post("/api/audio/transcribe", content=b"not wav", headers=headers).json() == {
            "error": "invalid_audio"
        }
        assert client.post(
            "/api/audio/transcribe",
            content=pcm_wav(),
            headers={**headers, "X-Audio-Language": "--help"},
        ).json() == {"error": "invalid_audio_language"}
        assert (
            client.post(
                "/api/audio/transcribe",
                content=pcm_wav(),
                headers={**headers, "Content-Type": "audio/webm"},
            ).status_code
            == 415
        )


def test_local_asr_timeout_kills_child_and_cleans_temp(tmp_path, monkeypatch):
    import tempfile

    from customer_service import audio

    configure_stub(tmp_path, monkeypatch, "import time\ntime.sleep(2)\n")
    monkeypatch.setattr(audio, "ASR_TIMEOUT", 0.05)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        result = client.post(
            "/api/audio/transcribe",
            content=pcm_wav(),
            headers={"X-Session": token, "Content-Type": "audio/wav"},
        )
        assert result.status_code == 504
        assert result.json() == {"error": "audio_timeout"}
    assert list(tmp_path.glob("customer-audio-*")) == []


def test_real_local_synthesis_produces_bounded_wav(tmp_path, monkeypatch):
    import ctypes.util

    import pytest

    if not ctypes.util.find_library("espeak-ng"):
        pytest.skip("local libespeak-ng not installed")
    monkeypatch.setenv("LOCAL_AUDIO_ENABLED", "1")
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token}
        result = client.post(
            "/api/audio/synthesize",
            headers=headers,
            json={"text": "Order shipped.", "language": "en"},
        )
        assert result.status_code == 200 and result.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(result.content), "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getsampwidth() == 2
            assert 0 < wav.getnframes() / wav.getframerate() <= 30
        assert (
            client.post(
                "/api/audio/synthesize",
                headers=headers,
                json={"text": "hello", "language": "invalid"},
            ).status_code
            == 400
        )


def test_oversize_long_audio_and_busy_inference_are_rejected(tmp_path, monkeypatch):
    from customer_service import audio

    configure_stub(tmp_path, monkeypatch, "raise SystemExit(42)\n")
    long_wav = io.BytesIO()
    with wave.open(long_wav, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 16000 * 31)
    with TestClient(create_app(tmp_path / "demo.sqlite3")) as client:
        token = client.post("/api/sessions", json={"customer_id": "cust-a"}).json()["session_id"]
        headers = {"X-Session": token, "Content-Type": "audio/wav"}
        assert (
            client.post(
                "/api/audio/transcribe", content=long_wav.getvalue(), headers=headers
            ).status_code
            == 413
        )
        assert (
            client.post(
                "/api/audio/transcribe", content=b"x" * (audio.MAX_AUDIO_BYTES + 1), headers=headers
            ).status_code
            == 413
        )
        assert audio._asr_lock.acquire(blocking=False)
        try:
            assert (
                client.post("/api/audio/transcribe", content=pcm_wav(), headers=headers).status_code
                == 429
            )
        finally:
            audio._asr_lock.release()
