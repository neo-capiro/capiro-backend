import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { DefenseTenantContext } from '../program-elements/program-elements.shared.js';

/** Injects the resolved DefenseTenantContext (populated by DefenseMemberResolverGuard). */
export const DefenseCurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): DefenseTenantContext => {
    const req = ctx.switchToHttp().getRequest<Request & { defenseTenantContext?: DefenseTenantContext }>();
    if (!req.defenseTenantContext) {
      throw new Error('DefenseTenantContext missing; route is not covered by DefenseMemberResolverGuard');
    }
    return req.defenseTenantContext;
  },
);
