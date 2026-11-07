"""Bounded, opt-in prerecorded speech with local executables only."""

import asyncio
import io
import os
import sys
import tempfile
import threading
import wave
from pathlib import Path

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = 30
MAX_TEXT = 500
ASR_TIMEOUT = 60
TTS_TIMEOUT = 20
_asr_lock = threading.Lock()
_tts_lock = threading.Lock()


class AudioError(Exception):
    def __init__(self, code: str, status: int):
        self.code, self.status = code, status
        super().__init__(code)


def validate_wav(audio: bytes, rate: int | None = 16000) -> None:
    if len(audio) > MAX_AUDIO_BYTES:
        raise AudioError("audio_too_large", 413)
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            frames, sample_rate = wav.getnframes(), wav.getframerate()
            if (
                wav.getnchannels() != 1
                or wav.getsampwidth() != 2
                or wav.getcomptype() != "NONE"
                or not sample_rate
                or (rate is not None and sample_rate != rate)
                or frames <= 0
            ):
                raise AudioError("invalid_audio", 422)
            if frames / sample_rate > MAX_AUDIO_SECONDS:
                raise AudioError("audio_too_large", 413)
            if len(wav.readframes(frames)) != frames * 2:
                raise AudioError("invalid_audio", 422)
    except (EOFError, OSError, wave.Error) as exc:
        raise AudioError("invalid_audio", 422) from exc


def check_enabled() -> None:
    if os.getenv("LOCAL_AUDIO_ENABLED") != "1":
        raise AudioError("audio_unavailable", 503)


async def run_local(command: list[str], timeout: int, stdin: bytes | None = None) -> bytes:
    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        raise AudioError("audio_unavailable", 503) from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except (TimeoutError, asyncio.CancelledError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise AudioError("audio_timeout", 504) from exc
    if proc.returncode != 0:
        raise AudioError("audio_unavailable", 503)
    return out or b""


async def transcribe(audio: bytes, language: str = "en") -> str:
    check_enabled()
    validate_wav(audio)
    if language not in {"en", "hi"}:
        raise AudioError("invalid_audio_language", 422)
    cli, model = os.getenv("LOCAL_WHISPER_CLI", ""), os.getenv("LOCAL_WHISPER_MODEL", "")
    if not (
        os.path.isabs(cli)
        and os.path.isfile(cli)
        and os.access(cli, os.X_OK)
        and os.path.isabs(model)
        and os.path.isfile(model)
        and os.access(model, os.R_OK)
    ):
        raise AudioError("audio_unavailable", 503)
    if language == "hi" and ".en" in Path(model).name.lower():
        raise AudioError("audio_language_unavailable", 422)
    if not _asr_lock.acquire(blocking=False):
        raise AudioError("audio_busy", 429)
    try:
        with tempfile.TemporaryDirectory(prefix="customer-audio-") as temp:
            source = Path(temp) / "input.wav"
            prefix = Path(temp) / "result"
            try:
                source.write_bytes(audio)
                source.chmod(0o600)
            except OSError as exc:
                raise AudioError("audio_unavailable", 503) from exc
            await run_local(
                [
                    cli,
                    "-m",
                    model,
                    "-l",
                    language,
                    "-t",
                    "2",
                    "-ng",
                    "-nt",
                    "-np",
                    "-otxt",
                    "-of",
                    str(prefix),
                    "-f",
                    str(source),
                ],
                ASR_TIMEOUT,
            )
            try:
                path = prefix.with_suffix(".txt")
                if path.stat().st_size > 4000:
                    raise AudioError("audio_unavailable", 503)
                text = path.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeError) as exc:
                raise AudioError("audio_unavailable", 503) from exc
            if not text or len(text) > MAX_TEXT:
                raise AudioError("audio_no_transcript", 422)
            return text
    finally:
        _asr_lock.release()


async def synthesize(text: str, language: str) -> bytes:
    check_enabled()
    if language not in {"en", "hi"} or not text.strip() or len(text) > MAX_TEXT or "\0" in text:
        raise AudioError("invalid_audio_request", 422)
    try:
        encoded = text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise AudioError("invalid_audio_request", 422) from exc
    if not _tts_lock.acquire(blocking=False):
        raise AudioError("audio_busy", 429)
    try:
        output = await run_local(
            [sys.executable, str(Path(__file__).with_name("audio_synth_worker.py")), language],
            TTS_TIMEOUT,
            encoded,
        )
        validate_wav(output, rate=None)
        return output
    finally:
        _tts_lock.release()
