# S3 for immutable web releases

Two **independent** SeaweedFS 4.51 S3 servers run as Kubernetes StatefulSets (`soloapp/seaweedfs`, one pod per site) in YC and home. Each stores its own master/filer metadata and volume data under `/var/lib/soloapp-s3`. This is application-level replication for release artifacts, not a two-node consensus cluster or general-purpose writable HA S3 endpoint.

The chosen failure policy is: reads continue with one site; new releases require both sites. The CD publisher uploads exactly the same build to both buckets, reads every object back, verifies SHA-256, then writes `committed.json` to both. A partial upload never changes the running release. CD checks that both commit manifests agree before activation. A recovery/retry uploads the missing copy; it does not silently declare a one-copy release successful.

Objects live under `soloapp-web/releases/<git-sha>/`. Native bucket versioning is also enabled. Reusing a SHA with different content is rejected. The running revision is explicit Kubernetes configuration, not a mutable S3 `latest` pointer. Old versions remain available during rolling updates.

## Security

Only S3 port 18333 is published through a hostPort bound to the WireGuard address, preserving existing client endpoints. A private headless Service exposes port 8333 inside each cluster. NetworkPolicy permits only web pods and the two site hosts; the storage pod has no outbound network permission. Master, filer, IAM and other auxiliary interfaces are not published. S3 requests use SigV4; cross-site traffic travels through encrypted WireGuard. Pod-to-local-node HTTP stays within that host, like existing intra-cluster application HTTP. S3 is not exposed through the public load balancer.

Server, publisher and read-only web credentials are separate and held in Lockbox. Node delivery puts keys into `/run` with restricted ownership; web uses its own federated identity and only receives the read-only key. No storage key is kept in GitHub, the image or Git. `bootstrap.py` requires the operator's authenticated YC CLI and existing k3s OIDC federation; it creates resource-scoped Lockbox grants. The deployment key only permits the fixed `publish <current-green-main-sha>` operation; incoming archives have bounded sizes, validated paths and no links.

`bootstrap.py` creates initial credentials once. Rotation is an operator operation: create replacement credentials in Lockbox, keep old/new accepted in the server config during overlap, refresh readers/publisher, then remove old credentials. Lockbox delivery refreshes every five minutes; server configuration is reloaded with SIGHUP by the host delivery service through a scoped exec into the SeaweedFS container. The pod mounts only the existing host delivery directory, has no Kubernetes API token and waits for the configuration before starting after a reboot. Failed host delivery retries every five seconds rather than waiting for the next five-minute refresh. There is no automatic S3 access-key rotation scheduler.

## Install and operate

```sh
python3 infra/object-storage/bootstrap.py
ansible-playbook infra/cd/upgrade.yaml
ansible-playbook infra/object-storage/install.yaml
```

Each site defaults to 32 volumes of up to 1 GiB shared by its buckets; monitor free disk and prune obsolete releases deliberately. Never delete the running or rollback versions. Replication is not an independent backup; there is no off-site backup configured.

Production CD builds Flutter once, streams the bundle through the constrained SSH gate on YC, verifies both copies, then rolls the application sites. If either S3 is unavailable, publishing stops and existing pods keep serving their cached active release. A fresh web pod can download from either replica. If both S3 copies are lost, already running pods can serve their cached active release, but this cache is not a durable backup.

For a web-only rollback, verify the historical `committed.json` in both stores, then run the app playbook with `--tags web -e web_release=<previous-sha>` and the current web gateway image. Check compatibility with the currently deployed API. Full application rollback uses a revert commit through CI/CD.

## Kubernetes lifecycle and migration

`defaults.yaml` holds the pinned image, resource requests/limits, storage path and volume count. Override values with `s3_overrides` in the private per-site inventory. Each site intentionally has **one** all-in-one SeaweedFS pod: do not scale multiple writers against the same master/filer directory. Site redundancy comes from the two independent stores and the existing dual-publication protocol.

The static local PV points to the existing `/var/lib/soloapp-s3` directory, has node affinity and `Retain` reclaim policy. Deleting a pod does not delete data. The PVC's declared capacity is scheduling metadata, not a filesystem quota. A node loss cannot move this local disk to another node; clients must use the other site's S3.

`install.yaml` preloads the image and validates the manifest before stopping the old Docker runtime. Under the CD lock it hashes every S3 object version, disables the old container's restart policy, stops it, and takes a cold archive in `/var/backups/soloapp-s3`. It then starts the StatefulSet on the same directory, waits for startup/readiness, and compares all versions and hashes. A failed initial cutover scales the StatefulSet down and waits for pod deletion before restarting Docker; it never intentionally runs both writers. The stopped Docker container is retained for recovery.

Run one site at a time, beginning with home:

```sh
ansible-playbook infra/object-storage/install.yaml --limit home
ansible-playbook infra/object-storage/install.yaml --limit yc
```

The migration archive is a local recovery copy, not an off-site backup. Do not restore it over a running pod. StatefulSet updates briefly interrupt that site's S3; the other site remains available. Startup, readiness and liveness probes supervise the process. This does not turn independent stores into a consensus cluster or add background replication.

After deployment, verify authenticated reads from web pods to both endpoints, recreate one SeaweedFS pod and verify persistent data, then confirm default-denied pods cannot access S3. Headlamp lists `seaweedfs` under StatefulSets in namespace `soloapp`.

Run the controlled two-site storage outage and isolation smoke test with `python3 infra/object-storage/tests/verify_live.py`. It uses private operator inventory and restores each StatefulSet in a finally block. The pre-migration inventory must exist on both hosts.
