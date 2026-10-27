import { randomBytes } from 'node:crypto';
import { ChatStore, Database } from '@soloapp/chat-runtime';

const keyPattern = /^[a-zA-Z0-9_-]{16,128}$/;
export function validateDelivery(value, cancel = false) {
  if (
    !value ||
    typeof value !== 'object' ||
    !keyPattern.test(value.task_id) ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1
  )
    throw new Error('invalid_delivery');
  if (
    !cancel &&
    (!/^[0-9a-f]{32}$/.test(value.recipient) ||
      typeof value.payload !== 'string' ||
      Buffer.byteLength(value.payload) > 65536 ||
      !Number.isSafeInteger(value.deadline_ms))
  )
    throw new Error('invalid_delivery');
  if (!cancel) {
    const m = JSON.parse(value.payload);
    if (
      !m ||
      !/^[0-9]+-[0-9]+$/.test(m.id) ||
      !/^[0-9a-f]{32}$/.test(m.user_id) ||
      typeof m.text !== 'string' ||
      m.text.length > 1000 ||
      !Number.isSafeInteger(m.sent_at)
    )
      throw new Error('invalid_message');
  }
  return value;
}
export class Gateway {
  constructor(database = new Database()) {
    this.database = database;
    this.store = new ChatStore(database);
    this.connections = new Map();
    this.waiters = new Map();
    this.ready = false;
    this.stopped = false;
    this.disconnectListener = null;
    this.loop = null;
    this.metrics = { received: 0, acknowledged: 0, timeouts: 0, cancelled: 0 };
  }
  start() {
    this.loop = this.listenLoop();
  }
  async listenLoop() {
    while (!this.stopped) {
      let lost;
      const waiting = new Promise((resolve) => {
        lost = resolve;
      });
      try {
        this.disconnectListener = await this.database.listen((channel, id) => {
          void this.event(channel, id).catch(() => this.dropSockets());
        }, lost);
        if (this.stopped) {
          this.disconnectListener();
          break;
        }
        this.ready = true;
        this.endListener = lost;
        await waiting;
      } catch {
        /* Reconnect to a verified primary without logging database credentials. */
      } finally {
        this.ready = false;
        this.disconnectListener?.();
        this.disconnectListener = null;
        this.dropSockets();
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 500));
    }
  }
  dropSockets() {
    for (const { socket } of this.connections.values())
      socket.close(1013, 'reconnect');
  }
  async event(channel, id) {
    if (!keyPattern.test(id)) return;
    if (channel === 'soloapp_receipt') {
      const result = await this.database.query(
        'SELECT * FROM chat.delivery_state($1)',
        [id],
      );
      const state = result.rows[0];
      if (state) for (const done of this.waiters.get(id) ?? []) done(state);
      return;
    }
    if (channel !== 'soloapp_delivery') return;
    const r = await this.database.query(
      'SELECT * FROM chat.delivery_read($1)',
      [id],
    );
    const task = r.rows[0];
    if (!task) return;
    const event = {
      type: 'message',
      message: JSON.parse(task.payload),
      delivery: { task_id: id, attempt: Number(task.attempt) },
    };
    for (const connection of this.connections.values()) {
      if (connection.user === task.recipient) connection.send(event);
    }
  }
  async addSocket(socket, user, send) {
    const id = randomBytes(16).toString('hex');
    await this.database.query('SELECT chat.connection_open($1,$2)', [id, user]);
    this.connections.set(id, { socket, user, send });
    return id;
  }
  async removeSocket(id) {
    this.connections.delete(id);
    await this.database
      .query('SELECT chat.connection_close($1)', [id])
      .catch(() => {});
  }
  async refreshSocket(id) {
    await this.database.query('SELECT chat.connection_refresh($1)', [id]);
  }
  async acknowledge(user, event) {
    if (event?.type !== 'ack') throw new Error('invalid_ack');
    validateDelivery(event, true);
    const r = await this.database.query(
      'SELECT chat.delivery_ack($1,$2,$3) AS accepted',
      [event.task_id, event.attempt, user],
    );
    if (r.rows[0].accepted) this.metrics.acknowledged++;
    return r.rows[0].accepted;
  }
  async deliver(task, signal) {
    validateDelivery(task);
    if (!this.ready) throw new Error('unavailable');
    const remaining = Math.min(10000, task.deadline_ms - Date.now());
    if (remaining <= 0) throw new Error('expired');
    this.metrics.received++;
    let wake;
    const receipt = new Promise((resolve) => {
      wake = resolve;
    });
    const listeners = this.waiters.get(task.task_id) ?? new Set();
    const onState = (state) => {
      if (state.done) wake(true);
      else if (state.cancelled && Number(state.attempt) === task.attempt)
        wake(false);
      else if (Number(state.attempt) > task.attempt) wake(false);
    };
    listeners.add(onState);
    this.waiters.set(task.task_id, listeners);
    const abort = () => wake(false);
    let timer;
    try {
      if (signal?.aborted) throw new Error('aborted');
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        this.metrics.timeouts++;
        wake(false);
      }, remaining);
      const r = await this.database.query(
        'SELECT chat.delivery_begin($1,$2,$3,$4,$5) AS state',
        [
          task.task_id,
          task.attempt,
          task.deadline_ms,
          task.recipient,
          task.payload,
        ],
      );
      if (r.rows[0].state === 'done') return true;
      if (r.rows[0].state !== 'pending') return false;
      return await receipt;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      listeners.delete(onState);
      if (!listeners.size) this.waiters.delete(task.task_id);
    }
  }
  async cancel(task) {
    validateDelivery(task, true);
    await this.database.query('SELECT chat.delivery_cancel($1,$2)', [
      task.task_id,
      task.attempt,
    ]);
    this.metrics.cancelled++;
  }
  async close() {
    this.stopped = true;
    this.dropSockets();
    this.endListener?.();
    this.disconnectListener?.();
    for (const set of this.waiters.values())
      for (const wake of set)
        wake({ cancelled: true, attempt: Number.MAX_SAFE_INTEGER });
    await this.loop;
    await this.database.close();
  }
}
