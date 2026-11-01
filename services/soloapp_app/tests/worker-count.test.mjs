import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerCountSync } from '../public/client/worker-controls.js';

test('worker count accepts only committed, ordered bounded server state', () => {
  const s = new WorkerCountSync(() => true);
  for (const count of [0, 11, 1.5, '3', null])
    assert.equal(
      s.receive({
        type: 'workers_state',
        storage: 'postgresql',
        revision: 1,
        count,
      }),
      false,
    );
  assert.equal(s.count, 7);
  assert(
    s.receive({
      type: 'workers_state',
      storage: 'postgresql',
      revision: 4,
      count: 10,
    }),
  );
  assert.equal(
    s.receive({
      type: 'workers_state',
      storage: 'postgresql',
      revision: 3,
      count: 1,
    }),
    false,
  );
  assert.equal(s.count, 10);
  s.disconnect();
  assert.equal(s.ready, false);
  assert.equal(s.request(1, true), false);
});

test('worker count requires admin, retries same ID and never applies speculative selection', () => {
  const sent = [];
  let now = 0;
  const s = new WorkerCountSync(
    (m) => {
      sent.push(m);
      return true;
    },
    () => now,
  );
  s.receive({
    type: 'workers_state',
    storage: 'postgresql',
    revision: 1,
    count: 7,
  });
  assert.equal(s.request(1, false), false);
  assert(s.request(1, true));
  assert.equal(s.count, 7);
  assert.equal(s.request(10, true), false);
  now = 1001;
  s.tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  s.receive({ type: 'workers_ack', requestId: 'unrelated', accepted: true });
  assert(s.pending);
  s.receive({
    type: 'workers_ack',
    requestId: sent[0].requestId,
    accepted: false,
    error: 'stale_workers',
  });
  assert.equal(s.pending, null);
  assert(s.error);
  assert.equal(s.count, 7);
  assert(s.request(10, true));
  s.disconnect();
  now += 1001;
  s.tick();
  assert.equal(sent.length, 3);
});
