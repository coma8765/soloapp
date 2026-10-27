import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(
    process.env.PORT ?? 8080,
    process.env.LISTEN_ADDRESS ?? '0.0.0.0',
  );
}
await bootstrap();
