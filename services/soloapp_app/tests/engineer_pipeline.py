"""Exercise the real C++ async pipeline against disposable HTTP dependencies.

Build the service's Dockerfile --target build, then run with:
  python3 tests/engineer_pipeline.py --connection ml-test-r1 --image localhost/soloapp-chief-test
Use --live-search --live-model for the restored local services; Whisper/TTS stay
synthetic in this test so no human microphone or production credentials are used.
"""

import argparse
import base64
import io
import json
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("--connection", default="ml-test-r1")
parser.add_argument("--image", default="localhost/soloapp-chief-test")
parser.add_argument("--live-search", action="store_true")
parser.add_argument("--live-model", action="store_true")
parser.add_argument("--model", default="qwen2.5:3b")
parser.add_argument("--question", default="Для чего нужны стержни СУЗ?")
args = parser.parse_args()
state = {}
calls = []
output = io.BytesIO()
with wave.open(output, "wb") as stream:
    stream.setnchannels(1)
    stream.setsampwidth(2)
    stream.setframerate(22050)
    stream.writeframes(b"\0\0" * 2205)
wav = output.getvalue()
fallback = "Будьте серъёзнее или задавайте более осознанные вопросы"
source = {
    "document_id": "vver1200:test",
    "metadata": {"corpus": "vver1200-research", "source_url": "https://example.org/manual"},
    "title": "Источник",
    "source_text": "Стержни СУЗ поглощают нейтроны.",
    "page_from": 12,
    "score": 1.0,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header(
            "Content-Type", "audio/wav" if isinstance(body, bytes) else "application/json"
        )
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlsplit(self.path)
        calls.append(("search", parse_qs(parsed.query)))
        assert parsed.path == "/search"
        assert parse_qs(parsed.query)["mode"] == ["lexical"]
        self.respond(state.get("search_status", 200), state.get("rows", [source]))

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/transcribe":
            calls.append(("whisper", len(raw)))
            self.respond(200, {"words": [{"word": state.get("question", args.question)}]})
        elif self.path == "/api/chat":
            request = json.loads(raw)
            calls.append(("ollama", request))
            assert request["stream"] is False
            assert request["model"]
            evidence = json.loads(request["messages"][1]["content"])
            assert evidence["sources"][0]["text"] == source["source_text"]
            assert "source_url" not in evidence["sources"][0]
            self.respond(
                state.get("model_status", 200),
                {"message": {"content": "Стержни СУЗ поглощают нейтроны."}},
            )
        elif self.path == "/synthesize":
            calls.append(("tts", json.loads(raw)["text"]))
            self.respond(state.get("tts_status", 200), wav)
        else:
            self.respond(404, {})


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = "http://host.containers.internal:" + str(server.server_port)


def run(**scenario):
    state.clear()
    state.update(scenario)
    calls.clear()
    env = {
        "WHISPER_URL": base,
        "TTS_URL": base,
        "ENGINEER_SEARCH_URL": "http://host.containers.internal:8001" if args.live_search else base,
        "OLLAMA_URL": "http://host.containers.internal:11434" if args.live_model else base,
        "OLLAMA_MODEL": args.model,
    }
    command = ["podman", "--connection", args.connection, "run", "--rm", "-i"]
    for key, value in env.items():
        command += ["-e", key + "=" + value]
    command += ["--entrypoint", "/src/build/engineer_pipeline_probe", args.image, "/dev/stdin"]
    result = subprocess.run(
        command, input=wav, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode())
    data = result.stdout.decode()
    # Drogon may print log lines before/after the JSON response.
    start = data.find("{")
    response, _ = json.JSONDecoder().raw_decode(data[start:])
    return response


try:
    result = run()
    assert result["status"] == 200, result
    assert result["body"]["sources"], result
    if not args.live_search:
        assert result["body"]["sources"][0]["source_url"] == "https://example.org/manual"
    assert base64.b64decode(result["body"]["audio_base64"]) == wav
    if not args.live_search:
        assert next(v for name, v in calls if name == "search")["q"] == ["стержни суз"], calls
    if args.live_model:
        print(
            json.dumps(
                {"answer": result["body"]["answer"], "sources": len(result["body"]["sources"])},
                ensure_ascii=False,
            )
        )
    if not (args.live_search or args.live_model):
        for scenario in (
            {"rows": []},
            {"rows": [{**source, "metadata": {"corpus": "rbmk1000-vr-research"}}]},
        ):
            result = run(**scenario)
            assert result["status"] == 200 and result["body"]["answer"] == fallback, result
            assert not any(name == "ollama" for name, _ in calls), calls
            assert ("tts", fallback) in calls
        for scenario in ({"search_status": 503}, {"rows": {}}, {"model_status": 503}):
            result = run(**scenario)
            assert result["status"] == 503, result
            assert not any(name == "tts" for name, _ in calls), calls
        result = run(tts_status=503)
        assert result["status"] == 200 and result["body"]["audio_error"], result
        assert result["body"]["audio_base64"] == ""
        result = run(question="")
        assert result["status"] == 200 and result["body"]["answer"] == ""
        assert [name for name, _ in calls] == ["whisper"]
    print(
        "PASS: C++ HTTP pipeline, search contract, corpus filtering, fallback, dependency failures and backend WAV"
    )
finally:
    server.shutdown()
