import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { bodyLimits, routes, methods } from './generated/routes.js';
import { HealthCircuit } from './logic/health.js';

export function configureApp(app: NestExpressApplication): void {
  const health = app.get(HealthCircuit);
  const probes = new Set(
    [...routes.healthz, ...routes.health_ready].map((p) => '/' + p),
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    res.on('finish', () => {
      if (!probes.has(path)) health.record(res.statusCode);
    });
    if (methods[path] !== undefined && !methods[path].includes(req.method)) {
      res.status(405).end();
      return;
    }
    next();
  });
  const maximum = Math.max(...Object.values(bodyLimits));
  app.useBodyParser('json', { limit: maximum });
  app.useBodyParser('urlencoded', { limit: maximum, extended: true });
  app.useBodyParser('raw', { limit: maximum, type: () => true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    // JSON parsing can change encoded length; Content-Length covers normal clients,
    // while rawBody covers chunked requests when rawBody is enabled at bootstrap.
    const limit = bodyLimits[req.path];
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    if (
      limit !== undefined &&
      Math.max(Number(req.get('content-length') || 0), raw?.length || 0) > limit
    ) {
      res.status(413).end();
      return;
    }
    next();
  });
  app.enableShutdownHooks();
}
