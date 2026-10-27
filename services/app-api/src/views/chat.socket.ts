import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ChatService } from '../logic/chat.service.js';
import { routes } from '../generated/routes.js';

@Injectable()
export class ChatSocket implements OnModuleDestroy {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
    handleProtocols: () => 'soloapp.chat.v1',
  });
  private readonly users = new Map<string, number>();
  private closing = false;
  private pending = 0;

  constructor(@Inject(ChatService) private readonly chat: ChatService) {}

  attach(http: Server): void {
    http.on('upgrade', (request, socket, head) => {
      socket.on('error', () => undefined);
      void this.upgrade(request, socket, head);
    });
  }

  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const reject = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (request.url !== '/' + routes.chat_socket[0]) {
      reject(404);
      return;
    }
    if (this.closing || this.server.clients.size + this.pending >= 512) {
      reject(503);
      return;
    }
    const allowed = process.env.CHAT_ALLOWED_ORIGIN;
    if (
      request.headers.origin &&
      (!allowed || request.headers.origin !== allowed)
    ) {
      reject(403);
      return;
    }
    const protocols =
      request.headers['sec-websocket-protocol']
        ?.split(',')
        .map((p) => p.trim()) ?? [];
    const ticket = protocols
      .find((p) => /^ticket\.[0-9a-f]{64}$/.test(p))
      ?.slice(7);
    if (!ticket || !protocols.includes('soloapp.chat.v1')) {
      reject(401);
      return;
    }
    this.pending++;
    try {
      const user = await this.chat.consumeTicket(ticket);
      if (!user || !/^[0-9a-f]{32}$/.test(user)) {
        reject(401);
        return;
      }
      if (socket.destroyed || this.closing) return;
      if ((this.users.get(user) ?? 0) >= 8) {
        reject(429);
        return;
      }
      this.server.handleUpgrade(request, socket, head, (ws) =>
        this.connected(ws, user),
      );
    } catch {
      reject(503);
    } finally {
      this.pending--;
    }
  }

  private connected(ws: WebSocket, user: string): void {
    this.users.set(user, (this.users.get(user) ?? 0) + 1);
    const send = (event: object) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 256 * 1024) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(event));
    };
    const stop = this.chat.watch(send, () => ws.close(1013, 'reconnect'));
    // Snapshot is bounded. The client merges by stream ID, covering snapshot/live overlap.
    void this.chat
      .history()
      .then((history) => send({ type: 'history', ...history }))
      .catch(() => ws.close(1013, 'reconnect'));
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      send({ type: 'ping' });
    }, 15000);
    // Re-acquire a session-verified ticket at least every minute, including after logout elsewhere.
    const expiry = setTimeout(() => ws.close(4001, 'renew session'), 60000);
    ws.on('message', () => ws.close(1008, 'use authenticated HTTP send'));
    ws.on('error', () => undefined);
    ws.once('close', () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
      stop();
      const count = (this.users.get(user) ?? 1) - 1;
      if (count) this.users.set(user, count);
      else this.users.delete(user);
    });
  }

  onModuleDestroy(): void {
    this.closing = true;
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }
}
