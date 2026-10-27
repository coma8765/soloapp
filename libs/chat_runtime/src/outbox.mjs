// PostgreSQL owns publication intent. HTTP 202 means client-notify committed it.
// Crashes between HTTP success and confirmation are safe with a stable task_id.
export class Outbox {
  constructor(database, publish, now = Date.now) {
    this.database = database;
    this.publish = publish;
    this.running = false;
    this.timer = null;
    this.stopped = false;
    this.now = now;
    // Exceed the 15s DB lease so a failed local publisher cannot reclaim
    // the same batch before a healthy publisher on the other site.
    this.retryAt = 0;
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), 200);
  }
  async tick() {
    if (this.running || this.stopped || this.now() < this.retryAt) return;
    this.running = true;
    try {
      const rows = await this.database.query(
        'SELECT * FROM chat.claim_outbox()',
      );
      const results = await Promise.allSettled(
        rows.rows.map(async (row) => {
          await this.publish(row);
          await this.database.query('SELECT chat.confirm_outbox($1)', [
            row.task_id,
          ]);
        }),
      );
      if (results.some((result) => result.status === 'rejected'))
        this.retryAt = this.now() + 20_000;
    } catch {
      this.retryAt = this.now() + 20_000;
      /* Never log payloads or credentials. */
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }
}
export async function publishTask(config, task) {
  if (!config.notify?.url || !config.notify.token)
    throw new Error('Notify configuration required');
  const response = await fetch(
    config.notify.url + '/api/v1/client-notify/v1/tasks',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + config.notify.token,
      },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    },
  );
  if (response.status !== 202) {
    await response.body?.cancel();
    throw new Error('Notify unavailable');
  }
  await response.body?.cancel();
}
