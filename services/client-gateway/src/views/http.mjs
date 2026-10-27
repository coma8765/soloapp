import { timingSafeEqual } from 'node:crypto';
export function authenticated(request, token) {
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw new Error('too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export function publicHandler(gateway) {
  return (request, response) => {
    if (
      request.method === 'GET' &&
      ['/healthz', '/health/ready'].includes(request.url)
    ) {
      response.writeHead(
        request.url === '/healthz' || gateway.ready ? 200 : 503,
        { 'Content-Type': 'application/json' },
      );
      response.end(
        JSON.stringify({ status: gateway.ready ? 'ok' : 'starting' }),
      );
    } else if (request.method === 'GET' && request.url === '/metrics') {
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      const lines = [
        `client_gateway_ready ${gateway.ready ? 1 : 0}`,
        `client_gateway_connections ${gateway.connections.size}`,
      ];
      for (const [key, value] of Object.entries(gateway.metrics))
        lines.push(`client_gateway_${key}_total ${value}`);
      response.end(lines.join('\n') + '\n');
    } else {
      response.writeHead(404);
      response.end();
    }
  };
}
export function internalHandler(gateway, token, routes) {
  if (typeof token !== 'string' || token.length < 32)
    throw new Error('Gateway token required');
  return async (request, response) => {
    if (!authenticated(request, token)) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (
      request.method !== 'POST' ||
      ![routes.delivery, routes.cancel].includes(request.url)
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    try {
      const task = await body(request);
      if (request.url === routes.cancel) {
        await gateway.cancel(task);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"cancelled":true}');
      } else {
        const delivered = await gateway.deliver(task, abort.signal);
        if (response.destroyed) return;
        response.writeHead(delivered ? 200 : 408, {
          'Content-Type': 'application/json',
        });
        response.end(
          JSON.stringify({
            task_id: task.task_id,
            attempt: task.attempt,
            status: delivered ? 'delivered' : 'pending',
          }),
        );
      }
    } catch {
      if (!response.destroyed) {
        response.writeHead(503);
        response.end('{"error":"delivery_unavailable"}');
      }
    }
  };
}
