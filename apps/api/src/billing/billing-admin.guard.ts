import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Billing-visibility gate (onboarding v1, Ninja decisions Q6/Q8): the full
 * billing surface is visible ONLY to
 *   • `capiro_admin`, or
 *   • a `user_admin` whose membership carries `billing_admin = true`
 *     (the Gherkin "Super Admin").
 * Everyone else gets an opaque 403 with zero billing detail.
 *
 * Runs AFTER the tenant-context middleware (ctx is on the request); the
 * membership bit is read here rather than added to the change-controlled
 * middleware.
 */
@Injectable()
export class BillingAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ tenantContext?: TenantContext }>();
    const ctx = req.tenantContext;
    if (!ctx) throw new ForbiddenException('No tenant context');
    if (ctx.role === 'capiro_admin') return true;
    if (ctx.role !== 'user_admin') {
      throw new ForbiddenException('Billing is managed by your billing admin.');
    }
    const membership = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
        select: { billingAdmin: true, status: true },
      }),
    );
    if (membership?.status !== 'active' || !membership.billingAdmin) {
      throw new ForbiddenException('Billing is managed by your billing admin.');
    }
    return true;
  }
}
