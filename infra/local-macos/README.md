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

The chief engineer uses the existing Knowledge Search API and Ollama. Add an
`engineer` mapping to ignored `config.yaml` with `search_url`, `ollama_url`, and
`ollama_model`. Use internal IP origins reachable from the Colima pods (the same
host-loopback bridge used by `whisper.metal_host`), not pod-local `127.0.0.1`.
The renderer grants `whoami` egress only to those two IP/port pairs. Do not expose
these unauthenticated ML dependencies on the public gateway. See
[chief engineer deployment and checks](../../docs/CHIEF_ENGINEER.md).
