import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DoorSync, doorThreshold } from '../public/client/door-sync.js';

function setup() {
  let now = 0,
    id = 0;
  const sent = [],
    passages = [];
  const sync = new DoorSync({
    send: (m) => sent.push(structuredClone(m)),
    passed: (...args) => passages.push(args),
    clock: () => now,
    requestId: () => `r-${++id}`,
  });
  const state = (revision, open) => ({
    type: 'door_state',
    storage: 'postgresql',
    revision,
    open,
  });
  return {
    sync,
    sent,
    passages,
    state,
    time: (t) => {
      now = t;
    },
  };
}

test('two participants open from committed state and only the passing user changes map', () => {
  const a = setup(),
    b = setup();
  for (const t of [a, b]) {
    t.sync.connect(1, 'user');
    assert.equal(t.sync.request('open', 'planet'), false);
    t.sync.receive(t.state(1, false));
  }
  a.sync.request('open', 'planet');
  assert.equal(a.sync.open, false);
  a.sync.receive({ type: 'door_ack', requestId: 'r-1', accepted: true });
  assert.equal(a.sync.open, false, 'ACK alone does not speculate');
  for (const t of [a, b]) t.sync.receive(t.state(2, true));
  b.sync.request('pass', 'rbmk-training-room');
  assert.deepEqual(b.passages, []);
  for (const t of [a, b]) t.sync.receive(t.state(3, false));
  b.sync.receive({
    type: 'door_ack',
    requestId: 'r-1',
    accepted: true,
    destination: 'planet',
  });
  assert.deepEqual(b.passages, [['planet', 'rbmk-training-room']]);
  assert.deepEqual(a.passages, []);
  b.sync.receive({
    type: 'door_ack',
    requestId: 'r-1',
    accepted: true,
    destination: 'planet',
  });
  assert.equal(b.passages.length, 1, 'duplicate ACK cannot teleport twice');
});

test('disconnect blocks passage; reconnect retries the same request, stale state cannot reopen', () => {
  const t = setup();
  t.sync.connect(1, 'a');
  t.sync.receive(t.state(2, true));
  t.sync.request('pass', 'planet');
  t.sync.disconnect();
  t.time(2000);
  t.sync.tick();
  assert.equal(t.sync.open, false);
  assert.equal(t.sync.request('pass', 'planet'), false);
  assert.equal(t.sent.length, 1);
  t.sync.connect(1, 'a');
  t.sync.receive(t.state(3, false));
  t.sync.tick();
  assert.deepEqual(t.sent[0], t.sent[1]);
  t.sync.receive({
    type: 'door_ack',
    requestId: 'r-1',
    accepted: true,
    destination: 'rbmk-training-room',
  });
  assert.equal(t.passages.length, 1);
  t.sync.receive(t.state(2, true));
  assert.equal(t.sync.open, false);
});

test('account changes discard pending requests; unsupported servers fail closed', () => {
  const t = setup();
  t.sync.connect(1, 'a');
  t.sync.receive(t.state(2, true));
  t.sync.request('pass', 'planet');
  t.sync.connect(1, 'b');
  t.sync.receive({
    type: 'door_ack',
    requestId: 'r-1',
    accepted: true,
    destination: 'rbmk-training-room',
  });
  assert.equal(t.passages.length, 0);
  t.sync.connect(undefined, 'b');
  t.sync.receive(t.state(4, true));
  assert.equal(t.sync.request('open', 'planet'), false);
});

test('bad states and rejected passes never teleport', () => {
  const t = setup();
  t.sync.connect(1, 'a');
  t.sync.receive({ ...t.state(1, true), storage: 'memory' });
  t.sync.receive(t.state(-1, true));
  t.sync.receive(t.state(1, 'true'));
  assert.equal(t.sync.ready, false);
  t.sync.receive(t.state(1, true));
  t.sync.request('pass', 'planet');
  t.sync.receive({ type: 'door_ack', requestId: 'r-1', accepted: false });
  assert.equal(t.passages.length, 0);
  assert.equal(t.sync.pending, null);
  assert.equal(t.sync.request('pass', 'planet'), false, 'rejection backoff');
});

test('guest exercise closes after passage or timeout and cannot retain local authority on login', () => {
  const t = setup();
  t.sync.disconnect(); // Network initialization also disconnects in guest mode.
  t.sync.request('open', 'planet');
  t.time(8000);
  t.sync.tick();
  assert.equal(t.sync.open, false);
  t.sync.request('open', 'planet');
  t.sync.request('pass', 'planet');
  assert.equal(t.sync.open, false);
  assert.equal(t.passages.length, 1);
  t.sync.requireServer(true);
  assert.equal(t.sync.request('open', 'planet'), false);
});

test('threshold catches high-speed crossing both ways, blocks jambs and permits stepping away', () => {
  assert.deepEqual(doorThreshold([0, 0, 2], [0, 0, -2]).position, [0, 0, 0.36]);
  assert.deepEqual(
    doorThreshold([0, 0, -2], [0, 0, 2]).position,
    [0, 0, -0.36],
  );
  assert.equal(doorThreshold([1.2, 0, 2], [1.2, 0, -2]).aperture, false);
  assert.equal(doorThreshold([2, 0, 2], [2, 0, -2]), null);
  assert.equal(doorThreshold([0, 0, 2], [0, 0, 1]), null);
  assert.equal(doorThreshold([0, 0, 0.36], [0, 0, 1]), null);
});
