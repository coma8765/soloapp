import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, messages } from '../src/worker.mjs';
const env = {
  RELAY_TOKEN: 'x'.repeat(48),
  TELEGRAM_BOT_TOKEN: 'test-only',
  TELEGRAM_CHAT_ID: '-123',
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
  const output = messages(input);
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
  assert.match(output, /RESOLVED/);
  assert.match(output, /\[resolved\]/);
  assert.match(output, /truncated 2/);
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
