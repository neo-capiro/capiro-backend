import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { businessDevelopmentEnabled } from '../common/tenant-flags.js';

/**
 * Gates every Business Development Phase 1 endpoint on the per-tenant
 * `businessDevelopment.enabled` flag (tenants.settings_jsonb.clioFeatureFlags).
 *
 * Runs AFTER TenantContextMiddleware: apply as
 * `@UseGuards(RolesGuard, BusinessDevelopmentFlagGuard)`.
 *
 * ── Fail-closed on every path ────────────────────────────────────────────────
 * 404, not 403 (District Nexus precedent): a disabled feature must be
 * indistinguishable from a route that doesn't exist. All three failure modes —
 * missing tenant context, tenant lookup error, flag false — throw the SAME
 * NotFoundException() with no detail, so nothing about the feature (or another
 * tenant's state) is disclosed. A thrown DB error is caught and also 404s:
 * the module is OFF unless we can PROVE it is on.
 *
 * The tenant row is read under `withTenant` — tenants is tenant-scoped under
 * RLS, and unlike intel_feature_flag (District Nexus) the flag lives on the
 * tenant's own settings JSON, so no system scope is needed.
 */
@Injectable()
export class BusinessDevelopmentFlagGuard implements CanActivate {
  private readonly logger = new Logger(BusinessDevelopmentFlagGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    return this.assertEnabledForTenant(tenantId);
  }

  /** Reuse the identical entitlement policy for authorized non-HTTP readers. */
  async assertEnabledForTenant(tenantId: string | undefined): Promise<boolean> {
    // No tenant context means auth middleware didn't run. Fail closed, and
    // use the same 404 as a disabled flag so this path leaks nothing either.
    if (!tenantId) throw new NotFoundException();

    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        }),
      );
      // Missing tenant row OR flag false: identical safe not-found.
      if (!tenant || !businessDevelopmentEnabled(tenant.settings)) {
        throw new NotFoundException();
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `businessDevelopment flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}
