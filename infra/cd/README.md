# Continuous deployment

`Validate source` runs codegen/policy tests, secret/history scanning, Docker testsuite for auth plus the explicit app-api (NestJS) build/lint/unit/e2e and production-image job, and Flutter analyze/test/web build. Public PRs run only on GitHub-hosted runners and receive no production environment secrets.

`Deploy production` is manually started through Actions (`workflow_dispatch`, main only). Deploy one service at a time (recommended); `all` is an explicit coordinated release. A push still runs validation, but no longer automatically rolls every service. It waits up to 40 minutes for green push CI on the requested main SHA, checking every 15 seconds; the server independently checks the same conditions. The production environment permits only the main branch. Older queued revisions fail closed when main has advanced. GitHub concurrency and per-server file locks prevent overlapping deployments.

Each site has a separate expiring Ed25519 key, stored in GitHub Environment Secrets. SSH uses pinned host keys, a root-owned forced command, and disables PTY/forwarding. The login has no general sudo; only the fixed gate accepts `probe` or a validated commit SHA. Possession of this key grants deployment of current green main, not a shell. People allowed to change main/workflows remain trusted deployers; changes there must be reviewed.

GitHub-hosted CI builds only the selected runtime image (auth, whoami for app-api, or web), or all three for `all`, labels the approved commit, then publishes identical OCI content to both private S3-backed registries over the restricted SSH gate. Servers never build images. The gate checks matching selected image digests; web/all also require both static release markers, then runs Ansible using a namespace-scoped 20-minute token. Kubernetes pulls pinned digests through mTLS registry mirrors. See `infra/registry/README.md` for storage and access details.

Rollout order: YC → home → public API and web smoke tests. Each site waits only for the selected deployment; `all` waits for all four. Failed rollouts stop the workflow. To roll back without rebuilding, run `Deploy production` on main with `rollback_revision` set to a full previously deployed SHA. The gate permits only recorded successful releases and checks their original image digests. Database migrations are not reverted. Infrastructure and installed gate changes remain operator-managed.

Mandatory analysis, style, format and merge protection are documented in [CI](../ci/README.md).

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
5. After green main CI, manually run `Deploy production` and select a service. Inspect Actions and `/var/lib/soloapp-cd/deployed.json` on each node.

Source checkouts and deployment history remain on the node. Registry storage retains release images independently of the containerd cache. Build the controller locally with `make build-controller` before initial installation. No keys or kubeconfigs should be added to a GitHub artifact or the source repository.

GitHub environment controls: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments

## Versioned web publication

The production workflow builds Flutter at the selected green main revision and streams a bounded archive via `publish <sha>` before either site rolls. The same fixed gate validates main/CI for publishing and deployment. The publisher container gets only the bucket-scoped key from Lockbox delivery, runs as UID 10004 without capabilities, and verifies both independent S3 replicas. `deploy <sha>` refuses activation without matching commit markers in both replicas. The web gateway image is built on the GitHub runner alongside auth/whoami; the static assets are built once and identified by SHA. Public API smoke checks run after both sites have the migrated API contract. Operator gate upgrades use `infra/cd/upgrade.yaml`; SSH/sudo/RBAC scopes are unchanged.

## Release versions

Production reserves a Git tag `v0.1.P` for each new source revision, starting at `v0.1.0`. P is the maximum existing patch plus one; workflow concurrency serializes allocation. Reruns of the same SHA reuse its version, and rollback does not consume a version. A tag reserves a number, so a failed deployment may leave a gap; only successful per-site deployment records are eligible for rollback. The version appears in the Flutter UI, web build metadata, OCI image labels and immutable registry version aliases. SHA-based asset paths and image digests remain immutable. `rollback_revision` accepts either `v0.1.P` or a full SHA. Only the small version-allocation job has repository write permission; build/deploy jobs retain read-only GitHub permissions.

## NestJS identity runtime

The `whoami` image is built from `services/app-api` (NestJS), using the existing whoami deployment, secret identity and three-image release format. Rollback to earlier C++ images uses the same digest-based flow. No additional IAM mappings or gate command are required.


## Recommended: isolated service deployment

Actions → **Deploy production** → **Run workflow**, branch `main`:

* `service=app-api` (default): build the NestJS image, publish it to both private registries,
  and roll only the existing `whoami` Deployment.
* `service=auth`: build/publish/roll auth only.
* `service=web`: build Flutter assets and web gateway, verify both S3 copies, roll web only.
* `service=nginx`: apply generated gateway configuration and roll nginx only; no application
  image or Flutter build. Nginx uses its configured upstream runtime image.
* `service=all`: explicitly build/publish/roll the complete application.

No other Deployment is applied during a scoped rollout; the gate restricts Ansible to a
fixed tag (`app-api` maps to `whoami`). Root gate checks, green-current-main checks, pinned
SSH identities, environment branch restrictions and namespace RBAC remain in effect.
The workflow remains globally serialized because shared APIs/storage can couple releases.
No new shell, sudo command or IAM capability is granted.

Rollback uses the same service selection plus `rollback_revision=v0.1.P` or a recorded SHA.
It skips all builds/publication and checks only that service's recorded immutable digest.
Old full releases are eligible as scoped rollback targets. Per-service history is stored in
`/var/lib/soloapp-cd/history/services/<service>/<sha>.json`; full history stays in
`history/<sha>.json`. `deployed.json.services` records each currently deployed revision/image.
Its top-level `revision` is null when services run different commits. A version tag identifies
source, not proof that every service was deployed at that version; successful site history
remains authoritative. Failed partial rollout can leave one site ahead of the other.

Public API smoke tests still validate the integrated authentication boundary after both sites;
web asset revision checks run only for web/all. Changes to API contracts must remain compatible
with deployed peers. If a change requires new nginx routes or coordinated API/client changes,
use explicit `all`, or deploy a backward-compatible sequence (provider, gateway, consumer).
Infrastructure and monitoring use their own Ansible playbooks and are not changed by service CD.

Install updated fixed command parsing with `ansible-playbook infra/cd/upgrade.yaml` before
using scoped workflow commands. Existing legacy `deploy <sha>` and `rollback <sha>` still
mean a full release for compatibility with old workflows.

## Deployment notifications

The alert Telegram chat receives start and success/failure/cancelled events for each selected
service, including revision/version, phase, both data centers and an Actions attempt link.
Start means the workflow was accepted (including waiting for CI), not that pods have changed.
Success requires both sites and final smoke tests. For `all`, each service is explicitly marked
as part of the coordinated release: failure means the release failed, possibly partially, not
that all service pods are down. Notifications are separate from Prometheus incidents.

A separate final job uses `always()` to report failures in prepare, rollout and timed-out jobs.
Notification transport failure is visible as a failed notification job but does not prevent
prepare/rollout. Delivery retries three times; ambiguous network failures may produce duplicates.
GitHub outage/forced termination can prevent final notification; the Actions run is authoritative.

The relay `/deployments` accepts a dedicated `DEPLOY_TOKEN` only, validates fixed service/status
fields and sends to the configured alert chat; it cannot redirect messages to another chat.
The alert credential cannot use this endpoint, and the deploy credential cannot send alerts.
Bot secrets remain in Lockbox/Cloudflare. GitHub production stores only the dedicated relay
credential and endpoint (`CD_NOTIFY_TOKEN`, `CD_NOTIFY_URL`); untrusted PRs have no access.

Operator setup/rotation (credential transfer requires operator authorization):

```sh
.venv-codegen/bin/python infra/telegram-relay/deploy.py --grafana-url https://soloapp.secure-l3.stream/grafana/
.venv-codegen/bin/python infra/cd/configure_notifications.py
```

CI still fails closed if main advances, validation fails/cancels, or the 40-minute wait expires.
The server gate independently rechecks CI/main before publication or mutation.
