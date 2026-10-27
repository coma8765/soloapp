import { WebSocket, WebSocketServer } from 'ws';
export function attachSockets(http, gateway, origin, path) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
    handleProtocols: () => 'soloapp.chat.v1',
  });
  let pending = 0;
  const users = new Map();
  http.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const reject = (status) =>
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    if (request.url !== path) return reject(404);
    if (!gateway.ready || server.clients.size + pending >= 512)
      return reject(503);
    if (request.headers.origin && request.headers.origin !== origin)
      return reject(403);
    const protocols =
      request.headers['sec-websocket-protocol']
        ?.split(',')
        .map((p) => p.trim()) ?? [];
    const ticket = protocols
      .find((p) => /^ticket\.[0-9a-f]{64}$/.test(p))
      ?.slice(7);
    if (!ticket || !protocols.includes('soloapp.chat.v1')) return reject(401);
    pending++;
    void gateway.store
      .consumeTicket(ticket)
      .then((user) => {
        if (!user || !/^[0-9a-f]{32}$/.test(user)) return reject(401);
        if (socket.destroyed) return;
        if ((users.get(user) ?? 0) >= 8) return reject(429);
        server.handleUpgrade(request, socket, head, (ws) =>
          connected(ws, user),
        );
      })
      .catch(() => reject(503))
      .finally(() => pending--);
  });
  function connected(ws, user) {
    users.set(user, (users.get(user) ?? 0) + 1);
    let id,
      closed = false,
      alive = true,
      processing = 0;
    const send = (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256 * 1024) return ws.terminate();
      ws.send(JSON.stringify(event));
    };
    void gateway
      .addSocket(ws, user, send)
      .then(async (connection) => {
        id = connection;
        if (closed) {
          await gateway.removeSocket(id);
          return;
        }
        send({ type: 'history', ...(await gateway.store.history()) });
      })
      .catch(() => ws.close(1013, 'reconnect'));
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      send({ type: 'ping' });
      if (id)
        void gateway.refreshSocket(id).catch(() => ws.close(1013, 'reconnect'));
    }, 15000);
    const expiry = setTimeout(() => ws.close(4001, 'renew session'), 60000);
    ws.on('message', (raw) => {
      if (++processing > 16) {
        processing--;
        ws.close(1008, 'too many acknowledgements');
        return;
      }
      void Promise.resolve()
        .then(() => gateway.acknowledge(user, JSON.parse(raw.toString())))
        .catch(() => ws.close(1008, 'invalid acknowledgement'))
        .finally(() => processing--);
    });
    ws.on('error', () => {});
    ws.once('close', () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      if (id) void gateway.removeSocket(id);
      const count = (users.get(user) ?? 1) - 1;
      if (count) users.set(user, count);
      else users.delete(user);
    });
  }
  return () => {
    for (const ws of server.clients) ws.terminate();
    server.close();
  };
}
