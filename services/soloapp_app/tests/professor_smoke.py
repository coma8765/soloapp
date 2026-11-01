"""Authenticated audio -> transcript -> Llama -> WAV integration test.

Pass a synthetic mono PCM16/16kHz WAV (max 8 seconds) as argv[1].
"""

import base64
import io
import json
import sys
import time
import wave
from pathlib import Path

from speech_smoke import request


def main():
    import secrets

    credentials = json.dumps(
        {"username": "professor_test_" + secrets.token_hex(8), "password": secrets.token_hex(24)}
    ).encode()
    assert request("/api/v1/auth/v1/register", credentials)[0] == 201
    status, result = request("/api/v1/auth/v1/login", credentials)
    assert status == 200
    token = result["access_token"]
    path = "/api/v1/soloapp_app/v1/professor/respond"
    try:
        assert request(path, b"invalid", content="audio/wav")[0] == 401
        assert request(path, b"invalid", token, "audio/wav")[0] == 400
        time.sleep(2)
        start = time.monotonic()
        status, result = request(path, Path(sys.argv[1]).read_bytes(), token, "audio/wav")
        assert status == 200, (status, result)
        assert result["transcript"].strip() and result["answer"].strip()
        assert not result.get("audio_error"), result
        with wave.open(
            io.BytesIO(base64.b64decode(result["audio_base64"], validate=True)), "rb"
        ) as audio:
            assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
            assert audio.getframerate() == 22050 and audio.getnframes() > 1000
            seconds = audio.getnframes() / audio.getframerate()
        print(
            json.dumps(
                {
                    "transcript": result["transcript"],
                    "answer": result["answer"],
                    "audio_seconds": round(seconds, 2),
                    "latency_seconds": round(time.monotonic() - start, 2),
                },
                ensure_ascii=False,
            )
        )
    finally:
        request("/api/v1/auth/v1/logout", b"", token)


if __name__ == "__main__":
    main()
