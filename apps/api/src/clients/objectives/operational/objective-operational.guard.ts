import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { operationalFailure } from './objective-operational.rules.js';

/** Middleware resolves identity; the transaction still rechecks live membership/wall authority. */
@Injectable()
export class ObjectiveOperationalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      tenantContext?: TenantContext;
      headers?: Record<string, unknown>;
      res?: { setHeader: (name: string, value: string) => void };
    }>();
    request.res?.setHeader('Cache-Control', 'private, no-store');
    const actor = request.tenantContext;
    if (!actor?.tenantId || !actor.userId || !actor.clerkUserId)
      operationalFailure('UNAUTHENTICATED');
    if (request.headers?.['x-capiro-impersonate-tenant']) operationalFailure('FORBIDDEN');
    if (!['standard_user', 'user_admin', 'capiro_admin'].includes(actor.role))
      operationalFailure('FORBIDDEN');
    return true;
  }
}
