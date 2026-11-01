"""Load the real offline model and check the HTTP contract; optional synthetic WAV."""

import io
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path


def request(path, data=None):
    headers = {"Content-Type": "audio/wav"} if data else {}
    req = urllib.request.Request("http://127.0.0.1:8178" + path, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=95) as response:
        return json.load(response)


def main():
    worker = subprocess.Popen([sys.executable, "/app/server.py", "--model", "/model"])
    try:
        deadline = time.monotonic() + 240
        while True:
            assert worker.poll() is None, "Whisper process exited during model loading"
            try:
                health = request("/healthz")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() > deadline:
                    raise TimeoutError("Model did not become ready") from None
                time.sleep(1)
        assert health["ready"] and health["model"] == "openai/whisper-large-v3-turbo", health
        silent = io.BytesIO()
        with wave.open(silent, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 64000)
        assert request("/transcribe", silent.getvalue()) == {"words": []}
        if sys.argv[1:]:
            start = time.monotonic()
            result = request("/transcribe", Path(sys.argv[1]).read_bytes())
            assert result["words"], result
            assert all(0 <= w["start"] <= w["end"] <= 8 for w in result["words"]), result
            print(
                json.dumps(
                    {
                        "transcript": "".join(w["word"] for w in result["words"]),
                        "seconds": round(time.monotonic() - start, 2),
                    },
                    ensure_ascii=False,
                )
            )
        print("Whisper turbo offline model, health and silent WAV: OK")
    finally:
        worker.terminate()
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()


if __name__ == "__main__":
    main()
