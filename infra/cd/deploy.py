#!/usr/bin/python3
"""Root-owned CD gate. Only a green, current main commit can be deployed.

This program is installed by an operator, not self-updated by a release.
No arbitrary command, repository URL, inventory or manifest comes over SSH.
"""

import fcntl
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

CONFIG = Path("/etc/soloapp-cd/config.json")
STATE = Path("/var/lib/soloapp-cd")
SCOPES = ("auth", "app-api", "nginx", "web", "client-notify", "client-gateway", "all")
IMAGE_SERVICES = {
    "auth": ("auth",),
    "app-api": ("whoami",),
    "nginx": (),
    "web": ("web",),
    "client-notify": ("client-notify",),
    "client-gateway": ("client-gateway",),
    "all": ("auth", "whoami", "web", "client-notify", "client-gateway"),
}
WORKLOADS = {
    "auth": "auth",
    "app-api": "whoami",
    "nginx": "nginx",
    "web": "web",
    "client-notify": "client-notify",
    "client-gateway": "client-gateway",
}


def deployment_operation(mode):
    if mode in ("deploy", "rollback"):
        return mode, "all"  # Backward-compatible full-release commands.
    for action in ("deploy", "rollback"):
        prefix = action + "-"
        if mode.startswith(prefix) and mode[len(prefix) :] in SCOPES:
            return action, mode[len(prefix) :]
    if mode in (
        "publish",
        "push-auth",
        "push-whoami",
        "push-web",
        "push-client-notify",
        "push-client-gateway",
    ):
        return mode, None
    raise ValueError("Invalid CD operation")


def recorded_images(record, scope):
    """Read scoped history, or adapt an older successful full release."""
    if record.get("scope", "all") not in (scope, "all"):
        raise ValueError("History belongs to another service")
    if "image_map" in record:
        return [record["image_map"][name] for name in IMAGE_SERVICES[scope]]
    old = dict(zip(("auth", "whoami", "web"), record["images"]))
    return [old[name] for name in IMAGE_SERVICES[scope]]


def service_state(previous):
    if "services" in previous:
        return dict(previous["services"])
    # Import the existing three-image full-release format once.
    revision = previous["revision"]
    images = dict(zip(("auth", "whoami", "web"), previous["images"]))
    return {
        name: {"revision": revision, **({"image": images[workload]} if workload in images else {})}
        for name, workload in WORKLOADS.items()
        if workload in images or workload == "nginx"
    }


def update_service_state(previous, revision, scope, images):
    state = service_state(previous) if previous else {}
    image_map = dict(zip(IMAGE_SERVICES[scope], images))
    for name in WORKLOADS if scope == "all" else (scope,):
        workload = WORKLOADS[name]
        state[name] = {
            "revision": revision,
            **({"image": image_map[workload]} if workload in image_map else {}),
        }
    revisions = {value["revision"] for value in state.values()}
    return {"revision": next(iter(revisions)) if len(revisions) == 1 else None, "services": state}


def validate_revision(revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Expected a full lowercase commit SHA")
    return revision


def ci_passed(data, revision, repository):
    return any(
        r.get("head_sha") == revision
        and r.get("head_branch") == "main"
        and r.get("event") == "push"
        and r.get("conclusion") == "success"
        and r.get("head_repository", {}).get("full_name") == repository
        for r in data.get("workflow_runs", [])
    )


def run(argv, *, cwd=None, capture=False, env=None):
    if argv[0] == "git":
        argv = [
            "docker",
            "run",
            "--rm",
            "--user",
            "0:0",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "-v",
            str(STATE) + ":" + str(STATE),
            "-w",
            str(cwd or STATE),
            "--entrypoint",
            "git",
            "soloapp/deploy-controller:1",
        ] + argv[1:]
        cwd = None
    return subprocess.run(
        argv, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE if capture else None, env=env
    ).stdout


def registry_images(sha, require_both=True, services=("auth", "whoami", "web")):
    directory = Path("/run/soloapp-registry")
    ctx = ssl.create_default_context(cafile=str(directory / "ca.crt"))
    ctx.load_cert_chain(str(directory / "pull.crt"), str(directory / "pull.key"))
    copies = []
    for host in ("10.77.26.11", "10.77.26.12"):
        images = []
        try:
            for service in services:
                url = "https://" + host + ":5043/v2/soloapp/" + service + "/manifests/git-" + sha
                req = urllib.request.Request(
                    url,
                    headers={
                        "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
                    },
                )
                with urllib.request.urlopen(req, context=ctx, timeout=15) as response:
                    content = response.read(4 * 1024 * 1024)
                digest = "sha256:" + hashlib.sha256(content).hexdigest()
                images.append("registry.soloapp.internal:5043/soloapp/" + service + "@" + digest)
            copies.append(images)
        except Exception:
            if require_both:
                raise RuntimeError(
                    "Both registry copies must be reachable before a new release"
                ) from None
    if not copies:
        raise RuntimeError("No registry copy is reachable")
    if any(copy != copies[0] for copy in copies):
        raise RuntimeError("Registry replicas disagree")
    return copies[0]


def main():
    os.umask(0o077)
    if len(sys.argv) not in (2, 3):
        raise SystemExit("Expected probe or commit SHA")
    cfg = json.loads(CONFIG.read_text())
    if sys.argv[1] == "probe":
        print(json.dumps({"site": cfg["site"], "ready": True}))
        return
    sha = validate_revision(sys.argv[1])
    mode = sys.argv[2] if len(sys.argv) == 3 else "deploy"
    action, scope = deployment_operation(mode)
    is_rollback = action == "rollback"
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "deploy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        history = (
            STATE / "history" / (sha + ".json")
            if scope == "all"
            else STATE / "history" / "services" / str(scope) / (sha + ".json")
        )
        rollback_history = history
        if is_rollback and not rollback_history.is_file():
            rollback_history = STATE / "history" / (sha + ".json")
        if is_rollback and not rollback_history.is_file():
            raise SystemExit("Rollback requires a previously deployed release on this site")
        api = (
            "https://api.github.com/repos/"
            + cfg["repository"]
            + "/actions/workflows/ci.yaml/runs?event=push&branch=main&head_sha="
            + sha
        )
        req = urllib.request.Request(
            api, headers={"User-Agent": "soloapp-cd", "Accept": "application/vnd.github+json"}
        )
        if not is_rollback:
            with urllib.request.urlopen(req, timeout=30) as response:
                if not ci_passed(json.load(response), sha, cfg["repository"]):
                    raise SystemExit("Deployment denied: successful push CI on main is required")
        repo = STATE / "repository"
        if not repo.exists():
            run(
                [
                    "git",
                    "clone",
                    "--no-checkout",
                    "https://github.com/" + cfg["repository"] + ".git",
                    str(repo),
                ]
            )
        run(
            ["git", "fetch", "--prune", "origin", "+refs/heads/main:refs/remotes/origin/main"],
            cwd=repo,
        )
        if (
            not is_rollback
            and run(["git", "rev-parse", "origin/main"], cwd=repo, capture=True).strip() != sha
        ):
            raise SystemExit("Deployment denied: this is not the current main commit")
        source = STATE / ("release-" + sha)
        if not source.exists():
            run(["git", "worktree", "add", "--detach", str(source), sha], cwd=repo)
        # Files mounted into the unprivileged controller must be traversable.
        os.chmod(STATE, 0o755)
        run(["chmod", "-R", "a+rX", str(source)])
        storage = [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network",
            "host",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "10004:10004",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev",
            "--entrypoint",
            "python3",
            "-e",
            "PYTHONDONTWRITEBYTECODE=1",
            "-v",
            str(source) + ":/src:ro",
            "-v",
            "/run/soloapp-s3publisher:/run/s3:ro",
            "soloapp/deploy-controller:1",
            "/src/infra/object-storage/publish.py",
            sha,
        ]
        if mode == "publish":
            run(storage)
            return
        if mode.startswith("push-"):
            service = mode.removeprefix("push-")
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "-i",
                    "--network",
                    "host",
                    "--read-only",
                    "--cap-drop=ALL",
                    "--security-opt",
                    "no-new-privileges",
                    "--user",
                    "10006:10006",
                    "--tmpfs",
                    "/tmp:rw,nosuid,nodev,size=2200m,mode=1777",
                    "-v",
                    str(source) + ":/src:ro",
                    "-v",
                    "/run/soloapp-registry-publisher:/run/soloapp-registry:ro",
                    "--entrypoint",
                    "python3",
                    "soloapp/deploy-controller:1",
                    "/src/infra/registry/push.py",
                    sha,
                    service,
                ]
            )
            return
        if not is_rollback and scope in ("web", "all"):
            # Only a web activation depends on the static asset release.
            run(storage + ["--check"])
        services = IMAGE_SERVICES[scope]
        images = (
            registry_images(sha, require_both=not is_rollback, services=services)
            if services
            else []
        )
        if is_rollback and images != recorded_images(
            json.loads(rollback_history.read_text()), scope
        ):
            raise SystemExit(
                "Rollback image digests differ from the recorded successful deployment"
            )
        # Pull exact digests before mutating pods, including old manifests with Never policy.
        for image in images:
            run(["k3s", "crictl", "pull", image])
        # A short-lived, namespace-scoped token, held only in /run (tmpfs).
        with tempfile.TemporaryDirectory(prefix="soloapp-cd-", dir="/run") as temp:
            runtime = Path(temp)
            os.chown(runtime, 10004, 10004)
            kube = json.loads(
                run(["k3s", "kubectl", "config", "view", "--raw", "-o", "json"], capture=True)
            )
            token = run(
                [
                    "k3s",
                    "kubectl",
                    "-n",
                    "soloapp",
                    "create",
                    "token",
                    "cd-deployer",
                    "--duration=20m",
                ],
                capture=True,
            ).strip()
            kube["users"] = [{"name": "cd", "user": {"token": token}}]
            for context in kube["contexts"]:
                context["context"]["user"] = "cd"
            extra = {
                "project_root": "/src",
                "remote_root": "/manifests",
                "ansible_connection": "local",
                "ansible_python_interpreter": "/usr/local/bin/python3",
                "ansible_become": False,
                "cloud": json.loads(Path("/etc/soloapp-cd/resources.json").read_text()),
            }
            extra.update(
                {
                    service.replace("-", "_") + "_image": image
                    for service, image in zip(services, images)
                }
            )
            if scope in ("web", "all"):
                extra["web_release"] = sha
            for name, value in [("kubeconfig.json", kube), ("extra.json", extra)]:
                path = runtime / name
                path.write_text(json.dumps(value))
                os.chown(path, 10004, 10004)
            shutil.copyfile("/etc/soloapp-cd/inventory.yaml", runtime / "inventory.yaml")
            os.chown(runtime / "inventory.yaml", 10004, 10004)
            manifests = runtime / "manifests"
            manifests.mkdir()
            os.chown(manifests, 10004, 10004)
            cmd = [
                "docker",
                "run",
                "--rm",
                "--network",
                "host",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt",
                "no-new-privileges",
                "--user",
                "10004:10004",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev",
                "-e",
                "KUBECONFIG=/run/cd/kubeconfig.json",
                "-e",
                "HOME=/tmp",
                "-v",
                str(source) + ":/src:ro",
                "-v",
                str(runtime) + ":/run/cd:ro",
                "-v",
                str(manifests) + ":/manifests",
                "-w",
                "/src",
                "soloapp/deploy-controller:1",
                "-i",
                "/run/cd/inventory.yaml",
                "infra/ansible/apps.yaml",
                "--limit",
                cfg["site"],
                "-e",
                "@/run/cd/extra.json",
            ]
            if scope != "all":
                cmd += ["--tags", WORKLOADS[scope]]
            # Validate before any mutation, then use existing rolling rollout gates.
            run(cmd + ["--check"])
            run(cmd)
        result = {
            "site": cfg["site"],
            "revision": sha,
            "scope": scope,
            "images": images,
            "image_map": dict(zip(services, images)),
            "status": "deployed",
        }
        history.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        history.write_text(json.dumps(result) + "\n")
        current = STATE / "deployed.json"
        previous = json.loads(current.read_text()) if current.exists() else None
        state = update_service_state(previous, sha, scope, images)
        state.update({"site": cfg["site"], "status": "deployed", "last_operation": result})
        temporary = current.with_suffix(".tmp")
        temporary.write_text(json.dumps(state) + "\n")
        temporary.replace(current)
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
