"""Isolated local/CI PostgreSQL + RabbitMQ integration tests, never production."""

import argparse
import subprocess
import time
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="docker")
    parser.add_argument("--image", default="soloapp/client-notify-tests:dev")
    args = parser.parse_args()
    name = "solo-notify-test-" + uuid.uuid4().hex[:10]
    root = Path(__file__).resolve().parent

    def run(*command, check=True):
        return subprocess.run([args.engine, *command], check=check)

    run("network", "create", name)
    try:
        run(
            "run",
            "-d",
            "--name",
            name,
            "--network",
            name,
            "--network-alias",
            "rabbit",
            "--memory",
            "768m",
            "-v",
            f"{root}/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf:ro",
            "-v",
            f"{root}/rabbitmq-definitions.json:/etc/rabbitmq/test-definitions.json:ro",
            "rabbitmq:4.4.0@sha256:d9e71c639c9476bbfc78ac7b2948d9b93af2c63ee9b3226ccadd5af2d7113b78",
        )
        for _ in range(60):
            result = subprocess.run(
                [
                    args.engine,
                    "exec",
                    "--user",
                    "rabbitmq",
                    name,
                    "rabbitmq-diagnostics",
                    "-q",
                    "check_running",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError("Test RabbitMQ did not start")
        run("run", "--rm", "--network", name, "-e", "RABBIT_HOST=rabbit", args.image)
    except Exception:
        run("logs", "--tail", "150", name, check=False)
        run("inspect", "--format", "{{json .State}}", name, check=False)
        raise
    finally:
        run("rm", "-f", name, check=False)
        run("network", "rm", name, check=False)


if __name__ == "__main__":
    main()
