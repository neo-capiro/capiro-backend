import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { PurchaserAuth } from './clerk-user.guard.js';

/**
 * Injects the {@link PurchaserAuth} attached by {@link ClerkUserGuard}.
 * Using it on a route without the guard is a programming error → 500.
 */
export const CurrentPurchaser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PurchaserAuth => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.purchaserAuth) {
      throw new InternalServerErrorException('CurrentPurchaser used without ClerkUserGuard');
    }
    return req.purchaserAuth as PurchaserAuth;
  },
);
