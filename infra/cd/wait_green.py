#!/usr/bin/env python3
"""Wait for the requested main revision's CI without bypassing the release gate."""

import json
import os
import subprocess
import time

from deploy import ci_passed, validate_revision


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def wait_green(
    repository, revision, *, fetch=api, sleep=time.sleep, clock=time.monotonic, timeout=2400
):
    validate_revision(revision)
    deadline = clock() + timeout
    while True:
        if fetch(f"repos/{repository}/git/ref/heads/main")["object"]["sha"] != revision:
            raise RuntimeError("main advanced: start a new deployment on the current main revision")
        data = fetch(
            f"repos/{repository}/actions/workflows/ci.yaml/runs?event=push&branch=main&head_sha={revision}"
        )
        if ci_passed(data, revision, repository):
            print("Required main push CI succeeded", flush=True)
            return
        runs = [r for r in data.get("workflow_runs", []) if r.get("head_sha") == revision]
        if runs and all(r.get("status") == "completed" for r in runs):
            raise RuntimeError(
                "main push CI failed or was cancelled: inspect Validate source before retrying"
            )
        if clock() >= deadline:
            raise RuntimeError(
                "Timed out waiting 40 minutes for main push CI; deployment was not started"
            )
        print(
            "Waiting for Validate source on the requested main revision (retry in 15s)", flush=True
        )
        sleep(15)


def main():
    try:
        revision = os.environ["REQUESTED"]
        wait_green(os.environ["REPOSITORY"], revision)
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("sha=" + revision + "\n")
    except (RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
