"""Private offline text-to-speech; text and audio never leave request memory."""

import io
import json
import os
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def validate(body, max_chars):
    data = json.loads(body)
    if not isinstance(data, dict) or set(data) != {"text"}:
        raise ValueError("Expected text")
    text = data["text"]
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= max_chars:
        raise ValueError("Invalid text length")
    if any(ord(c) < 32 and c not in "\n\t" for c in text):
        raise ValueError("Invalid text")
    return text.strip()


def make_handler(synthesize, voice, max_chars=1000):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data, content_type="application/json"):
            body = data if isinstance(data, bytes) else json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if status == 429:
                self.send_header("Retry-After", "1")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path not in ("/healthz", "/health"):
                self.reply(404, {"error": "not_found"})
                return
            self.reply(200, {"ready": True, "voice": voice, "offline": True})

        def do_POST(self):
            if self.path != "/synthesize":
                self.reply(404, {"error": "not_found"})
                return
            if self.headers.get("Origin"):
                self.reply(403, {"error": "private_api"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if self.headers.get("Transfer-Encoding") or not 1 <= size <= 8192:
                    raise ValueError("Invalid body")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Expected JSON")
                self.connection.settimeout(5)
                text = validate(self.rfile.read(size), max_chars)
            except (ValueError, OSError, UnicodeError):
                self.reply(400, {"error": "invalid_text"})
                return
            if not lock.acquire(blocking=False):
                self.reply(429, {"error": "tts_busy"})
                return
            try:
                self.reply(200, synthesize(text), "audio/wav")
            except Exception:
                self.reply(503, {"error": "synthesis_failed"})
            finally:
                lock.release()

    return Handler


def main():
    from piper import PiperVoice

    path = os.environ.get("TTS_MODEL", "/model/ru_RU-denis-medium.onnx")
    voice = PiperVoice.load(path)
    # Bound CPU use independently of the host core count.
    import onnxruntime

    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = int(os.environ.get("TTS_THREADS", "2"))
    options.inter_op_num_threads = 1
    voice.session = onnxruntime.InferenceSession(
        path, sess_options=options, providers=["CPUExecutionProvider"]
    )

    def synthesize(text):
        output = io.BytesIO()
        with wave.open(output, "wb") as audio:
            voice.synthesize_wav(text, audio)
        return output.getvalue()

    synthesize("Готово.")  # Probes succeed only after model load and warmup.
    server = ThreadingHTTPServer(
        ("0.0.0.0", 8179),
        make_handler(
            synthesize, "ru_RU-denis-medium", int(os.environ.get("TTS_MAX_CHARS", "1000"))
        ),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
