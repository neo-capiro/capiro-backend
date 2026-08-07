import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MERIV3_CHAT_FLAG } from '../common/meriv3-flags.js';
import { MeriFeatureFlagsService } from '../meri/meri-feature-flags.service.js';

@Injectable()
export class MeriV3AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: MeriFeatureFlagsService,
  ) {}

  async setEnabled(actor: TenantContext, tenantId: string, enabled: boolean) {
    const result = await this.prisma.withSystem(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true, settings: true },
      });
      if (!tenant) throw new NotFoundException('Tenant not found');
      const settings =
        tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings)
          ? (tenant.settings as Record<string, unknown>)
          : {};
      const previousFlags =
        settings.clioFeatureFlags &&
        typeof settings.clioFeatureFlags === 'object' &&
        !Array.isArray(settings.clioFeatureFlags)
          ? (settings.clioFeatureFlags as Record<string, unknown>)
          : {};
      const clioFeatureFlags = { ...previousFlags, [MERIV3_CHAT_FLAG]: enabled };
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          settings: { ...settings, clioFeatureFlags } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'meriv3.canary.set',
          entityType: 'tenant',
          entityId: tenantId,
          before: {
            tenantSlug: tenant.slug,
            enabled: previousFlags[MERIV3_CHAT_FLAG] === true,
          },
          after: { tenantSlug: tenant.slug, enabled },
        },
      });
      return { tenantSlug: tenant.slug, clioFeatureFlags };
    });
    this.flags.invalidate(tenantId);
    return {
      tenantId,
      tenantSlug: result.tenantSlug,
      flag: MERIV3_CHAT_FLAG,
      enabled,
      clioFeatureFlags: result.clioFeatureFlags,
    };
  }
}
