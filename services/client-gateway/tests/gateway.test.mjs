import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, validateDelivery } from '../src/logic/gateway.mjs';
import { authenticated, internalHandler } from '../src/views/http.mjs';
const user = 'a'.repeat(32);
const task = {
  task_id: 'delivery_test_0001',
  attempt: 1,
  recipient: user,
  payload: JSON.stringify({
    id: '1-0',
    user_id: user,
    text: 'hello',
    sent_at: 1,
  }),
  deadline_ms: Date.now() + 10000,
};
test('rejects malformed delivery and attempts', () => {
  for (const patch of [
    { attempt: 0 },
    { attempt: 1.2 },
    { task_id: 'x' },
    { recipient: 'spoof' },
    { payload: '{}' },
    { deadline_ms: Infinity },
  ])
    assert.throws(() => validateDelivery({ ...task, ...patch }));
});
test('requires explicit gateway authentication secret', () => {
  assert.throws(() => internalHandler({}, undefined, {}));
  assert.equal(
    authenticated(
      { headers: { authorization: 'Bearer ' + 'a'.repeat(32) } },
      'a'.repeat(32),
    ),
    true,
  );
  assert.equal(authenticated({ headers: {} }, 'a'.repeat(32)), false);
});
test('HTTP result waits for browser receipt and stale cancellation cannot end a newer attempt', async () => {
  const gateway = new Gateway({
    query: async () => ({ rows: [{ state: 'pending' }] }),
  });
  gateway.ready = true;
  let resolved = false;
  const pending = gateway
    .deliver({ ...task, attempt: 2, deadline_ms: Date.now() + 1000 })
    .then((v) => {
      resolved = true;
      return v;
    });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);
  for (const wake of gateway.waiters.get(task.task_id))
    wake({ cancelled: true, attempt: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);
  for (const wake of gateway.waiters.get(task.task_id))
    wake({ done: true, attempt: 2 });
  assert.equal(await pending, true);
  assert.equal(gateway.waiters.size, 0);
});
test('request cancellation releases the waiter without waiting for deadline', async () => {
  const gateway = new Gateway({
    query: async () => ({ rows: [{ state: 'pending' }] }),
  });
  gateway.ready = true;
  const abort = new AbortController();
  const pending = gateway.deliver(
    { ...task, deadline_ms: Date.now() + 10000 },
    abort.signal,
  );
  abort.abort();
  assert.equal(await pending, false);
  assert.equal(gateway.waiters.size, 0);
});
