import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { WebSocket } from 'ws';
import { Database, ChatStore } from '@soloapp/chat-runtime';
import { Gateway } from '../src/logic/gateway.mjs';
import { attachSockets } from '../src/views/socket.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f) {
  for (let i = 0; i < 100; i++) {
    if (await f()) return;
    await pause(20);
  }
  throw new Error('condition timeout');
}
test(
  'cross-pod delivery, authenticated ACK, stale attempt fencing and durable outbox',
  { skip: !process.env.TEST_PG_PORT, timeout: 30000 },
  async () => {
    const port = Number(process.env.TEST_PG_PORT);
    const admin = new pg.Client({
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: 'synthetic-ci-only',
      database: 'postgres',
    });
    await admin.connect();
    const root = resolve(import.meta.dirname, '../../..');
    await admin.query(
      await readFile(
        root + '/services/client-notify/deploy/schema.sql',
        'utf8',
      ),
    );
    await admin.query(
      await readFile(root + '/infra/chat-storage/schema.sql', 'utf8'),
    );
    const directory = await mkdtemp(tmpdir() + '/solo-gateway-');
    const config = directory + '/config.json';
    await writeFile(
      config,
      JSON.stringify({
        database: {
          hosts: ['127.0.0.1'],
          port,
          name: 'postgres',
          user: 'postgres',
          password: 'synthetic-ci-only',
          test_plaintext: true,
          pool_max: 8,
        },
      }),
    );
    process.env.SOLOAPP_TEST_PLAINTEXT = '1';
    const one = new Gateway(new Database(config)),
      two = new Gateway(new Database(config));
    const store = new ChatStore(new Database(config));
    const server = http.createServer();
    const close = attachSockets(server, two, 'http://test', '/ws');
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let ws;
    try {
      one.start();
      two.start();
      await until(() => one.ready && two.ready);
      const user = 'a'.repeat(32),
        other = 'b'.repeat(32);
      const ticket = await store.ticket(user);
      ws = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/ws`,
        ['soloapp.chat.v1', 'ticket.' + ticket.ticket],
        { origin: 'http://test' },
      );
      const events = [];
      ws.on('message', (data) => events.push(JSON.parse(data)));
      await new Promise((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
      });
      await until(() => events.some((e) => e.type === 'history'));
      assert.equal(
        await store.consumeTicket(ticket.ticket),
        null,
        'ticket single use',
      );
      const message = await store.send(user, {
        text: 'durable hello',
        client_id: 'c'.repeat(32),
      });
      assert.deepEqual(
        await store.send(user, {
          text: 'durable hello',
          client_id: 'c'.repeat(32),
        }),
        message,
      );
      const outbox = await admin.query('SELECT * FROM chat.claim_outbox()');
      assert.equal(outbox.rows.length, 1);
      const task = outbox.rows[0],
        deadline = Date.now() + 10000;
      await admin.query(
        "INSERT INTO notify_tasks VALUES($1,$2,$3,'inflight',1,0,$4,false,1)",
        [task.task_id, task.recipient, task.payload, deadline + 20000],
      );
      let complete = false;
      const result = one
        .deliver({ ...task, attempt: 1, deadline_ms: deadline })
        .then((v) => {
          complete = true;
          return v;
        });
      await until(() => events.some((e) => e.delivery));
      assert.equal(complete, false, 'socket send is not ACK');
      assert.equal(
        await one.acknowledge(other, {
          type: 'ack',
          task_id: task.task_id,
          attempt: 1,
        }),
        false,
        'other account rejected',
      );
      ws.send(
        JSON.stringify({ type: 'ack', task_id: task.task_id, attempt: 1 }),
      );
      assert.equal(await result, true);
      assert.equal(
        await one.deliver({
          ...task,
          attempt: 2,
          deadline_ms: Date.now() + 1000,
        }),
        true,
        'durable receipt avoids resending',
      );
      // A new task survives expiry; a late old cancel/ACK cannot affect the next attempt.
      const second = { ...task, task_id: task.task_id + '_retry' };
      await admin.query(
        "INSERT INTO notify_tasks VALUES($1,$2,$3,'inflight',1,0,$4,false,1)",
        [second.task_id, second.recipient, second.payload, Date.now() + 30000],
      );
      const abort = new AbortController();
      const pending = one.deliver(
        { ...second, attempt: 1, deadline_ms: Date.now() + 10000 },
        abort.signal,
      );
      await until(() =>
        events.some((e) => e.delivery?.task_id === second.task_id),
      );
      abort.abort();
      assert.equal(await pending, false);
      await one.cancel({ ...second, attempt: 1 });
      await admin.query('UPDATE notify_tasks SET attempt=2 WHERE task_id=$1', [
        second.task_id,
      ]);
      const retry = one.deliver({
        ...second,
        attempt: 2,
        deadline_ms: Date.now() + 10000,
      });
      await until(() =>
        events.some(
          (e) =>
            e.delivery?.task_id === second.task_id && e.delivery.attempt === 2,
        ),
      );
      await one.cancel({ ...second, attempt: 1 });
      assert.equal(
        await two.acknowledge(user, {
          type: 'ack',
          task_id: second.task_id,
          attempt: 1,
        }),
        false,
      );
      ws.send(
        JSON.stringify({ type: 'ack', task_id: second.task_id, attempt: 2 }),
      );
      assert.equal(await retry, true);
    } finally {
      ws?.terminate();
      close();
      server.close();
      await Promise.all([one.close(), two.close(), store.close()]);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
