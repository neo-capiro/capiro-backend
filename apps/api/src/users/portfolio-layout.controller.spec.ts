import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { ApplicationAuthorityIdentityProof } from '../auth/application-authority.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PortfolioLayoutController } from './portfolio-layout.controller.js';
import { type SavedPortfolioLayout, PORTFOLIO_LAYOUT_MAX_VERSION } from './portfolio-layout.helpers.js';

const T = '11111111-1111-1111-1111-111111111111';
const U = '22222222-2222-2222-2222-222222222222';
const HOME = '33333333-3333-3333-3333-333333333333';
const OTHER = '44444444-4444-4444-4444-444444444444';
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
const A = id(1), B = id(2), C = id(3), D = id(4);
const request = {} as Request;
const context = (role: TenantContext['role'] = 'standard_user'): TenantContext =>
  ({ tenantId: T, userId: U, clerkUserId: 'user_existing', tenantSlug: 'existing', role });
const input = (order = [A, B], expectedVersion = 0) =>
  ({ contractVersion: 1, expectedVersion, order: order.map((value) => `client:${value}`) });
const clone = (row: SavedPortfolioLayout | null): SavedPortfolioLayout | null => row &&
  ({ ...row, clientOrder: [...row.clientOrder], updatedAt: new Date(row.updatedAt) });

/** Inert port with serialized callbacks and rollback, not a PostgreSQL/Clerk acceptance fixture. */
function host() {
  let row: SavedPortfolioLayout | null = null;
  let queue = Promise.resolve();
  let clock = 0;
  let unknownCommit = false;
  let abort: unknown;
  let proofFailureAt = 0;
  let wrongPrincipal = false;
  let changedRevisionAt = 0;
  let catalog: Array<{ id: string; status: string; wall: boolean; grant: boolean; tenantId: string }> =
    [A, B].map((clientId) => ({ id: clientId, status: 'active', wall: false, grant: false, tenantId: T }));
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const recheck = jest.fn<ReturnType<ApplicationAuthorityIdentityProof['recheckCurrent']>, []>();
  // Fixed original bound expiry: a recheck cannot extend a session.
  const expiry = Date.now() + 60000;
  recheck.mockImplementation(async () => {
    if (proofFailureAt && recheck.mock.calls.length === proofFailureAt) throw new ForbiddenException('canonical revoked');
    return { principal: { tenantId: T, actorId: U }, identityRevision: changedRevisionAt === recheck.mock.calls.length ? 'b'.repeat(64) : 'a'.repeat(64), expiresAtMs: expiry };
  });
  const authority = jest.fn(async (_req: Request, _ctx: TenantContext): Promise<ApplicationAuthorityIdentityProof> =>
    ({ principal: { tenantId: wrongPrincipal ? OTHER : T, actorId: U }, identityRevision: 'a'.repeat(64), expiresAtMs: expiry, recheckCurrent: recheck }));
  const system = jest.fn(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, _opts?: unknown) => {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let pending = clone(row);
    const tx = {
      $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...args: unknown[]) => {
        queries.push({ sql: sql.join('?'), args }); return 1;
      }),
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        queries.push({ sql, args });
        if (sql.includes('FROM tenant_memberships')) return [{ tenantId: HOME }];
        if (sql.includes('FROM users') || sql.includes('FROM tenants') || sql.includes('FROM impersonation_sessions') || sql.includes('pg_advisory')) return [];
        if (sql.startsWith('SELECT a.id FROM client_memory_access a')) return [];
        if (sql.includes('FROM clients c')) return catalog.filter((client) => client.tenantId === args[0] && client.wall && !client.grant).map((client) => ({ id: client.id }));
        if (sql.includes('FROM clients')) return catalog.filter((client) => client.tenantId === args[0] && client.status !== 'archived').map((client) => ({ id: client.id })).sort((x, y) => x.id.localeCompare(y.id));
        if (sql.startsWith('SELECT') && sql.includes('FROM user_portfolio_layouts')) return pending ? [clone(pending)] : [];
        if (sql.startsWith('INSERT')) {
          if (pending) return [];
          pending = { tenantId: args[0] as string, userId: args[1] as string, clientOrder: [...args[2] as string[]], version: args[3] as number, updatedAt: new Date(1760400000000 + ++clock) };
          return [clone(pending)];
        }
        if (sql.startsWith('UPDATE')) {
          if (!pending || pending.version !== args[4]) return [];
          pending = { ...pending, clientOrder: [...args[2] as string[]], version: args[3] as number, updatedAt: new Date(1760400000000 + ++clock) };
          return [clone(pending)];
        }
        throw new Error(`unhandled SQL ${sql}`);
      }),
    };
    try {
      if (abort) throw abort;
      const result = await callback(tx as unknown as Prisma.TransactionClient);
      row = clone(pending);
      if (unknownCommit) { unknownCommit = false; throw new Error('lost successful commit reply'); }
      return result;
    } finally { release(); }
  });
  const controller = new PortfolioLayoutController({ withSystem: system } as unknown as PrismaService,
    { readApplicationAuthority: authority } as unknown as TenantContextMiddleware);
  return { controller, system, authority, recheck, queries,
    get row() { return clone(row); }, set row(value) { row = clone(value); },
    get catalog() { return catalog; }, set catalog(value) { catalog = value; },
    set unknownCommit(value: boolean) { unknownCommit = value; }, set abort(value: unknown) { abort = value; },
    set proofFailureAt(value: number) { proofFailureAt = value; }, set wrongPrincipal(value: boolean) { wrongPrincipal = value; },
    set changedRevisionAt(value: number) { changedRevisionAt = value; },
  };
}

describe('Portfolio layout registered native route source', () => {
  it('mounts exact route, standard role guard, and no-store JSON on both operations', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PortfolioLayoutController)).toBe('me/portfolio-layout');
    expect(Reflect.getMetadata(GUARDS_METADATA, PortfolioLayoutController)).toEqual([RolesGuard]);
    for (const handler of [PortfolioLayoutController.prototype.read, PortfolioLayoutController.prototype.save])
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual(expect.arrayContaining([
        { name: 'Cache-Control', value: 'no-store' }, { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      ]));
  });

  it.each(['standard_user', 'user_admin', 'capiro_admin'] as const)('admits existing %s role through the actual RolesGuard', (role) => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate({ getHandler: () => PortfolioLayoutController.prototype.save, getClass: () => PortfolioLayoutController,
      switchToHttp: () => ({ getRequest: () => ({ tenantContext: context(role) }) }) } as never)).toBe(true);
  });

  it.each(['client_portal_user', 'unknown', undefined])('denies role/context %s through the actual RolesGuard', (role) => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate({ getHandler: () => PortfolioLayoutController.prototype.save, getClass: () => PortfolioLayoutController,
      switchToHttp: () => ({ getRequest: () => ({ tenantContext: role ? context(role as never) : undefined }) }) } as never)).toThrow(ForbiddenException);
  });

  it('parses proxy/actor/tenant fields before requesting authority or persistence', () => {
    const h = host();
    for (const body of [{ ...input(), userId: OTHER }, { ...input(), tenantId: OTHER }, new Proxy(input(), {})])
      expect(() => h.controller.save(context(), request, body)).toThrow(BadRequestException);
    expect(h.authority).not.toHaveBeenCalled(); expect(h.system).not.toHaveBeenCalled();
  });

  it('keeps the native request/context proof and refuses forged caller authority before a transaction', async () => {
    const h = host(), ctx = context(); h.wrongPrincipal = true;
    await expect(h.controller.read(ctx, request)).rejects.toThrow(ForbiddenException);
    expect(h.authority).toHaveBeenCalledWith(request, ctx); expect(h.system).not.toHaveBeenCalled();
    h.authority.mockRejectedValueOnce(new ForbiddenException('private WeakMap refused synthetic context'));
    await expect(h.controller.save(ctx, request, input())).rejects.toThrow(ForbiddenException);
    expect(h.system).not.toHaveBeenCalled();
  });
});

describe('Portfolio layout existing owner transaction controls', () => {
  it('returns virtual zero without persistence and saves/readbacks exact order with closed receipts', async () => {
    const h = host();
    const initial = await h.controller.read(context(), request);
    expect(initial).toEqual({ contractVersion: 1, tenantId: T, userId: U, version: 0, updatedAt: null, order: input().order });
    expect(h.row).toBeNull();
    const saved = await h.controller.save(context(), request, input([B, A]));
    expect(Object.keys(saved!)).toEqual(['contractVersion', 'tenantId', 'userId', 'version', 'updatedAt', 'order']);
    expect(saved).toMatchObject({ version: 1, order: input([B, A]).order });
    await expect(h.controller.read(context(), request)).resolves.toEqual(saved);
    expect(h.system.mock.calls.every((call) => JSON.stringify(call[1]) === JSON.stringify({ isolationLevel: 'Serializable' }))).toBe(true);
  });

  it.each(['standard_user', 'user_admin', 'capiro_admin'] as const)('uses full-status canonical native wall filtering with no %s bypass', async (role) => {
    const h = host(); h.catalog = [
      { id: A, status: 'active', wall: false, grant: false, tenantId: T },
      { id: B, status: 'prospect', wall: true, grant: true, tenantId: T },
      { id: C, status: 'active', wall: true, grant: false, tenantId: T },
      { id: D, status: 'archived', wall: false, grant: false, tenantId: T },
      { id: id(5), status: 'active', wall: false, grant: false, tenantId: OTHER },
    ];
    await expect(h.controller.read(context(role), request)).resolves.toMatchObject({ order: input([A, B]).order });
    await expect(h.controller.save(context(role), request, input([A, B, C]))).rejects.toThrow(ConflictException);
    expect(h.row).toBeNull();
    const wall = h.queries.find((query) => query.sql.includes('AND c.memory_wall'));
    expect(wall?.args).toEqual([T, U]);
    expect(wall?.sql).toContain('a.user_id = $2::uuid');
  });

  it('binds every layout operation to native tenant/user and locks clients before grants and home authority facts', async () => {
    const h = host(); await h.controller.save(context('capiro_admin'), request, input());
    const sql = h.queries.map((query) => query.sql);
    expect(sql.findIndex((text) => text.includes('FROM clients WHERE'))).toBeLessThan(sql.findIndex((text) => text.includes('FROM client_memory_access a')));
    expect(h.queries.find((query) => query.sql.includes('FROM tenants'))?.args).toEqual([[T, HOME].sort()]);
    expect(h.queries.find((query) => query.sql.includes('FROM impersonation_sessions'))?.args).toEqual([U, T]);
    for (const query of h.queries.filter((query) => query.sql.includes('user_portfolio_layouts'))) expect(query.args.slice(0, 2)).toEqual([T, U]);
    expect(h.recheck).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2])('rolls back authority revocation at canonical recheck %s', async (at) => {
    const h = host(); h.proofFailureAt = at;
    await expect(h.controller.save(context(), request, input())).rejects.toThrow(ForbiddenException);
    expect(h.row).toBeNull(); expect(h.system).toHaveBeenCalledTimes(1);
  });

  it('refuses changing original identity revision rather than accepting a refreshed principal', async () => {
    const h = host(); h.changedRevisionAt = 2;
    await expect(h.controller.save(context(), request, input())).rejects.toThrow(ForbiddenException);
    expect(h.row).toBeNull();
  });

  it('serializes initial save contenders into one winner and refuses stale replay', async () => {
    const h = host();
    const outcomes = await Promise.allSettled([h.controller.save(context(), request, input()), h.controller.save(context(), request, input([B, A]))]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ConflictException); expect(h.row?.version).toBe(1);
    await expect(h.controller.save(context(), request, input())).rejects.toThrow(ConflictException);
    expect(h.row?.version).toBe(1);
  });

  it('increments an identical write exactly once and refuses subset saves', async () => {
    const h = host(); await h.controller.save(context(), request, input());
    await expect(h.controller.save(context(), request, input([A, B], 1))).resolves.toMatchObject({ version: 2, order: input().order });
    await expect(h.controller.save(context(), request, input([A], 2))).rejects.toThrow(ConflictException);
    expect(h.row?.version).toBe(2);
  });

  it('durably prunes revoked/archived IDs, retains survivors and appends new visible UUIDs once without leaking removed IDs', async () => {
    const h = host(); await h.controller.save(context(), request, input([B, A]));
    h.catalog[0]!.wall = true;
    h.catalog.push({ id: C, status: 'inactive', wall: false, grant: false, tenantId: T });
    const results = await Promise.all([h.controller.read(context(), request), h.controller.read(context(), request)]);
    for (const receipt of results) {
      expect(receipt).toMatchObject({ version: 2, order: input([B, C]).order });
      expect(JSON.stringify(receipt)).not.toContain(A);
    }
    expect(h.row?.version).toBe(2);
    h.catalog[1]!.status = 'archived';
    await expect(h.controller.read(context(), request)).resolves.toMatchObject({ version: 3, order: input([C]).order });
  });

  it('returns capacity/exhaustion unavailable with no mutation or fake empty catalog', async () => {
    const h = host();
    h.catalog = Array.from({ length: 2001 }, (_, n) => ({ id: id(n), status: 'active', wall: false, grant: false, tenantId: T }));
    await expect(h.controller.read(context(), request)).rejects.toThrow(ServiceUnavailableException); expect(h.row).toBeNull();
    h.catalog = [{ id: A, status: 'active', wall: false, grant: false, tenantId: T }];
    h.row = { tenantId: T, userId: U, clientOrder: [A], version: PORTFOLIO_LAYOUT_MAX_VERSION, updatedAt: new Date() };
    await expect(h.controller.read(context(), request)).resolves.toMatchObject({ version: PORTFOLIO_LAYOUT_MAX_VERSION });
    h.catalog = [];
    await expect(h.controller.read(context(), request)).rejects.toThrow(ServiceUnavailableException);
    expect(h.row?.clientOrder).toEqual([A]);
  });

  it.each([{ code: 'P2034' }, { code: 'P2010', meta: { code: '40001' } }, { code: 'P2010', meta: { code: '40P01' } }])('returns confirmed-abort conflict without retry %j', async (failure) => {
    const h = host(); h.abort = failure;
    await expect(h.controller.save(context(), request, input())).rejects.toThrow(ConflictException);
    expect(h.system).toHaveBeenCalledTimes(1); expect(h.row).toBeNull();
  });

  it('does not infer confirmed abort from arbitrary text and never retries unknown commit', async () => {
    const h = host(); h.abort = new Error('40001 maybe after commit');
    await expect(h.controller.save(context(), request, input())).rejects.toThrow(ServiceUnavailableException);
    expect(h.system).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh durable GET after a lost commit reply, and refuses replay rather than trusting memory', async () => {
    const h = host(); h.unknownCommit = true;
    await expect(h.controller.save(context(), request, input([B, A]))).rejects.toThrow(ServiceUnavailableException);
    expect(h.system).toHaveBeenCalledTimes(1); expect(h.row?.version).toBe(1);
    // The same persisted port attached to a new controller represents source recovery, not native restart acceptance.
    await expect(h.controller.read(context(), request)).resolves.toMatchObject({ version: 1, order: input([B, A]).order });
    await expect(h.controller.save(context(), request, input([B, A]))).rejects.toThrow(ConflictException);
    await h.controller.save(context(), request, input([A, B], 1));
    await expect(h.controller.read(context(), request)).resolves.toMatchObject({ version: 2, order: input([A, B]).order });
  });
});
