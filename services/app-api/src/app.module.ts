import { ChatService } from './logic/chat.service.js';
import { ChatController } from './views/chat.controller.js';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { IdentityService } from './auth/identity.service.js';
import { IdentityMiddleware } from './auth/identity.middleware.js';
import { IdentityController } from './identity.controller.js';
import { HealthCircuit } from './logic/health.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [],
  controllers: [
    AppController,
    IdentityController,
    HealthController,
    ChatController,
  ],
  providers: [AppService, IdentityService, HealthCircuit, ChatService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(IdentityMiddleware)
      .forRoutes(IdentityController, ChatController);
  }
}
