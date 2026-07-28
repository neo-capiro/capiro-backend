import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const DISTRICT_NEXUS_FEATURE = 'district_nexus_v2';
export const CAPIRO_INTERNAL_TENANT_SLUG = 'capiro-internal';

/**
 * Gates every District Nexus v2 endpoint on the per-tenant
 * `district_nexus_v2` row in `intel_feature_flag` (plan §4.5).
 *
 * Runs AFTER TenantContextMiddleware, so apply as
 * `@UseGuards(RolesGuard, DistrictNexusFlagGuard)`.
 *
 * ── Three decisions worth knowing about ─────────────────────────────────────
 *
 * 404, not 403. intel-api's feature guards 404 so a disabled feature is
 * indistinguishable from a route that doesn't exist. A 403 advertises that the
 * capability exists and this tenant isn't paying for it. We match intel-api
 * rather than the /strategy-api guards, which deliberately 403 for a different
 * reason (letting their client distinguish "not entitled" from "not found").
 *
 * withSystem, not withTenant. `intel_feature_flag` is owned by intel-api and
 * has RLS FORCE-enabled. apps/api's connection sets no tenant GUC, so a plain
 * read returns ZERO rows and every tenant would look disabled — the feature
 * would be permanently dark with no error to explain it. Same reasoning, and
 * the same withSystem discipline, as tracker-change-detector's
 * intelOwnedTenantIds().
 *
 * The internal tenant is always on. The configured UUID remains the cheapest
 * path when present. The query also resolves the canonical `capiro-internal`
 * tenant slug under the system scope, so a missing task-definition variable can
 * no longer make the web advertise the canary while every API call returns 404.
 * This fallback is deliberately DB-backed rather than another hard-coded UUID:
 * the tenant row is the identity source of truth and can be re-created without
 * requiring a code change.
 */
@Injectable()
export class DistrictNexusFlagGuard implements CanActivate {
  private readonly logger = new Logger(DistrictNexusFlagGuard.name);
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

    // No tenant context means auth middleware didn't run. Fail closed, and use
    // the same 404 as a disabled flag so this path leaks nothing either.
    if (!tenantId) throw new NotFoundException();

    if (this.internalTenantId && tenantId === this.internalTenantId) return true;

    let enabled = false;
    try {
      // NO ::uuid cast on intel_feature_flag. `tenant_id` is TEXT, not uuid —
      // intel-api owns the table and declares it `tenantId String` with no
      // @db.Uuid (apps/intel-api/prisma/schema.prisma), and its RLS policy
      // casts the other way round: `tenant_id = (current_tenant_id())::text`.
      //
      // The plan's §4.5 sketch specified a uuid cast, and that was wrong. With
      // it, every read threw `42883 operator does not exist: text = uuid`, hit
      // the catch below, and failed closed — so the feature 404'd for a tenant
      // whose flag was genuinely enabled. It could not surface until the flag
      // was first switched on for someone (2026-07-26), because with no rows
      // anywhere the guard's answer was "denied" either way.
      //
      // The second EXISTS is the self-contained internal-canary fallback. It is
      // evaluated inside the same system-scoped query, so there is no second
      // round trip and no fail-open path if either table read errors.
      const rows = await this.prisma.withSystem((tx) =>
        tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok
          WHERE EXISTS (
            SELECT 1
            FROM intel_feature_flag
            WHERE feature = ${DISTRICT_NEXUS_FEATURE}
              AND tenant_id = ${tenantId}
              AND enabled = true
          )
          OR EXISTS (
            SELECT 1
            FROM tenants
            WHERE id::text = ${tenantId}
              AND slug = ${CAPIRO_INTERNAL_TENANT_SLUG}
          )
          LIMIT 1
        `,
      );
      enabled = rows.length > 0;
    } catch (error) {
      // Fail closed. A flag read that errors must not open the feature — the
      // whole point of the gate is that unseeded tenants see nothing.
      this.logger.error(
        `district_nexus_v2 flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }

    if (!enabled) throw new NotFoundException();
    return true;
  }
}
