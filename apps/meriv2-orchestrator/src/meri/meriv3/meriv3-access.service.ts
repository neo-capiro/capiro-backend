import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export const MERIV3_TENANT_FLAG = 'meriv3.fullChat' as const;
const CACHE_TTL_MS = 30_000;

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/**
 * Same two keys as the API gate (apps/api/src/common/meriv3-flags.ts), program
 * plan 2026-10-05 §4.1: the global MERIV3_ENABLED kill switch (unset means on)
 * and the tenant's meriv3.fullChat off switch (only an explicit false closes
 * it). There is no slug allow-list; the API decides routing and refuses a
 * closed tenant itself, this check is defense in depth.
 */
export function meriV3EnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MERIV3_ENABLED?.trim().toLowerCase();
  return !raw || !OFF_VALUES.has(raw);
}

export function tenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return true;
  return (flags as Record<string, unknown>)[MERIV3_TENANT_FLAG] !== false;
}

@Injectable()
export class MeriV3AccessService {
  private readonly logger = new Logger(MeriV3AccessService.name);
  private readonly cache = new Map<
    string,
    { allowed: boolean; slug: string | null; fetchedAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async isAllowed(tenantId: string): Promise<boolean> {
    if (!meriV3EnvironmentEnabled()) return false;
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.allowed;
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { slug: true, settings: true },
        }),
      );
      const slug = tenant?.slug?.toLowerCase() ?? null;
      // A tenant row must exist; its flag only closes on an explicit false.
      const allowed = Boolean(tenant) && tenantFlagEnabled(tenant?.settings);
      this.cache.set(tenantId, { allowed, slug, fetchedAt: Date.now() });
      return allowed;
    } catch (error) {
      this.logger.warn(
        `MeriV3 access check failed closed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
