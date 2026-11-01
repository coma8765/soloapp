import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(
  new URL('../../client-gateway/package.json', import.meta.url),
);
const WebSocket = require('ws');
const base = process.env.SOLOAPP_BASE_URL;
if (!base) throw Error('SOLOAPP_BASE_URL required');
const tokens = [];
async function api(method, path, body, token) {
  const r = await fetch(base + '/api/v1/auth/v1/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(r.ok, `${path}: ${r.status}`);
  return r.status === 204 ? null : r.json();
}
async function account() {
  const body = {
    username: `planet_test_${randomBytes(8).toString('hex')}`,
    password: randomBytes(24).toString('hex'),
  };
  await api('POST', 'register', body);
  const value = await api('POST', 'login', body);
  tokens.push(value.access_token);
  return value;
}
function connect(token, url) {
  const ws = new WebSocket(
    url || base.replace(/^http/, 'ws') + '/api/v1/soloapp_app/v1/signal',
    { origin: base },
  );
  const messages = [];
  const waiting = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', (data) => {
    const v = JSON.parse(data);
    messages.push(v);
    for (const wake of waiting.splice(0)) wake();
  });
  ws.on('error', () => {});
  async function next(predicate) {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const i = messages.findIndex(predicate);
      if (i >= 0) return messages.splice(i, 1)[0];
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw Error('Timed out waiting for world event');
  }
  return { ws, next };
}
let a, b;
try {
  const first = await account(),
    second = await account();
  a = connect(first.access_token, process.env.WS_URL_A);
  b = connect(second.access_token, process.env.WS_URL_B);
  const [wa, wb] = await Promise.all([
    a.next((v) => v.type === 'welcome'),
    b.next((v) => v.type === 'welcome'),
  ]);
  assert.equal(wa.user_id, first.user_id);
  assert.equal(wb.user_id, second.user_id);
  assert.equal(wa.world_protocol, 2);
  assert.notEqual(wa.id, wb.id);
  const [fa, fb] = await Promise.all([
    a.next((v) => v.type === 'fish'),
    b.next((v) => v.type === 'fish'),
  ]);
  assert.equal(fa.fish.length, 48);
  assert.equal(fb.fish.length, 48);
  a.ws.send(
    JSON.stringify({
      type: 'state',
      sequence: 1,
      position: [0, 36, 0],
      rotation: [0, 0, 0, 1],
      pitch: 0,
      avatarId: 'scientist',
    }),
  );
  const remote = await b.next(
    (v) => v.type === 'player_state' && v.from === wa.id,
  );
  assert.deepEqual(remote.state.position, [0, 36, 0]);
  assert.equal(remote.state.avatarId, 'scientist');
  a.ws.send(
    JSON.stringify({
      ...remote.state,
      type: 'state',
      sequence: 2,
      avatarId: 'female',
    }),
  );
  const switched = await b.next(
    (v) =>
      v.type === 'player_state' && v.from === wa.id && v.state.sequence === 2,
  );
  assert.equal(switched.state.avatarId, 'female');
  console.log(
    JSON.stringify({
      accounts: 2,
      shared_world: true,
      player_delivery: true,
      fish: fa.fish.length,
    }),
  );
} finally {
  a?.ws.close();
  b?.ws.close();
  for (const token of tokens) await api('POST', 'logout', undefined, token);
}
