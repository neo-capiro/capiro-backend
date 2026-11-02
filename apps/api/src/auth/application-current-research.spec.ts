import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { ApplicationCurrentService } from './application-current.service.js';
import { ApplicationAuthorityController } from './application-authority.controller.js';
import { parseResearchPortfolioCurrentBody } from '../research-portfolios/research-portfolio-sql-authority.js';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), role: 'standard_user' } as TenantContext;
const request = { conversationId: id(3), clientId: null, scopeKind: 'research_portfolio' };

function fixture() {
  const captured = {
    kind: 'research_portfolio', researchPortfolioId: id(4),
    researchPortfolioName: 'Captured portfolio', researchPortfolioRevision: 1,
  };
  const stored = { ...captured, scopeVersion: createHash('sha256').update(JSON.stringify(captured)).digest('hex'),
    currentResearchPortfolioName: 'Untrusted cached name', currentResearchPortfolioRevision: 999, stale: false };
  const conversation: any = { id: id(3), tenantId: ctx.tenantId, userId: ctx.userId,
    clientId: null, status: 'active', archivedAt: null, metadata: { researchPortfolioScope: stored } };
  const portfolio: any = { id: id(4), tenantId: ctx.tenantId, name: 'Current portfolio', revision: 2,
    lifecycle: 'active', grants: [{ id: id(5), role: 'viewer', updatedAt: new Date(100) }],
    clientLinks: [{ clientId: id(6) }] };
  let active = true, granted = true, wall = true;
  const tx: any = {
    $executeRaw: jest.fn(async () => { throw Error('Read-only authority must not acquire row locks'); }),
    $queryRawUnsafe: jest.fn(async (_sql: string, tenant: string, client: string, actor: string) => {
      expect([tenant, actor, client]).toEqual([ctx.tenantId, ctx.userId, id(6)]);
      return [{ allowed: wall }];
    }),
    tenantMembership: { findFirst: jest.fn(async ({ where }: any) => {
      expect(where).toEqual({ tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' });
      return active ? { id: id(7) } : null;
    }) },
    clioConversation: { findFirst: jest.fn(async ({ where }: any) => {
      expect(where).toEqual({ id: id(3), tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null });
      return conversation;
    }) },
    researchPortfolio: { findFirst: jest.fn(async ({ where }: any) => {
      expect(where).toEqual({ id: id(4), tenantId: ctx.tenantId, grants: { some: { principalUserId: ctx.userId } } });
      return granted ? portfolio : null;
    }) },
    clioConversationBootstrapReceipt: { findFirst: jest.fn(async () => ({ requestId: id(8) })) },
  };
  const prisma = { withSystem: jest.fn(async (work: any, options: any) => {
    expect(options).toEqual({ isolationLevel: 'RepeatableRead', readOnly: true });
    return work(tx);
  }) };
  const identity = { principal: { tenantId: ctx.tenantId, actorId: ctx.userId },
    identityRevision: 'a'.repeat(64), expiresAtMs: Date.now() + 120_000 };
  const tenant = { readApplicationAuthoritySession: jest.fn(async () => ({ readCurrent: async () => identity })) };
  const membership = { readInTransaction: jest.fn(async () => {
    if (!active) throw new ForbiddenException('Membership revoked');
    return { role: 'standard_user', permissions: [], clientIds: [id(6)], membershipRevision: 'b'.repeat(64) };
  }) };
  const service = new ApplicationCurrentService(prisma as never, tenant as never, {} as never, {} as never, membership as never);
  const req = { aborted: false, headers: {} } as Request;
  return { service, req, tx, identity, conversation, portfolio, stored, prisma,
    member: (value: boolean) => { active = value; }, grant: (value: boolean) => { granted = value; },
    wall: (value: boolean) => { wall = value; },
    read: (body: unknown = request) => service.readResearch(ctx, req, body) };
}

describe('explicit Research current authority for SQL', () => {
  it('dispatches explicit Research through the actual current controller and preserves ordinary refusal', async () => {
    const f = fixture(); const controller = { current: f.service } as unknown as ApplicationAuthorityController;
    await expect(ApplicationAuthorityController.prototype.applicationAuthorityCurrent.call(controller, ctx, f.req, request))
      .resolves.toMatchObject({ researchPortfolio: { researchPortfolioId: id(4) } });
    await expect(ApplicationAuthorityController.prototype.applicationAuthorityCurrent.call(controller, ctx, f.req,
      { conversationId: id(3), clientId: null })).rejects.toMatchObject({ status: 403 });
  });
  it.each(['viewer', 'editor', 'owner'])('uses the stored capture and current %s grant without repinning', async role => {
    const f = fixture(); f.portfolio.grants[0].role = role;
    const r = await f.read();
    expect(r.researchPortfolio).toEqual({
      kind: 'research_portfolio', researchPortfolioId: id(4),
      researchPortfolioName: 'Captured portfolio', researchPortfolioRevision: 1,
      scopeVersion: f.stored.scopeVersion, currentResearchPortfolioName: 'Current portfolio',
      currentResearchPortfolioRevision: 2, stale: true, resourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(r.selectedClientId).toBeNull();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.tx.clioConversationBootstrapReceipt.findFirst).not.toHaveBeenCalled();
  });

  it('keeps archived portfolio membership scalars readable when a linked client wall is denied', async () => {
    const f = fixture(); f.portfolio.lifecycle = 'archived'; f.wall(false);
    await expect(f.read()).resolves.toMatchObject({ researchPortfolio: { researchPortfolioId: id(4), stale: true } });
  });

  it('reports a matching capture without staleness', async () => {
    const f = fixture(); f.portfolio.name = f.stored.researchPortfolioName; f.portfolio.revision = 1;
    await expect(f.read()).resolves.toMatchObject({ researchPortfolio: { stale: false } });
  });

  it.each(['membership', 'grant'])('refuses revoked %s', async kind => {
    const f = fixture(); if (kind === 'grant') f.grant(false); else f.member(false);
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });

  it.each(['tenantId', 'userId', 'clientId', 'status', 'archivedAt'])('refuses changed conversation %s', async field => {
    const f = fixture(); f.conversation[field] = field === 'archivedAt' ? new Date() : field === 'status' ? 'closed' : id(9);
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });

  it.each(['scopeVersion', 'researchPortfolioId', 'researchPortfolioRevision'])('refuses forged stored capture %s', async field => {
    const f = fixture(); (f.stored as any)[field] = field === 'researchPortfolioRevision' ? 3 : field === 'scopeVersion' ? 'c'.repeat(64) : id(9);
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });

  it('does not turn a General conversation into Research', async () => {
    const f = fixture(); f.conversation.metadata = {};
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });

  it('preserves Research-as-General refusal even with a fabricated General bootstrap receipt', async () => {
    const f = fixture();
    await expect(f.service.read(ctx, f.req, { conversationId: id(3), clientId: null })).rejects.toMatchObject({ status: 403 });
    expect(f.tx.clioConversationBootstrapReceipt.findFirst).not.toHaveBeenCalled();
  });

  it.each(['revision', 'grant', 'wall'])('refuses expected current context after %s changes', async kind => {
    const f = fixture(); const first = await f.read();
    if (kind === 'revision') f.portfolio.revision++;
    else if (kind === 'grant') f.portfolio.grants[0].updatedAt = new Date(200);
    else f.wall(false);
    await expect(f.read({ ...request, expect: { contextRevision: first.contextRevision } })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses observed grant drift during resource observation', async () => {
    const f = fixture(); const original = f.tx.researchPortfolio.findFirst.getMockImplementation(); let calls = 0;
    f.tx.researchPortfolio.findFirst.mockImplementation(async (args: any) => {
      if (++calls === 4) f.portfolio.grants[0].updatedAt = new Date(200);
      return original(args);
    });
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });

  it('propagates source unavailability without authorizing an empty portfolio', async () => {
    const f = fixture(); f.tx.researchPortfolio.findFirst.mockRejectedValue(Error('database unavailable'));
    await expect(f.read()).rejects.toMatchObject({ status: 503 });
  });

  it('honors cancellation before reading the Research projection', async () => {
    const f = fixture(); (f.req as any).aborted = true;
    await expect(f.read()).rejects.toMatchObject({ status: 403 });
  });
});

describe('Research current selector syntax', () => {
  it.each([{ portfolioId: id(9) }, { actorId: id(9) }, { grant: 'owner' }, { clientId: id(9) }, { scopeKind: 'general' }])(
    'rejects model authority or wrong scope %j', extra => {
      expect(() => parseResearchPortfolioCurrentBody({ ...request, ...extra })).toThrow();
    },
  );
  it('rejects getters without evaluating them', () => {
    const getter = jest.fn(() => id(3)); const value = { ...request };
    Object.defineProperty(value, 'conversationId', { enumerable: true, get: getter });
    expect(() => parseResearchPortfolioCurrentBody(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
