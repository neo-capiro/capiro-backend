import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';

export const MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY = 'researchPortfolioScope';

export interface MeriResearchPortfolioScope {
  kind: 'research_portfolio';
  researchPortfolioId: string;
  researchPortfolioName: string;
  researchPortfolioRevision: number;
  scopeVersion: string;
  currentResearchPortfolioName: string;
  currentResearchPortfolioRevision: number;
  stale: boolean;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function readMeriResearchPortfolioScope(value: unknown): MeriResearchPortfolioScope | null {
  const row = object(value);
  if (
    row?.kind !== 'research_portfolio' ||
    typeof row.researchPortfolioId !== 'string' ||
    !row.researchPortfolioId ||
    typeof row.researchPortfolioName !== 'string' ||
    !row.researchPortfolioName.trim() ||
    !Number.isInteger(row.researchPortfolioRevision) ||
    (row.researchPortfolioRevision as number) < 0 ||
    typeof row.scopeVersion !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.scopeVersion)
  )
    return null;
  return {
    kind: 'research_portfolio',
    researchPortfolioId: row.researchPortfolioId,
    researchPortfolioName: row.researchPortfolioName.trim(),
    researchPortfolioRevision: row.researchPortfolioRevision as number,
    scopeVersion: row.scopeVersion,
    currentResearchPortfolioName:
      typeof row.currentResearchPortfolioName === 'string' &&
      row.currentResearchPortfolioName.trim()
        ? row.currentResearchPortfolioName.trim()
        : row.researchPortfolioName.trim(),
    currentResearchPortfolioRevision:
      Number.isInteger(row.currentResearchPortfolioRevision) &&
      (row.currentResearchPortfolioRevision as number) >= 0
        ? (row.currentResearchPortfolioRevision as number)
        : (row.researchPortfolioRevision as number),
    stale: row.stale === true,
  };
}

@Injectable()
export class ResearchPortfolioMeriScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(ctx: TenantContext, portfolioId: string): Promise<MeriResearchPortfolioScope> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const bounded = {
        kind: 'research_portfolio' as const,
        researchPortfolioId: row.id,
        researchPortfolioName: row.name,
        researchPortfolioRevision: row.revision,
      };
      return {
        ...bounded,
        scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex'),
        currentResearchPortfolioName: row.name,
        currentResearchPortfolioRevision: row.revision,
        stale: false,
      };
    });
  }

  async authorize(
    ctx: TenantContext,
    stored: MeriResearchPortfolioScope,
  ): Promise<MeriResearchPortfolioScope> {
    const current = await this.resolve(ctx, stored.researchPortfolioId);
    // The immutable receipt identifies what the user launched. Current access
    // is rechecked above; later portfolio revisions do not silently rewrite the
    // receipt attached to earlier turns.
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          kind: stored.kind,
          researchPortfolioId: stored.researchPortfolioId,
          researchPortfolioName: stored.researchPortfolioName,
          researchPortfolioRevision: stored.researchPortfolioRevision,
        }),
      )
      .digest('hex');
    if (stored.scopeVersion !== expected) {
      throw new ForbiddenException('Research Portfolio scope receipt is invalid');
    }
    return {
      ...stored,
      currentResearchPortfolioName: current.researchPortfolioName,
      currentResearchPortfolioRevision: current.researchPortfolioRevision,
      stale:
        current.researchPortfolioRevision !== stored.researchPortfolioRevision ||
        current.researchPortfolioName !== stored.researchPortfolioName,
    };
  }
}

export async function authorizeMeriResearchPortfolioScope(
  service: ResearchPortfolioMeriScopeService | undefined,
  ctx: TenantContext,
  metadata: Prisma.JsonValue | null | undefined,
): Promise<MeriResearchPortfolioScope | null> {
  const meta = object(metadata);
  if (!meta || !Object.hasOwn(meta, MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY)) return null;
  const stored = readMeriResearchPortfolioScope(meta[MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]);
  if (!stored || !service) throw new ForbiddenException('Research Portfolio scope is unavailable');
  return service.authorize(ctx, stored);
}

export function researchPortfolioScopeDirective(scope: MeriResearchPortfolioScope): string {
  return [
    'The active scope is one Defense Intelligence Research Portfolio.',
    `Research Portfolio ID: ${scope.researchPortfolioId}`,
    `Name: ${scope.researchPortfolioName}`,
    `Captured revision: ${scope.researchPortfolioRevision}`,
    `Current revision: ${scope.currentResearchPortfolioRevision}`,
    `Context freshness: ${scope.stale ? 'stale — use current reads before relying on captured values' : 'current'}`,
    `Scope receipt: ${scope.scopeVersion}`,
    'Research Portfolio tools are server-bound to this conversation receipt. Never switch portfolio authority from model input, and do not reinterpret ordinary portfolio scope (all firm clients) as this research portfolio.',
  ].join('\n');
}

export function researchPortfolioTurnScopeReceipt(scope: MeriResearchPortfolioScope) {
  return {
    kind: 'research_portfolio' as const,
    clientId: null,
    clientName: null,
    targetHint: null,
    researchPortfolioId: scope.researchPortfolioId,
    researchPortfolioName: scope.researchPortfolioName,
    researchPortfolioRevision: scope.researchPortfolioRevision,
    currentResearchPortfolioRevision: scope.currentResearchPortfolioRevision,
    stale: scope.stale,
    scopeVersion: scope.scopeVersion,
  };
}
