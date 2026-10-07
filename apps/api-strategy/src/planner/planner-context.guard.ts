import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
/** The shared Strategies guard authenticates the signed-in org only. Reject an
 * unsupported target rather than showing or mutating the real org inside an
 * impersonated Capiro shell. Does not change shared authentication. */
@Injectable()
export class PlannerContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers['x-capiro-impersonate-tenant'])
      throw new ForbiddenException(
        'Return to your signed-in organization to use Planner. Tenant impersonation is not enabled for Planner.',
      );
    return true;
  }
}
