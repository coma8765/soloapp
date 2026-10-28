#!/usr/bin/env python3
"""Operator integration check, with optional reversible UI-only failover drill."""

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "operations"))
from remote import base_url, run  # noqa: E402


def request(path, token=None):
    headers = {"User-Agent": "soloapp-headlamp-check/1"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base_url() + "/k8s" + path, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status, response.headers.get("X-Solo-Site"), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers.get("X-Solo-Site"), b""


def check_api(tokens):
    for site, token in tokens.items():
        path = f"/clusters/{site}/api/v1/namespaces/soloapp/pods"
        assert request(path)[0] == 401, "Anonymous Kubernetes access was not rejected"
        status, serving_site, body = request(path, token)
        assert status == 200 and json.loads(body)["kind"] == "PodList"
        for resource, kind in [
            ("/api/v1/pods", "PodList"),
            ("/api/v1/nodes", "NodeList"),
            ("/api/v1/events", "EventList"),
            ("/apis/apps/v1/deployments", "DeploymentList"),
        ]:
            code, _, data = request(f"/clusters/{site}{resource}", token)
            assert code == 200 and json.loads(data)["kind"] == kind, resource
        assert request(f"/clusters/{site}/api/v1/namespaces/soloapp/secrets", token)[0] == 403
        print(
            f"{site}: authenticated PodList via {serving_site}; anonymous 401; Secrets 403",
            flush=True,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--failover", action="store_true")
    args = parser.parse_args()
    tokens = {
        site: run(
            site,
            "k3s kubectl -n observability create token headlamp-operator --duration=10m",
            capture=True,
        ).stdout.strip()
        for site in ["yc", "home"]
    }
    check_api(tokens)
    if not args.failover:
        return
    for site, remaining in [("yc", "home"), ("home", "yc")]:
        before = json.loads(
            run(
                site, "k3s kubectl -n observability get deployment headlamp -o json", capture=True
            ).stdout
        )
        replicas = before["spec"]["replicas"]
        other = json.loads(
            run(
                remaining,
                "k3s kubectl -n observability get deployment headlamp -o json",
                capture=True,
            ).stdout
        )
        assert other["status"].get("availableReplicas", 0) >= 2
        try:
            run(
                site,
                "k3s kubectl -n observability scale deployment/headlamp --replicas=0",
                capture=True,
            )
            started = time.monotonic()
            run(
                site,
                "k3s kubectl -n observability wait --for=delete pod -l app=headlamp --timeout=60s",
                capture=True,
            )
            deadline = time.monotonic() + 30
            consecutive = 0
            while time.monotonic() < deadline:
                try:
                    status, serving_site, body = request("/")
                    good = status == 200 and serving_site == remaining and b"<html" in body.lower()
                except (OSError, TimeoutError):
                    good = False
                consecutive = consecutive + 1 if good else 0
                if consecutive >= 5:
                    break
                time.sleep(1)
            assert consecutive >= 5, f"UI did not stabilize on {remaining}"
            print(
                f"{site} UI stopped: five successful requests via {remaining}; {time.monotonic() - started:.1f}s including pod termination",
                flush=True,
            )
            check_api(tokens)
        finally:
            run(
                site,
                f"k3s kubectl -n observability scale deployment/headlamp --replicas={replicas}",
                capture=True,
            )
            run(
                site,
                "k3s kubectl -n observability rollout status deployment/headlamp --timeout=300s",
                capture=True,
            )
            print(f"{site}: restored {replicas} replicas", flush=True)


if __name__ == "__main__":
    main()
