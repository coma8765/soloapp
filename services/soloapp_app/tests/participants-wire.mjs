// Run via participants-integration.py against disposable loopback servers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const [auth, first, second, origin] = process.argv.slice(2);
for (const value of [auth, first, second, origin])
  assert.equal(new URL(value).hostname, '127.0.0.1');
const password = 'synthetic-metrics-test-password';
async function account(username) {
  const body = JSON.stringify({ username, password });
  const register = await fetch(auth + '/api/v1/auth/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(register.status, 201);
  const login = await fetch(auth + '/api/v1/auth/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const profile = await fetch(auth + '/api/v1/auth/v1/me', {
    headers: { Authorization: 'Bearer ' + session.access_token },
  });
  assert.deepEqual(await profile.json(), {
    user_id: session.user_id,
    username: username.toLowerCase(),
  });
  return session.access_token;
}
const sockets = [];
function connect(endpoint, token, fps) {
  const ws = new WebSocket(endpoint, { origin });
  sockets.push(ws);
  const client = { ws, messages: [], reply: true, roster: null };
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        type: 'auth',
        token,
        email: 'a@gmail.com',
        admin: true,
      }),
    ),
  );
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    client.messages.push(message);
    if (message.type === 'participants') client.roster = message;
    if (message.type === 'telemetry_probe' && client.reply)
      setTimeout(
        () => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: 'telemetry_reply',
                nonce: message.nonce,
                fps,
                email: 'a@gmail.com',
                ping: 0,
                admin: true,
              }),
            );
        },
        fps === 60 ? 80 : 0,
      );
  });
  ws.on('error', () => {});
  return client;
}
async function until(predicate, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(30);
  }
  throw Error(description);
}
function regularOnly(client) {
  const rosters = client.messages.filter((m) => m.type === 'participants');
  assert(rosters.length);
  for (const roster of rosters) {
    assert.equal(roster.admin, false);
    for (const p of roster.players)
      for (const field of ['fps', 'ping', 'telemetry', 'user_id', 'owner'])
        assert.equal(
          Object.hasOwn(p, field),
          false,
          'private field leaked: ' + field,
        );
  }
}
try {
  const adminToken = await account('A@GMAIL.COM');
  const memberToken = await account('member@example.test');
  const a = connect(first, adminToken, 90);
  const b = connect(second, memberToken, 60);
  await until(
    () =>
      a.roster?.players.length === 2 &&
      a.roster.players.every((p) => p.fps !== null),
    'cross-node metrics missing',
  );
  assert.equal(a.roster.admin, true);
  assert.deepEqual(
    new Set(a.roster.players.map((p) => p.email)),
    new Set(['a@gmail.com', 'member@example.test']),
  );
  assert.equal(a.roster.players.find((p) => p.email === 'a@gmail.com').fps, 90);
  const member = a.roster.players.find(
    (p) => p.email === 'member@example.test',
  );
  assert.equal(member.fps, 60);
  assert(
    member.ping >= 60 && member.ping < 5000,
    'server RTT must include delayed reply',
  );
  await until(() => b.roster?.players.length === 2, 'regular roster missing');
  regularOnly(b);
  b.ws.send(JSON.stringify({ type: 'participants', admin: true, players: [] }));
  b.ws.send(
    JSON.stringify({
      type: 'telemetry_reply',
      nonce: 'forged',
      fps: 999,
      admin: true,
    }),
  );
  await delay(1200);
  assert.equal(a.roster.players.find((p) => p.email === member.email).fps, 60);
  regularOnly(b);
  b.reply = false;
  await until(
    () => a.roster.players.find((p) => p.email === member.email)?.fps === null,
    'stale sample did not expire',
  );
  b.reply = true;
  await until(
    () => a.roster.players.find((p) => p.email === member.email)?.fps === 60,
    'sample did not recover',
  );
  b.ws.close();
  await until(() => a.roster.players.length === 1, 'departed member retained');
  a.ws.close();
  await delay(500);
  const switched = connect(first, memberToken, 72);
  await until(() => switched.roster !== null, 'account switch failed');
  regularOnly(switched);
  const revoked = await fetch(auth + '/api/v1/auth/v1/logout', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + adminToken },
  });
  assert.equal(revoked.status, 204);
  const invalid = connect(second, adminToken, 90);
  await until(
    () => invalid.ws.readyState === WebSocket.CLOSED,
    'revoked admin token accepted',
  );
  assert.equal(
    invalid.messages.some((m) => m.type === 'participants'),
    false,
  );
  console.log(
    'PASS: actual auth + PostgreSQL + two C++ servers: email identity, admin-only metrics, server RTT, forged input, expiry, recovery, leave, account switch and revoked token',
  );
} finally {
  for (const ws of sockets) ws.close();
}
