import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  businessDevelopmentEnabled,
  businessDevelopmentWatchEnabled,
} from '../common/tenant-flags.js';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Business Development Phase 5 — ADDITIONAL watch flag guard.
 *
 * Gates every Phase 5 watch/alert HTTP route on the GLOBAL env kill-switch
 * (BIZDEV_WATCH_ENABLED, default OFF) AND the per-tenant
 * `businessDevelopment.watch.enabled` flag (default OFF) ON TOP of the base
 * BusinessDevelopmentFlagGuard (businessDevelopment.enabled), exactly like
 * the Phase 2 dossier / Phase 4 brief guards. Runs AFTER
 * TenantContextMiddleware; apply as
 * `@UseGuards(BusinessDevelopmentWatchFlagGuard)` on a controller that
 * already has RolesGuard + BusinessDevelopmentFlagGuard at class level.
 *
 * ── Fail-closed on every path ───────────────────────────────────────────────
 * 404, not 403: a disabled feature is indistinguishable from a missing route.
 * Missing tenant context, missing tenant row, global switch off, base flag
 * off, watch flag off, malformed settings, and thrown DB error all produce
 * the SAME bare NotFoundException with no detail.
 */
@Injectable()
export class BusinessDevelopmentWatchFlagGuard implements CanActivate {
  private readonly logger = new Logger(BusinessDevelopmentWatchFlagGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    return this.assertEnabledForTenant(tenantId);
  }

  /** Reuse the identical entitlement policy for authorized non-HTTP readers. */
  async assertEnabledForTenant(tenantId: string | undefined): Promise<boolean> {
    // Global env kill-switch FIRST — default OFF, fail closed.
    if (!this.config.get('BIZDEV_WATCH_ENABLED', { infer: true })) {
      throw new NotFoundException();
    }
    if (!tenantId) throw new NotFoundException();

    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        }),
      );
      if (
        !tenant ||
        // Base flag AND watch flag must BOTH resolve true (defaults OFF).
        !businessDevelopmentEnabled(tenant.settings) ||
        !businessDevelopmentWatchEnabled(tenant.settings)
      ) {
        throw new NotFoundException();
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `businessDevelopment.watch flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}
