import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
/** Narrow internal preparation endpoint; does not change shared JWT auth. */
@Injectable()
export class PreparationSourceGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest(),
      supplied = request.headers['x-internal-service-secret'],
      expected = process.env.INTERNAL_SERVICE_SECRET;
    if (typeof supplied !== 'string' || !expected) throw new UnauthorizedException();
    const a = Buffer.from(supplied),
      b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}
