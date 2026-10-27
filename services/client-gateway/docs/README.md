# client-gateway

Two independent Kubernetes replicas per DC terminate authenticated browser sockets.
The public route remains `/api/v1/app-api/v1/chat/ws`; nginx generates its backend
from app-api's `docs/api.yaml` (`x-upstream: client-gateway`). A single-use, 30-second
PostgreSQL ticket binds each connection to a verified account. Connections renew
session authorization after 60 seconds. No bearer token is put in the URL.

client-notify calls the private HTTPS/mTLS port 8443 with an additional scoped token.
Gateway records the current task attempt in PostgreSQL and broadcasts only its ID
with LISTEN/NOTIFY. All gateway instances look up the durable attempt and send to
local sockets for that account. LISTEN/NOTIFY is a wakeup mechanism, not a durable
queue. Lost wakeups are recovered by client-notify's retry.

A browser acknowledges `{type: ack, task_id, attempt}` after merging the message by
its stable ID. Only an ACK from that account, for the active unexpired attempt, marks
the durable receipt done. The waiting HTTP call then returns `status: delivered`.
An ACK proves browser application receipt, not that a human read the message.
The first matching socket ACK completes this account-level delivery; it does not
promise every tab/device received it. Offline accounts retrieve chat history.

Delivery timeout is 10s. Cancellation fences only the specified attempt. Retrying a
completed task returns the stored result. Network retries may produce repeated
frames; the Flutter client deduplicates message IDs. There is no exactly-once claim.

`make codegen-client-gateway`, `make test-client-gateway`, `make build-client-gateway`.
CI integration tests use real PostgreSQL and a real WebSocket across two gateway
instances. Runtime images are built locally/CI, never on application hosts.
