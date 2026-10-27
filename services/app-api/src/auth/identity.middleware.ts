import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { IdentityService } from './identity.service.js';

export interface AuthenticatedRequest extends Request {
  auth: { userId: string };
}

@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async use(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    res.setHeader('Cache-Control', 'no-store');
    const userId = req.get('X-Verified-User-Id');
    if (
      !userId ||
      !(await this.identity.verify(
        userId,
        req.get('X-User-Timestamp'),
        req.get('X-User-Signature'),
      ))
    ) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.auth = { userId };
    next();
  }
}
