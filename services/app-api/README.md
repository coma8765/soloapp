# NestJS identity service

This application replaces the C++ whoami runtime. Production retains one Kubernetes
Deployment/Service named `whoami`, two replicas per site, its existing Lockbox
identity, HMAC secret and registry image name. No separate app-api deployment or
additional IAM permission is required.

## Contract

- `GET /api/v1/whoami/v1/user-id`: existing public contract, used by Flutter.
- `GET /api/v1/app-api/v1/user-id`: equivalent public route to the same pods.
- `GET /user-id`: backend-only alias.
- `/healthz`: process liveness; `/health/ready`: readable signing key and healthy circuit.

Clients authenticate to nginx with a Bearer session. nginx obtains signed identity
from auth, replaces client identity headers and strips Authorization before proxying.
NestJS verifies lowercase user id (32 hex), timestamp (10 digits), HMAC-SHA256 over
`soloapp-user-id:<user-id>:<timestamp>`, using timing-safe comparison. The acceptance
window is 2 seconds into the future / 10 seconds into the past. Identity responses
have `Cache-Control: no-store`.

`HMAC_KEY_FILE` points to the 64-hex-character secret file. It is read per verification
to support atomic secret rotation; missing/invalid keys fail closed. The service
reads secrets from the existing in-memory volume, never from the image.

Routes and body limits are generated in `src/generated/routes.ts` from
`services/whoami/docs/api.yaml` and `services/app-api/docs/api.yaml` by
`make codegen-whoami`; CI rejects stale generated metadata. nginx policies and the
Flutter client continue to come from those OpenAPI contracts.

## Health and deployment

`HEALTH_ERROR_THRESHOLD` (3), `HEALTH_WINDOW_SECONDS` (10) and
`HEALTH_COOLDOWN_SECONDS` (15) preserve the existing configurable 5xx circuit.
Health probe responses do not count toward it; 4xx do not eject a pod. Liveness stays
200 during cooldown; readiness returns 503 and recovers after cooldown. The existing
preStop, graceful SIGTERM shutdown and RollingUpdate (zero unavailable) remain.

Production manifests and per-site overrides live under `services/whoami/deploy`.
Memory request/limit are 96Mi/256Mi; CPU request/limit 50m/500m.
The runtime is Node.js 24, UID 10001, read-only root, no capabilities.
Registry releases still contain auth/whoami/web, so old releases remain rollbackable.

## Local development and validation

```sh
npm ci
npm run build
npm run lint
npm test
npm run test:e2e
HMAC_KEY_FILE=/path/to/userid-hmac npm run start:dev
```

`PORT` defaults to 8080 and `LISTEN_ADDRESS` to `0.0.0.0`. Tests create synthetic keys.
From the repository root, `make build-whoami` and `make test-whoami` build/test this
NestJS application. `make build-app-api` remains a standalone development alias.
Builds run on developer machines or GitHub runners, never production hosts.
