import { ChatService } from './chat.service.js';

const fake = vi.hoisted(() => ({
  xrevrange: vi.fn(),
  eval: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
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
