import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export const MERIV3_TENANT_FLAG = 'meriv3.fullChat' as const;
const CACHE_TTL_MS = 30_000;

export function meriV3EnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV3_ENABLED === 'true';
}

export function meriV3CanarySlugs(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.MERIV3_CANARY_TENANT_SLUGS?.trim() || 'capiro-internal';
  return new Set(
    raw
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function tenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  return (flags as Record<string, unknown>)[MERIV3_TENANT_FLAG] === true;
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
      const allowed = Boolean(
        slug && meriV3CanarySlugs().has(slug) && tenantFlagEnabled(tenant?.settings),
      );
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
