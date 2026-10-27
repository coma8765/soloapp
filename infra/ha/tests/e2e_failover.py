"""Live project-scoped failure test; restores network automatically and in finally."""

import argparse
import datetime
import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import ROOT, base_url, run

ap = argparse.ArgumentParser()
ap.add_argument("--target-seconds", type=float, default=15)
ap.add_argument("--hosts", nargs="+", choices=["yc", "home"], default=["home", "yc"])
args = ap.parse_args()
base = base_url()
report = {
    "time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "checks": [],
    "faults": [],
}


def request(path, body=None, token=None, headers=None, timeout=12):
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode() if body is not None else None, headers=h
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            b = json.loads(e.read() or b"{}")
        except Exception:
            b = {}
        return e.code, b, dict(e.headers)
    except Exception:
        return 0, {}, {}


def expect(name, got, want):
    if got != want:
        raise RuntimeError(f"{name}: expected {want}, got {got}")
    report["checks"].append(name)
    print("PASS", name, flush=True)


name = "test_" + secrets.token_hex(8)
password = secrets.token_hex(20)
status, data, _ = request("/api/v1/auth/v1/register", {"username": name, "password": password})
expect("register", status, 201)
userid = data["user_id"]
status, data, _ = request("/api/v1/auth/v1/login", {"username": name, "password": password})
expect("login", status, 200)
token = data["access_token"]
expect("anonymous denied", request("/api/v1/whoami/v1/user-id")[0], 401)
expect(
    "spoofed user-id denied",
    request(
        "/api/v1/whoami/v1/user-id",
        headers={
            "X-Verified-User-Id": "f" * 32,
            "X-User-Signature": "a" * 64,
            "X-User-Timestamp": str(int(time.time())),
        },
    )[0],
    401,
)
expect(
    "wrong password denied",
    request("/api/v1/auth/v1/login", {"username": name, "password": "not-correct-password"})[0],
    401,
)
expect(
    "duplicate account denied",
    request("/api/v1/auth/v1/register", {"username": name, "password": password})[0],
    409,
)
expect(
    "invalid username rejected",
    request(
        "/api/v1/auth/v1/register", {"username": "abc'; DROP TABLE users;--", "password": password}
    )[0],
    400,
)
sites = set()
for i in range(12):
    st, body, headers = request("/api/v1/whoami/v1/user-id", token=token)
    expect("authenticated user-id " + str(i), body.get("user_id"), userid)
    sites.add(headers.get("x-solo-site", headers.get("X-Solo-Site")))
    time.sleep(0.15)
report["sites_seen"] = sorted(sites)
expect("both sites serve requests", sites, {"yc", "home"})
for host in args.hosts:
    restore = "iptables -D FORWARD -i wg-solo -j DROP 2>/dev/null || true; iptables -D FORWARD -o wg-solo -j DROP 2>/dev/null || true; iptables -D OUTPUT -o wg-solo -j DROP 2>/dev/null || true; iptables -D INPUT -i wg-solo -j DROP 2>/dev/null || true"
    restore_unit = "solo-fault-restore-" + str(int(time.time()))
    run(
        host,
        "systemd-run --unit="
        + restore_unit
        + " --on-active=180s /bin/sh -c "
        + __import__("shlex").quote(restore)
        + "\niptables -I INPUT 1 -i wg-solo -j DROP\niptables -I OUTPUT 1 -o wg-solo -j DROP\niptables -I FORWARD 1 -i wg-solo -j DROP\niptables -I FORWARD 1 -o wg-solo -j DROP\n",
    )
    start = time.monotonic()
    samples = []
    outcome = None
    try:
        while time.monotonic() - start < 155:
            trial = "fail_" + host + "_" + secrets.token_hex(6)
            st, body, headers = request(
                "/api/v1/auth/v1/register",
                {"username": trial, "password": secrets.token_hex(16)},
                timeout=4,
            )
            elapsed = round(time.monotonic() - start, 2)
            samples.append({"seconds": elapsed, "status": st})
            if st == 201:
                # Ensure the pre-failure session also survives, and the failed site is excluded.
                st2, b2, h2 = request("/api/v1/whoami/v1/user-id", token=token, timeout=4)
                site = h2.get("x-solo-site", h2.get("X-Solo-Site"))
                if st2 == 200 and b2.get("user_id") == userid and site != host:
                    outcome = {
                        "failed_site": host,
                        "write_recovered_seconds": elapsed,
                        "surviving_site": site,
                        "session_survived": True,
                        "samples": samples,
                    }
                    break
            time.sleep(0.25)
        if outcome is None:
            raise RuntimeError("Failover did not recover within 155 seconds: " + host)
        # Verify a new write after more than the partition detection window, while isolated.
        time.sleep(max(0, 25 - (time.monotonic() - start)))
        expect(
            "write with " + host + " isolated",
            request(
                "/api/v1/auth/v1/register",
                {"username": "solo_" + secrets.token_hex(8), "password": secrets.token_hex(16)},
            )[0],
            201,
        )
        report["faults"].append(outcome)
        (ROOT / "outputs/e2e-report.json").write_text(json.dumps(report, indent=2))
        print("FAILOVER", json.dumps(outcome), flush=True)
    finally:
        run(host, restore + "\nsystemctl stop " + restore_unit + ".timer\n")
    # Wait for the repaired cluster to be fully synchronously replicated before next fault.
    ready = False
    for n in range(50):
        text = run(
            "edge",
            "docker exec solo-monitor pg_autoctl show state --pgdata /var/lib/postgresql/data\n",
            capture=True,
        ).stdout
        if (
            "primary" in text
            and "secondary" in text
            and "catchingup" not in text
            and "wait_primary" not in text
            and "!" not in text
        ):
            ready = True
            break
        time.sleep(3)
    if not ready:
        raise RuntimeError("Cluster did not return to primary/secondary after " + host)
    print("RESTORED", host, flush=True)
    expect(
        "failover within target " + host,
        outcome["write_recovered_seconds"] <= args.target_seconds,
        True,
    )
expect("logout", request("/api/v1/auth/v1/logout", body={}, token=token)[0], 204)
expect("revoked session denied", request("/api/v1/whoami/v1/user-id", token=token)[0], 401)
(ROOT / "outputs/e2e-report.json").write_text(json.dumps(report, indent=2))
print("E2E COMPLETE", flush=True)
