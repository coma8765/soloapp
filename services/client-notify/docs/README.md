# client-notify

C++17/Drogon delivery worker with PostgreSQL/ODB and a RabbitMQ **quorum queue**, not Streams.
Each DC has an independent two-node RabbitMQ cluster and two client-notify pods.
Both deployments share PostgreSQL task state. The surviving site's reconciler
republishes expired unfinished tasks into its local queue; it does not depend on
queue replication between the clusters. See `infra/rabbitmq/README.md`.

## Contract

Internal authenticated POST `/api/v1/client-notify/v1/tasks` accepts `task_id`, `recipient`,
`payload` (a UTF-8 string). `task_id` is the caller-generated stable idempotency key, 16–128
ASCII letters/digits/underscore/hyphen. The fixed configured gateway receives the data;
callers cannot supply arbitrary callback URLs. A successful HTTP 202 means **committed to
PostgreSQL**, not delivered. Reusing a key with different contents returns 409. POST
`/api/v1/client-notify/v1/status` accepts `task_id` and returns pending/inflight/done.

Timeouts in `deploy/defaults.yaml` support per-site `service_overrides.client_notify` and
are passed as `NOTIFY_ACK_TIMEOUT_MS`, `NOTIFY_DELIVERY_TIMEOUT_MS`, `NOTIFY_RETRY_DELAY_MS`.
Environment overrides take precedence over the secret JSON configuration.

Task and outbox state are one row committed atomically. The publisher sends only its ID
as a persistent AMQP message, uses mandatory routing and publisher confirms, and marks
publication afterwards. A crash between confirmation and commit may duplicate the queue
entry; an optimistic ODB version, attempt counter and database lease prevent concurrent
ownership. A reconciler republishes overdue unfinished tasks if broker state is lost.

Each service pod has a publisher connection and a separate manual-ACK consumer connection
with prefetch=1. The consumer reloads the task from the primary, claims a lease, and POSTs
`/internal/delivery` to the configured gateway. HTTP 200 plus matching `task_id`, `attempt`
and `status: delivered` is required. It commits `done` **before** ACK. On redelivery a done
task is ACKed without contacting the gateway. An error/timeout marks it retryable and sends
NACK(requeue=true). Retries have a configurable one-second delay and no attempt limit.

## Deadlines and cancellation

* `delivery_timeout_ms: 10000`: total HTTP request deadline (including connect), libcurl
  closes the local request on expiry. Redirects are disabled; connect timeout is 1 second.
* `ack_timeout_ms: 30000`: application watchdog starts when RabbitMQ delivers the task.
  At expiry it shuts down the consumer socket, causing unacked work to be requeued once
  the broker detects closure. It also signals HTTP cancellation. OS scheduling/network
  detection can add delay; this is not a hard real-time scheduling guarantee.
* RabbitMQ's broker-side `consumer-timeout` is **60000 ms** as a fallback. A broker setting
  of 30000 is unsupported (RabbitMQ checks on a minute cadence). The exact requested 30s
  operational deadline is implemented by the service, not misrepresented as broker policy.

On failed delivery a bounded independent worker submits `/internal/delivery/cancel` with
`task_id` and `attempt`, a one-second network timeout, without awaiting its response in the
delivery loop. A later cancellation of attempt N must NEVER cancel N+1. Local timeout cannot
undo a remote side effect: the gateway contract below is required, not optional.

## Gateway contract

Request headers: `Authorization: Bearer <gateway token>`, `Idempotency-Key: <task_id>`.
Body: `{task_id, attempt, deadline_ms, recipient, payload}`. The attempt number is monotonic;
the task ID is stable across retries. Cancellation body contains `{task_id, attempt}`.

The gateway must durably deduplicate effects by task ID, fence older/cancelled attempts,
reject attempts after the deadline, and apply cancellation only to that exact attempt.
A repeat of a previously completed task returns the cached successful outcome using the
current request's attempt number. It must keep completion records at least as long as tasks
can be retried. A best-effort HTTP cancellation packet alone cannot guarantee cancellation.

Success response: `{"task_id":"...","attempt":1,"status":"delivered"}` with HTTP 200.
This proves only what the gateway promises. If delivery to the browser is required, the
gateway must wait for the browser's application-level ACK before sending this response.
Writing bytes to a WebSocket is not proof of receipt/read. No exactly-once claim is made.

## Configuration and deployment

`docs/api.yaml` generates `src/generated/api.hpp`; ODB generates `src/generated/odb`
during build. `make client-notify`, `make test-client-notify`, `make codegen-client-notify`.
Tests run a disposable RabbitMQ broker and testsuite-managed PostgreSQL, not production.
`tests/rabbitmq-definitions.json` uses one replica ONLY for isolated CI.

Production needs separately scoped Lockbox credentials, service account federation and
network grants. Never commit live credentials. Mount from tmpfs: `database-url`, `api-token`,
`notify-config.json`, CA/client certificate/private key. Database role needs SELECT/INSERT/
UPDATE only on `notify_tasks`; no auth tables, DDL or superuser rights. Use a primary-aware
libpq DSN with `target_session_attrs=read-write`, `connect_timeout=2`, `statement_timeout=4000`
and `lock_timeout=2000`. Apply `deploy/schema.sql` once as the migration owner.

Broker vhost `/soloapp`; operator declares durable quorum queue `client-notify` with
`x-delivery-limit=-1`. Runtime permissions: configure `^$`, write `^amq\.default$`, read `^client-notify$`.
No TTL, max-length drop policy or finite delivery limit: failures remain pending until success.
Alert on age/attempts and outbox growth; unlimited retry is not unlimited disk capacity.
The pending task table contains user payloads. No automatic task deletion is configured;
completed-task retention must preserve the agreed idempotency window.

`deploy/ansible/deploy.yaml` rolls two replicas per site using an immutable image digest and
an explicitly provisioned identity. Deployment does not create IAM privileges or apply DDL.
`deploy/k8s/networkpolicy.yaml.j2` is an explicit allowlist to combine with default-deny.
TLS verification is mandatory; plaintext is allowed only with the explicit test-only env
`NOTIFY_TEST_ALLOW_PLAINTEXT`. Broker passwords and gateway token are loaded at startup;
rotate via overlapping credentials and rolling restart. Deployments use the separate `client-gateway` receiver.

A task becomes eligible on the surviving site when it is unfinished and due, and
its publication/worker lease expires (or needs_publish is set). This is checked
once per second. Republishing an expired in-flight task never renews the dead
worker lease. PostgreSQL must have a writable primary; a broker alone cannot
complete deliveries while the task database is unavailable.
