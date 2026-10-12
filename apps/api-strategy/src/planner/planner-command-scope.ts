import { ForbiddenException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthTenantContext } from '../auth/tenant-context.js';

/** Optional narrowing constraints for cross-service commands, never authority. */
export function requirePlannerCommandScope(ctx: AuthTenantContext, headers: IncomingHttpHeaders) {
  for (const [name, actual] of [
    ['x-capiro-expected-tenant-id', ctx.tenantId],
    ['x-capiro-expected-actor-id', ctx.clerkUserId],
  ] as const) {
    if (headers[name] !== undefined && headers[name] !== actual)
      throw new ForbiddenException('Command scope mismatch');
  }
}
