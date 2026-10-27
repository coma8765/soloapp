import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ChatSocket } from '../src/views/chat.socket.js';
import type { ChatService } from '../src/logic/chat.service.js';

const user = 'ab'.repeat(16);
const token = 'cd'.repeat(32);
const message = { id: '1-0', user_id: user, text: 'live', sent_at: 1 };

describe('WebSocket authenticated delivery', () => {
  let http: Server;
  let gateway: ChatSocket;
  let url: string;
  let consumed: boolean;
  const listeners = new Set<(event: object) => void>();
  beforeEach(async () => {
    consumed = false;
    process.env.CHAT_ALLOWED_ORIGIN = 'https://example.invalid';
    const chat = {
      consumeTicket: vi.fn(async (ticket: string) => {
        if (ticket !== token || consumed) return null;
        consumed = true;
        return user;
      }),
      watch: (listener: (event: object) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      history: async () => ({ messages: [] }),
    };
    gateway = new ChatSocket(chat as unknown as ChatService);
    http = createServer();
    gateway.attach(http);
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1/app-api/v1/chat/ws`;
  });
  afterEach(async () => {
    gateway.onModuleDestroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    listeners.clear();
    delete process.env.CHAT_ALLOWED_ORIGIN;
  });
  const open = (
    url: string,
    ticket = token,
    origin = 'https://example.invalid',
  ) => new WebSocket(url, ['soloapp.chat.v1', `ticket.${ticket}`], { origin });
  async function rejected(socket: WebSocket, code: number) {
    const [, response] = await once(socket, 'unexpected-response');
    expect(response.statusCode).toBe(code);
    socket.on('error', () => undefined);
    socket.terminate();
  }
  it('rejects invalid and cross-origin tickets before upgrading', async () => {
    await rejected(open(url, 'a'.repeat(64)), 401);
    await rejected(open(url, token, 'https://attacker.invalid'), 403);
  });
  it('consumes tickets once and delivers history plus immediate events', async () => {
    const socket = open(url);
    const history = once(socket, 'message');
    await once(socket, 'open');
    expect(socket.protocol).toBe('soloapp.chat.v1');
    expect(JSON.parse(String((await history)[0]))).toEqual({
      type: 'history',
      messages: [],
    });
    await rejected(open(url), 401);
    const live = once(socket, 'message');
    for (const listener of listeners) listener({ type: 'message', message });
    expect(JSON.parse(String((await live)[0]))).toEqual({
      type: 'message',
      message,
    });
    socket.close();
    await once(socket, 'close');
    await vi.waitFor(() => expect(listeners.size).toBe(0));
  });
  it('does not accept identity or message injection on the delivery channel', async () => {
    const socket = open(url);
    await once(socket, 'open');
    socket.send(JSON.stringify({ user_id: user, text: 'bypass' }));
    const [code] = await once(socket, 'close');
    expect(code).toBe(1008);
  });
});
