import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthTenantContext } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * @capiro/auth's TenantGuard resolves `tenantId` from the JWT as either the
 * Capiro tenant UUID (`capiro_tenant_id` template claim, preferred) or the
 * raw Clerk org id (`org_...`, fallback when the template claim is absent).
 * Everything in this service keys on the tenant UUID, so normalize here.
 */
@Injectable()
export class TenantResolverService {
  private readonly cache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveTenantUuid(ctx: AuthTenantContext): Promise<string> {
    const raw = ctx.tenantId;
    if (!raw.startsWith('org_')) return raw;

    const cached = this.cache.get(raw);
    if (cached) return cached;

    const tenant = await this.prisma.withSystem((tx) =>
      tx.tenant.findUnique({ where: { clerkOrgId: raw }, select: { id: true } }),
    );
    if (!tenant) {
      throw new ForbiddenException('No tenant for org');
    }
    this.cache.set(raw, tenant.id);
    return tenant.id;
  }
}
