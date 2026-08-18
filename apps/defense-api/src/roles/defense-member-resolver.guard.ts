import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DefenseTenantContext } from '../program-elements/program-elements.shared.js';

declare module 'express-serve-static-core' {
  interface Request {
    defenseTenantContext?: DefenseTenantContext;
  }
}

const KNOWN_ROLES = new Set(['capiro_admin', 'user_admin', 'standard_user', 'client_portal_user']);

/**
 * Bridges @capiro/auth's TenantGuard output (Clerk-verified tenantId +
 * clerkUserId) to the frozen contract's DefenseTenantContext (Capiro user
 * UUID + TenantRole). Runs AFTER TenantGuard in the guard chain.
 *
 * Resolves via the ONE narrow SECURITY DEFINER function granted to
 * capiro_defense_serve for this purpose (capiro_defense_resolve_member,
 * migration 20261120210000_phase8_defense_serve_user_resolver) — no generic
 * RLS-bypass path, mirroring org-tenant-resolver.provider.ts.
 */
@Injectable()
export class DefenseMemberResolverGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const auth = req.tenantContext;
    if (!auth) {
      throw new ForbiddenException('No tenant context; TenantGuard did not run before DefenseMemberResolverGuard');
    }

    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; role: string }>>`
      SELECT user_id, role FROM capiro_defense_resolve_member(${auth.tenantId}::uuid, ${auth.clerkUserId})
    `;
    const row = rows[0];
    if (!row || !KNOWN_ROLES.has(row.role)) {
      throw new ForbiddenException('No active Capiro membership resolvable for this tenant/user');
    }

    req.defenseTenantContext = { tenantId: auth.tenantId, userId: row.user_id, role: row.role };
    return true;
  }
}
