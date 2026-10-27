const MAX_BYTES = 262144;
const encoder = new TextEncoder();
const text = (value, max = 512) =>
  typeof value === 'string' ? value.slice(0, max) : '';

async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get('Authorization') || '';
  if (supplied.length > 256) return false;
  const hashes = await Promise.all(
    [supplied, `Bearer ${secret}`].map((value) =>
      crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
  const a = new Uint8Array(hashes[0]),
    b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readPayload(request) {
  if (
    !request.body ||
    Number(request.headers.get('Content-Length') || 0) > MAX_BYTES
  ) {
    throw new Error('Invalid body size');
  }
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const payload = JSON.parse(new TextDecoder().decode(buffer));
  if (
    !['firing', 'resolved'].includes(payload.status) ||
    !Array.isArray(payload.alerts) ||
    payload.alerts.length < 1 ||
    payload.alerts.length > 100 ||
    payload.alerts.some(
      (alert) =>
        !alert ||
        !['firing', 'resolved'].includes(alert.status) ||
        alert.labels?.project !== 'soloapp',
    )
  )
    throw new Error('Invalid alerts');
  return payload;
}

const DASHBOARDS = {
  auth: 'soloapp-auth',
  'app-api': 'soloapp-whoami',
  whoami: 'soloapp-whoami',
  nginx: 'soloapp-nginx',
  web: 'soloapp-overview',
  postgres: 'soloapp-postgres',
  routing: 'soloapp-routing',
  observability: 'soloapp-infrastructure',
};
const RUNBOOK =
  'https://github.com/coma8765/soloapp/blob/main/infra/observability/deploy/metrics/README.md';

function grafanaBase(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/grafana/')
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function timestamp(value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  return new Date(milliseconds)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function links(alert, env) {
  const base = grafanaBase(env.GRAFANA_URL);
  const result = [];
  if (base) {
    const service = alert.labels.service;
    const uid = Object.hasOwn(DASHBOARDS, service)
      ? DASHBOARDS[service]
      : 'soloapp-infrastructure';
    const url = new URL(`d/${uid}`, base);
    for (const key of ['dc', 'pod', 'route']) {
      if (alert.labels[key])
        url.searchParams.set(`var-${key}`, text(alert.labels[key], 256));
    }
    const start = Date.parse(alert.startsAt);
    const end = Date.parse(alert.endsAt);
    url.searchParams.set(
      'from',
      Number.isFinite(start) && start > 0 ? String(start - 300000) : 'now-1h',
    );
    url.searchParams.set(
      'to',
      alert.status === 'resolved' && Number.isFinite(end) && end > 0
        ? String(end + 300000)
        : 'now',
    );
    result.push(`Графики: ${url.href}`);
  }
  const name = text(alert.labels.alertname, 100);
  result.push(
    `Что проверить: ${RUNBOOK}${/^[A-Za-z0-9]+$/.test(name) ? '#' + name.toLowerCase() : ''}`,
  );
  return result;
}

export function messages(payload, env = {}) {
  const firing = payload.alerts.filter(
    (alert) => alert.status === 'firing',
  ).length;
  const resolved = payload.alerts.length - firing;
  const heading = `Soloapp · активных: ${firing} · восстановлено: ${resolved}\n`;
  const result = [];
  let current = heading;
  // Keep links and identity lines together; never split a Unicode surrogate pair.
  function append(line) {
    let part = '';
    for (const character of line + '\n') {
      if (part.length + character.length > 3500) {
        appendPart(part);
        part = '';
      }
      part += character;
    }
    appendPart(part);
  }
  function appendPart(part) {
    if (current.length + part.length > 3900) {
      result.push(current);
      current = heading;
    }
    current += part;
  }
  for (const alert of payload.alerts) {
    const labels = alert.labels;
    const annotations = alert.annotations || {};
    const recovered = alert.status === 'resolved';
    const status = recovered
      ? '✅ ВОССТАНОВЛЕНО'
      : labels.severity === 'critical'
        ? '🔴 КРИТИЧНО'
        : '⚠️ ВНИМАНИЕ';
    append(
      `\n${status} · ${text(annotations.summary || labels.alertname, 300)}`,
    );
    append(`Правило: ${text(labels.alertname, 100)}`);
    const identity = [
      'dc',
      'service',
      'namespace',
      'pod',
      'container',
      'route',
      'check',
      'deployment',
      'ingress',
      'proxy',
      'server',
    ]
      .filter((key) => labels[key])
      .map(
        (key) => `${key}=${text(labels[key], 256).replace(/[\r\n\t]/g, ' ')}`,
      );
    for (const item of identity) append(item);
    if (annotations.description)
      append(
        `${recovered ? 'Условие инцидента' : 'Что происходит'}: ${text(annotations.description, 1500)}`,
      );
    if (annotations.action && !recovered)
      append(`Действие: ${text(annotations.action, 900)}`);
    const start = timestamp(alert.startsAt);
    const end = recovered ? timestamp(alert.endsAt) : '';
    if (start) append(`Начало: ${start}`);
    if (end) append(`Восстановление: ${end}`);
    if (recovered)
      append(
        'Условие алерта отсутствовало 3 минуты. Значение выше относится к инциденту, а не к текущему измерению.',
      );
    for (const link of links(alert, env)) append(link);
  }
  if (payload.truncatedAlerts > 0) {
    append(
      `Ещё ${Number(payload.truncatedAlerts)} алертов не вошли в webhook; откройте Grafana.`,
    );
  }
  if (current !== heading) result.push(current);
  return result;
}

export async function handle(request, env, send = fetch) {
  const path = new URL(request.url).pathname;
  if (path !== '/alerts') return new Response('Not found', { status: 404 });
  if (request.method !== 'POST')
    return new Response('Method not allowed', { status: 405 });
  if (!(await authorized(request, env.RELAY_TOKEN)))
    return new Response('Unauthorized', { status: 401 });
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !/^-?\d+$/.test(env.TELEGRAM_CHAT_ID || '') ||
    !grafanaBase(env.GRAFANA_URL)
  ) {
    return new Response('Relay unavailable', { status: 503 });
  }
  let payload;
  try {
    payload = await readPayload(request);
  } catch {
    return new Response('Invalid alert payload', { status: 400 });
  }
  let failure = 'transport';
  try {
    for (const message of messages(payload, env)) {
      const response = await send(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            link_preview_options: { is_disabled: true },
          }),
        },
      );
      if (!response.ok) {
        failure = `telegram-http-${response.status}`;
        throw new Error('Delivery failed');
      }
      failure = 'telegram-response';
      if ((await response.json()).ok !== true)
        throw new Error('Delivery failed');
      failure = 'transport';
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (
      failure === 'transport' &&
      ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)
    )
      failure += '-' + error.name;
    // Never return/log Telegram responses or token-bearing URLs; Alertmanager retries.
    return new Response('Delivery temporarily unavailable', {
      status: 503,
      headers: { 'X-Relay-Error': failure },
    });
  }
}
export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
