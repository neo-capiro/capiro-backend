import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Enforces a minimum role for the route. The required roles come from the
 * @Roles() decorator on the handler or controller. Access is granted if the
 * caller's role rank >= the lowest-ranked required role.
 *
 * The TenantContext is set by TenantContextMiddleware. If it's missing the
 * route was reached without auth, fail closed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<TenantRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const ctx = req.tenantContext;
    if (!ctx) {
      throw new ForbiddenException('No tenant context, auth middleware did not run');
    }

    // Fail CLOSED on a role that is not in the rank table.
    //
    // `ctx.role` is typed TenantRole but arrives from the database via an
    // `as TenantRole` cast in TenantContextMiddleware, so the type is a promise
    // the runtime does not keep: a row holding a legacy or hand-edited value
    // yields `ROLE_RANK[ctx.role] === undefined`, and because
    // `undefined < anyNumber` is FALSE, the comparison below silently GRANTED
    // access to every @Roles()-gated route. Reject explicitly instead.
    const callerRank: number | undefined = ROLE_RANK[ctx.role];
    if (typeof callerRank !== 'number') {
      throw new ForbiddenException(`Unrecognized role ${String(ctx.role)}`);
    }

    // Same hazard on the required side: an unmapped entry would make
    // Math.min(...) return NaN, and every comparison against NaN is false.
    const requiredRanks: Array<number | undefined> = required.map((r) => ROLE_RANK[r]);
    if (requiredRanks.some((rank) => typeof rank !== 'number')) {
      throw new ForbiddenException(
        `Route declares an unrecognized required role (${required.join(' | ')})`,
      );
    }

    const minRequiredRank = Math.min(...(requiredRanks as number[]));
    if (callerRank < minRequiredRank) {
      throw new ForbiddenException(
        `Role ${ctx.role} is below the required minimum (${required.join(' | ')})`,
      );
    }
    return true;
  }
}
