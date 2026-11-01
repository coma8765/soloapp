import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { RbmkServerSync } from '../public/client/rbmk-server.js';
import { RbmkModel } from '../public/client/rbmk-model.js';
import { RBMK_CONTROLS } from '../public/client/rbmk-data.js';

function setup() {
  const sent = [],
    restored = [],
    notes = [],
    acknowledgements = [];
  let now = 0,
    next = 0;
  const channel = new RbmkServerSync({
    send: (value) => sent.push(structuredClone(value)),
    restore: (state) => {
      restored.push(state);
      return !!state?.controls;
    },
    journal: (entry) => notes.push(entry),
    acknowledged: (ack) => acknowledgements.push(ack),
    clock: () => now,
    requestId: () => `request-${++next}`,
  });
  const state = new RbmkModel().snapshot();
  const snapshot = (changes = {}) => ({
    type: 'reactor_state',
    storage: 'postgresql',
    version: 1,
    revision: 0,
    writer: 1,
    writerEpoch: 1,
    state,
    ...changes,
  });
  return {
    channel,
    sent,
    restored,
    notes,
    acknowledgements,
    snapshot,
    time: (value) => {
      now = value;
    },
  };
}

test('shared commands wait for PostgreSQL state and do not optimistically change the model', () => {
  const t = setup();
  t.channel.connect(1, 1);
  assert.deepEqual(t.sent, [{ type: 'reactor_join', active: true }]);
  assert.equal(t.channel.request({ kind: 'action', action: 'scram' }), false);
  t.channel.receive(t.snapshot());
  const before = structuredClone(t.restored[0]);
  const id = t.channel.request({
    kind: 'control',
    name: 'targetPower',
    mode: 'delta',
    delta: 5,
  });
  assert.equal(id, 'request-2');
  assert.deepEqual(t.restored[0], before);
  assert.equal(t.channel.pending.size, 1);
  t.channel.receive({
    type: 'reactor_ack',
    requestId: id,
    accepted: true,
    revision: 1,
  });
  assert.equal(t.channel.pending.size, 0);
  assert.equal(t.channel.revision, 0);
  t.channel.receive(t.snapshot({ version: 2, revision: 1 }));
  assert.equal(t.channel.revision, 1);
  assert.equal(t.restored.length, 2);
});

test('only the elected writer publishes, and its own echoed snapshot does not rewind time', () => {
  const t = setup();
  t.channel.connect(1, 1);
  t.channel.receive(t.snapshot());
  t.time(200);
  t.channel.tick({ elapsed: 0.2 });
  assert.equal(t.sent.at(-1).type, 'reactor_snapshot');
  assert.equal(t.sent.at(-1).writerEpoch, 1);
  t.channel.receive(t.snapshot({ version: 2 }));
  assert.equal(t.restored.length, 1);
  t.channel.receive(t.snapshot({ version: 3, writer: 2, writerEpoch: 2 }));
  const count = t.sent.length;
  t.time(400);
  t.channel.tick({ elapsed: 0.4 });
  assert.equal(t.sent.length, count);
  assert.equal(t.restored.length, 2);
});

test('reconnect retries the same request ID and rejects stale state versions', () => {
  const t = setup();
  t.channel.connect(1, 1);
  t.channel.receive(t.snapshot());
  const id = t.channel.request({ kind: 'action', action: 'lamp-test' });
  t.channel.disconnect();
  t.time(2000);
  t.channel.tick({});
  assert.equal(t.sent.filter((m) => m.type === 'reactor_command').length, 1);
  t.channel.connect(17, 1);
  t.channel.receive(t.snapshot({ version: 4, revision: 1, writer: 17 }));
  t.channel.tick({ elapsed: 0 });
  assert.equal(t.sent.at(-1).requestId, id);
  t.channel.receive(t.snapshot({ version: 3, revision: 0 }));
  assert.equal(t.channel.version, 4);
  t.channel.receive({
    type: 'reactor_ack',
    requestId: id,
    accepted: true,
    revision: 1,
  });
  assert.equal(t.channel.pending.size, 0);
});

test('unsupported backend and invalid snapshots keep shared controls blocked', () => {
  const t = setup();
  t.channel.connect(1, undefined);
  assert.equal(t.channel.request({ kind: 'action', action: 'reset' }), false);
  assert.equal(t.sent.length, 0);
  t.channel.connect(1, 1);
  t.channel.receive(t.snapshot({ state: {} }));
  assert.equal(t.channel.ready, false);
  t.channel.receive(t.snapshot({ storage: 'memory' }));
  assert.equal(t.channel.ready, false);
});

test('journal and command acknowledgements are independent streams', () => {
  const t = setup();
  t.channel.connect(1, 1);
  t.channel.receive(t.snapshot());
  const id = t.channel.request({ kind: 'journal', entry: { id: 'note' } });
  t.channel.receive({
    type: 'reactor_ack',
    requestId: id,
    accepted: false,
    error: 'invalid_journal_entry',
  });
  assert.equal(t.notes.length, 0);
  assert.match(t.channel.status(), /invalid_journal_entry/);
  t.channel.receive({
    type: 'reactor_journal',
    entry: { id: 'accepted-note' },
  });
  assert.equal(t.notes[0].id, 'accepted-note');
});

test('server profile exactly matches browser controls, reset state and selector order', () => {
  const profile = JSON.parse(
    readFileSync(new URL('../src/data/rbmk-profile.json', import.meta.url)),
  );
  assert.deepEqual(profile.controls, RBMK_CONTROLS);
  assert.deepEqual(profile.initial, new RbmkModel().snapshot());
  assert.deepEqual(
    profile.optionOrder.scenario,
    Object.keys(RBMK_CONTROLS.scenario.options),
  );
});
