# Observability

Grafana: https://<public_domain>/grafana/ . Dashboard UID: `soloapp-overview`.

Each independent k3s cluster runs Grafana, Prometheus, Loki, an mTLS gateway, Alloy and kube-state-metrics. Alloy sends metrics and application logs to both sites over WireGuard and mutually authenticated TLS. Grafana queries its local Prometheus and Loki. HAProxy routes `/grafana/` to the healthy site (YC preferred, home backup); its separate Grafana health check does not use PostgreSQL readiness. The shared public NLB checks ingress availability. During PostgreSQL promotion, ingress stays eligible when Grafana is healthy and the existing third-site witness is reachable over WireGuard. An isolated ingress fails this check. This is only routing health; PostgreSQL fencing and promotion rules are unchanged. A whole-site failure can still cause a brief ingress convergence period.

Losing either site leaves a complete monitoring stack and previously delivered data on the other site. New samples from the failed site stop; samples from the surviving site continue. Each store has independent local-path PVCs. This is dual delivery, not a replicated storage cluster: delivery gaps and different histories are possible. Prometheus remote-write uses a local WAL with bounded retention; Loki delivery is best-effort and may lose logs during a prolonged outage. Losing both disks loses history.

Grafana instances have independent SQLite user/session databases. The initial admin password is shared through Lockbox; dashboards and datasources are provisioned from this directory. Failover may require signing in again. UI changes to users/passwords are local to one instance; do not rely on them for replicated configuration. Save shared dashboards and configuration here and redeploy. A shared Grafana database is deliberately not required for monitoring availability.

## Metrics and logs

* Per-DC deployment desired/available replicas, pod restarts, node readiness.
* Container CPU cores, CPU throttling, working-set memory, percentage of configured memory limit.
* Public HTTP request rate, status codes, p50/p95/p99 estimated from histogram buckets, grouped by bounded route and DC.
* Application stdout/stderr and nginx JSON access logs in Loki, with DC/service/pod filters.

HTTP metrics measure complete requests observed by nginx, including auth checks for `/user-id`. They do not measure requests rejected before nginx or isolated C++ handler execution time. Internal auth subrequests and health probes are not counted twice. Histogram buckets are configured in `templates/alloy.alloy.j2`; percentiles below the first bucket (5 ms) are approximate. Rate panels need at least two scrapes. Logs use bounded routes without query strings, bodies, Authorization headers, session tokens or client IPs in access logs.

## Configuration and deployment

`defaults.yaml` defines versions, resource budgets, retention, storage requests and gateway port. `observability_overrides` in `infra/ansible/group_vars/all.yaml` or per-DC `host_vars` recursively overrides these values. Keep the gateway port the same on both sites. Service replicas are configured independently of monitoring.

```sh
ansible-playbook infra/observability/deploy.yaml
ansible-playbook infra/ansible/apps.yaml --tags nginx
ansible-playbook infra/ingress/cutover.yaml
ansible-playbook infra/ansible/site.yaml --tags certificates --limit app_sites
python3 infra/observability/tests/verify.py
```

The observability playbook installs the private NodePort guard before exposing gateway Service 31981. It deploys stores one DC at a time. Monitoring components have one replica per site and Recreate updates; the second site remains available during an individual stack update. Application Deployments retain their two-replica RollingUpdate configuration.

Retention defaults: metrics 3 days / 1 GiB TSDB blocks, logs 72 hours. PVC requests: Prometheus/Loki 2 GiB each, Grafana/Alloy 256 MiB each. K3s local-path requests are not disk quotas; Prometheus WAL and head storage are additional to its retention size. Monitor host free space and adapt retention to actual traffic. Default container memory limits total about 2.6 GiB per site including secret-fetch helpers; actual usage is lower and should be measured in the dashboard. CPU and memory requests/limits are in `defaults.yaml`.

## Access and secrets

Login `admin`; initial `admin-password` is stored in the `soloapp-grafana-admin` Lockbox secret (ID in `infra/cloud/resources.json`). Retrieve it through the Yandex Cloud Lockbox UI with your account; do not place it in manifests or repository files. Only each Grafana service identity can read this secret. Grafana stores its password hash in its private SQLite volume.

Each agent/gateway has its own scoped workload identity and TLS secret. Projected Kubernetes identity tokens expire after 600 seconds. Secret material is delivered to a RAM-backed volume; CA private key remains accessible only to the certificate issuer. The certificate CronJobs cover monitoring certificates. Grafana's initial password is not automatically changed by updating Lockbox after SQLite initialization; password rotation must update both instances explicitly.

Prometheus and Loki are not publicly exposed. NetworkPolicy limits their access to the monitoring gateway and Grafana. The gateway accepts writes only from agent certificate identities and Grafana requests only from nginx certificate identities. Public access to Grafana requires its own authentication; anonymous access and signup are disabled.

Prometheus evaluates replica availability, missing DC agent samples, HTTP error-rate and latency rules. Notifications are not configured; rules are visible in Prometheus/Grafana queries. This deployment does not include Alertmanager, distributed tracing or SQL-text/query-level profiling.

References: [Alloy remote-write fan-out](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.remote_write/), [Grafana home dashboard provisioning](https://grafana.com/docs/grafana/latest/administration/organization-preferences/).

Alloy reads `nodes/metrics` only for its local node over verified kubelet TLS; it has no `nodes/proxy`, exec, secret-read or workload-write permission. Application pod discovery/log access and kube-state-metrics workload reads are enforced by Roles in `soloapp`; only node state is cluster-scoped. See [Kubelet authorization](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-authn-authz/).

## Separate dashboards and HTTP health probes

Navigation: `soloapp-overview`, `soloapp-auth`, `soloapp-whoami`, `soloapp-nginx`, `soloapp-infrastructure` (under `/grafana/d/<uid>`). Source JSON files are generated reproducibly by `python3 infra/observability/dashboards/generate.py`; `dashboard_files` provisions the explicit list to both sites. Application dashboards fix the service label and filter CPU/memory/restarts by application container. The application pod selector applies to health/resource/application-log panels; business HTTP metrics and gateway logs are measured at nginx and are service/DC aggregates.

Each local Alloy probes every running app pod, including unready pods, every `health_probe_interval` (default 5s), with `health_probe_timeout` 2s. Auth: `/healthz`, `/health/ready`, `/ready`; whoami: `/healthz`, `/health/ready`; nginx: `/healthz` on its internal health port (also its readiness check). That is 14 targets per site / 28 total for two replicas per service. These independent observational probes do not control pod scheduling and do not add business RPS. Kubelet readiness/liveness probes remain responsible for traffic exclusion/restarts.

Panels show per-pod availability, real HTTP status (0 means no HTTP response), end-to-end probe duration and sample age. UP requires a sample younger than 20s; older samples are shown as STALE (orange), and absent data remains a gap. Missing data is never synthesized as success. If the interval is raised above 5s, adjust the 20s freshness horizon in the generator to cover at least several intervals. Data starts when the new probes are deployed, not retroactively. Auth DB readiness is separate from process liveness. `/user-id` client-visible errors/latency include nginx's auth verification and are not pure whoami handler timings.

The probe component is built into Alloy; no new privileged pod or secret is needed. Additive NetworkPolicies allow only pods labeled `app=alloy` in namespace `observability` to the C++ HTTP ports (their health endpoints share the application listener). Existing application authentication still applies. No new kubelet/exec RBAC is granted. Metrics use the existing mTLS dual delivery to both Prometheus stores.

## Routing exclusions: NLB → ingress → DC → Service → pod

Dashboard `soloapp-routing` shows the separate control decisions rather than inferring exclusion from a synthetic ping:

* YC `getTargetStates`: each ingress target's actual HEALTHY/UNHEALTHY/INITIAL/DRAINING/INACTIVE state. NLB targets are YC and edge ingress VMs, not the home DC directly. This API does not expose an exact timeout reason or per-probe latency.
* Native HAProxy exporter: auth/Grafana backend UP/DOWN/MAINT/DRAIN/NOLB, check result (connection error, TLS/HTTP timeout, unexpected HTTP status), HTTP code, last check duration, UP→DOWN counter and selected session rate. Home Grafana is a healthy backup; UP does not imply active traffic.
* kube-state-metrics EndpointSlice data: ready/non-terminating members of each Service, plus kubelet pod Ready conditions. This is independent of Alloy's HTTP health probes. Only `list/watch` on EndpointSlices in `soloapp` is added; no workload write or secret permissions.
* Per-pod `/healthz` and readiness probe histories remain available alongside the actual routing decisions.

Both DCs independently observe both ingress proxies and the NLB, and send results to both stores. Keep the `observer` label when diagnosing a partition; the same HAProxy counters are observed twice and must not be summed across observers. NLB and HAProxy status panels mark samples older than 20s as STALE; NLB additionally checks the last successful API-poll timestamp. Missing data is not a healthy routing state. HAProxy status may remain visible briefly while a scrape has already failed: consult the collection panel. The dashboard is sampled history, not an atomic distributed trace or proof of successful business transactions.

Configuration in `defaults.yaml`: `routing_scrape_interval` 5s, `routing_scrape_timeout` 2s, `state_scrape_interval` 5s, `nlb_poll_interval` 5s and `nlb_api_timeout` 2s. These control observation, not the actual routing thresholds. Actual NLB checks are 2s interval / 1s timeout / 2 failures; HAProxy uses 1s interval / 2 failures, connect timeout 2s and check timeout 4s (`ingress_ready_timeout_seconds` override). Pod health thresholds are documented in `infra/kubernetes/HEALTH.md`. A slow business handler does not automatically exclude a pod while readiness remains healthy. HAProxy auth `/ready` and Grafana health are separate; healthy Grafana can keep ingress eligible during DB promotion.

The exporter endpoint is published only on each ingress WireGuard address, port 19091, with server certificate verification and mandatory client certificate CN `observability-yc` or `observability-home`. It offers read-only metrics, not the HAProxy administrative API. Existing Lockbox TLS identities rotate as before. The initial Docker port migration drains one ingress from NLB, waits for exclusion and existing requests, replaces its container and waits for both targets to become healthy before continuing.

NLB access uses existing projected 600s Kubernetes identity tokens, exchanged for IAM tokens kept only in RAM. No new permanent key is created. Both monitoring service accounts have the explicitly approved `load-balancer.viewer` role at folder scope (the narrowest supported scope); this reads all NLB/target-group metadata in that folder and does not grant changes. Reproduce the grants with `ansible-playbook infra/observability/nlb-access.yaml` only with operator authorization. The sidecar uses the existing secrets helper image but does not mount TLS/Lockbox secret volumes; its endpoint binds localhost only.

Deploy ingress first (`infra/ingress/cutover.yaml`), then observability (`infra/observability/deploy.yaml`). Generate JSON with `python3 infra/observability/dashboards/generate.py`. Validate with `python3 infra/observability/tests/test_nlb_exporter.py` and `python3 infra/observability/tests/verify.py`.

The controlled test `python3 infra/observability/tests/routing_fault.py` temporarily drains only the YC ingress from NLB, then changes only one health-check destination to a local deliberately stalled HTTP listener. It verifies NLB UNHEALTHY, HAProxy DOWN and L7TOUT in both stores, then recovery to HEALTHY/UP/L7OK. The edge ingress must remain healthy. A 120s systemd watchdog and `finally` restore the original configuration. Run only during an authorized validation window; this test changes live routing eligibility temporarily.

`HAProxy — responses by status (selected range)` uses `increase(haproxy_server_http_responses_total[$__range])`, then deduplicates the two observers with `max` per ingress/backend/server/status class before summing. It shows estimated counts for the selected Grafana range as an instant bar gauge, respecting ingress/DC/observer filters. Classes are 1xx–5xx and other; individual 200/401/503 codes are not available in the native counter. These are backend user-traffic responses, not active health-check counts or errors generated by HAProxy without a backend response. Counter resets are handled; missing scrapes can still undercount and Prometheus extrapolation can produce fractional estimates (rounded in display). Health-check results and timing remain in adjacent panels.

The routing dashboard also has separate `HAProxy — Good RPS` (1xx/2xx/3xx) and `HAProxy — Bad RPS` (4xx/5xx/other) time-series panels. HTTP 4xx includes expected authorization denials; Bad is not exclusively server faults. These use `rate` over Grafana's adaptive rate interval and deduplicate observers before summing status classes; ingress/DC/observer filters apply.


## PostgreSQL: primary location and database health

Dashboard `soloapp-postgres` shows the current primary DC and a per-observer
primary/standby timeline, reachability, metric freshness/errors, synchronous
replicas, WAL gaps, connection states (including the ODB auth pool), transaction
rates, cache hits, row activity, temporary writes, locks, oldest open transaction,
deadlocks, database size and uptime. Navigation links appear on all dashboards.

Both Alloy agents connect to both physical database addresses, rather than a
primary-selecting DSN. Each physical observation keeps `dc` and `observer` labels;
aggregate counters use the maximum per-DC observer rate to avoid double counting.
The two independent Prometheus stores receive all samples. History starts with
installation; it is not reconstructed from earlier failovers.

The built-in [Alloy PostgreSQL exporter](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.postgres/)
uses the existing rotating observability mTLS certificates from Lockbox/RAM.
`postgres-access.yaml` grants certificate-only `monitor_yc`/`monitor_home` roles
`pg_monitor` and database CONNECT, with read-only sessions, 2s SQL timeout and
8-connection limit per role. These roles cannot SELECT users/sessions and have
no superuser, role-management, database-creation, replication or bypass-RLS
privileges. Queries export aggregates only: no SQL text, usernames, tokens,
passwords or application rows. No new permanent key or public endpoint is added.

```sh
ansible-playbook infra/observability/postgres-access.yaml
python3 infra/observability/dashboards/generate.py
ansible-playbook infra/observability/deploy.yaml
python3 infra/observability/tests/verify.py
# Selective updates:
ansible-playbook infra/observability/deploy.yaml --tags stores
ansible-playbook infra/observability/deploy.yaml --tags agents
```

Collection interval/timeout are configurable as `postgres_scrape_interval` (5s)
and `postgres_scrape_timeout` (4s). Keep the dashboard 20s freshness horizon above
several scrape intervals. Metric queries live in `files/postgres-queries.yaml`.
HBA/identity mapping is maintained by the shared PostgreSQL Ansible templates;
only observer identities from their DC's private/pod subnet can authenticate.

PRIMARY means `pg_is_in_recovery()=false`, not independent proof that fencing is
correct or a write can commit. Consult auth `/ready` and the observed-primary
count (normally 1). UNAVAILABLE means connection or collection failure; STALE
means no fresh sample for 20s. Missing samples remain unknown. Replication gap
is in bytes, not wall-clock delay; an idle standby's last-replay timestamp is
intentionally not presented as replication lag. Missing/disconnected replicas
are not shown as zero lag. TPS includes monitoring/readiness transactions.

## Grafana automation account

Each independent Grafana has a `codex-observer` service account with the Viewer
role. It can read provisioned dashboards and query Prometheus/Loki, but cannot
manage users, service accounts or dashboards. Its separate 30-day API token is
stored in the site's `soloapp-grafana-codex-yc` or
`soloapp-grafana-codex-home` Lockbox secret. Resource IDs and expiry metadata
are recorded in `infra/cloud/resources.json`; token values are not.

`libs/monitoring/grafana.py` fetches the site's token inside the Grafana pod
using its short-lived workload identity and runs API checks there. The token
is never exported to the caller or written to the repository.
`python3 infra/observability/tests/verify.py` uses this Viewer access for all
seven provisioned dashboards and their data sources. Personal home-dashboard
preferences are outside this service-account check.

`create-service-account.py` bootstraps accounts once and refuses to overwrite
an existing configuration. Initial bootstrap uses the admin password in the
pod's RAM volume. A temporary Lockbox editor grant is restricted to the new
token secret and is removed after delivery; only payloadViewer remains for
the corresponding Grafana workload identity. No automatic API-token rotation
is configured: renew the tokens and update each Lockbox payload before the
recorded expiry, then revoke the old Grafana tokens. Internal TLS certificate
rotation is separate and continues automatically.
