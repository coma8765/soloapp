import importlib.util
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("tts", Path(__file__).parents[1] / "src/server.py")
tts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tts)


class TtsTests(unittest.TestCase):
    def test_validation(self):
        for data in [
            [],
            {},
            {"text": 1},
            {"text": " "},
            {"text": "a" * 1001},
            {"text": "hi", "voice": "../../etc"},
        ]:
            with self.assertRaises(ValueError):
                tts.validate(json.dumps(data).encode(), 1000)
        self.assertEqual(tts.validate(b'{"text":"hello"}', 1000), "hello")

    def test_busy_health_and_recovery(self):
        started, finish = threading.Event(), threading.Event()

        def synthesize(text):
            started.set()
            finish.wait(5)
            return b"RIFF" + text.encode()

        server = ThreadingHTTPServer(("127.0.0.1", 0), tts.make_handler(synthesize, "test"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"

        def post(origin=None):
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            return urllib.request.urlopen(
                urllib.request.Request(
                    url + "/synthesize", data=b'{"text":"hello"}', headers=headers
                ),
                timeout=10,
            )

        received = []

        def first():
            with post() as response:
                received.append((response.headers["Content-Type"], response.read()))

        worker = threading.Thread(target=first)
        try:
            worker.start()
            self.assertTrue(started.wait(3))
            with self.assertRaises(urllib.error.HTTPError) as caught:
                post()
            self.assertEqual(caught.exception.code, 429)
            caught.exception.close()
            with urllib.request.urlopen(url + "/healthz") as response:
                self.assertEqual(response.status, 200)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                post("https://untrusted.invalid")
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
            finish.set()
            worker.join(5)
            self.assertEqual(received, [("audio/wav", b"RIFFhello")])
            with post() as response:
                self.assertEqual(response.status, 200)
        finally:
            finish.set()
            worker.join(5)
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
