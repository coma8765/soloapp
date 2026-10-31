#!/usr/bin/env python3
"""Authenticated speech regression: a >64 KiB WAV must work on a read-only pod."""

import io
import json
import os
import secrets
import ssl
import urllib.error
import urllib.request
import wave

BASE = os.environ["SOLOAPP_BASE_URL"].rstrip("/")
CONTEXT = ssl.create_default_context(cafile=os.environ.get("SOLOAPP_CA"))


def request(path, body=None, token=None, content="application/json"):
    headers = {"Content-Type": content}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, context=CONTEXT, timeout=100) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None


def main():
    credentials = json.dumps(
        {"username": "speech_test_" + secrets.token_hex(8), "password": secrets.token_hex(24)}
    ).encode()
    assert request("/api/v1/auth/v1/register", credentials)[0] == 201
    status, result = request("/api/v1/auth/v1/login", credentials)
    assert status == 200
    token = result["access_token"]
    try:
        path = "/api/v1/soloapp_app/v1/speech/"
        assert request(path + "health")[0] == 401
        assert request(path + "health", token=token)[0] == 200
        assert request(path + "transcribe", b"invalid", token, "audio/wav")[0] == 400
        audio = io.BytesIO()
        with wave.open(audio, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0" * 128000)
        status, result = request(path + "transcribe", audio.getvalue(), token, "audio/wav")
        assert status == 200, f"Speech request failed: HTTP {status}"
        assert result == {"words": []}
        print("Speech OK: auth, invalid input, 128 KiB WAV on read-only runtime")
    finally:
        request("/api/v1/auth/v1/logout", b"", token)


if __name__ == "__main__":
    main()
