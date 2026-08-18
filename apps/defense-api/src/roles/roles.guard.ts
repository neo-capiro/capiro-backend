import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { DefenseTenantContext } from '../program-elements/program-elements.shared.js';
import { ROLES_KEY, type DefenseRole } from './roles.decorator.js';

const ROLE_RANK: Record<DefenseRole, number> = {
  client_portal_user: 0,
  standard_user: 1,
  user_admin: 2,
  capiro_admin: 3,
};

/**
 * Enforces the minimum @Roles() metadata for the matched handler/controller.
 * Runs AFTER DefenseMemberResolverGuard (req.defenseTenantContext must be
 * populated). Fails CLOSED on any role not present in ROLE_RANK — mirrors
 * apps/api's RolesGuard fix (an `undefined < anyNumber` comparison is always
 * false, which would silently grant access on an unrecognized role).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<DefenseRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { defenseTenantContext?: DefenseTenantContext }>();
    const ctx = req.defenseTenantContext;
    if (!ctx) {
      throw new ForbiddenException('No tenant context; DefenseMemberResolverGuard did not run');
    }

    const callerRank = ROLE_RANK[ctx.role as DefenseRole];
    if (typeof callerRank !== 'number') {
      throw new ForbiddenException(`Unrecognized role ${String(ctx.role)}`);
    }
    const requiredRanks = required.map((r) => ROLE_RANK[r]);
    if (requiredRanks.some((rank) => typeof rank !== 'number')) {
      throw new ForbiddenException(`Route declares an unrecognized required role (${required.join(' | ')})`);
    }
    const minRequiredRank = Math.min(...(requiredRanks as number[]));
    if (callerRank < minRequiredRank) {
      throw new ForbiddenException(`Role ${ctx.role} is below the required minimum (${required.join(' | ')})`);
    }
    return true;
  }
}
