import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const CAPIRO_INTERNAL_TENANT_SLUG = 'capiro-internal';

/**
 * Gates the Defense Budget lifecycle/source-coverage read routes to the
 * `capiro-internal` tenant only.
 *
 * Modeled on `../district-nexus/district-nexus-flag.guard.ts`, with its
 * `intel_feature_flag` OR-branch removed: per the Defense Budget vNext ship
 * task, this surface is strictly capiro-internal, not "internal + whoever has
 * a rollout flag." Run AFTER TenantContextMiddleware, so apply as
 * `@UseGuards(RolesGuard, DefenseBudgetLifecycleInternalGuard)` — RolesGuard
 * first, so an unauthenticated caller can't use this guard's 404 to probe
 * tenant identity.
 *
 * 404, not 403 — a tenant outside this surface must see the same response a
 * nonexistent route would produce, not a signal that the capability exists.
 *
 * withSystem, not withTenant — `tenants` is read under the RLS-bypass scope
 * for the same reason `DistrictNexusFlagGuard` does: this is a system-level
 * identity check, not a per-tenant data read, and it must not depend on (or
 * be capped by) whatever tenant scope the caller's own request would imply.
 *
 * The configured `CAPIRO_INTERNAL_TENANT_ID` is the fast path; the DB-backed
 * slug lookup is the fallback so a missing/rotated env var can't silently
 * dark the canary tenant. Any read error fails closed (404), never open.
 */
@Injectable()
export class DefenseBudgetLifecycleInternalGuard implements CanActivate {
  private readonly logger = new Logger(DefenseBudgetLifecycleInternalGuard.name);
  private readonly internalTenantId?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.internalTenantId = config.get<string>('CAPIRO_INTERNAL_TENANT_ID')?.trim() || undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;

    // No tenant context means auth middleware didn't run. Fail closed with
    // the same 404 a disabled surface would produce.
    if (!tenantId) throw new NotFoundException();

    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    let isInternal = false;
    try {
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          WHERE EXISTS (
            SELECT 1
            FROM tenants
            WHERE id::text = ${tenantId}
              AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
          )
          LIMIT 1
        `,
      );
      isInternal = rows.length > 0;
    } catch (error) {
      // Fail closed. A tenant-identity read that errors must not open a
      // capiro-internal-only surface to whoever happened to be asking.
      this.logger.error(
        `capiro-internal tenant check failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }

    if (!isInternal) throw new NotFoundException();
    return true;
  }
}
