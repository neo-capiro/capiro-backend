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
  BUSINESS_DEVELOPMENT_DOSSIER_FLAG,
  businessDevelopmentDossierEnabled,
} from '../common/tenant-flags.js';

/**
 * Gates the Phase 2 dossier/candidate-search surface on the per-tenant
 * `businessDevelopment.dossier.enabled` flag (default OFF).
 *
 * Composition with Phase 1: the controller already runs RolesGuard then
 * BusinessDevelopmentFlagGuard (Phase 1 flag). This guard is applied as an
 * additional `@UseGuards(BusinessDevelopmentDossierFlagGuard)` on the Phase 2
 * routes ONLY, so Phase 1 routes remain available when just the dossier
 * surface is off.
 *
 * Fail-closed exactly like BusinessDevelopmentFlagGuard: every failure mode
 * (missing tenant context, missing tenant row, flag false, malformed
 * settings, thrown DB error) yields the SAME bare NotFoundException —
 * indistinguishable from a missing route.
 */
@Injectable()
export class BusinessDevelopmentDossierFlagGuard implements CanActivate {
  private readonly logger = new Logger(BusinessDevelopmentDossierFlagGuard.name);

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
      if (!tenant || !businessDevelopmentDossierEnabled(tenant.settings)) {
        throw new NotFoundException();
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `${BUSINESS_DEVELOPMENT_DOSSIER_FLAG} read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}
