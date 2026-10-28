# Headlamp

URL: `https://<public_domain>/k8s/`. Two stateless pods per site, ClusterIP
Service, RollingUpdate (zero unavailable), PDB. Both instances use the same two
context names: `yc` and `home`. Losing a site loses its Kubernetes API, but the UI
and the remaining cluster remain usable. Watches/WebSockets reconnect after a
connection failure; an existing TCP connection cannot move between servers.

## Access

The UI workload has **no Kubernetes credentials or RBAC bindings**. Its mounted
kubeconfig contains only public CA certificates and private API endpoints.
For each cluster, run `python3 infra/headlamp/login.py yc` (or `home`) from the
operator Mac, then paste the clipboard into the corresponding cluster login.
The token expires in one hour. No token is written to a file, Git or chat.
Clear the clipboard afterwards: `pbcopy </dev/null`.

The human operator can read application workloads/logs and edit/scale the six
existing application Deployments in `soloapp`. No secret reads, exec, RBAC edits,
namespace deletion or infrastructure editing. Deployment editing is nevertheless
a privileged operation: changing its image/volumes can execute code with that
application's identity. Grant this identity only to trusted operators.
The UI itself has no access to metadata, public Internet, databases or Lockbox;
only the two Kubernetes API servers on private TCP/6443 are permitted.

This uses the same HTTPS origin as the application. Treat application/frontend
code as trusted: a same-origin compromise can issue authenticated UI requests.
A dedicated origin plus federated per-user OIDC is a subsequent hardening option.

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
