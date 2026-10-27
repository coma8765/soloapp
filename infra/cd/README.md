# Continuous deployment

`Validate source` runs codegen/policy tests, secret/history scanning, Docker testsuite for auth/whoami, and Flutter analyze/test/web build. Public PRs run only on GitHub-hosted runners and receive no production environment secrets.

`Deploy production` starts after a successful **push CI on main**, or manually through Actions (`workflow_dispatch`, main only). It rechecks the current main SHA and green CI; the server independently checks the same conditions. The production environment permits only the main branch. Older queued revisions fail closed when main has advanced. GitHub concurrency and per-server file locks prevent overlapping deployments.

Each site has a separate expiring Ed25519 key, stored in GitHub Environment Secrets. SSH uses pinned host keys, a root-owned forced command, and disables PTY/forwarding. The login has no general sudo; only the fixed gate accepts `probe` or a validated commit SHA. Possession of this key grants deployment of current green main, not a shell. People allowed to change main/workflows remain trusted deployers; changes there must be reviewed.

GitHub-hosted CI builds auth, whoami and web runtime images once, labels the approved commit, then publishes identical OCI content to both private S3-backed registries over the restricted SSH gate. Servers never build images. The gate checks matching image digests and both web release markers, then runs Ansible using a namespace-scoped 20-minute token. Kubernetes pulls pinned digests through mTLS registry mirrors. See `infra/registry/README.md` for storage and access details.

Rollout order: YC → home → public API and web smoke tests. Each site waits for auth, whoami, web and nginx readiness. Failed rollouts stop the workflow. To roll back without rebuilding, run `Deploy production` on main with `rollback_revision` set to a full previously deployed SHA. The gate permits only recorded successful releases and checks their original image digests. Database migrations are not reverted. Infrastructure and installed gate changes remain operator-managed.

## Operator installation and rotation

Prerequisites: existing two-site deployment, Docker/k3s, private inventory/cloud resource configuration, and SSH administration access. Controller image dependencies are pinned in Dockerfile. Inspect/update the installed root-owned gate explicitly when its implementation changes; production releases cannot self-update it.

1. Generate a unique Ed25519 key per site into a temporary protected directory outside Git (for example `work/cd-keys/`). Do not reuse an administrator key.
2. Set an expiry (UTC, `YYYYMMDDHHMMSSZ`, recommended 90 days; installer converts it to the local-time syntax supported by older OpenSSH), then run:

```sh
ansible-playbook infra/cd/install.yaml \
  -e cd_repository=YOUR_OWNER/YOUR_REPO \
  -e cd_controller_archive="$PWD/work/deploy-controller.tar" \
  -e cd_key_directory="$PWD/work/cd-keys" \
  -e cd_key_expiry=YYYYMMDDHHMMSSZ
```

3. In environment `production`, restrict deployment branches to `main`, and store these secrets: `CD_YC_KEY`, `CD_HOME_KEY`, `CD_YC_HOST`, `CD_HOME_HOST`, `CD_YC_PORT`, `CD_HOME_PORT`, `CD_KNOWN_HOSTS`, `SOLOAPP_BASE_URL`. Obtain host public keys through an already verified administrator connection, not an unauthenticated scan. Ports must be reachable from GitHub-hosted runners.
4. Test each identity using `ssh ... soloapp-cd@HOST probe`; arbitrary commands must be rejected. Delete temporary private keys after storing and checking them. Repeat before expiry; replacing authorized_keys revokes the previous key.
5. Push main or manually run `Deploy production`. Inspect Actions and `/var/lib/soloapp-cd/deployed.json` on each node.

Source checkouts and deployment history remain on the node. Registry storage retains release images independently of the containerd cache. Build the controller locally with `make build-controller` before initial installation. No keys or kubeconfigs should be added to a GitHub artifact or the source repository.

GitHub environment controls: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

## Versioned web publication

The production workflow builds Flutter at the selected green main revision and streams a bounded archive via `publish <sha>` before either site rolls. The same fixed gate validates main/CI for publishing and deployment. The publisher container gets only the bucket-scoped key from Lockbox delivery, runs as UID 10004 without capabilities, and verifies both independent S3 replicas. `deploy <sha>` refuses activation without matching commit markers in both replicas. The web gateway image is built on the GitHub runner alongside auth/whoami; the static assets are built once and identified by SHA. Public API smoke checks run after both sites have the migrated API contract. Operator gate upgrades use `infra/cd/upgrade.yaml`; SSH/sudo/RBAC scopes are unchanged.

## Release versions

Production reserves a Git tag `v0.1.P` for each new source revision, starting at `v0.1.0`. P is the maximum existing patch plus one; workflow concurrency serializes allocation. Reruns of the same SHA reuse its version, and rollback does not consume a version. A tag reserves a number, so a failed deployment may leave a gap; only successful per-site deployment records are eligible for rollback. The version appears in the Flutter UI, web build metadata, OCI image labels and immutable registry version aliases. SHA-based asset paths and image digests remain immutable. `rollback_revision` accepts either `v0.1.P` or a full SHA. Only the small version-allocation job has repository write permission; build/deploy jobs retain read-only GitHub permissions.
