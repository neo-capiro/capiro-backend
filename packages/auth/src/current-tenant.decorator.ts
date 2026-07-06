import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from './tenant-context';

/**
 * Injects the current AuthTenantContext into a controller method. The
 * TenantGuard sets `req.tenantContext`; this decorator reads it. Throws if the
 * route did not pass through TenantGuard.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthTenantContext => {
    const req = ctx.switchToHttp().getRequest<Request & { tenantContext?: AuthTenantContext }>();
    if (!req.tenantContext) {
      throw new Error('TenantContext missing, route is not covered by TenantGuard');
    }
    return req.tenantContext;
  },
);
