"""Isolate libespeak-ng's process-global callback in a short-lived process."""

import ctypes
import io
import sys
import wave


def main() -> int:
    voice = sys.argv[1] if len(sys.argv) == 2 else ""
    content = sys.stdin.buffer.read(4001)
    if voice not in {"en", "hi"} or not content or len(content) > 4000:
        return 2
    try:
        engine = ctypes.CDLL("libespeak-ng.so.1")
        callback_type = ctypes.CFUNCTYPE(
            ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p
        )
        parts = []
        samples_total = 0
        sample_rate = 0

        @callback_type
        def collect(samples, count, _events):
            nonlocal samples_total
            samples_total += max(0, count)
            if samples_total > sample_rate * 30:
                return 1
            if samples and count > 0:
                parts.append(ctypes.string_at(samples, count * 2))
            return 0

        engine.espeak_Initialize.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
        ]
        engine.espeak_Initialize.restype = ctypes.c_int
        engine.espeak_SetSynthCallback.argtypes = [callback_type]
        engine.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        engine.espeak_SetVoiceByName.restype = ctypes.c_int
        engine.espeak_Synth.argtypes = [
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_uint,
            ctypes.c_int,
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_uint),
            ctypes.c_void_p,
        ]
        engine.espeak_Synth.restype = ctypes.c_int
        sample_rate = engine.espeak_Initialize(1, 100, None, 0)
        if not (0 < sample_rate <= 96000):
            return 3
        engine.espeak_SetSynthCallback(collect)
        if engine.espeak_SetVoiceByName(voice.encode("ascii")) != 0:
            return 3
        ident = ctypes.c_uint()
        if (
            engine.espeak_Synth(
                ctypes.c_char_p(content), len(content), 0, 1, 0, 1, ctypes.byref(ident), None
            )
            != 0
        ):
            return 3
        engine.espeak_Synchronize()
        engine.espeak_Terminate()
        if not parts or samples_total > sample_rate * 30:
            return 3
        result = io.BytesIO()
        with wave.open(result, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(b"".join(parts))
        sys.stdout.buffer.write(result.getvalue())
        return 0
    except (OSError, AttributeError, ValueError):
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
