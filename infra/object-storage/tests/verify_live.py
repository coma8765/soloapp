"""Operator-only S3 migration smoke test, including one-site storage outages."""

import concurrent.futures
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "operations"))
from remote import host_config, run  # noqa: E402

READ = """import os, hashlib
from storage.client import clients
bucket,stores=clients('/run/soloapp-secrets/data/reader.json')
for store in stores:
    response=store.get_object(Bucket=bucket,Key='releases/'+os.environ['WEB_RELEASE']+'/committed.json')
    with response['Body'] as body: data=body.read()
    print(store.meta.endpoint_url, hashlib.sha256(data).hexdigest())
"""
FALLBACK = """import os,runpy,hashlib
module=runpy.run_path('/app/gateway.py',run_name='verification')
data=module['object_bytes']('releases/'+os.environ['WEB_RELEASE']+'/committed.json')
print('uncached fallback read',hashlib.sha256(data).hexdigest())
"""


def web(site, code):
    result = run(
        site,
        "k3s kubectl -n soloapp exec deployment/web -c web -- python3 -c " + shlex.quote(code),
        capture=True,
    )
    print(site, result.stdout, flush=True)


def main():
    with concurrent.futures.ThreadPoolExecutor() as pool:
        list(pool.map(lambda site: web(site, READ), ("home", "yc")))
    for site in ("home", "yc"):
        pod_ip = run(
            site,
            "k3s kubectl -n soloapp get pod seaweedfs-0 -o jsonpath='{.status.podIP}'",
            capture=True,
        ).stdout
        deny = f"""import socket
try:
    connection=socket.create_connection(({pod_ip!r},8333),timeout=3)
except (TimeoutError,OSError):
    print('S3 access denied to auth pod as expected')
else:
    connection.close()
    raise SystemExit('Unexpected S3 access from auth pod')
"""
        result = run(
            site,
            "k3s kubectl -n soloapp exec deployment/auth -c refresh-secrets -- python3 -c "
            + shlex.quote(deny),
            capture=True,
        )
        print(site, result.stdout, flush=True)
        try:
            run(
                site,
                """k3s kubectl -n soloapp scale statefulset/seaweedfs --replicas=0
k3s kubectl -n soloapp wait --for=delete pod/seaweedfs-0 --timeout=120s""",
            )
            web(site, FALLBACK)
        finally:
            run(
                site,
                """k3s kubectl -n soloapp scale statefulset/seaweedfs --replicas=1
k3s kubectl -n soloapp rollout status statefulset/seaweedfs --timeout=180s""",
            )
        web(site, READ)
        ip = host_config(site)["private_ip"]
        result = run(
            site,
            f"docker run --rm --user 0:0 --network host --entrypoint python3 -v /run/soloapp-s3server:/secrets:ro -v /var/backups/soloapp-s3:/snapshots:ro -v /opt/hack-vk-26/s3-verify-migration.py:/verify.py:ro soloapp/deploy-controller:1 /verify.py http://{ip}:18333 --snapshot /snapshots/pre-k8s-inventory.json --verify",
            capture=True,
        )
        print(site, result.stdout, flush=True)


if __name__ == "__main__":
    main()
