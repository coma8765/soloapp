#!/usr/bin/env python3
"""Update the installed Mac contour from one pinned Git revision."""

import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "infra/local-macos"
CONTEXT = "colima-soloapp-local"
KUBE = ["kubectl", "--context", CONTEXT, "-n", "soloapp"]
SERVICES = {
    "auth": "auth",
    "whoami": "soloapp_app",
    "client-gateway": "client-gateway",
    "client-notify": "client-notify",
    "tts": "tts",
    "llama": "llama",
    "web": "web",
}


def run(*args, cwd=ROOT, capture=False, data=None, env=None):
    return subprocess.run(
        list(map(str, args)),
        cwd=cwd,
        check=True,
        text=True,
        input=data,
        stdout=subprocess.PIPE if capture else None,
        env=env,
    ).stdout


def validate_config(config):
    if config.get("profile") != "soloapp-local" or config.get("namespace") != "soloapp":
        raise ValueError("Only the installed soloapp-local / soloapp contour is supported")
    ip = ipaddress.ip_address(config["lan"]["ip"])
    if ip.version != 4 or not ip.is_private or ip.is_unspecified or ip.is_loopback:
        raise ValueError("Configure a private LAN IPv4 address")
    if config["lan"]["https_port"] != 443:
        raise ValueError("This updater requires LAN HTTPS on port 443")
    if not config.get("whisper", {}).get("metal_host"):
        raise ValueError("Mac Whisper must use the existing native Metal service")


def pin_manifest(documents, images):
    for doc in documents:
        if not doc or doc.get("kind") != "Deployment":
            continue
        name = doc["metadata"]["name"]
        if name == "whisper":
            if doc["spec"].get("replicas") != 0:
                raise ValueError("Refusing CPU Whisper deployment on Mac")
        elif name in images:
            containers = doc["spec"]["template"]["spec"]["containers"]
            if len(containers) != 1:
                raise ValueError(f"Review updated multi-container manifest: {name}")
            containers[0]["image"] = images[name]
            containers[0]["imagePullPolicy"] = "Never"
    return documents


def healthy(url, ca=None, revision=None):
    try:
        context = ssl.create_default_context(cafile=str(ca)) if ca else None
        with urllib.request.urlopen(url, context=context, timeout=5) as response:
            return response.status == 200 and (
                revision is None or response.headers.get("X-Web-Revision") == revision
            )
    except (OSError, ValueError):
        return False


def wait_for(predicate, label, seconds=90):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError(label)
        time.sleep(2)


@contextlib.contextmanager
def port_forward(service, remote_port):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryFile(mode="w+") as log:
        process = subprocess.Popen(
            KUBE
            + [
                "port-forward",
                f"service/{service}",
                f"{port}:{remote_port}",
                "--address",
                "127.0.0.1",
            ],
            stdout=log,
            stderr=log,
            text=True,
        )
        try:

            def ready():
                if process.poll() is not None:
                    raise RuntimeError(f"Port-forward to {service} failed")
                log.seek(0)
                return "Forwarding from" in log.read()

            wait_for(ready, f"Port-forward to {service}", 30)
            yield f"http://127.0.0.1:{port}"
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def native_whisper():
    if not healthy("http://127.0.0.1:8178/healthz"):
        print("Starting the installed Whisper Metal launch agent", flush=True)
        run("launchctl", "kickstart", "-k", f"gui/{os.getuid()}/stream.soloapp.whisper-metal")
    wait_for(lambda: healthy("http://127.0.0.1:8178/healthz"), "Whisper Metal readiness", 180)
    with urllib.request.urlopen("http://127.0.0.1:8178/healthz", timeout=5) as response:
        result = json.load(response)
    if result.get("device") != "metal" or not result.get("ready"):
        raise RuntimeError("Whisper is not ready on Metal")


def require_ready(deployments):
    found = {item["metadata"]["name"]: item for item in deployments}
    failed = []
    for name in SERVICES:
        item = found.get(name)
        if item is None:
            failed.append(name + " missing")
            continue
        desired = item["spec"].get("replicas", 1)
        status = item.get("status", {})
        if (
            desired < 1
            or status.get("readyReplicas", 0) < desired
            or status.get("updatedReplicas", 0) < desired
            or status.get("observedGeneration", 0) < item["metadata"].get("generation", 1)
        ):
            failed.append(f"{name} {status.get('readyReplicas', 0)}/{desired} ready")
    if failed:
        raise RuntimeError("Degraded local workloads: " + ", ".join(failed))


def checks(checkout, config, ca, revision=None):
    url = "https://" + config["lan"]["ip"]
    wait_for(lambda: healthy(url + "/", ca, revision), "LAN HTTPS / web revision")
    native_whisper()
    modules = checkout / "services/client-gateway/node_modules"
    if not modules.exists():
        run("npm", "ci", "--omit=dev", "--ignore-scripts", cwd=modules.parent)
    env = dict(os.environ, NODE_EXTRA_CA_CERTS=str(ca), SOLOAPP_BASE_URL=url)
    run("node", "services/soloapp_app/tests/smoke.mjs", cwd=checkout, env=env)
    with port_forward("tts", 8179) as tts:
        run(sys.executable, LOCAL / "check-speech.py", "--url", url, "--ca", ca, "--tts", tts)
    run(*KUBE, "get", "pods")
    require_ready(json.loads(run(*KUBE, "get", "deployments", "-o", "json", capture=True))["items"])
    print(f"READY: {url}/", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--revision", default="origin/main", help="Commit/ref to pin after fetching main"
    )
    parser.add_argument(
        "--plan", action="store_true", help="Fetch and print the revision; no builds/deployment"
    )
    parser.add_argument(
        "--check-only", action="store_true", help="Check the running contour, including speech"
    )
    parser.add_argument(
        "--lan-ip", help="New private LAN IPv4; reissues only the LAN leaf certificate"
    )
    args = parser.parse_args()
    config_path = LOCAL / "config.yaml"
    config = yaml.safe_load(config_path.read_text())
    previous_ip = config["lan"]["ip"]
    if args.lan_ip:
        config["lan"]["ip"] = args.lan_ip
    validate_config(config)
    ca = ROOT / "outputs/soloapp-local-ca.crt"
    if args.check_only:
        checks(ROOT, config, ca)
        return
    run("git", "fetch", "origin", "main")
    revision = run(
        "git",
        "rev-parse",
        "--verify",
        "--end-of-options",
        args.revision + "^{commit}",
        capture=True,
    ).strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise ValueError("Invalid resolved revision")
    print(f"Pinned revision: {revision}", flush=True)
    if args.plan:
        print(
            "Build ARM64 apps; test; publish local S3; apply local app manifests; smoke + speech checks."
        )
        return
    checkout = ROOT / "work/local-updates" / revision
    checkout.parent.mkdir(parents=True, exist_ok=True)
    if checkout.exists():
        actual = run("git", "rev-parse", "HEAD", cwd=checkout, capture=True).strip()
        dirty = run(
            "git", "status", "--porcelain", "--untracked-files=normal", cwd=checkout, capture=True
        )
        if actual != revision or dirty:
            raise RuntimeError(f"Release checkout has local changes: {checkout}")
    else:
        run("git", "worktree", "add", "--detach", checkout, revision)
    release_local = checkout / "infra/local-macos"
    config["web_release"] = revision
    (release_local / "config.yaml").write_text(yaml.safe_dump(config, sort_keys=False))
    run("colima", "start", "--profile", "soloapp-local", "--activate=false", cwd="/tmp")
    run(*KUBE, "wait", "--for=condition=Ready", "node/colima-soloapp-local", "--timeout=180s")
    run(*KUBE, "get", "namespace", "soloapp")
    nodes = json.loads(run(*KUBE, "get", "nodes", "-o", "json", capture=True))
    if [n["metadata"]["name"] for n in nodes["items"]] != ["colima-soloapp-local"]:
        raise RuntimeError("Unexpected cluster identity")
    native_whisper()
    for name in ("postgres", "rabbitmq", "seaweedfs"):
        run(*KUBE, "rollout", "status", f"statefulset/{name}", "--timeout=180s")
    images = {}
    build_env = dict(os.environ, DOCKER_CONTEXT=CONTEXT)
    for deployment, service in SERVICES.items():
        tag = "web-origin" if deployment == "web" else service
        image = f"soloapp-local/{tag}:git-{revision}"
        print(f"Building {deployment}: {image}", flush=True)
        run(
            "docker-buildx",
            "build",
            "--load",
            "--platform",
            "linux/arm64",
            "--target",
            "runtime",
            "--label",
            f"org.opencontainers.image.revision={revision}",
            "-t",
            image,
            "-f",
            f"services/{service}/deploy/Dockerfile",
            ".",
            cwd=checkout,
            env=build_env,
        )
        images[deployment] = image
    run(
        "docker-buildx",
        "build",
        "--load",
        "--target",
        "build",
        "-t",
        "soloapp-test",
        "-f",
        "services/soloapp_app/deploy/Dockerfile",
        ".",
        cwd=checkout,
        env=build_env,
    )
    run("bash", "services/soloapp_app/tests/integration.sh", cwd=checkout, env=build_env)
    # Run the same Node test entrypoints as the source checkout; not browser automation.
    tests = sorted((checkout / "services/soloapp_app/tests").glob("*.test.mjs"))
    run("node", "--test", *tests, cwd=checkout)
    archive = checkout / "web-release.tar.gz"
    run(sys.executable, "services/soloapp_app/deploy/package.py", revision, archive, cwd=checkout)
    with port_forward("seaweedfs", 8333) as endpoint:
        run(
            sys.executable,
            release_local / "publish-web.py",
            revision,
            archive,
            "--endpoint",
            endpoint,
            cwd=checkout,
        )
    # Additive, idempotent game schema, before new backend readers/writers start.
    run(
        *KUBE,
        "exec",
        "-i",
        "postgres-0",
        "--",
        "psql",
        "-U",
        "postgres",
        "-d",
        "chatdb",
        "-v",
        "ON_ERROR_STOP=1",
        data=(checkout / "services/soloapp_app/deploy/schema.sql").read_text(),
    )
    if config["lan"]["ip"] != previous_ip:
        run(
            sys.executable,
            "-c",
            "from credentials import CONFIG, apply_secret, bundle, issue; "
            "apply_secret('lan-tls', issue(bundle(), 'soloapp-local', "
            "ips=[CONFIG['lan']['ip'], '127.0.0.1'], dns=['localhost']))",
            cwd=release_local,
        )
    documents = list(
        yaml.safe_load_all(run(sys.executable, release_local / "apps.py", capture=True))
    )
    documents = pin_manifest(documents, images)
    web = [
        d
        for d in documents
        if d and d.get("kind") == "Deployment" and d["metadata"]["name"] == "web"
    ]
    before_web = [d for d in documents if d not in web]
    run(*KUBE, "apply", "-f", "-", data=yaml.safe_dump_all(before_web, sort_keys=False))
    for name in SERVICES:
        if name != "web":
            run(*KUBE, "rollout", "status", f"deployment/{name}", "--timeout=300s")
    run(*KUBE, "apply", "-f", "-", data=yaml.safe_dump_all(web, sort_keys=False))
    run(*KUBE, "rollout", "status", "deployment/web", "--timeout=180s")
    config_path.write_text(yaml.safe_dump(config, sort_keys=False))
    # ConfigMap subPath mounts require a restart to load the pinned nginx config.
    run(*KUBE, "rollout", "restart", "deployment/nginx")
    run(*KUBE, "rollout", "status", "deployment/nginx", "--timeout=180s")
    # Install a current Service tunnel, preserving the already installed TLS keys.
    run(sys.executable, release_local / "install-launchagent.py", cwd=checkout)
    wait_for(lambda: healthy("https://127.0.0.1/", ca), "Loopback HTTPS", 60)
    if not healthy("https://" + config["lan"]["ip"] + "/", ca):
        print(
            "Approve the macOS administrator dialog to reopen the existing LAN :443 listener.",
            flush=True,
        )
        run(sys.executable, release_local / "install-https-relay.py", cwd=checkout)
    checks(checkout, config, ca, revision)
    print(f"DEPLOYED {revision}; checkout: {checkout}", flush=True)


if __name__ == "__main__":
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / ".update.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another local update/check is running") from None
        try:
            main()
        except (subprocess.CalledProcessError, OSError, ValueError, RuntimeError) as error:
            # Never include command input or captured stdout: these may contain credentials.
            print(f"Local update stopped: {type(error).__name__}: {error}", file=sys.stderr)
            raise SystemExit(1) from None
