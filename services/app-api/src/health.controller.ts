import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { routes } from './generated/routes.js';
import { HealthCircuit } from './logic/health.js';
import { IdentityService } from './auth/identity.service.js';

@Controller()
export class HealthController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(HealthCircuit) private readonly health: HealthCircuit,
  ) {}

  @Get(routes.healthz)
  @Header('Cache-Control', 'no-store')
  live() {
    return { status: 'ok' };
  }

  @Get(routes.health_ready)
  @Header('Cache-Control', 'no-store')
  async ready() {
    if (!this.health.ready()) throw new ServiceUnavailableException({ status: "cooldown" });
    try {
      const key = await this.identity.readKey();
      key.fill(0);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({
        error: 'signing key unavailable',
      });
    }
  }
}
