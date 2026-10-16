import { createHash } from 'node:crypto';
import { ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed, fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import {
  loadAuthorizedResearchPortfolioCurrentFacts,
  RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS,
} from './research-portfolio-access.js';

type Operation = 'get_research_portfolio' | 'get_research_portfolio_changes';
type Facts = {
  portfolio: [id: string, name: string, revision: number, lifecycle: string];
  grant: [id: string, role: string, updatedAtMs: number];
  linkedClientIds: string[];
};
type WallFacts = string[] | Array<[clientId: string, allowed: boolean]>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = () => new ServiceUnavailableException('Portfolio authority unavailable');
const changed = () => new ConflictException('Portfolio authority changed; reload');

function assertFacts(condition: unknown): asserts condition {
  if (!condition) throw unavailable();
}

function record(value: unknown): Record<string, unknown> {
  assertFacts(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function sortedClientIds(value: unknown): string[] {
  assertFacts(Array.isArray(value) && value.length <= RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS);
  assertFacts(value.every(uuid));
  const ids = [...value].sort();
  assertFacts(new Set(ids).size === ids.length);
  return ids;
}

function currentFacts(value: unknown, ctx: TenantContext, portfolioId: string, detail: boolean): Facts {
  const row = record(value);
  assertFacts(row.id === portfolioId && row.tenantId === ctx.tenantId);
  assertFacts(typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 400 &&
    Array.from(row.name).length <= 200);
  assertFacts(Number.isSafeInteger(row.revision) && (row.revision as number) >= 0);
  assertFacts(row.lifecycle === 'active' || row.lifecycle === 'archived');
  assertFacts(Array.isArray(row.grants) && row.grants.length === 1);
  const grant = record(row.grants[0]);
  assertFacts(uuid(grant.id));
  assertFacts(grant.role === 'viewer' || grant.role === 'editor' || grant.role === 'owner');
  assertFacts(grant.updatedAt instanceof Date && Number.isSafeInteger(grant.updatedAt.getTime()));
  let linkedClientIds: string[] = [];
  if (detail) {
    assertFacts(Array.isArray(row.clientLinks) && row.clientLinks.length <= RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS);
    linkedClientIds = sortedClientIds(row.clientLinks.map((link) => record(link).clientId));
  }
  return {
    portfolio: [portfolioId, row.name, row.revision as number, row.lifecycle],
    grant: [grant.id, grant.role, grant.updatedAt.getTime()],
    linkedClientIds,
  };
}

function assertSame(before: unknown, after: unknown): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw changed();
}

/** Private current observation, not a capability or native-conversation proof.
 * Caller owns current membership, authenticated principal and captured subject.
 * Two wall observations are bracketed by current grant/resource reads; equality
 * cannot prove that no change-and-revert occurred between those observations. */
export async function readResearchPortfolioResourceRevision(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  portfolioId: string,
  operation: Operation,
  checkpoint: () => void,
): Promise<{ portfolioId: string; resourceRevision: string }> {
  checkpoint();
  assertFacts(uuid(ctx.tenantId) && uuid(ctx.userId) && uuid(portfolioId));
  assertFacts(operation === 'get_research_portfolio' || operation === 'get_research_portfolio_changes');
  const detail = operation === 'get_research_portfolio';

  async function read<T>(query: () => Promise<T>): Promise<T> {
    checkpoint();
    let result: T;
    try {
      result = await query();
    } catch (error) {
      checkpoint();
      if (error instanceof HttpException) throw error;
      throw unavailable();
    }
    checkpoint();
    return result;
  }

  async function resource(): Promise<Facts> {
    const row = await read(() => loadAuthorizedResearchPortfolioCurrentFacts(tx, ctx, portfolioId, detail));
    return currentFacts(row, ctx, portfolioId, detail);
  }

  async function walls(facts: Facts): Promise<WallFacts> {
    if (!detail) {
      const ids = await read(() => fetchDeniedClientIds(
        tx, ctx.tenantId, ctx.userId, RESEARCH_PORTFOLIO_AUTHORITY_MAX_CLIENTS + 1,
      ));
      return sortedClientIds(ids);
    }
    const decisions: Array<[string, boolean]> = [];
    for (const clientId of facts.linkedClientIds) {
      const allowed = await read(() => clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId));
      assertFacts(typeof allowed === 'boolean');
      // A denied link changes the producer's projection, not portfolio access.
      decisions.push([clientId, allowed]);
    }
    return decisions;
  }

  const first = await resource();
  const firstWalls = await walls(first);
  const second = await resource();
  assertSame(first, second);
  const secondWalls = await walls(second);
  const final = await resource();
  assertSame(second, final);
  assertSame(firstWalls, secondWalls);
  checkpoint();
  return {
    portfolioId,
    resourceRevision: createHash('sha256').update(JSON.stringify([
      'capiro-portfolio-resource-v1', ctx.tenantId, ctx.userId, operation,
      final.portfolio, final.grant,
      detail ? 'linked-client-walls' : 'tenant-denied-clients', secondWalls,
    ])).digest('hex'),
  };
}
