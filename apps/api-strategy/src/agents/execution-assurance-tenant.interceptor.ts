import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { runWithExecutionAssuranceTenant } from './execution-assurance.js';

/**
 * Binds the authenticated, server-resolved tenant to Strategy execution's
 * destination-side assurance gate for the complete handler subscription.
 *
 * Registered as an application interceptor because the Execution Agent routes
 * share a large controller with other agent surfaces. It is inert for every
 * other controller and harmless for non-execution AgentsController methods;
 * only ExecutionService consumes the request-local assurance context.
 */
@Injectable()
export class ExecutionAssuranceTenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = request.tenantContext?.tenantId;
    if (!tenantId || context.getClass().name !== 'AgentsController') {
      return next.handle();
    }

    return new Observable((subscriber) =>
      runWithExecutionAssuranceTenant(tenantId, () => next.handle().subscribe(subscriber)),
    );
  }
}
