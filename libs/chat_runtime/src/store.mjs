import { randomBytes, createHash } from 'node:crypto';
import { Database } from './database.mjs';

export class ChatError extends Error {
  constructor(status, reason) {
    super(reason);
    this.status = status;
  }
}
export function validateSend(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !['text', 'client_id'].includes(k)) ||
    typeof body.text !== 'string' ||
    !body.text.trim() ||
    body.text.length > 1000 ||
    typeof body.client_id !== 'string' ||
    !/^[0-9a-f]{32}$/.test(body.client_id)
  ) {
    throw new ChatError(400, 'invalid_message');
  }
  return { ...body, text: body.text.trim() };
}
export class ChatStore {
  constructor(database = new Database()) {
    this.database = database;
  }
  async history() {
    return this.database.withClient(async (c) => {
      const result = await c.query('SELECT message FROM chat.history()');
      return { messages: result.rows.map((r) => r.message) };
    });
  }
  async send(user, body) {
    const data = validateSend(body);
    return this.database.withClient(async (c) => {
      const result = await c.query('SELECT chat.send($1, $2, $3) AS message', [
        user,
        data.client_id,
        data.text,
      ]);
      if (result.rows[0].message === null)
        throw new ChatError(429, 'chat_rate_limited');
      return result.rows[0].message;
    });
  }
  async ticket(user) {
    const ticket = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(ticket).digest('hex');
    return this.database.withClient(async (c) => {
      const result = await c.query(
        'SELECT chat.issue_ticket($1,$2) AS allowed',
        [user, hash],
      );
      if (!result.rows[0].allowed)
        throw new ChatError(429, 'chat_rate_limited');
      return { ticket, expires_in: 30 };
    });
  }
  async consumeTicket(ticket) {
    if (!/^[0-9a-f]{64}$/.test(ticket)) return null;
    const hash = createHash('sha256').update(ticket).digest('hex');
    return this.database.withClient(async (c) => {
      const r = await c.query('SELECT chat.consume_ticket($1) AS user_id', [
        hash,
      ]);
      return r.rows[0].user_id;
    });
  }
  async close() {
    await this.database.close();
  }
}
