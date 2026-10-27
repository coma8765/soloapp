import { ChatService } from './chat.service.js';

const fake = vi.hoisted(() => ({
  xrevrange: vi.fn(),
  eval: vi.fn(),
  getdel: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  options: vi.fn(),
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(options: unknown) {
      fake.options(options);
      return fake;
    }
  },
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () =>
    JSON.stringify({
      sentinels: [{ host: '127.0.0.1', port: 26379 }],
      name: 'test',
      ca: 'test-ca',
      password: 'test-password',
    }),
  ),
}));

describe('Chat business rules', () => {
  let service: ChatService;
  beforeEach(() => {
    vi.clearAllMocks();
    service = new ChatService();
  });
  afterEach(() => service.onModuleDestroy());
  it.each([
    null,
    [],
    {},
    { text: '' },
    { text: 'x', client_id: 'bad' },
    { text: ' '.repeat(10), client_id: 'a'.repeat(32) },
    { text: 'x'.repeat(1001), client_id: 'a'.repeat(32) },
    { text: 'x', client_id: 'a'.repeat(32), user_id: 'forged' },
  ])('rejects malformed or spoofed input %j', async (body) => {
    await expect(service.send('verified', body)).rejects.toMatchObject({
      status: 400,
    });
    expect(fake.eval).not.toHaveBeenCalled();
  });
  it('uses verified identity and a per-user idempotency key', async () => {
    const expected = {
      id: '1-0',
      user_id: 'verified',
      text: 'hello',
      sent_at: 1,
    };
    fake.eval.mockResolvedValue(JSON.stringify(expected));
    expect(
      await service.send('verified', {
        text: ' hello ',
        client_id: 'a'.repeat(32),
      }),
    ).toEqual(expected);
    expect(fake.eval.mock.calls[0].slice(1, 7)).toEqual([
      3,
      'soloapp:chat:messages',
      'soloapp:chat:dedup:verified:' + 'a'.repeat(32),
      'soloapp:chat:rate:verified',
      'verified',
      'hello',
    ]);
  });
  it('verifies TLS for both discovery and data, and reconnects silent sockets', async () => {
    fake.xrevrange.mockResolvedValue([]);
    await service.history();
    expect(fake.options).toHaveBeenCalledWith(
      expect.objectContaining({
        tls: { ca: 'test-ca', rejectUnauthorized: true },
        sentinelTLS: { ca: 'test-ca', rejectUnauthorized: true },
        socketTimeout: 5000,
        sentinelCommandTimeout: 2000,
        autoResendUnfulfilledCommands: false,
      }),
    );
  });
  it('issues bounded single-use tickets scoped to the authenticated user', async () => {
    fake.eval.mockResolvedValue(1);
    const ticket = await service.ticket('ab'.repeat(16));
    expect(ticket.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.expires_in).toBe(30);
    fake.getdel
      .mockResolvedValueOnce('ab'.repeat(16))
      .mockResolvedValueOnce(null);
    expect(await service.consumeTicket(ticket.ticket)).toBe('ab'.repeat(16));
    expect(await service.consumeTicket(ticket.ticket)).toBeNull();
    expect(fake.getdel).toHaveBeenCalledWith(
      `soloapp:chat:ticket:${ticket.ticket}`,
    );
    expect(await service.consumeTicket('bad')).toBeNull();
    expect(fake.getdel).toHaveBeenCalledTimes(2);
  });
  it('reports shared Redis rate limits as 429', async () => {
    fake.eval.mockResolvedValue('RATE_LIMIT');
    await expect(
      service.send('verified', { text: 'hello', client_id: 'a'.repeat(32) }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('returns chronological, bounded history from the shared stream', async () => {
    fake.xrevrange.mockResolvedValue([
      ['2-0', ['user_id', 'b', 'text', 'second', 'sent_at', '2']],
      ['1-0', ['user_id', 'a', 'text', 'first', 'sent_at', '1']],
    ]);
    expect((await service.history()).messages.map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);
    expect(fake.xrevrange).toHaveBeenCalledWith(
      'soloapp:chat:messages',
      '+',
      '-',
      'COUNT',
      100,
    );
  });
  it('returns 503 during failover without leaking connection errors', async () => {
    fake.xrevrange.mockRejectedValue(new Error('private connection detail'));
    await expect(service.history()).rejects.toMatchObject({
      status: 503,
      response: { error: 'chat_temporarily_unavailable' },
    });
  });
});
