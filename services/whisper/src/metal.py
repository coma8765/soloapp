"""Native macOS Metal worker with the same private HTTP contract as CUDA/CPU."""

import argparse
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import make_handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8178)
    args = parser.parse_args()
    import mlx.core as mx
    import mlx_whisper
    import numpy as np

    if not mx.metal.is_available():
        raise RuntimeError("Metal GPU is required; CPU fallback is disabled")
    if not (args.model / "weights.safetensors").is_file():
        raise RuntimeError("Download the pinned MLX model before starting the worker")
    mx.set_default_device(mx.gpu)

    def transcribe(audio):
        mx.set_default_device(mx.gpu)
        return mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=str(args.model),
            language="ru",
            word_timestamps=True,
            condition_on_previous_text=False,
            temperature=0,
            verbose=None,
        )

    def recognize(pcm):
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        if np.sqrt(np.mean(audio * audio)) < 0.002:
            return []
        result = transcribe(audio)
        return [
            {"word": word["word"], "start": word["start"], "end": word["end"]}
            for segment in result["segments"]
            if segment.get("no_speech_prob", 0) < 0.8
            for word in segment.get("words", [])
        ]

    transcribe(np.zeros(16000, dtype=np.float32))
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port),
        make_handler(recognize, "openai/whisper-large-v3-turbo", "metal"),
    )
    print("Whisper Metal ready on loopback; audio is never saved", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
