# S3 for immutable web releases

Two **independent** SeaweedFS 4.51 S3 servers run in YC and home. Each stores its own master/filer metadata and volume data under `/var/lib/soloapp-s3`. This is application-level replication for release artifacts, not a two-node consensus cluster or general-purpose writable HA S3 endpoint.

The chosen failure policy is: reads continue with one site; new releases require both sites. The CD publisher uploads exactly the same build to both buckets, reads every object back, verifies SHA-256, then writes `committed.json` to both. A partial upload never changes the running release. CD checks that both commit manifests agree before activation. A recovery/retry uploads the missing copy; it does not silently declare a one-copy release successful.

Objects live under `soloapp-web/releases/<git-sha>/`. Native bucket versioning is also enabled. Reusing a SHA with different content is rejected. The running revision is explicit Kubernetes configuration, not a mutable S3 `latest` pointer. Old versions remain available during rolling updates.

## Security

Only S3 port 18333 is published, bound to the WireGuard address. Master, filer, IAM and other auxiliary interfaces are not published. S3 requests use SigV4; cross-site traffic travels through encrypted WireGuard. Pod-to-local-node HTTP stays within that host, like existing intra-cluster application HTTP. S3 is not exposed through the public load balancer.

Server, publisher and read-only web credentials are separate and held in Lockbox. Node delivery puts keys into `/run` with restricted ownership; web uses its own federated identity and only receives the read-only key. No storage key is kept in GitHub, the image or Git. `bootstrap.py` requires the operator's authenticated YC CLI and existing k3s OIDC federation; it creates resource-scoped Lockbox grants. The deployment key only permits the fixed `publish <current-green-main-sha>` operation; incoming archives have bounded sizes, validated paths and no links.

`bootstrap.py` creates initial credentials once. Rotation is an operator operation: create replacement credentials in Lockbox, keep old/new accepted in the server config during overlap, refresh readers/publisher, then remove old credentials. Lockbox delivery refreshes every five minutes; server configuration is reloaded with SIGHUP. There is no automatic S3 access-key rotation scheduler.

## Install and operate

```sh
python3 infra/object-storage/bootstrap.py
ansible-playbook infra/cd/upgrade.yaml
ansible-playbook infra/object-storage/install.yaml
```

The two buckets are limited by eight 1-GiB volumes each; monitor free disk and prune obsolete releases deliberately. Never delete the running or rollback versions. Replication is not an independent backup; there is no off-site backup configured.

Production CD builds Flutter once, streams the bundle through the constrained SSH gate on YC, verifies both copies, then rolls the application sites. If either S3 is unavailable, publishing stops and existing pods keep serving their cached active release. A fresh web pod can download from either replica. If both S3 copies are lost, already running pods can serve their cached active release, but this cache is not a durable backup.

For a web-only rollback, verify the historical `committed.json` in both stores, then run the app playbook with `--tags web -e web_release=<previous-sha>` and the current web gateway image. Check compatibility with the currently deployed API. Full application rollback uses a revert commit through CI/CD.
