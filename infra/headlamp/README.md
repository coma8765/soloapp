# Headlamp

URL: `https://<public_domain>/k8s/`. Two stateless pods per site, ClusterIP
Service, RollingUpdate (zero unavailable), PDB. Both instances use the same two
context names: `yc` and `home`. Losing a site loses its Kubernetes API, but the UI
and the remaining cluster remain usable. Watches/WebSockets reconnect after a
connection failure; an existing TCP connection cannot move between servers.

## Access

Primary login is Keycloak OIDC with passkeys. Select a cluster to redirect to
Keycloak; the callback broadcasts the identity to both configured contexts.
The operator group is `keycloak:headlamp:operator`; an ordinary Keycloak user
without a Headlamp role is rejected by the Kubernetes API servers.

The runtime has no Kubernetes service-account token. An init container obtains
the OIDC client secret from Lockbox using a scoped workload identity and writes
the kubeconfig into memory. The runtime sees that file but not the workload
identity token. API requests use the authenticated user's OIDC identity.

The legacy operator-only token login remains available through
`python3 infra/headlamp/login.py yc` (or `home`). Its one-hour token is copied to
the clipboard. It is not a permanent login method.

The overview role reads workload status, nodes, events and resource
metrics across namespaces, as required by Headlamp aggregate views. Application
logs and ConfigMaps remain limited to `soloapp`. The expanded read-only role was explicitly approved by the operator.
The human operator can edit/scale the six
existing application Deployments in `soloapp`. No secret reads, exec, RBAC edits,
namespace deletion or infrastructure editing. Deployment editing is nevertheless
a privileged operation: changing its image/volumes can execute code with that
application's identity. Grant this identity only to trusted operators.
The UI cannot access metadata or databases. Network policy permits the private
Kubernetes APIs and DNS/HTTPS needed for OIDC and the scoped init-container
Lockbox exchange.

This uses the same HTTPS origin as the application. Treat application/frontend
code as trusted: a same-origin compromise can issue authenticated UI requests.
OIDC is per-user; a dedicated admin origin remains a subsequent hardening option.

## Configuration and rollout

`defaults.yaml` sets the pinned image, replicas and resource requests/limits.
Per-site `headlamp_overrides` recursively overrides those settings. The `/k8s`
route must be changed consistently in nginx, monitoring gateway and HAProxy.

Run `ansible-playbook infra/headlamp/rollout.yaml` for the following sequence.
Both sites must be reachable; a missing public CA stops before changes.

1. `infra/headlamp/deploy.yaml` collects both public CAs and deploys the UI.
2. Apply the updated network matrix through `infra/network/isolate.yaml`.
3. Apply the observability gateway configuration and wait for its rollout.
4. Roll nginx on each site, then `infra/ingress/cutover.yaml`.
5. Verify unauthenticated Kubernetes requests are denied and both contexts work.
6. Remove one site's Headlamp endpoints, verify the public route still works,
   restore replicas and repeat for the other site. This checks routing failover,
   not a full server/power outage.

UI edits change live desired state. They do not update Git: the next deployment
can overwrite them. Persist intended overrides in the service/site config.
The UI does not replace GitHub CI or its per-service deployment workflow.

## Verification

`python3 infra/headlamp/tests/verify_live.py` checks both Kubernetes API contexts,
anonymous denial and denial of secret reads. `--failover` additionally scales
only Headlamp to zero on one site at a time and restores the original replica
count in a `finally` block. It requires operator SSH and temporarily reduces UI
redundancy. It does not stop application pods or servers.

Validated on 2026-10-28: both sites 2/2 ready; both API contexts reachable through
either UI site, anonymous requests 401 and secret reads 403. UI-only failover
passed in both directions. A full server/network outage was not injected.

## OIDC callback routing

The login request and callback must reach the same Headlamp process: OIDC
state/PKCE state is process-local. HAProxy sets a Secure/HttpOnly routing cookie
`HEADLAMP_SITE`; both ingress instances use the same site identifiers. The
Headlamp Service uses ClientIP affinity behind the single observability gateway
per site. This primarily uses one Headlamp replica per gateway; the other remains
ready for failover. This is not per-browser load balancing inside a site.

If a replica/site disappears during login, start login again from `/k8s/`;
do not reload an old callback URL. Affinity does not replicate pending OIDC state.
Both nginx hops allow 32 KiB response headers and larger request headers for
OIDC cookies for both cluster contexts. Automatic OIDC redirect avoids depending
on popup support in embedded browsers. TLS, PKCE and role validation stay enabled.

On 2026-10-28 a real browser OIDC session loaded both YC and home overviews after
these fixes. This check does not establish that an in-progress login survives a
site failure without restarting the login flow.

## OIDC subpath hotfix (v0.46.0)

`patches/oidc-base-path.patch` fixes refresh lookup under `/k8s`, preserves the
refreshed Authorization header rather than replacing it with an old cookie,
and returns 401 for missing user credentials instead of a client-go proxy 502.
No shared Kubernetes token or relaxed JWT validation is used.

Build only on a workstation or CI. Fetch the upstream v0.46.0 source, apply the
patch with `patch -p1`, then run in its `backend` directory:

```sh
go test ./pkg/auth ./pkg/kubeconfig
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o ../headlamp-server ./cmd
```

Upstream source archive SHA-256: `9b89a1cf41d56115254f68f6c6740fd755ce14edd80e183624628a703ea0ac06`.

The base image is `ghcr.io/headlamp-k8s/headlamp@sha256:fcc6a6b011a8c0adbf4489384588442224c01f74b6f63739e50b089d54b98371`
(linux/amd64). Export it as an OCI archive, then run
`python3 infra/headlamp/build-image.py BASE.oci.tar headlamp-server COMMIT OUTPUT.oci.tar`.
The packager validates base and result blob digests and records source revision
and patch hash. Publish with the operator's existing registry publisher identity;
`defaults.yaml` pins the resulting immutable digest. This infrastructure image
is not added to the application CD service selector.

An OIDC acceptance check must run longer than Keycloak's 300-second access-token
lifetime and load both cluster contexts, including SelfSubjectRulesReview.
Short-lived tokens must not be made long-lived to hide refresh failures.

OIDC token broadcast is disabled: upstream 0.46 broadcasts only at login, while
refresh updates a single cluster cookie and expires the shared cache entry after
10 seconds. Each cluster therefore establishes its own OIDC session through
Keycloak SSO and refreshes it independently. No access-token lifetime is extended.
