import {
  HttpException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ChatError,
  ChatStore,
  Database,
  Outbox,
  publishTask,
  validateSend,
} from '@soloapp/chat-runtime';
export type { ChatMessage } from '@soloapp/chat-runtime';

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly store = new ChatStore(new Database());
  private readonly outbox = new Outbox(this.store.database, async (task) =>
    publishTask(await this.store.database.config(), task),
  );
  onModuleInit(): void {
    this.outbox.start();
  }
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ChatError)
        throw new HttpException({ error: error.message }, error.status);
      throw new ServiceUnavailableException({
        error: 'chat_temporarily_unavailable',
      });
    }
  }
  history() {
    return this.call(() => this.store.history());
  }
  send(userId: string, body: unknown) {
    return this.call(() => this.store.send(userId, validateSend(body)));
  }
  ticket(userId: string) {
    return this.call(() => this.store.ticket(userId));
  }
  async onModuleDestroy(): Promise<void> {
    await this.outbox.close();
    await this.store.close();
  }
}
