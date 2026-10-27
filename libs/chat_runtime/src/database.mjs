import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Never replay an ambiguous transaction. New operations discover the current primary.
export class Database {
  constructor(
    file = process.env.CHAT_CONFIG_FILE ??
      '/run/soloapp-secrets/data/chat-client.json',
  ) {
    this.file = file;
    this.pool = null;
    this.opening = null;
    this.configText = null;
    this.closed = false;
  }
  async config() {
    return JSON.parse(await readFile(this.file, 'utf8'));
  }
  async connect() {
    if (this.closed) throw new Error('closed');
    const text = await readFile(this.file, 'utf8');

    const c = JSON.parse(text).database;
    let ssl;
    if (process.env.SOLOAPP_TEST_PLAINTEXT === '1' && c.test_plaintext)
      ssl = false;
    else {
      if (!c.ca_file || !c.cert_file || !c.key_file)
        throw new Error('Database mTLS required');
      ssl = {
        ca: await readFile(c.ca_file),
        cert: await readFile(c.cert_file),
        key: await readFile(c.key_file),
        rejectUnauthorized: true,
      };
    }
    const fingerprint = text + (ssl ? ssl.cert.toString() : '');
    if (this.pool && this.configText === fingerprint) return this.pool;
    if (this.pool) void this.pool.end().catch(() => {});
    this.pool = null;
    if (!c.hosts?.length || !c.user || !c.name)
      throw new Error('Missing database configuration');
    for (const host of c.hosts) {
      const pool = new pg.Pool({
        host,
        port: c.port,
        database: c.name,
        user: c.user,
        password: c.password,
        ssl,
        max: c.pool_max ?? 4,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 30000,
        query_timeout: 5000,
        statement_timeout: 4000,
        application_name: c.user,
      });
      pool.on('error', () => this.discard(pool));
      try {
        const result = await pool.query(
          "SELECT NOT pg_is_in_recovery() AND current_setting('transaction_read_only')='off' AS primary",
        );
        if (!result.rows[0].primary) throw new Error('standby');
        this.configText = fingerprint;
        this.pool = pool;
        return pool;
      } catch {
        await pool.end();
      }
    }
    throw new Error('Database primary unavailable');
  }
  discard(pool) {
    if (this.pool === pool) this.pool = null;
    void pool.end().catch(() => {});
  }
  async acquire() {
    if (!this.opening) this.opening = this.connect();
    let pool;
    try {
      pool = await this.opening;
    } finally {
      this.opening = null;
    }
    try {
      return { pool, client: await pool.connect() };
    } catch (error) {
      this.discard(pool);
      throw error;
    }
  }
  async withClient(action) {
    const { pool, client } = await this.acquire();
    let broken = false;
    try {
      return await action(client);
    } catch (error) {
      if (!error.code || /^(08|57|25|53)/.test(error.code)) {
        broken = true;
        this.discard(pool);
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
  async query(sql, args = []) {
    return this.withClient((c) => c.query(sql, args));
  }
  async listen(onEvent, onLost) {
    const { pool, client } = await this.acquire();
    let closed = false;
    let timer;
    const close = (failed = false) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      client.removeAllListeners('notification');
      client.removeListener('error', lost);
      client.removeListener('end', lost);
      client.release(true);
      if (failed) {
        this.discard(pool);
        onLost();
      }
    };
    const lost = () => close(true);
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', (event) => onEvent(event.channel, event.payload));
    try {
      await client.query('LISTEN soloapp_delivery; LISTEN soloapp_receipt');
    } catch (error) {
      close();
      this.discard(pool);
      throw error;
    }
    let checking = false;
    timer = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try {
        const r = await client.query(
          'SELECT NOT pg_is_in_recovery() AS primary',
        );
        if (!r.rows[0].primary) lost();
      } catch {
        lost();
      } finally {
        checking = false;
      }
    }, 5000);
    return () => close();
  }
  async close() {
    this.closed = true;
    const p = this.pool;
    this.pool = null;
    if (p) await p.end();
  }
}
