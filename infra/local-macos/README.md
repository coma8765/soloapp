# Independent Mac contour

This is a separate local Kubernetes/data contour. It does not promote an offline
Mac into the production PostgreSQL cluster or merge divergent game worlds.

Copy `config.example.yaml` to ignored `config.yaml`, set the current LAN IPv4,
then start Colima using `make start`. Build on the Mac with `bash build.sh` and
apply `deploy.yaml`. Secrets live in macOS Keychain and encrypted Kubernetes
Secrets; never commit `config.yaml`, keys, or generated inventories.

The game backend is `soloapp_app`, retaining Kubernetes Deployment `whoami`.
The two pods share the local PostgreSQL world and elect one active simulator.
`services/soloapp_app/deploy/schema.sql` is applied by the local bootstrap.

For a web release, package from the repository root:

```sh
.venv-codegen/bin/python services/soloapp_app/deploy/package.py <revision> /tmp/web.tar.gz
kubectl --context colima-soloapp-local -n soloapp port-forward svc/seaweedfs 18333:8333 --address 127.0.0.1
# In another terminal:
.venv-codegen/bin/python infra/local-macos/publish-web.py <revision> /tmp/web.tar.gz
```

Set `web_release: <revision>` in local config and reapply app manifests. The
reader can only read `soloapp-web`; publication uses the local administrator's
Keychain-held credentials and verifies every object before committing a release.
The production publisher independently requires two successful S3 copies.

The LAN entry listens on TCP 443 using a launchd socket relay into a supervised
loopback SSH tunnel through the Colima VM to the nginx Kubernetes Service.
Individual interrupted downloads do not terminate other clients’ WSS sessions,
and new connections follow Service endpoints after pod replacement. `make lan-refresh LAN_IP=<address>` updates the leaf
certificate and allowed Origin after moving networks. The public CA is exported
to `outputs/soloapp-local-ca.crt`; clients must trust that CA to use HTTPS by IP.
Keys never belong in the exported CA file. A second physical LAN client has not
been tested automatically.

Read-only health: `make status`. Application smoke:

```sh
NODE_EXTRA_CA_CERTS=outputs/soloapp-local-ca.crt SOLOAPP_BASE_URL=https://<LAN-IP> node services/soloapp_app/tests/smoke.mjs
```

Container images and the active web bundle must be available locally before
losing Internet. Voice between clients on different NATs requires TURN; game
coordinates and shared world snapshots use WSS through the same HTTPS entry.

## Update the installed Mac contour

From the repository root, use one command:

```sh
./infra/local-macos/update-local.sh
```

It fetches `origin/main` once, pins the resulting commit and creates an isolated
checkout under `work/local-updates/<sha>`. The original checkout, uncommitted
changes, Keychain credentials and persistent storage are preserved. The command
starts the existing Colima profile, builds ARM64 application images locally,
runs game C++/PostgreSQL and browser-module tests, publishes and verifies the
versioned web bundle in local SeaweedFS, applies the game schema and app/network
manifests, waits for backend readiness, then switches web. Failed commands stop
the update; there is no automatic database rollback. Old release objects and
images remain available.

This updates auth, the game backend, gateway, client-notify, TTS, Llama and the web
origin. It uses the installed native Whisper Metal service and restarts its
launch agent if needed; it does not replace it with a CPU pod or upgrade the
native Whisper installation. PostgreSQL, RabbitMQ and SeaweedFS binaries are not
upgraded by this application update. This is for an already bootstrapped contour,
not initial provisioning. The Mac Keychain must be unlocked. Python dependencies
come from the existing `.venv-codegen`; Docker Buildx, Git, Node/npm, Colima and
kubectl must already be installed. No YC/home commands are executed.

Useful variants:

```sh
# Fetch and print the pinned revision, without building or deploying:
./infra/local-macos/update-local.sh --plan

# Check the running contour, including a synthetic audio question and spoken answer:
./infra/local-macos/update-local.sh --check-only

# Deploy a particular existing revision:
./infra/local-macos/update-local.sh --revision ad876ab56b0610f433c97e0f2652e3d894166f15

# After moving to another LAN; keeps HTTPS port 443 and the existing CA:
./infra/local-macos/update-local.sh --lan-ip 192.168.184.90
```

Equivalent Make targets are `make -C infra/local-macos update`, `check`, and
`update-plan`; pass optional update flags with `ARGS='--lan-ip 192.168.184.90'`.
If launchd lost its LAN listener after reboot, the updater opens the standard
macOS administrator dialog to reopen port 443. Enter the password only there.
The final checks verify HTTPS certificates, registration/login, identity,
shared-world WebSocket traffic and SDP/ICE, Whisper on Metal, and the full
Whisper → Llama → TTS request through the application. They use synthetic
accounts/audio and do not open the microphone. Real Safari/Quest playback and
physical controllers still require a device check. Concurrent updates/checks are
blocked by a local file lock.
