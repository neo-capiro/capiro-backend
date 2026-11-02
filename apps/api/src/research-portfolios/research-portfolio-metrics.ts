import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { createMetricsDatabaseBudget } from '../prisma/metrics-database-budget.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

// Observation capacity, not a portfolio capacity or a paginated count.
const MAX_OBSERVED_PORTFOLIOS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = { kind: 'granted' } | { kind: 'client'; clientId: string };
export type ResearchPortfolioMetricsResult = { metric: 'active_research_portfolios'; version: 1; scope: Scope; observedAt: string } &
  ({ status: 'complete'; complete: true; capped: false; count: number } |
   { status: 'incomplete'; complete: false; capped: true; count: null });

/** Fixed aggregate beside the canonical explicit-grant portfolio reader. */
export async function readResearchPortfolioMetrics(
  prisma: Pick<PrismaService, 'withTenant'>, supplied: TenantContext, query: unknown,
  now: () => number = Date.now,
): Promise<ResearchPortfolioMetricsResult> {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => key !== 'clientId')) throw new BadRequestException('Use only an optional clientId.');
  const rawClientId = (query as { clientId?: unknown }).clientId;
  if (rawClientId !== undefined && (typeof rawClientId !== 'string' || !UUID.test(rawClientId)))
    throw new BadRequestException('clientId must be a UUID.');
  const scope: Scope = rawClientId === undefined ? { kind: 'granted' } :
    { kind: 'client', clientId: (rawClientId as string).toLowerCase() };
  const ctx = { ...supplied }, started = now();
  const unavailable = () => new ServiceUnavailableException('Research portfolio metrics changed or are unavailable. Please retry.');
  const { prisma: database, assertActive } = createMetricsDatabaseBudget(prisma, started, now);
  const where: Prisma.ResearchPortfolioWhereInput = {
    tenantId: ctx.tenantId, lifecycle: 'active',
    grants: { some: { tenantId: ctx.tenantId, principalUserId: ctx.userId, role: { in: ['viewer', 'editor', 'owner'] } } },
    ...(scope.kind === 'client' ? { clientLinks: { some: { tenantId: ctx.tenantId, clientId: scope.clientId } } } : {}),
  };
  async function principal(tx: Prisma.TransactionClient) {
    assertActive();
    const member = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active', user: { clerkUserId: ctx.clerkUserId } },
      select: { id: true, role: true, updatedAt: true },
    });
    if (!member) throw new ForbiddenException('Active tenant membership required');
    if (scope.kind === 'client') {
      const client = await tx.client.findFirst({
        where: { id: scope.clientId, tenantId: ctx.tenantId, status: { not: 'archived' } }, select: { id: true },
      });
      if (!client || !await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, scope.clientId))
        throw new NotFoundException('Client not found');
    }
    assertActive();
    return JSON.stringify(member);
  }
  async function observe() {
    return database.withTenant(ctx.tenantId, async tx => {
      const before = await principal(tx);
      const rows = await tx.researchPortfolio.findMany({ where, orderBy: { id: 'asc' },
        take: MAX_OBSERVED_PORTFOLIOS + 1,
        select: { id: true,
          grants: { where: { tenantId: ctx.tenantId, principalUserId: ctx.userId },
            select: { id: true, role: true, updatedAt: true }, take: 1 },
          ...(scope.kind === 'client' ? { clientLinks: {
            where: { tenantId: ctx.tenantId, clientId: scope.clientId }, select: { id: true, createdAt: true }, take: 1,
          } } : {}),
        },
      });
      const after = await principal(tx);
      if (before !== after) throw unavailable();
      return { key: JSON.stringify([after, rows]), size: rows.length,
        incomplete: rows.length > MAX_OBSERVED_PORTFOLIOS };
    });
  }
  assertActive();
  const before = await observe();
  const metadata = { metric: 'active_research_portfolios' as const, version: 1 as const, scope };
  if (before.incomplete) {
    assertActive();
    return { ...metadata, observedAt: new Date(now()).toISOString(),
      status: 'incomplete', complete: false, capped: true, count: null };
  }
  // Count the full primary-row population with the same grant/link predicate.
  // The vector only fences currentness; its length is never the metric value.
  const count = await database.withTenant(ctx.tenantId, tx => tx.researchPortfolio.count({ where }));
  assertActive();
  const after = await observe();
  if (after.incomplete || before.key !== after.key || !Number.isSafeInteger(count) ||
      count < 0 || count !== before.size) throw unavailable();
  assertActive();
  return { ...metadata, observedAt: new Date(now()).toISOString(),
    status: 'complete', complete: true, capped: false, count };
}
