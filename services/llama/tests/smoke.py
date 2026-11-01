"""Validate a real model in a network-disabled container."""

import json
import os
import subprocess
import time

image = os.environ.get("LLAMA_IMAGE", "soloapp-llama-test")
container = subprocess.check_output(
    ["docker", "run", "-d", "--network", "none", "--read-only", "--cap-drop=ALL", image], text=True
).strip()
try:
    for _ in range(120):
        result = subprocess.run(
            ["docker", "exec", container, "curl", "-sf", "http://127.0.0.1:8180/health"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("Llama did not become healthy")
    request = json.dumps(
        {
            "model": "llama-3.2-1b-instruct",
            "messages": [
                {"role": "user", "content": "Ответь одним словом: сколько будет два плюс два?"}
            ],
            "max_tokens": 32,
            "temperature": 0,
            "stream": False,
        }
    )
    output = subprocess.check_output(
        [
            "docker",
            "exec",
            container,
            "curl",
            "-sf",
            "--max-time",
            "45",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            request,
            "http://127.0.0.1:8180/v1/chat/completions",
        ],
        text=True,
    )
    answer = json.loads(output)["choices"][0]["message"]["content"]
    assert answer.strip()
    print("Offline Llama completion:", answer)
finally:
    subprocess.run(["docker", "rm", "-f", container], check=True)
