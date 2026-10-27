import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ChatService } from '../src/logic/chat.service.js';
import { IdentityService } from '../src/auth/identity.service.js';
import { configureApp } from '../src/configure-app.js';
const path = '/api/v1/app-api/v1/chat/messages';
const user = 'ab'.repeat(16);

describe('Chat authorization boundary', () => {
  let app: NestExpressApplication;
  const history = vi.fn(async () => ({ messages: [] }));
  const send = vi.fn(async () => ({
    id: '1-0',
    user_id: user,
    text: 'hello',
    sent_at: 1,
  }));
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ChatService)
      .useValue({ history, send })
      .overrideProvider(IdentityService)
      .useValue({
        verify: async (id: string, ts: string, sig: string) =>
          id === user && ts === 'verified-time' && sig === 'verified-signature',
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it.each(['get', 'post'] as const)(
    'requires verified session for %s',
    async (method) => {
      await request(app.getHttpServer())
        [method](path)
        .set('X-User-Id', user)
        .expect(401);
    },
  );
  it('reads messages with signed identity', async () => {
    await request(app.getHttpServer())
      .get(path)
      .set('X-Verified-User-Id', user)
      .set('X-User-Timestamp', 'verified-time')
      .set('X-User-Signature', 'verified-signature')
      .expect(200)
      .expect({ messages: [] });
  });
  it('passes the verified user to the sender', async () => {
    const body = { text: 'hello', client_id: 'cd'.repeat(16) };
    await request(app.getHttpServer())
      .post(path)
      .set('X-Verified-User-Id', user)
      .set('X-User-Timestamp', 'verified-time')
      .set('X-User-Signature', 'verified-signature')
      .send(body)
      .expect(201);
    expect(send).toHaveBeenCalledWith(user, body);
  });
  it('rejects unconfigured verbs', async () => {
    await request(app.getHttpServer()).delete(path).expect(405);
  });
});
