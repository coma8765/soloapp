"""Run inside the image with --network none and --read-only."""

import io
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave

server = subprocess.Popen([sys.executable, "/app/server.py"])
try:
    for attempt in range(60):
        if server.poll() is not None:
            raise RuntimeError("TTS failed to start")
        try:
            with urllib.request.urlopen("http://127.0.0.1:8179/healthz", timeout=2) as response:
                assert json.load(response)["ready"]
            break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError("TTS readiness timed out")
    request = urllib.request.Request(
        "http://127.0.0.1:8179/synthesize",
        data=json.dumps({"text": "Привет! Проверка синтеза речи."}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.headers["Content-Type"] == "audio/wav"
        with wave.open(io.BytesIO(response.read()), "rb") as audio:
            assert audio.getnchannels() == 1
            assert audio.getsampwidth() == 2
            assert audio.getframerate() == 22050
            assert audio.getnframes() > 22050
    print("Offline, read-only synthesis: OK")
finally:
    server.terminate()
    server.wait(timeout=10)
