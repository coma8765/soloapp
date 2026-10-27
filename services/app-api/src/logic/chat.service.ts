import {
  BadRequestException,
  HttpException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Redis } from 'ioredis';

export interface ChatMessage {
  id: string;
  user_id: string;
  text: string;
  sent_at: number;
}
interface RedisConfig {
  sentinels: { host: string; port: number }[];
  name: string;
  username: string;
  password: string;
  sentinelUsername: string;
  sentinelPassword: string;
  ca: string;
}

// Atomic deduplication and a shared per-user quota apply across every app pod.
const SEND = `
local previous = redis.call('GET', KEYS[2])
if previous then return previous end
local count = redis.call('INCR', KEYS[3])
if count == 1 then redis.call('EXPIRE', KEYS[3], 10) end
if count > 10 then return 'RATE_LIMIT' end
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '=', 500, '*', 'user_id', ARGV[1], 'text', ARGV[2], 'sent_at', ARGV[3])
local message = cjson.encode({id=id, user_id=ARGV[1], text=ARGV[2], sent_at=tonumber(ARGV[3])})
redis.call('SET', KEYS[2], message, 'EX', 86400)
return message
`;

@Injectable()
export class ChatService implements OnModuleDestroy {
  private client?: Redis;
  private reader?: Redis;
  private watching = false;
  private destroyed = false;
  private readonly listeners = new Set<{
    message: (event: object) => void;
    failure: () => void;
  }>();
  private configText?: string;
  private opening?: Promise<Redis>;

  private async connect(): Promise<Redis> {
    const encoded = await readFile(
      process.env.REDIS_CONFIG_FILE ??
        '/run/soloapp-secrets/data/redis-client.json',
      'utf8',
    );
    if (this.client && this.configText === encoded) return this.client;
    const config = JSON.parse(encoded) as RedisConfig;
    if (!config.sentinels?.length || !config.ca || !config.password)
      throw new Error('Redis configuration missing');
    this.client?.disconnect();
    this.client = new Redis({
      sentinels: config.sentinels,
      name: config.name,
      username: config.username,
      password: config.password,
      sentinelUsername: config.sentinelUsername,
      sentinelPassword: config.sentinelPassword,
      enableTLSForSentinelMode: true,
      tls: { ca: config.ca, rejectUnauthorized: true },
      sentinelTLS: { ca: config.ca, rejectUnauthorized: true },
      sentinelCommandTimeout: 2000,
      socketTimeout: 5000,
      autoResendUnfulfilledCommands: false,
      reconnectOnError: (error) => error.message.startsWith('READONLY'),
      connectTimeout: 2000,
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
      sentinelRetryStrategy: () => 1000,
    });
    // Do not log client options, connection strings or credentials.
    this.client.on('error', () => undefined);
    this.configText = encoded;
    return this.client;
  }

  private async redis(): Promise<Redis> {
    if (!this.opening) this.opening = this.connect();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  async history(): Promise<{ messages: ChatMessage[] }> {
    try {
      const rows = await (
        await this.redis()
      ).xrevrange('soloapp:chat:messages', '+', '-', 'COUNT', 100);
      return {
        messages: rows.reverse().map(([id, fields]) => {
          const data: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2)
            data[fields[i]] = fields[i + 1];
          return {
            id,
            user_id: data.user_id,
            text: data.text,
            sent_at: Number(data.sent_at),
          };
        }),
      };
    } catch {
      throw new ServiceUnavailableException({
        error: 'chat_temporarily_unavailable',
      });
    }
  }

  async send(userId: string, body: unknown): Promise<ChatMessage> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException({ error: 'invalid_message' });
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).some((k) => !['text', 'client_id'].includes(k)) ||
      typeof data.text !== 'string' ||
      !data.text.trim() ||
      data.text.length > 1000 ||
      typeof data.client_id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(data.client_id)
    )
      throw new BadRequestException({ error: 'invalid_message' });
    let result: unknown;
    try {
      result = await (
        await this.redis()
      ).eval(
        SEND,
        3,
        'soloapp:chat:messages',
        `soloapp:chat:dedup:${userId}:${data.client_id}`,
        `soloapp:chat:rate:${userId}`,
        userId,
        data.text.trim(),
        Date.now(),
      );
    } catch {
      throw new ServiceUnavailableException({
        error: 'chat_temporarily_unavailable',
      });
    }
    if (result === 'RATE_LIMIT')
      throw new HttpException({ error: 'chat_rate_limited' }, 429);
    return JSON.parse(String(result)) as ChatMessage;
  }
  async ticket(
    userId: string,
  ): Promise<{ ticket: string; expires_in: number }> {
    const ticket = randomBytes(32).toString('hex');
    try {
      const result = await (
        await this.redis()
      ).eval(
        `local n = redis.call('INCR', KEYS[1])
         if n == 1 then redis.call('EXPIRE', KEYS[1], 10) end
         if n > 10 then return 0 end
         redis.call('SET', KEYS[2], ARGV[1], 'EX', 30)
         return 1`,
        2,
        `soloapp:chat:ticket-rate:${userId}`,
        `soloapp:chat:ticket:${ticket}`,
        userId,
      );
      if (result !== 1)
        throw new HttpException({ error: 'chat_rate_limited' }, 429);
      return { ticket, expires_in: 30 };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({
        error: 'chat_temporarily_unavailable',
      });
    }
  }

  async consumeTicket(ticket: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(ticket)) return null;
    // Atomic and shared across DCs: a ticket cannot open two sockets on a healthy primary.
    return (await this.redis()).getdel(`soloapp:chat:ticket:${ticket}`);
  }

  watch(message: (event: object) => void, failure: () => void): () => void {
    const listener = { message, failure };
    this.listeners.add(listener);
    if (!this.watching) void this.readStream();
    return () => this.listeners.delete(listener);
  }

  private emit(event: object): void {
    for (const listener of this.listeners) listener.message(event);
  }

  private async readStream(): Promise<void> {
    this.watching = true;
    try {
      const initial = await this.history();
      let cursor = initial.messages.at(-1)?.id ?? '0-0';
      this.emit({ type: 'history', ...initial });
      const base = await this.redis();
      this.reader = base.duplicate();
      this.reader.on('error', () => undefined);
      await new Promise<void>((resolve, reject) => {
        if (this.reader!.status === 'ready') {
          resolve();
          return;
        }
        this.reader!.once('ready', resolve);
        this.reader!.once('error', reject);
      });
      while (!this.destroyed && this.listeners.size) {
        if ((await this.redis()) !== base)
          throw new Error('Redis credentials rotated');
        // One blocking reader per pod, never one connection per browser.
        // BLOCK bounds shutdown time; new messages wake XREAD immediately.
        const streams = await this.reader.xread(
          'COUNT',
          100,
          'BLOCK',
          1000,
          'STREAMS',
          'soloapp:chat:messages',
          cursor,
        );
        for (const [, rows] of streams ?? []) {
          for (const [id, fields] of rows) {
            const data: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2)
              data[fields[i]] = fields[i + 1];
            cursor = id;
            this.emit({
              type: 'message',
              message: {
                id,
                user_id: data.user_id,
                text: data.text,
                sent_at: Number(data.sent_at),
              },
            });
          }
        }
      }
    } catch {
      // Force history recovery on a new ticket after Sentinel/connection failure.
      for (const listener of this.listeners) listener.failure();
    } finally {
      this.reader?.disconnect();
      this.reader = undefined;
      this.watching = false;
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.reader?.disconnect();
    this.client?.disconnect();
  }
}
