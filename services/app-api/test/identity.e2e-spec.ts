import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HealthCircuit } from '../src/logic/health.js';
import { configureApp } from '../src/configure-app.js';

const USER_ID = '0123456789abcdef'.repeat(2);
const NOW = 1793030000;
const KEY = '01'.repeat(32);
const ENDPOINT = '/api/v1/whoami/v1/user-id';

function headers(timestamp = String(NOW), key = KEY) {
  return {
    'X-Verified-User-Id': USER_ID,
    'X-User-Timestamp': timestamp,
    'X-User-Signature': createHmac('sha256', Buffer.from(key, 'hex'))
      .update(`soloapp-user-id:${USER_ID}:${timestamp}`)
      .digest('hex'),
  };
}

describe('Signed identity', () => {
  let app: INestApplication<App>;
  let directory: string;
  let keyPath: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'app-api-test-'));
    keyPath = join(directory, 'userid-hmac');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const expressApp = module.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(expressApp);
    app = expressApp;
    expressApp
      .getHttpAdapter()
      .get('/test-error', (_req, res) => res.status(500).end());
    await app.init();
  });

  beforeEach(async () => {
    vi.stubEnv('HMAC_KEY_FILE', keyPath);
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    await writeFile(keyPath, KEY + '\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([ENDPOINT, '/api/v1/app-api/v1/user-id', '/user-id'])(
    'returns the verified identity at %s',
    async (path) => {
      await request(app.getHttpServer())
        .get(path)
        .set(headers())
        .expect(200)
        .expect('Cache-Control', 'no-store')
        .expect({ user_id: USER_ID });
    },
  );

  it.each([
    [-3, 401],
    [-2, 200],
    [0, 200],
    [10, 200],
    [11, 401],
  ])(
    'enforces the whoami expiry boundary at delta %i',
    async (delta, status) => {
      await request(app.getHttpServer())
        .get(ENDPOINT)
        .set(headers(String(NOW - delta)))
        .expect(status);
    },
  );

  it.each([
    ['X-Verified-User-Id', 'x'.repeat(32)],
    ['X-Verified-User-Id', USER_ID.toUpperCase()],
    ['X-Verified-User-Id', 'fedcba9876543210'.repeat(2)],
    ['X-User-Timestamp', 'garbage'],
    ['X-User-Timestamp', '17930300000'],
    ['X-User-Signature', '0'.repeat(64)],
    ['X-User-Signature', 'a'.repeat(63)],
    ['X-User-Signature', headers()['X-User-Signature'].toUpperCase()],
  ])('rejects invalid %s (%s)', async (field, value) => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set({ ...headers(), [field]: value })
      .expect(401)
      .expect('Cache-Control', 'no-store')
      .expect({ error: 'unauthorized' });
  });

  it.each([
    'X-Verified-User-Id',
    'X-User-Timestamp',
    'X-User-Signature',
  ] as const)('rejects a missing %s', async (field) => {
    const values: Partial<ReturnType<typeof headers>> = headers();
    delete values[field];
    await request(app.getHttpServer()).get(ENDPOINT).set(values).expect(401);
  });

  it('rejects duplicate identity headers', async () => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set(headers())
      .set('X-Verified-User-Id', [USER_ID, USER_ID])
      .expect(401);
  });

  it('does not trust a bearer token or unsigned user id', async () => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set('Authorization', 'Bearer unverified')
      .set('X-User-Id', USER_ID)
      .expect(401);
  });

  it('rejects signatures made with another key', async () => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set(headers(String(NOW), '02'.repeat(32)))
      .expect(401);
  });

  it('loads an atomically rotated key without restarting', async () => {
    const newKey = '02'.repeat(32);
    await writeFile(keyPath + '.tmp', newKey);
    await rename(keyPath + '.tmp', keyPath);
    await request(app.getHttpServer()).get(ENDPOINT).set(headers()).expect(401);
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set(headers(String(NOW), newKey))
      .expect(200);
  });

  it.each(['missing', 'invalid', 'unset'])(
    'fails closed with %s key configuration',
    async (state) => {
      if (state === 'missing') await rm(keyPath);
      if (state === 'invalid') await writeFile(keyPath, 'not-a-key');
      if (state === 'unset') vi.stubEnv('HMAC_KEY_FILE', undefined);
      await request(app.getHttpServer())
        .get(ENDPOINT)
        .set(headers())
        .expect(401)
        .expect({ error: 'unauthorized' });
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer()).get('/healthz').expect(200);
    },
  );

  it('keeps health probes public and unknown routes absent', async () => {
    await request(app.getHttpServer())
      .get('/healthz')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    await request(app.getHttpServer()).get('/other').expect(404);
  });

  it('rejects unsupported methods on the identity endpoint', async () => {
    await request(app.getHttpServer())
      .post(ENDPOINT)
      .set(headers())
      .expect(405);
  });

  it('ejects after actual HTTP 5xx, without turning liveness or probes into failures', async () => {
    for (let i = 0; i < 3; i++)
      await request(app.getHttpServer()).get('/test-error').expect(500);
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    await request(app.getHttpServer()).get('/healthz').expect(200);
    const health = app.get(HealthCircuit);
    expect(health.ready()).toBe(false);
  });

  it('enforces the request body limit for direct backend traffic', async () => {
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set(headers())
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(8193))
      .expect(413);
    await request(app.getHttpServer())
      .get(ENDPOINT)
      .set(headers())
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(8192))
      .expect(200);
  });
});
