const MAX_BYTES = 262144;
const encoder = new TextEncoder();
const text = (value, max = 512) => typeof value === 'string' ? value.slice(0, max) : '';

async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 256) return false;
  const hashes = await Promise.all([supplied, `Bearer ${secret}`].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(hashes[0]), b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readPayload(request) {
  if (!request.body || Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) {
    throw new Error('Invalid body size');
  }
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) { await reader.cancel(); throw new Error('Body too large'); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const payload = JSON.parse(new TextDecoder().decode(buffer));
  if (!['firing', 'resolved'].includes(payload.status) || !Array.isArray(payload.alerts) ||
      payload.alerts.length < 1 || payload.alerts.length > 100 ||
      payload.alerts.some(alert => !alert || !['firing', 'resolved'].includes(alert.status) ||
        alert.labels?.project !== 'soloapp')) throw new Error('Invalid alerts');
  return payload;
}

export function messages(payload) {
  const heading = `Soloapp ${payload.status.toUpperCase()}\n`;
  const result = []; let current = heading;
  for (const alert of payload.alerts) {
    const labels = alert.labels;
    const details = ['dc', 'service', 'namespace', 'pod', 'container', 'route', 'deployment']
      .filter(key => labels[key]).map(key => `${key}=${text(labels[key])}`).join('\n');
    const entry = `\n${text(labels.alertname)} [${alert.status}]\n${details}\n` +
      `${text(alert.annotations?.summary, 700)}\n${text(alert.annotations?.description, 1500)}\n`;
    // Split long plain-text entries as well: no Telegram parse_mode or external links.
    for (let offset = 0; offset < entry.length; offset += 3500) {
      const part = entry.slice(offset, offset + 3500);
      if (current.length + part.length > 3900) { result.push(current); current = heading; }
      current += part;
    }
  }
  if (payload.truncatedAlerts > 0) {
    const warning = `\nAlertmanager truncated ${Number(payload.truncatedAlerts)} alerts; inspect Grafana.\n`;
    if (current.length + warning.length > 3900) { result.push(current); current = heading; }
    current += warning;
  }
  if (current !== heading) result.push(current);
  return result;
}

export async function handle(request, env, send = fetch) {
  const path = new URL(request.url).pathname;
  if (path !== '/alerts') return new Response('Not found', {status: 404});
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
  if (!await authorized(request, env.RELAY_TOKEN)) return new Response('Unauthorized', {status: 401});
  if (!env.TELEGRAM_BOT_TOKEN || !/^-?\d+$/.test(env.TELEGRAM_CHAT_ID || '')) {
    return new Response('Relay unavailable', {status: 503});
  }
  let payload;
  try { payload = await readPayload(request); }
  catch { return new Response('Invalid alert payload', {status: 400}); }
  let failure = 'transport';
  try {
    for (const message of messages(payload)) {
      const response = await send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({chat_id: env.TELEGRAM_CHAT_ID, text: message,
          link_preview_options: {is_disabled: true}}),
      });
      if (!response.ok) { failure = `telegram-http-${response.status}`; throw new Error('Delivery failed'); }
      failure = 'telegram-response';
      if ((await response.json()).ok !== true) throw new Error('Delivery failed');
      failure = 'transport';
    }
    return new Response(null, {status: 204});
  } catch (error) {
    if (failure === 'transport' && ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)) failure += '-' + error.name;
    // Never return/log Telegram responses or token-bearing URLs; Alertmanager retries.
    return new Response('Delivery temporarily unavailable', {status: 503, headers: {'X-Relay-Error': failure}});
  }
}
export default {fetch(request, env) { return handle(request, env); }};
