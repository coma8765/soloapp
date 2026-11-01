#!/usr/bin/env python3
"""Exercise auth, Whisper, Llama and TTS with synthetic speech over verified HTTPS."""

import argparse
import base64
import io
import json
import secrets
import ssl
import struct
import time
import urllib.error
import urllib.request
import wave


def pcm16_16khz(data):
    with wave.open(io.BytesIO(data), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError("Expected mono PCM16 from TTS")
        rate = source.getframerate()
        count = source.getnframes()
        samples = struct.unpack("<" + "h" * count, source.readframes(count))
    if not samples or count / rate > 8:
        raise ValueError("Synthetic question must be nonempty and at most 8 seconds")
    result = []
    for index in range(int(count * 16000 / rate)):
        position = index * rate / 16000
        left = int(position)
        right = min(left + 1, count - 1)
        result.append(round(samples[left] + (samples[right] - samples[left]) * (position - left)))
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16000)
        target.writeframes(struct.pack("<" + "h" * len(result), *result))
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--ca", required=True)
    parser.add_argument("--tts", required=True, help="Loopback-only temporary TTS port-forward")
    args = parser.parse_args()
    context = ssl.create_default_context(cafile=args.ca)
    token = None

    def request(path, data=None, method=None, base=None):
        headers = {}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        elif isinstance(data, bytes):
            headers["Content-Type"] = "audio/wav"
        if token and base is None:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(
            (base or args.url) + path, data=data, headers=headers, method=method
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, context=context, timeout=175) as response:
                body = response.read()
                return body if base else (json.loads(body) if body else None)
        except urllib.error.HTTPError as error:
            detail = error.read(512).decode(errors="replace")
            raise RuntimeError(
                f"{path}: HTTP {error.code} after {time.monotonic() - started:.2f}s: {detail}"
            ) from None

    credentials = {
        "username": "local_check_" + secrets.token_hex(6),
        "password": secrets.token_hex(24),
    }
    request("/api/v1/auth/v1/register", credentials)
    try:
        session = request("/api/v1/auth/v1/login", credentials)
        token = session["access_token"]
        identity = request("/api/v1/soloapp_app/v1/user-id")
        if identity["user_id"] != session["user_id"]:
            raise ValueError("Signed user identity mismatch")
        health = request("/api/v1/soloapp_app/v1/speech/health")
        if not health.get("ready") or health.get("device") != "metal":
            raise ValueError("Whisper Metal unavailable through the app")
        audio = pcm16_16khz(request("/synthesize", {"text": "Почему небо голубое?"}, base=args.tts))
        start = time.monotonic()
        transcript = request("/api/v1/soloapp_app/v1/speech/transcribe", audio)
        asr_seconds = round(time.monotonic() - start, 2)
        if not transcript.get("words"):
            raise ValueError("Whisper returned no words for synthetic speech")
        start = time.monotonic()
        result = request("/api/v1/soloapp_app/v1/professor/respond", audio)
        total_seconds = round(time.monotonic() - start, 2)
        speech = base64.b64decode(result.get("audio_base64", ""), validate=True)
        if not result.get("transcript") or not result.get("answer") or speech[:4] != b"RIFF":
            raise ValueError("Incomplete professor response: transcript / answer / WAV")
        with wave.open(io.BytesIO(speech), "rb") as response_audio:
            if response_audio.getnframes() <= 0:
                raise ValueError("Empty synthesized answer")
        print(
            json.dumps(
                {
                    "speech": "PASS",
                    "device": "metal",
                    "whisper_seconds": asr_seconds,
                    "professor_seconds": total_seconds,
                    "answer_audio_bytes": len(speech),
                }
            )
        )
    finally:
        if token:
            request("/api/v1/auth/v1/logout", method="POST")


if __name__ == "__main__":
    main()
