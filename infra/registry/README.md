# Private image registry

Two independent OCI Distribution 3.0 registries store blobs/manifests on persistent host filesystems at `/var/lib/soloapp-registry`, mounted as `/var/lib/registry`. The same linux/amd64 OCI image is explicitly published to both sites; directories do not replicate automatically. A new deployment requires identical digests in both registries. Web deployments additionally require matching web release markers in both S3 stores; other image storage has no SeaweedFS dependency. Kubernetes references immutable digests, not mutable release tags.

Read replicas listen only on WireGuard, HTTPS 5043, with mandatory client certificates and read-only storage. A separate publisher listens only on loopback HTTPS 5044 and trusts a different client CA. Pod workloads receive neither registry credentials nor S3 write keys. Containerd uses its host-level mTLS identity and prefers the local replica, falling back to the other. Public internet access and anonymous pulls are unavailable. Registry deletion is disabled. The read container mounts image storage read-only; only the loopback publisher has a writable mount. Both run as UID 10006.

Builds run locally (`make release-images`) or on GitHub-hosted runners. CI delivers initial OCI content through the existing expiring, forced-command SSH identity (`push-auth|push-whoami|push-web <green-main-sha>`). The server verifies the archive, platform, revision label and all blob hashes, then publishes it as an unprivileged user. This transport does not grant a shell or forwarding and does not publish ODB binaries publicly. Initial delivery uses temporary archives; subsequent pulls and rollbacks use registry storage and need no archives or rebuilds.

`Deploy production` accepts optional `rollback_revision`. A rollback skips all build/publication steps and can select only a release previously deployed successfully on each target, with exactly the recorded digests. A reachable replica is sufficient to retrieve old images; the workflow still requires SSH access to every target it rolls. Rollback does not reverse database migrations. A new release still waits for both sites. Failed first-time deployments cannot be selected as successful rollback targets.

## Bootstrap and operations

1. `python3 infra/registry/bootstrap.py` creates separate mTLS server/pull/push identities directly in Lockbox. Install Python cryptography for this operator command. It refuses to overwrite existing live identities. CA private keys stay in an operator-only Lockbox secret; node identities read only their site secret.
2. For a **new empty installation only**, run `ansible-playbook infra/registry/install.yaml -e registry_initialize_empty=true`. Existing registries require the verified migration marker described below; do not bypass this guard to migrate data.
3. The playbook runs pinned prebuilt registry images and installs containerd mirrors without restarting k3s. A systemd unit starts the containers after WireGuard and secret delivery on boot.
4. `ansible-playbook infra/cd/upgrade.yaml` explicitly installs the reviewed gate when CD changes. Controller images must already be built locally or in CI; production never builds them.

Secrets are delivered to `/run` from Lockbox using workload identities. Server/pull/push certificates expire in 90 days: renew them through the operator and add a new Lockbox version before expiry. Refresh timers distribute updates; the helper restarts registry containers after certificate/config changes. Client CA separation must be preserved. This bootstrap does not currently automate certificate issuance. Registry configuration and CA keys are never committed.

## Migrating an existing S3 registry

Migrate both sites during a publication maintenance window. Reads remain available from the other replica while each read container is recreated. Coordinate with the CD deployment lock; do not publish concurrently with the copy.

1. Copy `migrate_storage.py` and `verify_storage.py` to the target host. Run the verifier with the site's WireGuard address and `--snapshot /var/lib/soloapp-registry-before-filesystem.json`. It records every tag/digest and checks referenced blob sizes using the pull certificate, without printing credentials. The snapshot refuses to overwrite an existing file.
2. Install the current secret refresh helper. Stop `solo-registry-secrets.timer` and its service, create `/run/soloapp-registry-migrating`, and stop `solo-registry-write`. The marker prevents secret refresh from restarting a publisher during migration. Freeze writers on both sites until both migrations finish.
3. Create `/var/lib/soloapp-registry` with owner `10006:10006`, mode `0700`. Run the prebuilt deployment controller with the old `/run/soloapp-registry` mounted read-only at `/secrets`, the destination mounted at `/data`, and the migration script mounted read-only. Override the entrypoint with `python3`, use host networking and UID `10006:10006`. Without `--copy` the script only reports capacity and object inventory. With `--copy` it copies current S3 objects, checks content-addressed blob hashes, reads back file hashes and requires an unchanged source inventory. It writes `.migration-verified.json` only after success and refuses to overwrite an already migrated store.
4. From the operator machine run `python3 infra/registry/filesystem_config.py <yc|home>`. This adds a Lockbox version changing only the storage driver and preserving TLS identities. Then run `ansible-playbook infra/registry/install.yaml --limit <yc|home>` to refresh configuration and recreate containers with explicit filesystem mounts.
5. Run the verifier against that site with the same snapshot and `--verify --write-check`. This checks every old tag and referenced blob, and republishes one existing manifest unchanged to test the loopback writer. Stop the writer again if the other site has not yet migrated. Repeat for the other site.
6. After both verifications pass, start both writers, remove the migration markers and start both secret refresh timers. Check `solo-registry.service`, the timers and an actual `k3s crictl pull` of a deployed immutable image on both hosts.

The scripts never delete source S3 data. Retain the source bucket and previous Lockbox versions until migration is accepted. They are a snapshot of the migration time, **not a backup of later filesystem publications**. Reverting to S3 after new pushes requires copying those newer images first; merely restoring the old configuration would hide them.

## Retention and backups

Old tags and content remain available for rollback; garbage collection and deletion are disabled. Monitor host disk usage. Two publication destinations protect availability against one site's failure but are not an independent backup. Scheduled filesystem backups and a retention policy are not configured by this playbook; arrange consistent snapshots or freeze writes while copying the storage directory before enabling cleanup.

SeaweedFS remains responsible for web release artifacts. Its old registry bucket is retained and is no longer used for new image publications.

Containerd host configuration: https://github.com/containerd/containerd/blob/main/docs/hosts.md
