import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { ClientsService } from './clients.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../intelligence/entity-resolution.service.js', () => ({ EntityResolutionService: class {} }));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({ ClientPrepopulationService: class {} }));
jest.mock('../intelligence/sam-entity.service.js', () => ({ SamEntityEnrichmentService: class {} }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));

const tenant = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId: tenant, userId: actor, clerkUserId: 'user_synthetic', role: 'user_admin' } as TenantContext;

// Transaction adapter retains current membership, client/tenant predicates,
// wall grants and rollback. Actual PostgreSQL lock qualification is separate.
function fixture() {
  const state = { active: true, tenantActive: true, role: ctx.role, clerk: ctx.clerkUserId,
    exists: true, tenant, wall: false, granted: false, status: 'active', name: 'Synthetic',
    onClientLock: () => {}, onCapacityLock: () => {} };
  const calls: string[] = [];
  const member = () => state.active && state.tenantActive && state.clerk === ctx.clerkUserId
    ? { role: state.role } : null;
  const row = () => ({ id: clientId, tenantId: state.tenant, name: state.name, status: state.status,
    uei: null, applicantTypes: [], intakeData: {}, logoS3Key: null });
  const tx = {
    $executeRaw: jest.fn(async () => { calls.push('capacity'); state.onCapacityLock(); return 1; }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      const sql = 'sql' in parts ? parts.sql : parts.join('?');
      if ('sql' in parts) values = parts.values;
      if (sql.includes('FROM tenants')) { calls.push('capacity-tenant'); return [{ billingStatus: 'comped', clientSlots: 2, ldaRegistrantId: null }]; }
      if (sql.includes('FOR SHARE OF tm, u')) { calls.push('member-lock'); return member() ? [member()] : []; }
      if (sql.includes('FROM clients')) {
        calls.push('client-lock'); state.onClientLock();
        if (!state.exists || values[0] !== state.tenant || values[1] !== clientId) return [];
        if (sql.includes('account_owner_version') && values[2] !== true && state.status === 'archived') return [];
        return [{ ...row(), version: 0, primary: null }];
      }
      if (sql.includes('FROM client_memory_access')) { calls.push('grant-lock'); return state.granted ? [{ user_id: actor }] : []; }
      throw Error('Unexpected transaction query');
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, tenantId: string, id: string) => {
      if (sql.includes('AS allowed')) {
        calls.push('wall');
        return state.exists && tenantId === state.tenant && id === clientId ? [{ allowed: !state.wall || state.granted }] : [];
      }
      calls.push('denied-roster');
      return state.tenant === tenantId && state.wall && !state.granted ? [{ id: clientId }] : [];
    }),
    tenantMembership: { findFirst: jest.fn(async () => { calls.push('member'); return member(); }) },
    client: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async ({ where }: any) => {
        calls.push('profile'); return state.exists && where.id === clientId && where.tenantId === state.tenant ? row() : null;
      }),
      findMany: jest.fn(async ({ where }: any) => state.exists && where.tenantId === state.tenant &&
        !where.id?.notIn.includes(clientId) && (where.status?.not !== state.status) ? [row()] : []),
      create: jest.fn(async () => { calls.push('insert'); return row(); }),
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== clientId || where.tenantId !== state.tenant) throw Error('Wrong row');
        calls.push('update'); Object.assign(state, data); return row();
      }),
    },
  };
  const prisma = { withTenant: async (id: string, run: (tx: unknown) => Promise<unknown>) => {
    expect(id).toBe(tenant); const before = { name: state.name, status: state.status };
    try { return await run(tx); } catch (e) { Object.assign(state, before); throw e; }
  } };
  const resolver = { resolveClient: jest.fn(async () => ({})) };
  const kb = { indexClientProfileFireAndForget: jest.fn() };
  const service = new ClientsService({ ...prisma, withTenantRetry: prisma.withTenant } as never, { get: () => undefined } as never,
    resolver as never, { prepopulate: async () => ({}) } as never, { enrichGovIds: async () => ({}) } as never, kb as never);
  return { state, calls, tx, service, resolver, kb };
}

describe('canonical client record transaction authorization', () => {
  it('creates only after capacity and a locked current actor', async () => {
    const h = fixture();
    await h.service.create(ctx, { name: 'Synthetic' });
    expect(h.calls).toEqual(['capacity', 'capacity-tenant', 'member-lock', 'insert']);
    expect(h.tx.client.create).toHaveBeenCalledTimes(1);
  });
  it.each(['revoked', 'inactive tenant', 'rebound identity', 'downgraded role'])('denies create for %s before insertion/provider work', async reason => {
    const h = fixture();
    h.state.onCapacityLock = () => {
      if (reason === 'revoked') h.state.active = false;
      if (reason === 'inactive tenant') h.state.tenantActive = false;
      if (reason === 'rebound identity') h.state.clerk = 'user_other';
      if (reason === 'downgraded role') h.state.role = 'standard_user';
    };
    await expect(h.service.create(ctx, { name: 'Synthetic' })).rejects.toMatchObject({ status: 403 });
    expect(h.tx.client.create).not.toHaveBeenCalled();
    expect(h.resolver.resolveClient).not.toHaveBeenCalled();
  });
  it('retains standard-user internal update while binding its actual current role', async () => {
    const h = fixture(); h.state.role = 'standard_user';
    await h.service.update({ ...ctx, role: 'standard_user' }, clientId, { name: 'Edited' });
    expect(h.state.name).toBe('Edited');
    expect(h.calls.indexOf('member-lock')).toBeLessThan(h.calls.indexOf('profile'));
    expect(h.calls.indexOf('wall')).toBeLessThan(h.calls.indexOf('update'));
  });
  it.each(['absent', 'foreign', 'wall', 'revoked after wait', 'downgraded after wait', 'grant revoked after wait'])('denies edit for %s before row/index writes', async reason => {
    const h = fixture();
    if (reason === 'absent') h.state.exists = false;
    if (reason === 'foreign') h.state.tenant = '44444444-4444-4444-8444-444444444444';
    if (reason === 'wall') h.state.wall = true;
    h.state.onClientLock = () => {
      if (reason === 'revoked after wait') h.state.active = false;
      if (reason === 'downgraded after wait') h.state.role = 'standard_user';
      if (reason === 'grant revoked after wait') { h.state.wall = true; h.state.granted = false; }
    };
    await expect(h.service.update(ctx, clientId, { name: 'Forbidden' })).rejects.toMatchObject({ status: reason.includes('after wait') && !reason.startsWith('grant') ? 403 : 404 });
    expect(h.tx.client.update).not.toHaveBeenCalled(); expect(h.kb.indexClientProfileFireAndForget).not.toHaveBeenCalled();
    expect(h.state.name).toBe('Synthetic');
  });
  it('uses the fresh profile after the client lock wait for funding validation', async () => {
    const h = fixture();
    h.state.onClientLock = () => { h.state.name = 'Concurrent'; };
    await h.service.update(ctx, clientId, { description: 'New' });
    expect(h.calls.indexOf('client-lock')).toBeLessThan(h.calls.indexOf('profile'));
    expect(h.tx.client.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: clientId, tenantId: tenant } }));
  });
  it('archives and restores with capacity before client/member/grant locks', async () => {
    const h = fixture();
    await h.service.archive(ctx, clientId);
    expect(h.state.status).toBe('archived');
    h.calls.length = 0;
    await h.service.update(ctx, clientId, { status: 'active' });
    expect(h.state.status).toBe('active');
    expect(h.calls[0]).toBe('capacity');
    expect(h.calls.indexOf('capacity-tenant')).toBeLessThan(h.calls.indexOf('client-lock'));
    expect(h.calls.indexOf('client-lock')).toBeLessThan(h.calls.indexOf('member-lock'));
    expect(h.calls.indexOf('member-lock')).toBeLessThan(h.calls.indexOf('grant-lock'));
  });
  it('wall-denied archived records cannot be read, restored or returned in an inclusive list', async () => {
    const h = fixture(); h.state.status = 'archived'; h.state.wall = true;
    await expect(h.service.get(ctx, clientId)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.update(ctx, clientId, { status: 'active' })).rejects.toMatchObject({ status: 404 });
    expect(await h.service.list(ctx, { includeArchived: true })).toEqual([]);
    expect(h.tx.client.update).not.toHaveBeenCalled();
    h.state.granted = true;
    expect(await h.service.list(ctx, { includeArchived: true })).toHaveLength(1);
    expect(await h.service.list(ctx)).toEqual([]);
    await expect(h.service.get(ctx, clientId)).resolves.toMatchObject({ id: clientId, status: 'archived' });
  });
});
