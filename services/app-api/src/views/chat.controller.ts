import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/identity.middleware.js';
import { routes } from '../generated/routes.js';
import { ChatService } from '../logic/chat.service.js';

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chat: ChatService) {}
  @Get(routes.chat_messages)
  history() {
    return this.chat.history();
  }
  @Post(routes.chat_socket_ticket)
  ticket(@Req() request: AuthenticatedRequest) {
    return this.chat.ticket(request.auth.userId);
  }
  @Post(routes.chat_send)
  send(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.chat.send(request.auth.userId, body);
  }
}
