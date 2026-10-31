import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from server import decode_wav, make_handler


def wav(samples=b"\x00\x00" * 1600, rate=16000, channels=1):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as f:
        f.setnchannels(channels)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(samples)
    return buffer.getvalue()


class WorkerTests(unittest.TestCase):
    def test_decode(self):
        self.assertEqual(decode_wav(wav()), b"\x00\x00" * 1600)
        for invalid in [
            wav(rate=48000),
            wav(channels=2),
            wav(samples=b""),
            wav()[:-4],
            b"invalid",
            wav(b"\0\0" * 128001),
        ]:
            with self.assertRaises((ValueError, wave.Error, EOFError)):
                decode_wav(invalid)

    def test_http_isolation_and_busy(self):
        entered, release = threading.Event(), threading.Event()
        seen = []

        def recognize(pcm):
            seen.append(pcm)
            entered.set()
            release.wait(5)
            return [{"word": str(pcm[0]), "start": 0, "end": 0.1}]

        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(recognize, "test-local"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(path, data=None, headers=None):
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}{path}", data=data, headers=headers or {}
            )
            try:
                response = urllib.request.urlopen(req, timeout=6)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                return response.status, json.load(response)

        try:
            self.assertEqual(request("/health")[1]["ready"], True)
            self.assertEqual(
                request(
                    "/transcribe",
                    wav(),
                    {"Content-Type": "audio/wav", "Origin": "https://other.test"},
                )[0],
                403,
            )
            self.assertEqual(request("/transcribe", b"bad", {"Content-Type": "audio/wav"})[0], 400)
            first = []
            job = threading.Thread(
                target=lambda: first.append(
                    request("/transcribe", wav(b"\1\0" * 1600), {"Content-Type": "audio/wav"})
                )
            )
            job.start()
            self.assertTrue(entered.wait(2))
            self.assertEqual(request("/transcribe", wav(), {"Content-Type": "audio/wav"})[0], 429)
            release.set()
            job.join()
            second = request("/transcribe", wav(b"\2\0" * 1600), {"Content-Type": "audio/wav"})
            self.assertEqual(
                [first[0][1]["words"][0]["word"], second[1]["words"][0]["word"]], ["1", "2"]
            )
            self.assertEqual(seen, [b"\1\0" * 1600, b"\2\0" * 1600])
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join()
