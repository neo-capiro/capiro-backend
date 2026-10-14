import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ClientTargetsService } from './client-targets.service.js';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const C = 'ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF';
const O = '44444444-4444-4444-8444-444444444444';
const R = '55555555-5555-4555-8555-555555555555';
const TARGET = 'ABCDEFAB-5678-4567-89AB-ABCDEFABCDEF';
const FOREIGN = '77777777-7777-4777-8777-777777777777';
const ctx = { tenantId: T, userId: U, clerkUserId: 'user_native', role: 'standard_user' } as TenantContext;
const query = { clientId: C, objectiveId: O, objectiveVersion: 3 };

/** Only the database IO port is synthetic. The real shared authority helper runs. */
function fixture() {
  const state = {
    tenantId: T, userId: U, clerkUserId: ctx.clerkUserId,
    tenantActive: true, membershipActive: true, internalRole: true, clientAvailable: true,
    wall: true, grant: true, objectiveAvailable: true, objectiveVersion: 3, revisionAvailable: true,
    target: { id: TARGET.toLowerCase(), clientId: C.toLowerCase(), sourceDirectory: 'congress', memberId: 'member-12' } as Record<string, unknown> | null,
    beforeTarget: () => {}, error: undefined as Error | undefined,
  };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = { $queryRaw: async <A>(strings: TemplateStringsArray, ...values: unknown[]): Promise<A> => {
    const sql = strings.join('?'); calls.push({ sql, values });
    if (state.error) throw state.error;
    if (sql.includes('FROM tenants')) {
      const allowed = state.tenantActive && state.membershipActive && state.internalRole && state.clientAvailable &&
        values[0] === state.tenantId && values[1] === state.userId && values[2] === state.clerkUserId && values[3] === C.toLowerCase();
      return (allowed ? [{ userId: U, memoryWall: state.wall }] : []) as A;
    }
    if (sql.includes('FROM client_memory_access')) return (state.grant ? [{ id: 'current_grant' }] : []) as A;
    if (sql.includes('FROM client_objectives')) return (state.objectiveAvailable ? [{ version: state.objectiveVersion }] : []) as A;
    if (sql.includes('FROM client_objective_revisions')) return (state.revisionAvailable ? [{ id: R }] : []) as A;
    if (sql.includes('FROM client_targets')) {
      state.beforeTarget();
      return (state.target && state.target.id === values[2] && state.target.clientId === values[1] && values[0] === state.tenantId ? [state.target] : []) as A;
    }
    throw new Error('Unrecognized synthetic SQL');
  } };
  const transactions: Array<{ tenantId: string; userId: string; tx: typeof tx }> = [];
  const prisma = { withTenantUser: async (tenantId: string, userId: string, fn: (port: typeof tx) => unknown) => {
    transactions.push({ tenantId, userId, tx }); return fn(tx);
  } };
  const external = new Proxy({}, { get: () => { throw new Error('Directory enrichment is outside saved-target observation'); } });
  const service = new ClientTargetsService(prisma as never, external as never, external as never);
  return { state, calls, transactions, service, run: (input = query, clientId = C, targetId = TARGET, actor = ctx) => service.objectiveDestination(actor, clientId, targetId, input) };
}

describe('Saved Directory target Objective destination (source/synthetic database ports)', () => {
  it.each(['congress', 'state', 'staff'])('observes an existing %s target without cached entity lookup or metadata leakage', async (sourceDirectory) => {
    const f = fixture();
    f.state.target = { ...f.state.target, sourceDirectory, memberId: sourceDirectory === 'state' ? 'ocd-person/unknown-but-saved' : 'unknown-but-saved', memberName: 'Private stale name', tenantId: T };
    await expect(f.run()).resolves.toEqual({
      destination: { kind: 'directory_target', resourceId: TARGET.toLowerCase(), clientId: C.toLowerCase(), objectiveId: O, objectiveVersion: 3, objectiveRevisionId: R },
      target: { id: TARGET.toLowerCase(), clientId: C.toLowerCase(), sourceDirectory, memberId: f.state.target.memberId },
    });
    expect(f.transactions).toEqual([{ tenantId: T, userId: U, tx: f.transactions[0]!.tx }]);
    expect(f.calls.map((call) => call.sql.match(/FROM (\w+)/)?.[1])).toEqual(['tenants', 'client_memory_access', 'client_objectives', 'client_objective_revisions', 'client_targets']);
    expect(f.calls[0]!.values).toEqual([T, U, 'user_native', C.toLowerCase()]);
    expect(f.calls[0]!.sql).toContain('FOR SHARE OF t,m,u,c');
    expect(f.calls[1]!.values).toEqual([T, C.toLowerCase(), U]);
    expect(f.calls[1]!.sql).toContain('FOR SHARE');
    expect(f.calls[2]!.sql).toContain('FOR SHARE');
    expect(f.calls[3]!.sql).not.toContain('FOR SHARE');
    expect(f.calls[4]!.values).toEqual([T, C.toLowerCase(), TARGET.toLowerCase()]);
    expect(f.calls[4]!.sql).toMatch(/WHERE tenant_id=\?::uuid AND client_id=\?::uuid\s+AND id=\?::uuid FOR SHARE/);
    expect(f.calls.every((call) => !/UPDATE |INSERT |DELETE /.test(call.sql))).toBe(true);
  });

  it.each(['tenantActive', 'membershipActive', 'internalRole', 'clientAvailable', 'grant', 'objectiveAvailable', 'revisionAvailable'] as const)(
    'refuses current revoked or missing %s before any target read', async (field) => {
      const f = fixture(); f.state[field] = false;
      await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
      expect(f.calls.some((call) => call.sql.includes('FROM client_targets'))).toBe(false);
    },
  );

  it.each(['userId', 'clerkUserId', 'tenantId'] as const)('pins the actual current native %s without casting a Clerk subject to UUID', async (field) => {
    const f = fixture(); f.state[field] = field === 'clerkUserId' ? 'user_rebound' : FOREIGN;
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.calls[0]!.sql).toContain('u.clerk_user_id=?');
    expect(f.calls[0]!.sql).not.toContain('clerk_user_id=?::uuid');
    expect(f.calls.some((call) => call.sql.includes('FROM client_targets'))).toBe(false);
  });

  it('does not grant an administrator a wall bypass', async () => {
    const f = fixture(); f.state.grant = false;
    await expect(f.run(query, C, TARGET, { ...ctx, role: 'capiro_admin' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not require an invented grant on an unwalled client', async () => {
    const f = fixture(); f.state.wall = false; f.state.grant = false;
    await expect(f.run()).resolves.toMatchObject({ destination: { objectiveRevisionId: R } });
    expect(f.calls.some((call) => call.sql.includes('FROM client_memory_access'))).toBe(false);
  });

  it('rechecks current scope on every replay instead of treating a receipt as a capability', async () => {
    const f = fixture(); const receipt = await f.run(); f.state.grant = false;
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(receipt.destination.resourceId).toBe(TARGET.toLowerCase());
    expect(f.transactions).toHaveLength(2);
  });

  it.each([null, { id: FOREIGN, clientId: C.toLowerCase(), sourceDirectory: 'congress', memberId: 'member-12' },
    { id: TARGET.toLowerCase(), clientId: FOREIGN, sourceDirectory: 'congress', memberId: 'member-12' }])(
    'refuses missing, foreign or moved targets and suppresses stale Objective disclosure: %p', async (target) => {
      const f = fixture(); f.state.objectiveVersion = 4; f.state.target = target;
      await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
      expect(f.calls.map((call) => call.sql.match(/FROM (\w+)/)?.[1])).toEqual(['tenants', 'client_memory_access', 'client_objectives', 'client_targets']);
    },
  );

  it.each([{ sourceDirectory: 'committee' }, { sourceDirectory: 'personnel' }, { memberId: '' }, { memberId: '   ' },
    { memberId: 'x'.repeat(129) }, { memberId: null }])('refuses unsupported persisted target identity %p before exposing a stale version', async (invalid) => {
    const f = fixture(); f.state.objectiveVersion = 4; f.state.target = { ...f.state.target, ...invalid };
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns only the established conflict for an otherwise authorized current target', async () => {
    const f = fixture(); f.state.objectiveVersion = 4;
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'OBJECTIVE_VERSION_CONFLICT' } });
    await expect(f.run()).rejects.toBeInstanceOf(ConflictException);
    expect(f.calls.some((call) => call.sql.includes('FROM client_objective_revisions'))).toBe(false);
  });

  it.each(['deleted', 'moved', 'source-changed'])('checks %s target state at its actual read after current authority, including stale conflict suppression', async (change) => {
    const f = fixture(); f.state.objectiveVersion = 4;
    f.state.beforeTarget = () => {
      if (change === 'deleted') f.state.target = null;
      else f.state.target = { ...f.state.target, ...(change === 'moved' ? { clientId: FOREIGN } : { sourceDirectory: 'unknown' }) };
    };
    await expect(f.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.calls.at(-1)!.sql).toContain('FOR SHARE');
  });

  it.each([0, -1, 1.5, 2147483648, '3', [3], null])('refuses invalid Objective version %p before database access', async (objectiveVersion) => {
    const f = fixture(); await expect(f.run({ ...query, objectiveVersion } as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.transactions).toHaveLength(0);
  });

  it.each([{ clientId: FOREIGN }, { targetId: 'member-12' }, { clientId: 'not-uuid' }, { targetId: ['bad'] }])(
    'refuses malformed or mismatched path identity %p before database access', async (invalid) => {
      const f = fixture(); await expect(f.run(query, invalid.clientId ?? C, (invalid.targetId ?? TARGET) as string)).rejects.toBeInstanceOf(BadRequestException);
      expect(f.transactions).toHaveLength(0);
    },
  );

  it('preserves infrastructure error identity without retry, cached receipt, or unavailable coercion', async () => {
    const f = fixture(), error = new Error('synthetic permission or transaction abort'); f.state.error = error;
    await expect(f.run()).rejects.toBe(error);
    expect(f.transactions).toHaveLength(1); expect(f.calls).toHaveLength(1);
  });
});
