# Private image registry

Two independent OCI Distribution 3.0 registries store blobs/manifests in the `soloapp-registry` bucket of the existing two-site SeaweedFS S3. The same linux/amd64 OCI image is published to each replica. A new deployment requires identical digests in both registries and matching web release markers in both S3 stores. Kubernetes references immutable digests, not mutable release tags.

Read replicas listen only on WireGuard, HTTPS 5043, with mandatory client certificates and read-only storage. A separate publisher listens only on loopback HTTPS 5044 and trusts a different client CA. Pod workloads receive neither registry credentials nor S3 write keys. Containerd uses its host-level mTLS identity and prefers the local replica, falling back to the other. Public internet access and anonymous pulls are unavailable. S3 redirects and registry deletion are disabled.

Builds run locally (`make release-images`) or on GitHub-hosted runners. CI delivers initial OCI content through the existing expiring, forced-command SSH identity (`push-auth|push-whoami|push-web <green-main-sha>`). The server verifies the archive, platform, revision label and all blob hashes, then publishes it as an unprivileged user. This transport does not grant a shell or forwarding and does not publish ODB binaries publicly. Initial delivery uses temporary archives; subsequent pulls and rollbacks use registry storage and need no archives or rebuilds.

`Deploy production` accepts optional `rollback_revision`. A rollback skips all build/publication steps and can select only a release previously deployed successfully on each target, with exactly the recorded digests. A reachable replica is sufficient to retrieve old images; the workflow still requires SSH access to every target it rolls. Rollback does not reverse database migrations. A new release still waits for both sites. Failed first-time deployments cannot be selected as successful rollback targets.

## Bootstrap and operations

1. `python3 infra/registry/bootstrap.py` creates bucket-scoped S3 reader/writer keys and separate mTLS server/pull/push identities directly in Lockbox. Install Python cryptography for this operator command. It refuses to overwrite existing live identities. CA private keys stay in an operator-only Lockbox secret; node identities read only their site secret.
2. `ansible-playbook infra/object-storage/install.yaml` updates S3 identity delivery and its configurable volume limit (default 32 volumes, up to 1 GiB each, shared by both buckets).
3. `ansible-playbook infra/registry/install.yaml` initializes the versioned bucket, runs pinned prebuilt registry images and installs containerd mirrors without restarting k3s.
4. `ansible-playbook infra/cd/upgrade.yaml` explicitly installs the reviewed gate. Controller images must already be built locally or in CI; production never builds them.

Secrets are delivered to `/run` from Lockbox using workload identities. Server/pull/push certificates expire in 90 days: renew them through the operator and add a new Lockbox version before expiry. Refresh timers distribute updates; the helper restarts registry containers after certificate/config changes. Client CA separation must be preserved. This bootstrap does not currently automate certificate issuance. Do not run garbage collection while releases must remain rollbackable. Native S3 versioning is enabled; it is not an independent backup. Monitor disk usage before increasing retention or volume limits. Registry configuration and CA keys are never committed.

Distribution S3 configuration: https://distribution.github.io/distribution/storage-drivers/s3/
Containerd host configuration: https://github.com/containerd/containerd/blob/main/docs/hosts.md
