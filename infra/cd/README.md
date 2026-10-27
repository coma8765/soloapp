# Continuous deployment

`Validate source` runs codegen/policy tests, secret/history scanning, Docker testsuite for auth/whoami, and Flutter analyze/test/web build. Public PRs run only on GitHub-hosted runners and receive no production environment secrets.

`Deploy production` starts after a successful **push CI on main**, or manually through Actions (`workflow_dispatch`, main only). It rechecks the current main SHA and green CI; the server independently checks the same conditions. The production environment permits only the main branch. Older queued revisions fail closed when main has advanced. GitHub concurrency and per-server file locks prevent overlapping deployments.

Each site has a separate expiring Ed25519 key, stored in GitHub Environment Secrets. SSH uses pinned host keys, a root-owned forced command, and disables PTY/forwarding. The login has no general sudo; only the fixed gate accepts `probe` or a validated commit SHA. Possession of this key grants deployment of current green main, not a shell. People allowed to change main/workflows remain trusted deployers; changes there must be reviewed.

The gate builds runtime images **on each site** from the exact commit, tags them `git-<full SHA>`, imports them into k3s, and runs the existing Ansible app playbook in an unprivileged, read-only container. Git and the pinned kubectl client also run in the controller image, without installing host packages. Its Kubernetes token expires after 20 minutes and has rights only in `soloapp`; it is kept in `/run` and removed after the command. Production Lockbox payloads and application keys are not copied into GitHub. There is no self-hosted GitHub runner on the production network and no public binary/image release.

Rollout order: YC → public API smoke test → home → public API smoke test. Every site's Ansible playbook waits for all three deployments to become ready. RollingUpdate preserves existing ready pods. A failure stops the pipeline, preserving the other site; it does not automatically revert configuration or database changes. Roll back with a reviewed revert commit on main and green CI. Only auth/whoami/nginx app deployments are automated; PostgreSQL, IAM, certificates, observability and the initial Flutter scaffold require separate explicit rollout work.

## Operator installation and rotation

Prerequisites: existing two-site deployment, Docker/k3s, private inventory/cloud resource configuration, and SSH administration access. Controller image dependencies are pinned in Dockerfile. Inspect/update the installed root-owned gate explicitly when its implementation changes; production releases cannot self-update it.

1. Generate a unique Ed25519 key per site into a temporary protected directory outside Git (for example `work/cd-keys/`). Do not reuse an administrator key.
2. Set an expiry (UTC, `YYYYMMDDHHMMSSZ`, recommended 90 days; installer converts it to the local-time syntax supported by older OpenSSH), then run:

```sh
ansible-playbook infra/cd/install.yaml \
  -e cd_repository=YOUR_OWNER/YOUR_REPO \
  -e cd_key_directory="$PWD/work/cd-keys" \
  -e cd_key_expiry=YYYYMMDDHHMMSSZ
```

3. In environment `production`, restrict deployment branches to `main`, and store these secrets: `CD_YC_KEY`, `CD_HOME_KEY`, `CD_YC_HOST`, `CD_HOME_HOST`, `CD_YC_PORT`, `CD_HOME_PORT`, `CD_KNOWN_HOSTS`, `SOLOAPP_BASE_URL`. Obtain host public keys through an already verified administrator connection, not an unauthenticated scan. Ports must be reachable from GitHub-hosted runners.
4. Test each identity using `ssh ... soloapp-cd@HOST probe`; arbitrary commands must be rejected. Delete temporary private keys after storing and checking them. Repeat before expiry; replacing authorized_keys revokes the previous key.
5. Push main or manually run `Deploy production`. Inspect Actions and `/var/lib/soloapp-cd/deployed.json` on each node.

Source checkouts and image build caches remain on the node for diagnosis/reuse; plan periodic disk cleanup while retaining active/previous images. No keys or kubeconfigs should be added to a GitHub artifact or the source repository.

GitHub environment controls: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
