# Telegram relay

The Cloudflare Worker provides independent Telegram egress for both Alertmanagers.
It accepts only POST /alerts with a dedicated Bearer credential, validates Soloapp
Alertmanager payloads (256 KiB / 100 alerts maximum), and forwards plain text to a
fixed bot and chat. Callers cannot choose a target URL or chat. Messages include
status/severity, DC, service, exact pod/container/check/route, measured condition, next action and UTC timestamps. Links open the configured Grafana dashboard with incident filters/time range and the public alert runbook; caller-provided URLs are ignored. Long groups split
below Telegram's message limit. Telegram failures return generic retryable 503.
No request bodies, authorization headers or token-bearing URLs are logged.

`src/worker.mjs` has no dependencies or build step. Local/CI checks:

```sh
node --test infra/telegram-relay/tests/worker.test.mjs
```

## Deployment and secrets

Initialize Alertmanager identities and the operator bot secret using
`infra/observability/bootstrap-alerting.py`. With the operator's existing YC login
and `CF_ACCOUNT_ID` / `CF_API_TOKEN` environment (Workers Scripts Write), run:

```sh
.venv-codegen/bin/python infra/telegram-relay/deploy.py --subdomain <workers-subdomain> \
  --hostname <relay-hostname> --zone-name <cloudflare-zone> \
  --grafana-url https://<public-host>/grafana/
ansible-playbook infra/observability/deploy.yaml --tags stores
```

The subdomain is created only when absent; an existing account subdomain is reused.
Only the `soloapp-alert-relay` script is uploaded, with encrypted secret_text bindings
RELAY_TOKEN, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. Preview URLs and Worker logs
are disabled. The optional custom hostname is registered with Cloudflare Workers and disables the
workers.dev endpoint. Without it, the endpoint uses workers.dev. Both use HTTPS
independently of our sites; subsequent deployments reuse the recorded hostname.
The bot secret remains in operator-only Lockbox as the deployment source; each
Alertmanager identity can read only the separate relay-token secret. Secret values
travel through stdin or API bodies in memory, never command arguments or files.
The local ignored resources.json holds IDs and endpoint, not keys.

After migrating existing direct Telegram receivers, revoke both Alertmanager
identities' payloadViewer bindings on the old alertmanager-telegram secret, once both
new pods are healthy. This prevents workloads from recovering the bot token.
For credential rotation, create a new Lockbox version and rerun deploy.py; changing
the relay key causes a possible brief retry window until the five-minute refresh.
Telegram token/chat changes only require Worker redeployment. Do not delete the old
secret or other identities' access as part of this migration.

## Delivery semantics

Alertmanager's HA notification log deduplicates normal sends across sites. Retries,
network partitions, or partial multi-message deliveries can duplicate messages;
this relay does not promise exactly-once delivery. It returns success only after
Telegram accepts every chunk. There is no relay queue or stored alert payload.
`TelegramDeliveryFailed` monitors Alertmanager webhook failures. Delivery depends
on Cloudflare and Telegram availability/quotas, but not on the other application DC.
Possession of the relay key permits sending project-shaped alerts to this one chat;
it does not provide bot administration or access to another chat. Only the two
Alertmanager workload identities and trusted operators receive this credential.

`GRAFANA_URL` is a non-secret Worker binding configured by `--grafana-url` and reused
from local deployment state. It must use HTTPS, end with `/grafana/`, and contain no
credentials or query parameters. Dashboard UIDs come from a fixed service map; unknown
utilities link to infrastructure. Recovery messages explicitly identify incident values
as historical. See [alert timing and runbooks](../observability/deploy/metrics/README.md).
