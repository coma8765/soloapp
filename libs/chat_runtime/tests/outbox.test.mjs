import assert from 'node:assert/strict';
import test from 'node:test';
import { Outbox } from '../src/outbox.mjs';

test('failed local publication yields expired leases to a healthy site', async () => {
  let now = 1;
  const row = {
    task_id: 'synthetic-task',
    recipient: 'synthetic',
    payload: '{}',
  };
  let lease = 0;
  let published = false;
  let claims = 0;
  const database = {
    async query(sql) {
      if (sql.includes('claim_outbox')) {
        claims++;
        if (published || lease >= now) return { rows: [] };
        lease = now + 15_000;
        return { rows: [row] };
      }
      published = true;
      return { rows: [] };
    },
  };
  const unavailable = new Outbox(
    database,
    async () => {
      throw new Error('unavailable');
    },
    () => now,
  );
  const delivered = [];
  const healthy = new Outbox(
    database,
    async (task) => delivered.push(task.task_id),
    () => now,
  );
  await unavailable.tick();
  assert.equal(published, false);
  now = 15_002;
  // The unavailable site gets the first tick, but must not claim again.
  await unavailable.tick();
  assert.equal(claims, 1);
  await healthy.tick();
  assert.deepEqual(delivered, ['synthetic-task']);
  assert.equal(published, true);
  now = 20_002;
  await unavailable.tick();
  assert.equal(claims, 3);
  await Promise.all([unavailable.close(), healthy.close()]);
});

test('one failed task does not discard successful publication in the same batch', async () => {
  const confirmed = [];
  const database = {
    async query(sql, args) {
      if (sql.includes('claim_outbox'))
        return { rows: [{ task_id: 'ok' }, { task_id: 'failed' }] };
      confirmed.push(args[0]);
      return { rows: [] };
    },
  };
  const outbox = new Outbox(database, async (row) => {
    if (row.task_id === 'failed') throw new Error('unavailable');
  });
  await outbox.tick();
  assert.deepEqual(confirmed, ['ok']);
  await outbox.close();
});
