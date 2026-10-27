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
  controllers: [AppController, IdentityController, HealthController],
  providers: [AppService, IdentityService, HealthCircuit],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(IdentityMiddleware).forRoutes(IdentityController);
  }
}
