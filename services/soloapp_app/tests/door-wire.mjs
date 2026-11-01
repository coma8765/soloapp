// Run only against two disposable local servers and a synthetic auth service.
// NODE_PATH can point at a temporary installation of ws; no production account is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
const run = randomUUID();
const key = (id) => (id.startsWith(run) ? id : `${run}:${id}`);
const require = createRequire(
  new URL('../../client-gateway/package.json', import.meta.url),
);
const WebSocket = require('ws');
const endpoints = [process.env.DOOR_TEST_WS_A, process.env.DOOR_TEST_WS_B];
const origin = process.env.DOOR_TEST_ORIGIN;
for (const url of [...endpoints, origin]) {
  assert.ok(
    url && new URL(url).hostname === '127.0.0.1',
    'disposable loopback endpoints required',
  );
}
const sockets = [];
function connect(url, letter) {
  const ws = new WebSocket(url, { origin });
  sockets.push(ws);
  const messages = [];
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'auth', token: letter.repeat(64) })),
  );
  ws.on('message', (data) => messages.push(JSON.parse(data)));
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    if (process.env.DOOR_TEST_DEBUG && message.type.startsWith('door_'))
      console.log(
        letter,
        message.type,
        message.revision,
        message.open,
        message.accepted,
        message.error,
      );
  });
  ws.on('error', () => {});
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    async next(predicate) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const i = messages.findIndex(predicate);
        if (i >= 0) return messages.splice(i, 1)[0];
        await delay(20);
      }
      throw Error('Timed out waiting for door protocol event');
    },
  };
}
const pose = (map, sequence) => ({
  type: 'state',
  sequence,
  map,
  position: map === 'planet' ? [0, 36, 0] : [0, 0, 10],
  rotation: [0, 0, 0, 1],
  pitch: 0,
});
const request = (id, action, side, revision) => ({
  type: 'door_request',
  requestId: key(id),
  action,
  side,
  revision,
});
const state = (revision) => (m) =>
  m.type === 'door_state' && m.revision >= revision;
const ack = (id) => (m) => m.type === 'door_ack' && m.requestId === key(id);
try {
  const a = connect(endpoints[0], 'a'),
    b = connect(endpoints[1], 'b');
  const [wa, wb] = await Promise.all([
    a.next((m) => m.type === 'welcome'),
    b.next((m) => m.type === 'welcome'),
  ]);
  assert.equal(wa.door_protocol, 1);
  assert.equal(wb.door_protocol, 1);
  const [sa, sb] = await Promise.all([a.next(state(1)), b.next(state(1))]);
  assert.equal(sa.revision, sb.revision);
  assert.equal(sa.open, false);
  a.send(pose('planet', 1));
  b.send(pose('rbmk-training-room', 1));
  const remote = await a.next(
    (m) =>
      m.type === 'player_state' &&
      m.from === wb.id &&
      m.state.map === 'rbmk-training-room',
  );
  assert.deepEqual(
    remote.state.position,
    [0, 0, 10],
    'room poses are relayed through server',
  );
  a.send(request('open-a', 'open', 'planet', sa.revision));
  assert.equal((await a.next(ack('open-a'))).accepted, true);
  const [oa, ob] = await Promise.all([
    a.next(state(sa.revision + 1)),
    b.next(state(sa.revision + 1)),
  ]);
  assert.deepEqual(oa, ob);
  assert.equal(oa.open, true);
  await delay(550);
  const passA = request('pass-a', 'pass', 'planet', oa.revision);
  const passB = request('pass-b', 'pass', 'rbmk-training-room', ob.revision);
  a.send(passA);
  b.send(passB);
  const [ra, rb] = await Promise.all([
    a.next(ack('pass-a')),
    b.next(ack('pass-b')),
  ]);
  assert.equal(
    Number(ra.accepted) + Number(rb.accepted),
    1,
    'one concurrent passage commits',
  );
  const [ca, cb] = await Promise.all([
    a.next(state(oa.revision + 1)),
    b.next(state(ob.revision + 1)),
  ]);
  assert.deepEqual(ca, cb);
  assert.equal(ca.open, false);
  const winner = ra.accepted ? a : b,
    original = ra.accepted ? passA : passB;
  const expected = ra.accepted ? ra : rb;
  winner.ws.close();
  const reconnected = connect(endpoints[1], ra.accepted ? 'a' : 'b');
  const welcome = await reconnected.next((m) => m.type === 'welcome');
  const late = await reconnected.next(state(ca.revision));
  assert.equal(late.open, false, 'late join sees committed closed state');
  reconnected.send(pose(expected.destination, 1));
  reconnected.send(original);
  const replay = await reconnected.next(ack(original.requestId));
  assert.equal(replay.accepted, true);
  assert.equal(replay.destination, expected.destination);
  assert.equal(replay.to, welcome.id, 'receipt follows reconnected session');
  assert.equal(
    replay.revision,
    expected.revision,
    'retry does not mutate door',
  );
  await delay(550); // Finish closing before the next opening.
  reconnected.send(
    request('abandoned-open', 'open', expected.destination, late.revision),
  );
  assert.equal((await reconnected.next(ack('abandoned-open'))).accepted, true);
  const abandoned = await reconnected.next(state(late.revision + 1));
  for (const socket of sockets) socket.close();
  await delay(8300);
  const visitor = connect(endpoints[0], 'c');
  await visitor.next((m) => m.type === 'welcome');
  const closed = await visitor.next(state(abandoned.revision + 1));
  assert.equal(closed.open, false, 'database clock closes without browsers');
  console.log(
    'PASS: two C++ servers + PostgreSQL + WSS protocol: poses, shared door, concurrent passage, reconnect replay, late join and autonomous close',
  );
} finally {
  for (const socket of sockets) socket.close();
}
