#!/usr/bin/env python3
"""Fetch only the identity's allowed Lockbox payload into a tmpfs directory."""

import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request


def request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def iam():
    if os.environ.get("TOKEN_FILE"):
        token = pathlib.Path(os.environ["TOKEN_FILE"]).read_text().strip()
        body = urllib.parse.urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "audience": os.environ["SERVICE_ACCOUNT_ID"],
                "subject_token": token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
            }
        ).encode()
        return request(
            "https://auth.yandex.cloud/oauth/token",
            body,
            {"Content-Type": "application/x-www-form-urlencoded"},
        )["access_token"]
    if os.environ.get("KUBE_TOKEN"):
        token = subprocess.check_output(
            [
                "k3s",
                "kubectl",
                "-n",
                "soloapp",
                "create",
                "token",
                os.environ.get("KUBE_SERVICE_ACCOUNT", "node-secrets"),
                "--audience=soloapp-lockbox",
                "--duration=10m",
            ],
            text=True,
        ).strip()
        body = urllib.parse.urlencode(
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "audience": os.environ["SERVICE_ACCOUNT_ID"],
                "subject_token": token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
            }
        ).encode()
        return request(
            "https://auth.yandex.cloud/oauth/token",
            body,
            {"Content-Type": "application/x-www-form-urlencoded"},
        )["access_token"]
    return request(
        "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"},
    )["access_token"]


def atomic(path, value, uid=None):
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists() and p.read_text() == value:
        return False
    t = p.with_name(p.name + ".tmp")
    fd = os.open(t, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value)
    if uid is not None:
        os.chown(t, uid, uid)
    os.replace(t, p)
    return True


def fetch():
    token = iam()
    changed = False
    uid = int(os.environ["FILE_UID"]) if "FILE_UID" in os.environ else None
    out = pathlib.Path(os.environ.get("SECRET_DIR", "/run/soloapp-secrets"))
    out.mkdir(parents=True, exist_ok=True)
    if uid is not None:
        os.chown(out, uid, uid)
    os.chmod(out, 0o700)
    for secret in os.environ["SECRET_IDS"].split(","):
        data = request(
            "https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/"
            + secret
            + "/payload",
            headers={"Authorization": "Bearer " + token},
        )
        for ent in data["entries"]:
            name = ent["key"]
            assert "/" not in name and name not in (".", "..")
            if name == "wg.key" and os.environ.get("PROFILE") == "node":
                d = pathlib.Path("/run/soloapp-wireguard")
                d.mkdir(mode=0o700, exist_ok=True)
                atomic(d / name, ent["textValue"], 0)
            else:
                changed = atomic(out / name, ent["textValue"], uid) or changed
    if (out / "tls.crt").exists():
        changed = (
            atomic(
                out / "client.pem",
                (out / "tls.crt").read_text() + (out / "tls.key").read_text(),
                uid,
            )
            or changed
        )
    if (out / "fullchain.pem").exists():
        changed = (
            atomic(
                out / "https.pem",
                (out / "fullchain.pem").read_text() + (out / "privkey.pem").read_text(),
                uid,
            )
            or changed
        )
    if os.environ.get("DB_USER"):
        dsn = (
            "host=10.77.26.11,10.77.26.12 port=55432,55432 dbname=authdb user="
            + os.environ["DB_USER"]
            + " target_session_attrs=read-write connect_timeout=2 options='-c statement_timeout=7000 -c lock_timeout=3000' sslmode=verify-full sslrootcert="
            + str(out / "ca.crt")
            + " sslcert="
            + str(out / "tls.crt")
            + " sslkey="
            + str(out / "tls.key")
        )
        atomic(out / "database-url", dsn, uid)
    if changed and os.environ.get("RELOAD_POSTGRES"):
        subprocess.run(
            [
                "docker",
                "exec",
                os.environ["RELOAD_POSTGRES"],
                "/usr/lib/postgresql/17/bin/pg_ctl",
                "-D",
                "/var/lib/postgresql/data",
                "reload",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if changed and os.environ.get("RELOAD_HAPROXY"):
        subprocess.run(
            ["docker", "kill", "--signal=USR2", "solo-ingress"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if changed and os.environ.get("RELOAD_NGINX") and pathlib.Path("/tmp/nginx.pid").exists():
        os.kill(int(pathlib.Path("/tmp/nginx.pid").read_text()), signal.SIGHUP)
    if changed and os.environ.get("RELOAD_S3"):
        subprocess.run(
            ["docker", "kill", "--signal=HUP", "solo-s3"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if os.environ.get("REGISTRY_BUNDLES"):
        dest = pathlib.Path("/run/soloapp-registry-publisher")
        dest.mkdir(exist_ok=True)
        os.chown(dest, 10006, 10006)
        os.chmod(dest, 0o700)
        for name in ["ca.crt", "push.crt", "push.key"]:
            atomic(dest / name, (out / name).read_text(), 10006)
        for mode, ca in [("read", "pull"), ("write", "push")]:
            dest = pathlib.Path("/run/soloapp-registry-" + mode)
            dest.mkdir(exist_ok=True)
            os.chown(dest, 10006, 10006)
            os.chmod(dest, 0o700)
            for name in [mode + ".json", "server.crt", "server.key", ca + "-ca.crt"]:
                atomic(dest / name, (out / name).read_text(), 10006)
            if changed and not pathlib.Path("/run/soloapp-registry-migrating").exists():
                subprocess.run(
                    ["docker", "restart", "solo-registry-" + mode],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
    print("Secret delivery succeeded", flush=True)


if __name__ == "__main__":
    while True:
        try:
            fetch()
        except Exception as e:
            print("Secret delivery unavailable: " + type(e).__name__, file=sys.stderr, flush=True)
            if not os.environ.get("LOOP"):
                sys.exit(1)
        if not os.environ.get("LOOP"):
            break
        time.sleep(300)
