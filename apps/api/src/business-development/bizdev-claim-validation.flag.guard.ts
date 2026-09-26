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
  BUSINESS_DEVELOPMENT_CLAIM_VALIDATION_FLAG,
  businessDevelopmentClaimValidationEnabled,
} from '../common/tenant-flags.js';

/**
 * Independently gates the Phase 4 deterministic claim-check endpoint on
 * `businessDevelopment.claimValidation.enabled` (default OFF).
 *
 * BD-CLAIM Jev remains dark until its Phase 3 evaluation gate is satisfied;
 * this guard exposes only the bounded deterministic checker. Every denial or
 * read failure is the same bare 404 used by the other business-development
 * feature guards.
 */
@Injectable()
export class BusinessDevelopmentClaimValidationFlagGuard implements CanActivate {
  private readonly logger = new Logger(BusinessDevelopmentClaimValidationFlagGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    return this.assertEnabledForTenant(req.tenantContext?.tenantId);
  }

  async assertEnabledForTenant(tenantId: string | undefined): Promise<boolean> {
    if (!tenantId) throw new NotFoundException();
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
      );
      if (!tenant || !businessDevelopmentClaimValidationEnabled(tenant.settings)) {
        throw new NotFoundException();
      }
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `${BUSINESS_DEVELOPMENT_CLAIM_VALIDATION_FLAG} read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }
}
