# Realtime chat

The HTTP and WebSocket route paths are generated from `api.yaml`.

1. POST `chat/socket-ticket` with Bearer session; nginx validates the session and signs
   the identity. A random single-use ticket is stored for 30 seconds in Redis.
2. Open WSS `chat/ws` with subprotocols `soloapp.chat.v1` and `ticket.<ticket>`.
   The server checks the Origin when present, consumes the ticket with GETDEL before
   upgrade, and selects only `soloapp.chat.v1`. No credentials go in URLs or logs.
3. Receive JSON `{type: history, messages: [...]}`, `{type: message, message: {...}}`
   and `{type: ping}` frames. Message DTOs use the ChatMessage schema in api.yaml.
4. Sending remains authenticated HTTP POST `chat/messages`, with the existing shared
   quota and idempotency key. All receiving browsers get the event through XREAD/WSS.

The browser merges by stream ID and retains the newest 100 messages. Disconnects trigger
reconnection with 0.5–10s exponential backoff and jitter, a new ticket, and history replay.
No periodic history fetch runs. A ping/pong heartbeat runs every 15s; the client detects
a silent link after 40s. The socket closes after 60s to obtain a freshly verified session
(maximum logout/revocation exposure approximately 60s). Session expiry stops reconnecting.

Per pod limits: 512 sockets/pending upgrades, 8 sockets per user, 256 KiB outgoing buffer
per socket, 1 KiB incoming frames, no compression. WebSocket input cannot bypass the HTTP
send authorization/quota. There is one Redis stream reader per pod, not per browser.
During Redis errors or credential rotation, sockets reconnect and recover bounded history.
Delivery is not a durable consumer acknowledgment protocol; a gap exceeding the retained
history or Redis asynchronous-replication loss cannot be recovered.

Deploy Redis ACL first, then app-api, nginx and web. Existing HTTP chat clients remain
compatible throughout. nginx explicitly proxies Upgrade/Connection and allows 45s idle
reads, longer than the heartbeat; HAProxy's 20s idle timeout also exceeds the heartbeat.

HTTP latency panels and the app-api latency alert exclude status 101: nginx records
the complete upgraded connection lifetime, which is not message-delivery latency.
Status counters still include WebSocket handshakes.
