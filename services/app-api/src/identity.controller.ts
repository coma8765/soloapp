import { Controller, Get, Req } from '@nestjs/common';
import { routes } from './generated/routes.js';
import type { AuthenticatedRequest } from './auth/identity.middleware.js';

@Controller()
export class IdentityController {
  @Get(routes.user_id)
  getUserId(@Req() request: AuthenticatedRequest): { user_id: string } {
    return { user_id: request.auth.userId };
  }
}
