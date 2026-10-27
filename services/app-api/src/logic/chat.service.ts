import {
  BadRequestException,
  HttpException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
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
      throw new ServiceUnavailableException('chat_temporarily_unavailable');
    }
  }

  async send(userId: string, body: unknown): Promise<ChatMessage> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('invalid_message');
    const data = body as Record<string, unknown>;
    if (
      Object.keys(data).some((k) => !['text', 'client_id'].includes(k)) ||
      typeof data.text !== 'string' ||
      !data.text.trim() ||
      data.text.length > 1000 ||
      typeof data.client_id !== 'string' ||
      !/^[0-9a-f]{32}$/.test(data.client_id)
    )
      throw new BadRequestException('invalid_message');
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
      throw new ServiceUnavailableException('chat_temporarily_unavailable');
    }
    if (result === 'RATE_LIMIT')
      throw new HttpException('chat_rate_limited', 429);
    return JSON.parse(String(result)) as ChatMessage;
  }
  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}
