import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { runWithMemoryGovernanceTenant } from './memory-governance-tenant-scope.js';

/**
 * Carries the tenant-context middleware's verified tenant through every API
 * handler so inherited no-argument governance switches can apply the exact
 * `MEMORY_GOVERNANCE_TENANTS` canary. Public/internal routes without a Clerk
 * tenant context are left unchanged and require an explicit `all` rollout for
 * background behavior.
 */
@Injectable()
export class MemoryGovernanceTenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = request.tenantContext?.tenantId;
    if (!tenantId) return next.handle();
    return new Observable((subscriber) =>
      runWithMemoryGovernanceTenant(tenantId, () => next.handle().subscribe(subscriber)),
    );
  }
}
