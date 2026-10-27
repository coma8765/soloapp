import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, messages } from '../src/worker.mjs';
const env = {
  RELAY_TOKEN: 'x'.repeat(48),
  TELEGRAM_BOT_TOKEN: 'test-only',
  TELEGRAM_CHAT_ID: '-123',
  GRAFANA_URL: 'https://soloapp.example/grafana/',
};
const payload = {
  status: 'firing',
  alerts: [
    {
      status: 'firing',
      labels: {
        project: 'soloapp',
        alertname: 'PodUnavailable',
        dc: 'yc',
        service: 'auth',
        pod: 'auth-123',
      },
      annotations: {
        summary: 'Unavailable <pod>',
        description: 'Synthetic test',
      },
    },
  ],
};
function request(body = payload, token = env.RELAY_TOKEN) {
  return new Request('https://relay.example/alerts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
test('rejects absent or incorrect credentials without outbound calls', async () => {
  for (const token of ['', 'wrong', 'y'.repeat(48)]) {
    assert.equal(
      (await handle(request(payload, token), env, () => assert.fail())).status,
      401,
    );
  }
  assert.equal(
    (await handle(request(), { ...env, RELAY_TOKEN: '' }, () => assert.fail()))
      .status,
    401,
  );
});
test('only sends to configured bot/chat, preserves exact pod names and plain text', async () => {
  const input = {
    ...payload,
    chat_id: 'attacker',
    url: 'https://attacker.example',
  };
  let calls = 0;
  const response = await handle(request(input), env, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.telegram.org/bottest-only/sendMessage');
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, '-123');
    assert.equal(body.parse_mode, undefined);
    assert.match(body.text, /pod=auth-123/);
    assert.match(body.text, /Unavailable <pod>/);
    assert.equal(options.redirect, 'manual');
    return Response.json({ ok: true });
  });
  assert.equal(response.status, 204);
  assert.equal(calls, 1);
});
test('rejects malformed, oversized or unrelated payloads before sending', async () => {
  for (const body of [
    {},
    { ...payload, alerts: [] },
    {
      ...payload,
      alerts: [{ status: 'firing', labels: { project: 'other' } }],
    },
    { ...payload, padding: 'x'.repeat(262144) },
    { ...payload, alerts: Array(101).fill(payload.alerts[0]) },
  ]) {
    assert.equal(
      (await handle(request(body), env, () => assert.fail())).status,
      400,
    );
  }
});
test('upstream errors and token-bearing exceptions become generic retryable errors', async () => {
  for (const send of [
    async () =>
      new Response('', {
        status: 302,
        headers: { Location: 'https://attacker.example' },
      }),
    async () => new Response('secret', { status: 429 }),
    async () => Response.json({ ok: false }),
    async () => {
      throw new Error(env.TELEGRAM_BOT_TOKEN);
    },
  ]) {
    const response = await handle(request(), env, send);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Delivery temporarily unavailable');
  }
});
test('splits large groups below Telegram limit without dropping pod identifiers', () => {
  const input = {
    ...payload,
    alerts: Array.from({ length: 100 }, (_, i) => ({
      ...payload.alerts[0],
      labels: { ...payload.alerts[0].labels, pod: `auth-pod-${i}-end` },
      annotations: { description: 'x'.repeat(1500) },
    })),
  };
  const output = messages(input, env);
  assert.ok(output.length > 1);
  assert.ok(output.every((item) => item.length <= 3900));
  for (let i = 0; i < 100; i++)
    assert.ok(output.join('\n').includes(`pod=auth-pod-${i}-end`));
});
test('recovery and truncation are visible', async () => {
  const output = messages({
    ...payload,
    status: 'resolved',
    truncatedAlerts: 2,
    alerts: [{ ...payload.alerts[0], status: 'resolved' }],
  }).join('\n');
  assert.match(output, /ВОССТАНОВЛЕНО/);
  assert.match(output, /восстановлено: 1/);
  assert.match(output, /Ещё 2 алертов/);
});
test('rejects unsupported methods and paths', async () => {
  assert.equal(
    (await handle(new Request('https://relay.example/alerts'), env)).status,
    405,
  );
  assert.equal(
    (await handle(new Request('https://relay.example/elsewhere'), env)).status,
    404,
  );
});

test('Workers entrypoint accepts execution context without treating it as fetch', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ ok: true }),
  );
  assert.equal(
    (await worker.fetch(request(), env, { waitUntil() {} })).status,
    204,
  );
  assert.equal(mock.mock.calls.length, 1);
});

test('links point to configured Grafana and incident runbook, preserve filters and time range', () => {
  const alert = {
    ...payload.alerts[0],
    startsAt: '2026-10-27T14:00:00Z',
    labels: {
      ...payload.alerts[0].labels,
      severity: 'critical',
      route: '/login?a=1&b=2',
    },
    annotations: {
      summary: 'Pod недоступен',
      description: 'Readiness > 1m',
      action: 'Проверьте Events',
      dashboard_url: 'https://attacker.example',
    },
    generatorURL: 'http://private-prometheus:9090/graph',
  };
  const output = messages({ ...payload, alerts: [alert] }, env).join('\n');
  assert.match(output, /🔴 КРИТИЧНО/);
  assert.match(output, /Действие: Проверьте Events/);
  assert.match(output, /Начало: 2026-10-27 14:00:00 UTC/);
  const url = new URL(output.split('Графики: ')[1].split('\n')[0]);
  assert.equal(url.origin, 'https://soloapp.example');
  assert.equal(url.pathname, '/grafana/d/soloapp-auth');
  assert.equal(url.searchParams.get('var-dc'), 'yc');
  assert.equal(url.searchParams.get('var-pod'), 'auth-123');
  assert.equal(url.searchParams.get('var-route'), '/login?a=1&b=2');
  assert.equal(
    url.searchParams.get('from'),
    String(Date.parse(alert.startsAt) - 300000),
  );
  assert.equal(url.searchParams.get('to'), 'now');
  assert.match(output, /README.md#podunavailable/);
  assert.doesNotMatch(output, /attacker|private-prometheus|namespace=\n/);
});

test('mixed groups show recovery time per alert and do not suggest incident values are current', () => {
  const recovered = {
    ...payload.alerts[0],
    status: 'resolved',
    startsAt: '2026-10-27T14:00:00Z',
    endsAt: '2026-10-27T14:10:00Z',
  };
  const output = messages(
    { ...payload, alerts: [payload.alerts[0], recovered] },
    env,
  ).join('\n');
  assert.match(output, /активных: 1 · восстановлено: 1/);
  assert.match(output, /Восстановление: 2026-10-27 14:10:00 UTC/);
  assert.match(output, /не к текущему измерению/);
  const urls = output
    .split('\n')
    .filter((line) => line.startsWith('Графики: '))
    .map((line) => new URL(line.slice(9)));
  assert.equal(
    urls[1].searchParams.get('to'),
    String(Date.parse(recovered.endsAt) + 300000),
  );
});

test('Grafana URL must be configured, https and without credentials or query', async () => {
  for (const url of [
    '',
    'http://grafana.example/grafana/',
    'https://user:password@grafana.example/grafana/',
    'https://grafana.example/grafana/?token=secret',
  ]) {
    assert.equal(
      (
        await handle(request(), { ...env, GRAFANA_URL: url }, () =>
          assert.fail(),
        )
      ).status,
      503,
    );
  }
});

test('unknown service safely uses infrastructure dashboard', () => {
  const input = {
    ...payload,
    alerts: [
      {
        ...payload.alerts[0],
        labels: { ...payload.alerts[0].labels, service: 'constructor' },
      },
    ],
  };
  assert.match(messages(input, env).join('\n'), /\/d\/soloapp-infrastructure/);
});
