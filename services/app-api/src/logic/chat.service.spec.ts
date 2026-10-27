import { ChatError, ChatStore } from '@soloapp/chat-runtime';
import { ChatService } from './chat.service.js';

describe('Chat business rules', () => {
  let service: ChatService;
  beforeEach(() => {
    service = new ChatService();
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.restoreAllMocks();
  });
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
    const send = vi.spyOn(ChatStore.prototype, 'send');
    await expect(service.send('verified', body)).rejects.toMatchObject({
      status: 400,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('uses verified identity and stable client id', async () => {
    const message = {
      id: '1-0',
      user_id: 'verified',
      text: 'hello',
      sent_at: 1,
    };
    const send = vi
      .spyOn(ChatStore.prototype, 'send')
      .mockResolvedValue(message);
    expect(
      await service.send('verified', {
        text: ' hello ',
        client_id: 'a'.repeat(32),
      }),
    ).toEqual(message);
    expect(send).toHaveBeenCalledWith('verified', {
      text: 'hello',
      client_id: 'a'.repeat(32),
    });
  });
  it('maps the shared quota to HTTP 429', async () => {
    vi.spyOn(ChatStore.prototype, 'send').mockRejectedValue(
      new ChatError(429, 'chat_rate_limited'),
    );
    await expect(
      service.send('verified', { text: 'hello', client_id: 'a'.repeat(32) }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('does not expose database connection details', async () => {
    vi.spyOn(ChatStore.prototype, 'history').mockRejectedValue(
      new Error('private database detail'),
    );
    await expect(service.history()).rejects.toMatchObject({
      status: 503,
      response: { error: 'chat_temporarily_unavailable' },
    });
  });
});
