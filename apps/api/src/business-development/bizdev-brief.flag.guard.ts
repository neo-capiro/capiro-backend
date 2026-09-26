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
import {
  BUSINESS_DEVELOPMENT_BRIEF_FLAG,
  businessDevelopmentBriefEnabled,
} from '../common/tenant-flags.js';

/**
 * Gates the Phase 4 brief surface on the per-tenant
 * `businessDevelopment.brief.enabled` flag (default OFF).
 *
 * Composition with Phase 1/2: the controller already runs RolesGuard then
 * BusinessDevelopmentFlagGuard (Phase 1 flag), and Phase 2 dossier routes add
 * the dossier guard. This guard is applied as an additional `@UseGuards` on
 * the Phase 4 brief routes ONLY.
 *
 * Fail-closed exactly like the Phase 1/2 guards: every failure mode (missing
 * tenant context, missing tenant row, flag false, malformed settings, thrown
 * DB error) yields the SAME bare NotFoundException — indistinguishable from a
 * missing route.
 */
@Injectable()
export class BusinessDevelopmentBriefFlagGuard implements CanActivate {
  private readonly logger = new Logger(BusinessDevelopmentBriefFlagGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    return this.assertEnabledForTenant(req.tenantContext?.tenantId);
  }

  /** Same entitlement check for authorized non-HTTP readers. */
  async assertEnabledForTenant(tenantId: string | undefined): Promise<boolean> {
    if (!tenantId) throw new NotFoundException();
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
      );
      if (!tenant || !businessDevelopmentBriefEnabled(tenant.settings)) {
        throw new NotFoundException();
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `${BUSINESS_DEVELOPMENT_BRIEF_FLAG} read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}