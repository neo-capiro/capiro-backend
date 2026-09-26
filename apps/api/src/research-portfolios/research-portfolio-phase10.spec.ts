import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  authorizeMeriResearchPortfolioScope,
  MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY,
  readMeriResearchPortfolioScope,
  ResearchPortfolioMeriScopeService,
  researchPortfolioTurnScopeReceipt,
} from './research-portfolio-meri-scope.service.js';
import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const portfolioId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';

describe('Research Portfolio Phase 10 Meri integration', () => {
  test('uses the same portfolio services for reads, watches, snapshots and outputs', async () => {
    const portfolios = { detail: jest.fn(async () => ({ id: portfolioId })) };
    const analytics = {
      analytics: jest.fn(async () => ({ availability: 'unavailable' })),
      createSnapshot: jest.fn(async () => ({ id: 'snapshot-1' })),
    };
    const changes = {
      listChanges: jest.fn(async () => ({ items: [], nextCursor: null })),
      createSubscription: jest.fn(async () => ({ id: 'watch-1' })),
      updateEventState: jest.fn(async () => ({ revision: 2 })),
    };
    const outputs = {
      create: jest.fn(async () => ({ id: 'job-1' })),
      saveToClient: jest.fn(async () => ({ attachmentId: 'attachment-1' })),
    };
    const receipt = {
      kind: 'research_portfolio' as const,
      researchPortfolioId: portfolioId,
      researchPortfolioName: 'Autonomous Maritime Systems',
      researchPortfolioRevision: 7,
      scopeVersion: 'a'.repeat(64),
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
        callback({
          clioConversation: {
            findFirst: jest.fn(async () => ({
              metadata: { [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: receipt },
            })),
          },
        }),
      ),
    };
    const scope = { authorize: jest.fn(async () => receipt) };
    const service = new ResearchPortfolioMeriToolsService(
      prisma as never,
      scope as never,
      portfolios as never,
      analytics as never,
      changes as never,
      outputs as never,
    );
    await expect(service.execute(ctx, 'get_research_portfolio', { conversationId }))
      .resolves.toEqual({ id: portfolioId });
    await expect(service.execute(ctx, 'watch_research_portfolio', { conversationId }))
      .resolves.toEqual({ id: 'watch-1' });
    await service.execute(ctx, 'create_research_portfolio_snapshot', {
      conversationId,
      operationKey: 'snapshot:key',
      name: 'Current baseline',
      expectedRevision: 7,
    });
    await service.execute(ctx, 'request_research_portfolio_output', {
      conversationId,
      operationKey: 'output:key',
    });
    expect(changes.createSubscription).toHaveBeenCalledWith(ctx, portfolioId, {
      targetKind: 'portfolio', targetId: portfolioId, channel: 'in_app', cadence: 'immediate',
    });
    expect(outputs.create).toHaveBeenCalledWith(ctx, portfolioId, expect.objectContaining({
      operationKey: 'output:key', format: 'csv', includeSourceAppendix: true,
    }));
    await expect(service.execute(ctx, 'get_research_portfolio', {
      conversationId,
      portfolioId,
    })).rejects.toThrow('portfolioId is controlled by the server');
  });

  test('resolves an immutable receipt and rechecks current access on every turn', async () => {
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
        callback({
          researchPortfolio: {
            findFirst: jest.fn(async () => ({
              id: portfolioId,
              tenantId: ctx.tenantId,
              name: 'Autonomous Maritime Systems',
              revision: 9,
              grants: [{ role: 'viewer' }],
              clientLinks: [],
            })),
          },
        }),
      ),
    };
    const service = new ResearchPortfolioMeriScopeService(prisma as never);
    const receipt = await service.resolve(ctx, portfolioId);
    expect(receipt.scopeVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(researchPortfolioTurnScopeReceipt(receipt)).toMatchObject({
      kind: 'research_portfolio', researchPortfolioId: portfolioId, researchPortfolioRevision: 9,
    });
    await expect(authorizeMeriResearchPortfolioScope(service, ctx, {
      [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: receipt,
    } as never)).resolves.toMatchObject({ researchPortfolioId: portfolioId });
    expect(prisma.withTenant).toHaveBeenCalledTimes(2);
  });

  test('fails closed for malformed or unavailable scoped conversations', async () => {
    expect(readMeriResearchPortfolioScope({
      kind: 'research_portfolio', researchPortfolioId: portfolioId,
      researchPortfolioName: 'x', researchPortfolioRevision: 1, scopeVersion: 'short',
    })).toBeNull();
    await expect(authorizeMeriResearchPortfolioScope(undefined, ctx, {
      [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: {
        kind: 'research_portfolio', researchPortfolioId: portfolioId,
        researchPortfolioName: 'x', researchPortfolioRevision: 1, scopeVersion: 'a'.repeat(64),
      },
    })).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('restores an existing paused watch without replacing its quiet-first baseline', async () => {
    const baselineCompletedAt = new Date('2026-09-25T12:00:00.000Z');
    const existing = {
      id: 'watch-1', portfolioId, subscriberUserId: ctx.userId,
      targetKind: 'portfolio', targetId: portfolioId, channel: 'in_app', cadence: 'immediate',
      active: false, baselineEventId: 'event-1', baselineRevision: 7, baselineCompletedAt,
      checkpoint: { quietFirstBaseline: true }, createdAt: baselineCompletedAt, updatedAt: baselineCompletedAt,
    };
    const update = jest.fn(async () => ({ ...existing, active: true }));
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
        callback({
          researchPortfolio: { findFirst: jest.fn(async () => ({
            id: portfolioId, tenantId: ctx.tenantId, name: 'Portfolio', revision: 9,
            grants: [{ role: 'viewer' }], clientLinks: [],
          })) },
          researchPortfolioSubscription: {
            findFirst: jest.fn(async () => existing),
            update,
          },
        }),
      ),
    };
    const service = new ResearchPortfolioChangesService(prisma as never);
    await expect(service.createSubscription(ctx, portfolioId, {
      targetKind: 'portfolio', targetId: portfolioId, channel: 'in_app', cadence: 'immediate',
    })).resolves.toMatchObject({ id: 'watch-1', active: true, baselineRevision: 7 });
    expect(update).toHaveBeenCalledWith({ where: { id: 'watch-1' }, data: { active: true } });
  });

  test('withholds client-private change events after that client wall is revoked', async () => {
    const deniedClientId = '55555555-5555-4555-8555-555555555555';
    const occurredAt = new Date('2026-09-26T05:00:00.000Z');
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ allowed: false }]),
      researchPortfolio: { findFirst: jest.fn(async () => ({
        id: portfolioId, tenantId: ctx.tenantId, name: 'Portfolio', revision: 9,
        grants: [{ role: 'viewer' }], clientLinks: [{ clientId: deniedClientId }],
      })) },
      researchPortfolioSubscription: { findMany: jest.fn(async () => []) },
      researchPortfolioEvent: { findMany: jest.fn(async () => [
        { id: 'event-private', portfolioId, eventKind: 'client_linked', aggregateRevision: 9, actorUserId: ctx.userId, occurredAt, payload: { clientId: deniedClientId }, recipientStates: [] },
        { id: 'event-public', portfolioId, eventKind: 'member_added', aggregateRevision: 8, actorUserId: ctx.userId, occurredAt, payload: { memberId: 'member-1' }, recipientStates: [] },
      ]) },
    };
    const prisma = { withTenant: jest.fn(async (_tenantId: string, callback: (value: unknown) => unknown) => callback(tx)) };
    const service = new ResearchPortfolioChangesService(prisma as never);
    await expect(service.listChanges(ctx, portfolioId, null, 25)).resolves.toMatchObject({
      items: [{ id: 'event-public' }],
      nextCursor: null,
    });
  });
});
