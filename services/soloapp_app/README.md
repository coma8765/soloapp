# Soloapp shared world

Vendored from [soloapp_app](https://github.com/coma8765/soloapp_app); provenance is
recorded in [docs/UPSTREAM.md](docs/UPSTREAM.md).

The Babylon browser client uses existing Soloapp authentication and generated
OpenAPI routes. The C++ Drogon backend uses ODB/PostgreSQL for a shared world with
one lease-fenced active simulator. Gameplay travels over WSS; voice signaling
relays SDP/ICE for browser peer connections.

- `make build`: container build on the developer machine or CI.
- `make test`: compile and test checkpoint recovery.
- `make codegen`: regenerate browser client operations and C++ routes from YAML.
- `make package REVISION=<40-hex-revision>`: validated immutable web bundle.

Kubernetes resources retain the existing `whoami` identity and CD `app-api` scope
for existing RBAC and digest-based rollback. Their manifests now live here in
`deploy/k8s`; the container image replaces the previous NestJS backend.

Production `web` deployment automatically uploads and verifies both S3 copies
before activating that revision. Mac uses its own S3 and database; publishing
there does not modify production. See [docs/architecture.md](docs/architecture.md)
for topology and limitations. No SQLite accounts or standalone upstream launcher
are used by the integrated deployment.
