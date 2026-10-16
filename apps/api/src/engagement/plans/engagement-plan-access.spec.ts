import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import {
  discoverPermittedPlanClientIds,
  lockPlanClient,
  lockPlanTargets,
  PlanOfficeUnavailableConflict,
  presentPlanOfficeReferences,
  requirePlanActorAndGrant,
  validatePlanOfficeReferences,
} from './engagement-plan-access.js';

const ctx: TenantContext = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  tenantSlug: 'synthetic',
  userId: '20000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_synthetic_core_actor',
  role: 'standard_user',
};
const clientId = '30000000-0000-4000-8000-000000000001';
const otherClientId = '30000000-0000-4000-8000-000000000002';
const targetId = '40000000-0000-4000-8000-000000000001';
const otherTargetId = '40000000-0000-4000-8000-000000000002';
const officeKey = 'directory:50000000-0000-4000-8000-000000000001';
type Call = { name: string; sql: string; values: unknown[] };
type Reply = unknown[] | ((values: unknown[]) => Promise<unknown[]>);

function fixture() {
  const calls: Call[] = [];
  const replies: Record<string, Reply> = {
    discovery: [{ id: clientId, revision: 'synthetic-revision' }],
    client: [{ id: clientId, memoryWall: false }],
    clients: [{ id: clientId, memoryWall: false }],
    actor: [{ role: 'standard_user' }],
    grant: [],
    wall: [{ allowed: true }],
    offices: [],
  };
  const query = async (sql: string, ...values: unknown[]) => {
    const name = sql.includes('md5(to_jsonb')
      ? 'discovery'
      : sql.includes(' AS allowed')
        ? 'wall'
        : sql.includes('FROM tenants t')
          ? 'actor'
          : sql.includes('FROM client_memory_access')
            ? 'grant'
            : sql.includes('FROM engagement_report_target_offices')
              ? 'offices'
              : sql.includes('ORDER BY id')
                ? 'clients'
                : 'client';
    calls.push({ name, sql, values });
    const reply = replies[name]!;
    return typeof reply === 'function' ? reply(values) : reply;
  };
  const tx = {
    $queryRawUnsafe: query,
    $queryRaw: (parts: TemplateStringsArray, ...values: unknown[]) =>
      query(parts.join('?'), ...values),
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      calls.push({
        name: sql.includes('pg_advisory_xact_lock') ? 'target-fence' : 'target-rows',
        sql,
        values,
      });
      return 0;
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, calls, replies };
}

describe('Engagement plan access inside the caller transaction', () => {
  test('uses the existing target fence before client, actor, grant and canonical wall reads', async () => {
    const f = fixture();
    await lockPlanTargets(f.tx, ctx);
    await lockPlanClient(f.tx, ctx, clientId);
    await requirePlanActorAndGrant(f.tx, ctx, clientId);
    expect(f.calls.map((call) => call.name)).toEqual([
      'target-fence',
      'target-rows',
      'client',
      'actor',
      'grant',
      'wall',
    ]);
    expect(f.calls[0]!.values).toEqual([`engagement-report-targets:${ctx.tenantId}`]);
    expect(f.calls[2]!.values).toEqual([ctx.tenantId, clientId]);
    expect(f.calls[2]!.sql).toMatch(/status::text<>'archived' FOR UPDATE/);
    expect(f.calls[3]!.values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId]);
    expect(f.calls[3]!.sql).toContain("t.status::text='active'");
    expect(f.calls[3]!.sql).toContain("tm.status::text='active'");
    expect(f.calls[3]!.sql).toContain('u.clerk_user_id=$3');
    expect(f.calls[3]!.sql).toContain('FOR SHARE OF t, tm, u');
    expect(f.calls[4]!.values).toEqual([ctx.tenantId, clientId, ctx.userId]);
    expect(f.calls[4]!.sql).toContain('FOR SHARE');
    expect(f.calls[5]!.values).toEqual([ctx.tenantId, clientId, ctx.userId]);
    expect(f.calls[5]!.sql).toContain('NOT c.memory_wall');
  });

  test('an unwalled client needs no grant and ordinary standard-user authority suffices', async () => {
    const f = fixture();
    f.replies.grant = [];
    f.replies.wall = [{ allowed: true }];
    await expect(requirePlanActorAndGrant(f.tx, ctx, clientId)).resolves.toBeUndefined();
  });

  test('a walled client with a current canonical grant is admitted', async () => {
    const f = fixture();
    f.replies.grant = [{ user_id: ctx.userId }];
    f.replies.wall = [{ allowed: true }];
    await expect(requirePlanActorAndGrant(f.tx, ctx, clientId)).resolves.toBeUndefined();
  });

  test.each(['standard_user', 'user_admin', 'capiro_admin'])(
    'canonical wall denial has no %s bypass and exposes no grant metadata',
    async (role) => {
      const f = fixture();
      f.replies.actor = [{ role }];
      f.replies.wall = [{ allowed: false }];
      await expect(
        requirePlanActorAndGrant(f.tx, { ...ctx, role: role as TenantContext['role'] }, clientId),
      ).rejects.toMatchObject({ message: 'Client not found' });
      expect(f.calls.map((call) => call.name)).toEqual(['actor', 'grant', 'wall']);
    },
  );

  test.each(['client_portal_user', 'unknown_role', '__proto__'])(
    'current role %s is rejected even when the cached context says administrator',
    async (role) => {
      const f = fixture();
      f.replies.actor = [{ role }];
      await expect(
        requirePlanActorAndGrant(f.tx, { ...ctx, role: 'capiro_admin' }, clientId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(f.calls.map((call) => call.name)).toEqual(['actor']);
    },
  );

  test('rechecks the actor after the client lock wait rather than trusting initial context', async () => {
    const f = fixture();
    let release!: (rows: unknown[]) => void;
    f.replies.client = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = lockPlanClient(f.tx, ctx, clientId).then(() =>
      requirePlanActorAndGrant(f.tx, ctx, clientId),
    );
    await Promise.resolve();
    expect(f.calls.map((call) => call.name)).toEqual(['client']);
    // Membership/identity was revoked while the client lock was waiting.
    f.replies.actor = [];
    release([{ id: clientId, memoryWall: false }]);
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    expect(f.calls.map((call) => call.name)).toEqual(['client', 'actor']);
  });

  test('a grant wait completes before the canonical current wall decision', async () => {
    const f = fixture();
    let release!: (rows: unknown[]) => void;
    let entered!: () => void;
    const enteredGrant = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.replies.grant = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    const pending = requirePlanActorAndGrant(f.tx, ctx, clientId);
    await enteredGrant;
    expect(f.calls.map((call) => call.name)).toEqual(['actor', 'grant']);
    f.replies.wall = [{ allowed: false }];
    release([]);
    await expect(pending).rejects.toBeInstanceOf(NotFoundException);
    expect(f.calls.map((call) => call.name)).toEqual(['actor', 'grant', 'wall']);
  });

  test('missing/foreign/archived client rows share the same nondisclosing denial', async () => {
    const f = fixture();
    f.replies.client = [];
    await expect(lockPlanClient(f.tx, ctx, clientId)).rejects.toMatchObject({
      message: 'Client not found',
    });
    expect(f.calls.map((call) => call.name)).toEqual(['client']);
  });

  test.each([
    { ...ctx, tenantId: 'not-a-uuid' },
    { ...ctx, userId: 'user_clerk_is_not_a_core_uuid' },
    { ...ctx, clerkUserId: '' },
  ])('rejects malformed trusted context before target or SQL work', async (actor) => {
    const f = fixture();
    await expect(lockPlanTargets(f.tx, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.calls).toEqual([]);
  });
});

describe('Permitted plan client discovery', () => {
  test('locks all preliminary client IDs in ascending order before actor/grant rechecks', async () => {
    const f = fixture();
    f.replies.discovery = [
      { id: otherClientId, revision: 'b' },
      { id: clientId, revision: 'a' },
    ];
    f.replies.clients = [
      { id: clientId, memoryWall: false },
      { id: otherClientId, memoryWall: true },
    ];
    f.replies.wall = async (values) => [{ allowed: values[1] === clientId }];
    await expect(discoverPermittedPlanClientIds(f.tx, ctx)).resolves.toEqual([clientId]);
    expect(f.calls.map((call) => call.name)).toEqual([
      'discovery',
      'clients',
      'actor',
      'grant',
      'wall',
      'grant',
      'wall',
    ]);
    expect(f.calls[0]!.values).toEqual([ctx.clerkUserId, ctx.tenantId]);
    expect(f.calls[1]!.values).toEqual([ctx.tenantId, [clientId, otherClientId]]);
    expect(f.calls[1]!.sql).toContain("status::text<>'archived'");
    expect(f.calls[1]!.sql).toContain('ORDER BY id FOR UPDATE');
  });

  test('global discovery omits a client archived during the lock wait', async () => {
    const f = fixture();
    f.replies.clients = [];
    await expect(discoverPermittedPlanClientIds(f.tx, ctx)).resolves.toEqual([]);
    expect(f.calls.map((call) => call.name)).toEqual(['discovery', 'clients', 'actor']);
  });

  test('an explicitly selected client denied after the lock wait refuses the request', async () => {
    const f = fixture();
    f.replies.wall = [{ allowed: false }];
    await expect(discoverPermittedPlanClientIds(f.tx, ctx, clientId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('an explicitly denied or malformed selector never broadens to other permitted clients', async () => {
    const f = fixture();
    await expect(discoverPermittedPlanClientIds(f.tx, ctx, otherClientId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.calls.map((call) => call.name)).toEqual(['discovery']);
    f.calls.length = 0;
    await expect(discoverPermittedPlanClientIds(f.tx, ctx, 'invalid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.calls).toEqual([]);
  });

  test('empty discovery still rejects a stale tenant/member/Clerk identity', async () => {
    const f = fixture();
    f.replies.discovery = [];
    f.replies.actor = [];
    await expect(discoverPermittedPlanClientIds(f.tx, ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.calls.map((call) => call.name)).toEqual(['discovery', 'actor']);
  });
});

describe('Existing report-target office associations', () => {
  test('only exact current tenant/client/scope/key identities are available', async () => {
    const f = fixture();
    f.replies.offices = [
      { targetId, officeKey },
      { targetId: otherTargetId, officeKey: 'directory:new-key' },
    ];
    const refs = [
      { targetId, officeKey },
      { targetId: otherTargetId, officeKey: 'manual:old-key' },
    ];
    await expect(presentPlanOfficeReferences(f.tx, ctx, clientId, refs)).resolves.toEqual([
      { ...refs[0], available: true },
      { ...refs[1], available: false },
    ]);
    expect(f.calls[0]!.values).toEqual([ctx.tenantId, clientId, [targetId, otherTargetId]]);
    expect(f.calls[0]!.sql).toContain(
      'tenant_id=$1::uuid AND client_id=$2::uuid AND scope_key=$2::text',
    );
    expect(f.calls[0]!.sql).toContain('archived_at IS NULL');
    expect(f.calls[0]!.sql).not.toContain('directory:new-key');
  });

  test('missing, rescoping, archive and merge/deletion never reveal foreign metadata', async () => {
    const f = fixture();
    const refs = [{ targetId, officeKey }];
    await expect(presentPlanOfficeReferences(f.tx, ctx, clientId, refs)).resolves.toEqual([
      { targetId, officeKey, available: false },
    ]);
    let failure: unknown;
    try {
      await validatePlanOfficeReferences(f.tx, ctx, clientId, refs);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PlanOfficeUnavailableConflict);
    expect((failure as PlanOfficeUnavailableConflict).getStatus()).toBe(409);
    expect((failure as PlanOfficeUnavailableConflict).getResponse()).toEqual({
      code: 'PLAN_OFFICE_UNAVAILABLE',
      message: 'An office reference is unavailable.',
    });
  });

  test('empty associations need no target query; malformed or oversized refs fail before SQL', async () => {
    const f = fixture();
    await expect(validatePlanOfficeReferences(f.tx, ctx, clientId, [])).resolves.toBeUndefined();
    await expect(
      presentPlanOfficeReferences(
        f.tx,
        ctx,
        clientId,
        Array.from({ length: 201 }, () => ({ targetId, officeKey })),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      presentPlanOfficeReferences(f.tx, ctx, clientId, [{ targetId: 'invalid', officeKey }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.calls).toEqual([]);
  });
});
