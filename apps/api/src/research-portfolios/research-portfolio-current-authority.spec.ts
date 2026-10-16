import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';
import { readResearchPortfolioResourceRevision } from './research-portfolio-current-authority.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const portfolioId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const grantId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const firstClient = '11111111-1111-4111-8111-111111111111';
const secondClient = '22222222-2222-4222-8222-222222222222';
const historicalClient = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
const detail = 'get_research_portfolio' as const;
const changes = 'get_research_portfolio_changes' as const;

/** Actual canonical loaders/wall functions; only transactional I/O is synthetic. */
function fixture() {
  const row: any = {
    id: portfolioId, tenantId, name: 'Public portfolio', revision: 4, lifecycle: 'active',
    grants: [{ id: grantId, role: 'viewer', updatedAt: new Date(12) }],
    clientLinks: [{ clientId: secondClient }, { clientId: firstClient }],
  };
  const allowed = new Map([[firstClient, true], [secondClient, true]]);
  let denied: string[] = [];
  let grantPresent = true;
  let resourceReads = 0;
  let wallReads = 0;
  let deniedReads = 0;
  let cancelled: Error | undefined;
  let resourceHook: (index: number) => void | Promise<void> = () => {};
  let wallHook: (index: number) => void | Promise<void> = () => {};
  let deniedHook: (index: number) => void | Promise<void> = () => {};
  const tx: any = {
    researchPortfolio: { findFirst: jest.fn(async (query: any) => {
      await resourceHook(++resourceReads);
      if (!grantPresent) return null;
      const result = structuredClone(row);
      // Keep fixture Date values in this Jest realm; preserve invalid NaN.
      result.grants.forEach((grant: any, index: number) => {
        grant.updatedAt = new Date(row.grants[index].updatedAt.getTime());
      });
      if (query.select && !query.select.clientLinks) delete result.clientLinks;
      return result;
    }) },
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('AS allowed')) {
        await wallHook(++wallReads);
        expect(values[0]).toBe(tenantId);
        expect(values[2]).toBe(actorId);
        return [{ allowed: allowed.get(values[1] as string) === true }];
      }
      await deniedHook(++deniedReads);
      return denied.map((id) => ({ id }));
    }),
  };
  const checkpoint = jest.fn(() => { if (cancelled) throw cancelled; });
  return {
    row, allowed, tx, checkpoint,
    read: (operation: typeof detail | typeof changes = detail) =>
      readResearchPortfolioResourceRevision(tx, ctx, portfolioId, operation, checkpoint),
    deny(ids: string[]) { denied = ids; }, revokeGrant() { grantPresent = false; },
    onResource(fn: typeof resourceHook) { resourceHook = fn; },
    onWall(fn: typeof wallHook) { wallHook = fn; },
    onDenied(fn: typeof deniedHook) { deniedHook = fn; },
    cancel(error: Error) { cancelled = error; },
    get resourceReads() { return resourceReads; },
    get wallReads() { return wallReads; },
  };
}

describe('private current Portfolio resource facts', () => {
  it('uses only narrow bounded current grant/resource projections around canonical wall observations', async () => {
    const h = fixture();
    const receipt = await h.read();
    expect(Object.keys(receipt).sort()).toEqual(['portfolioId', 'resourceRevision']);
    expect(receipt.portfolioId).toBe(portfolioId);
    expect(receipt.resourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(h.resourceReads).toBe(3);
    expect(h.wallReads).toBe(4);
    for (const [query] of h.tx.researchPortfolio.findFirst.mock.calls) {
      expect(query.where).toEqual({ id: portfolioId, tenantId, grants: { some: { principalUserId: actorId } } });
      expect(query.include).toBeUndefined();
      expect(Object.keys(query.select).sort()).toEqual(['clientLinks', 'grants', 'id', 'lifecycle', 'name', 'revision', 'tenantId']);
      expect(query.select.grants).toEqual({ where: { principalUserId: actorId }, select: { id: true, role: true, updatedAt: true }, take: 1 });
      expect(query.select.clientLinks).toEqual({ select: { clientId: true }, orderBy: { clientId: 'asc' }, take: 4097 });
    }
  });

  it('canonicalizes row order and excludes observation clocks and unrelated identity fields', async () => {
    const h = fixture();
    const first = await h.read();
    h.row.clientLinks.reverse();
    h.row.checkedAtMs = Date.now();
    h.row.identityRevision = 'irrelevant';
    expect(await h.read()).toEqual(first);
  });

  it('retains readable public/archive scope when a linked wall is denied and observes its projection change', async () => {
    const h = fixture();
    h.row.lifecycle = 'archived';
    const first = await h.read();
    h.allowed.set(firstClient, false);
    const current = await h.read();
    expect(current.portfolioId).toBe(portfolioId);
    expect(current.resourceRevision).not.toBe(first.resourceRevision);
  });

  it('does not substitute unrelated tenant wall facts for Detail linked-client decisions', async () => {
    const h = fixture();
    const first = await h.read();
    h.deny([historicalClient]);
    expect(await h.read()).toEqual(first);
    expect(h.tx.$queryRawUnsafe.mock.calls.every(([sql]: [string]) => sql.includes('AS allowed'))).toBe(true);
  });

  it('observes all tenant denied Changes clients with no archive/link filter or Detail include', async () => {
    const h = fixture();
    const first = await h.read(changes);
    h.deny([historicalClient]);
    const second = await h.read(changes);
    expect(second.resourceRevision).not.toBe(first.resourceRevision);
    expect(h.wallReads).toBe(0);
    for (const [query] of h.tx.researchPortfolio.findFirst.mock.calls) {
      expect(query.select.clientLinks).toBeUndefined();
    }
    for (const [sql, ...values] of h.tx.$queryRawUnsafe.mock.calls) {
      expect(values).toEqual([tenantId, actorId, 4097]);
      expect(sql).toContain('AND c.memory_wall');
      expect(sql).toContain('a.tenant_id = c.tenant_id');
      expect(sql).toContain('a.client_id = c.id');
      expect(sql).toContain('a.user_id = $2::uuid');
      expect(sql).toContain('ORDER BY c.id LIMIT $3::integer');
      expect(sql).not.toMatch(/status|research_portfolio_client_links/);
    }
  });

  it('separates operations while allowing empty authorized wall scopes', async () => {
    const h = fixture();
    h.row.clientLinks = [];
    expect((await h.read()).resourceRevision).not.toBe((await h.read(changes)).resourceRevision);
  });

  it('reauthorizes a revoked viewer grant before returning an observation', async () => {
    const h = fixture();
    h.onResource((index) => { if (index === 2) h.revokeGrant(); });
    await expect(h.read()).rejects.toMatchObject({ status: 404 });
    expect(h.resourceReads).toBe(2);
  });

  it.each([
    { label: 'name', change: (row: any) => { row.name = 'Changed'; } },
    { label: 'revision', change: (row: any) => { row.revision++; } },
    { label: 'lifecycle', change: (row: any) => { row.lifecycle = 'archived'; } },
    { label: 'grant replacement', change: (row: any) => { row.grants[0].id = historicalClient; } },
    { label: 'grant role', change: (row: any) => { row.grants[0].role = 'editor'; } },
    { label: 'grant version', change: (row: any) => { row.grants[0].updatedAt = new Date(13); } },
    { label: 'linked clients', change: (row: any) => { row.clientLinks.pop(); } },
  ])('refuses observed $label drift across wall reads', async ({ change }) => {
    const h = fixture();
    h.onResource((index) => { if (index === 2) change(h.row); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses linked-client wall drift across the two observations', async () => {
    const h = fixture();
    h.onWall((index) => { if (index === 3) h.allowed.set(firstClient, false); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses historical denied-set drift across the two Changes observations', async () => {
    const h = fixture();
    h.onDenied((index) => { if (index === 2) h.deny([historicalClient]); });
    await expect(h.read(changes)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { label: 'foreign portfolio', change: (row: any) => { row.id = historicalClient; } },
    { label: 'foreign tenant', change: (row: any) => { row.tenantId = historicalClient; } },
    { label: 'invalid grant ID', change: (row: any) => { row.grants[0].id = 'invalid'; } },
    { label: 'invalid grant time', change: (row: any) => { row.grants[0].updatedAt = new Date(NaN); } },
    { label: 'unknown role', change: (row: any) => { row.grants[0].role = 'invented'; } },
    { label: 'invalid revision', change: (row: any) => { row.revision = NaN; } },
    { label: 'invalid lifecycle', change: (row: any) => { row.lifecycle = 'deleted'; } },
    { label: 'duplicate links', change: (row: any) => { row.clientLinks = [{ clientId: firstClient }, { clientId: firstClient }]; } },
    { label: 'invalid link', change: (row: any) => { row.clientLinks = [{ clientId: 'invalid' }]; } },
    { label: 'link overflow', change: (row: any) => { row.clientLinks = Array.from({ length: 4097 }, () => ({ clientId: firstClient })); } },
  ])('fails closed on malformed/incomplete $label facts', async ({ change }) => {
    const h = fixture(); change(h.row);
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
    expect(h.wallReads).toBe(0);
  });

  it.each([
    { label: 'overflow', ids: Array.from({ length: 4097 }, () => historicalClient) },
    { label: 'duplicate', ids: [historicalClient, historicalClient] },
    { label: 'malformed', ids: ['invalid'] },
  ])('refuses $label denied-client facts without partial Changes success', async ({ ids }) => {
    const h = fixture(); h.deny(ids);
    await expect(h.read(changes)).rejects.toMatchObject({ status: 503 });
  });

  it('preserves cancellation after an awaited resource read without starting wall work', async () => {
    const h = fixture();
    const cancelled = new Error('Cancelled');
    h.onResource(() => h.cancel(cancelled));
    await expect(h.read()).rejects.toBe(cancelled);
    expect(h.resourceReads).toBe(1);
    expect(h.wallReads).toBe(0);
  });

  it('checks cancellation before I/O and after an awaited wall read', async () => {
    const h = fixture();
    const cancelled = new Error('Cancelled');
    h.onWall(() => h.cancel(cancelled));
    await expect(h.read()).rejects.toBe(cancelled);
    expect(h.wallReads).toBe(1);
    expect(h.resourceReads).toBe(1);
    const stopped = fixture(); stopped.cancel(cancelled);
    await expect(stopped.read()).rejects.toBe(cancelled);
    expect(stopped.resourceReads).toBe(0);
  });

  it('maps database failure to unavailable and retains explicit resource refusals', async () => {
    const h = fixture();
    h.tx.researchPortfolio.findFirst.mockRejectedValueOnce(new Error('private database details'));
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
    h.tx.researchPortfolio.findFirst.mockRejectedValueOnce(new ForbiddenException('resource refused'));
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
  });
});

describe('canonical helper compatibility', () => {
  it('preserves the full legacy loader projection and role-floor behavior', async () => {
    const h = fixture();
    const row = await loadAuthorizedResearchPortfolio(h.tx, ctx, portfolioId);
    expect(row.myRole).toBe('viewer');
    expect(h.tx.researchPortfolio.findFirst.mock.calls[0][0].include).toEqual({
      grants: { where: { principalUserId: actorId }, select: { role: true }, take: 1 },
      clientLinks: { select: { clientId: true } },
    });
    await expect(loadAuthorizedResearchPortfolio(h.tx, ctx, portfolioId, 'editor')).rejects.toMatchObject({ status: 403 });
  });

  it('keeps the old denied query/value shape and adds only a bound static suffix for new callers', async () => {
    const h = fixture();
    await fetchDeniedClientIds(h.tx, tenantId, actorId);
    await fetchDeniedClientIds(h.tx, tenantId, actorId, 4097);
    const [original, bounded] = h.tx.$queryRawUnsafe.mock.calls;
    expect(original).toHaveLength(3);
    expect(original.slice(1)).toEqual([tenantId, actorId]);
    expect(bounded).toEqual([original[0] + ' ORDER BY c.id LIMIT $3::integer', tenantId, actorId, 4097]);
  });

  it.each([0, -1, 4098, 1.5, NaN])('rejects invalid internal denied-query bound %s before I/O', async (bound) => {
    const h = fixture();
    await expect(fetchDeniedClientIds(h.tx, tenantId, actorId, bound)).rejects.toThrow('invalid denied client bound');
    expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
