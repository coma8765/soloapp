# Pod health and 5xx ejection

Auth and whoami record all HTTP 500–599 responses in the shared `libs/runtime/health.hpp` circuit. Default: three errors within a sliding 10-second window make the pod's `/health/ready` return 503 for 15 seconds. Health endpoints (`/healthz`, `/health/ready`, auth `/ready`) are excluded from accounting. 2xx/4xx do not count; successes do not reset the window. Circuit responses do not extend its cooldown. Each process has independent state; no Kubernetes API credentials are required.

Kubernetes checks `/health/ready` every 2 seconds with a 1-second timeout. Two failures remove the pod from ready Service EndpointSlices; two successes after cooldown restore it. Endpoint propagation adds a small delay. Existing requests/connections are not forcibly terminated. A persistent failure can cause another ejection after the pod returns. If all replicas fail, all can become unready; this mechanism cannot repair a shared dependency.

Liveness uses `/healthz` every 5 seconds, timeout 2 seconds, threshold 6. This checks the HTTP event loop independently of PostgreSQL and the 5xx circuit. Restart is initiated after roughly 30 seconds of failures, followed by normal preStop/grace processing. Startup probes allow approximately 120 seconds. Whoami readiness also checks HMAC signing/verification, preserving its previous functional check.

Nginx probes its own `/healthz`. A downstream auth/whoami 5xx ejects the originating application pod, not the gateway pod: the latter also serves Grafana. Auth's DB-aware `/ready` remains the site-level HAProxy check. No automatic retries of POST requests were added.

Defaults: `infra/kubernetes/defaults.yaml`. Override independently in `infra/ansible/host_vars/yc.yaml` or `home.yaml`, or in service deploy defaults:

```yaml
service_overrides:
  auth:
    replicas: 2
    health:
      error_threshold: 3
      window_seconds: 10
      cooldown_seconds: 15
    probes:
      readiness:
        period_seconds: 2
        timeout_seconds: 1
        failure_threshold: 2
        success_threshold: 2
      liveness:
        period_seconds: 5
        timeout_seconds: 2
        failure_threshold: 6
```

`health` applies to the C++ services; `probes` applies to auth, whoami and nginx. Positive health values must be in 1..3600. Ansible also requires cooldown to cover readiness detection (period × failure threshold + timeout). Docker configuration uses `HEALTH_ERROR_THRESHOLD`, `HEALTH_WINDOW_SECONDS`, `HEALTH_COOLDOWN_SECONDS`. Apply through `ansible-playbook infra/ansible/apps.yaml`. The play rolls one site at a time with maxUnavailable=0, maxSurge=1.

Tests: `make test-auth test-whoami TAG=v5-health`. `infra/kubernetes/tests/health_ejection.py` runs on an app host as root and temporarily rejects PostgreSQL connections from one auth pod only; it restores rules in finally and has a 120-second systemd watchdog. It verifies 503 responses, EndpointSlice exclusion, recovery, and no container restart. Run only as an explicit live fault test.
