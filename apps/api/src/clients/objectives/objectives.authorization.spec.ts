import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import type { ClientObjective } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ClientObjectivesService } from './objectives.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const clientId = '33333333-3333-4333-8333-333333333333';
const objectiveId = '44444444-4444-4444-8444-444444444444';
const otherTenant = '55555555-5555-4555-8555-555555555555';
const otherUser = '66666666-6666-4666-8666-666666666666';
const otherClient = '77777777-7777-4777-8777-777777777777';
const requestId = '88888888-8888-4888-8888-888888888888';
const now = new Date('2026-10-11T12:00:00Z');
const record: ClientObjective = {
  id: objectiveId,
  tenantId: ctx.tenantId,
  clientId,
  clientRequestId: requestId,
  createRequestHash: '',
  outcome: 'Synthetic outcome',
  governmentProblem: 'Synthetic problem',
  askType: 'policy_authority',
  minimumWin: 'Synthetic minimum win',
  limits: '',
  ownerUserId: ctx.userId,
  createdByUserId: ctx.userId,
  status: 'draft',
  version: 1,
  readyAt: null,
  reviewRequestedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  // Minimal disposable tables for the unchanged canonical wall SQL, not a deployed schema.
  // The grant's six columns match 20260719220000_client_memory_walls exactly.
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      memory_wall boolean NOT NULL DEFAULT false, status text NOT NULL);
    CREATE TABLE client_memory_access (id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
      client_id uuid NOT NULL, user_id uuid NOT NULL, granted_by uuid,
      created_at timestamptz NOT NULL DEFAULT now());
  `);
});
beforeEach(async () => {
  await db.exec('TRUNCATE client_memory_access, clients');
});
afterAll(async () => {
  await db?.close();
});

async function seed(
  options: { wall?: boolean; tenantId?: string; status?: string; grant?: boolean } = {},
) {
  await db.query('INSERT INTO clients VALUES ($1::uuid,$2::uuid,$3,$4)', [
    clientId,
    options.tenantId ?? ctx.tenantId,
    options.wall ?? true,
    options.status ?? 'active',
  ]);
  if (options.grant) await grant();
}
async function grant(tenantId = ctx.tenantId, userId = ctx.userId, id = clientId) {
  await db.query(
    'INSERT INTO client_memory_access (id,tenant_id,client_id,user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)',
    [requestId, tenantId, id, userId],
  );
}
async function revoke() {
  await db.exec('DELETE FROM client_memory_access');
}

function setup(current: ClientObjective = record) {
  let saved = current;
  const tx = {
    $queryRawUnsafe: jest
      .fn<(sql: string, ...values: unknown[]) => Promise<unknown[]>>()
      .mockImplementation(async (sql, ...values) => (await db.query(sql, values)).rows),
    client: {
      findFirst: jest
        .fn<
          (arg: {
            where: { id: string; tenantId: string; status: { not: string } };
          }) => Promise<{ id: string } | null>
        >()
        .mockImplementation(async ({ where }) => {
          const result = await db.query<{ id: string }>(
            'SELECT id FROM clients WHERE id=$1::uuid AND tenant_id=$2::uuid AND status<>$3',
            [where.id, where.tenantId, where.status.not],
          );
          return result.rows[0] ?? null;
        }),
    },
    tenantMembership: {
      findFirst: jest
        .fn<() => Promise<{ id: string } | null>>()
        .mockResolvedValue({ id: 'synthetic-member' }),
    },
    clientObjective: {
      findMany: jest.fn<() => Promise<ClientObjective[]>>().mockResolvedValue([current]),
      findFirst: jest
        .fn<() => Promise<ClientObjective | null>>()
        .mockImplementation(async () => saved),
      createMany: jest
        .fn<(arg: { data: Partial<ClientObjective> }) => Promise<{ count: number }>>()
        .mockImplementation(async ({ data }) => {
          saved = { ...current, ...data };
          return { count: 1 };
        }),
      findFirstOrThrow: jest
        .fn<() => Promise<ClientObjective>>()
        .mockImplementation(async () => saved),
      updateMany: jest.fn<() => Promise<{ count: number }>>().mockImplementation(async () => {
        saved = { ...saved, version: saved.version + 1 };
        return { count: 1 };
      }),
    },
    clientObjectiveRevision: {
      create: jest
        .fn<() => Promise<{ id: string }>>()
        .mockResolvedValue({ id: 'synthetic-revision' }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  // Observable Objective operations are test doubles; the wall and active-client SQL are real.
  // Existing objectives.pg.spec.ts independently executes the Objective migration/constraints.
  return { tx, prisma, service: new ClientObjectivesService(prisma as unknown as PrismaService) };
}
type Fixture = ReturnType<typeof setup>;
const operations = [
  { name: 'list', run: (f: Fixture, actor = ctx) => f.service.list(actor, clientId) },
  { name: 'get', run: (f: Fixture, actor = ctx) => f.service.get(actor, clientId, objectiveId) },
  {
    name: 'create',
    run: (f: Fixture, actor = ctx) =>
      f.service.create(actor, clientId, { requestId, outcome: 'New draft' }),
  },
  {
    name: 'update',
    run: (f: Fixture, actor = ctx) =>
      f.service.update(actor, clientId, objectiveId, 1, { outcome: 'Changed' }),
  },
  {
    name: 'transition',
    run: (f: Fixture, actor = ctx) =>
      f.service.transition(actor, clientId, objectiveId, 1, 'confirm_ready'),
  },
  {
    name: 'delete',
    run: (f: Fixture, actor = ctx) => f.service.remove(actor, clientId, objectiveId, 1),
  },
];
async function expectHidden(result: Promise<unknown>) {
  await expect(result).rejects.toMatchObject({ message: 'Client not found', status: 404 });
}
function expectUntouched(f: Fixture) {
  for (const method of Object.values(f.tx.clientObjective)) expect(method).not.toHaveBeenCalled();
  expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
}

describe('Objectives canonical client wall authorization (disposable SQL)', () => {
  for (const operation of operations) {
    test(`${operation.name}: walled client without grant is non-disclosing before Objective/history access`, async () => {
      await seed();
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
    test(`${operation.name}: exact tenant/client/user grant permits the existing operation`, async () => {
      await seed({ grant: true });
      const f = setup();
      await expect(operation.run(f)).resolves.toBeDefined();
      expect(f.tx.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('client_memory_access'),
        ctx.tenantId,
        clientId,
        ctx.userId,
      );
      expect(f.prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    });
    test(`${operation.name}: unwalled client remains accessible without a grant`, async () => {
      await seed({ wall: false });
      await expect(operation.run(setup())).resolves.toBeDefined();
    });
    test(`${operation.name}: wrong-tenant grant cannot unlock the wall`, async () => {
      await seed();
      await grant(otherTenant);
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
    test(`${operation.name}: wrong-user grant cannot unlock the wall`, async () => {
      await seed();
      await grant(ctx.tenantId, otherUser);
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
    test(`${operation.name}: wrong-client grant cannot unlock the wall`, async () => {
      await seed();
      await grant(ctx.tenantId, ctx.userId, otherClient);
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
    test(`${operation.name}: missing, foreign and archived clients share the refusal`, async () => {
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
      await seed({ tenantId: otherTenant, wall: false });
      await expectHidden(operation.run(f));
      expectUntouched(f);
      await db.query('UPDATE clients SET tenant_id=$1::uuid,status=$2', [ctx.tenantId, 'archived']);
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
    test(`${operation.name}: hard-deleted grant is revoked`, async () => {
      await seed({ grant: true });
      await revoke();
      const f = setup();
      await expectHidden(operation.run(f));
      expectUntouched(f);
    });
  }
  test.each(['user_admin', 'capiro_admin'] as const)(
    '%s receives no implicit wall bypass',
    async (role) => {
      await seed();
      const f = setup();
      await expectHidden(f.service.list({ ...ctx, role }, clientId));
      expectUntouched(f);
    },
  );
  test('absent actor cannot unlock a walled client', async () => {
    await seed({ grant: true });
    const f = setup();
    // Deliberately malformed trusted context tests the helper's documented null-actor boundary.
    await expectHidden(
      f.service.list({ ...ctx, userId: null } as unknown as TenantContext, clientId),
    );
    expectUntouched(f);
  });
  test('canonical SQL failure fails closed before Objective access', async () => {
    await seed({ grant: true });
    const f = setup();
    f.tx.$queryRawUnsafe.mockRejectedValueOnce(new Error('synthetic database failure'));
    await expect(f.service.list(ctx, clientId)).rejects.toThrow('synthetic database failure');
    expectUntouched(f);
  });
});

describe('Objectives access rechecks after pending work (visible SQL revocation)', () => {
  beforeEach(async () => {
    await seed({ grant: true });
  });
  test('list does not publish rows after grant removal during read', async () => {
    const f = setup();
    f.tx.clientObjective.findMany.mockImplementationOnce(async () => {
      await revoke();
      return [record];
    });
    await expectHidden(f.service.list(ctx, clientId));
    expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });
  test('get does not publish row or existence after grant removal during read', async () => {
    const f = setup();
    f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return record;
    });
    await expectHidden(f.service.get(ctx, clientId, objectiveId));
  });
  test('missing Objective result is hidden when access closes during read', async () => {
    const f = setup();
    f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return null;
    });
    await expectHidden(f.service.get(ctx, clientId, objectiveId));
  });
  test.each(operations.filter((op) => ['update', 'transition', 'delete'].includes(op.name)))(
    '$name refuses after pending Objective read without writing',
    async (op) => {
      const f = setup();
      f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
        await revoke();
        return record;
      });
      await expectHidden(op.run(f));
      expect(f.tx.clientObjective.updateMany).not.toHaveBeenCalled();
      expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
    },
  );
  test('stale version conflict does not disclose after pending read loses access', async () => {
    const f = setup();
    f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return { ...record, version: 2 };
    });
    await expectHidden(f.service.update(ctx, clientId, objectiveId, 1, { outcome: 'Changed' }));
    expect(f.tx.clientObjective.updateMany).not.toHaveBeenCalled();
  });
  test('unchanged update cannot return an Objective after read loses access', async () => {
    const f = setup();
    f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return record;
    });
    await expectHidden(f.service.update(ctx, clientId, objectiveId, 1, {}));
    expect(f.tx.clientObjective.updateMany).not.toHaveBeenCalled();
  });
  test('already-ready transition cannot return an Objective after read loses access', async () => {
    const f = setup({ ...record, status: 'ready' });
    f.tx.clientObjective.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return { ...record, status: 'ready' };
    });
    await expectHidden(f.service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready'));
    expect(f.tx.clientObjective.updateMany).not.toHaveBeenCalled();
  });
  test('create rechecks the wall after pending owner read before any write', async () => {
    const f = setup();
    f.tx.tenantMembership.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return { id: 'member' };
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjective.createMany).not.toHaveBeenCalled();
    expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });
  test('invalid owner result does not disclose after pending owner read loses access', async () => {
    const f = setup();
    f.tx.tenantMembership.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return null;
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjective.createMany).not.toHaveBeenCalled();
  });
  test('owner reassignment rechecks access before update', async () => {
    const f = setup();
    f.tx.tenantMembership.findFirst.mockImplementationOnce(async () => {
      await revoke();
      return { id: 'member' };
    });
    await expectHidden(f.service.update(ctx, clientId, objectiveId, 1, { ownerUserId: otherUser }));
    expect(f.tx.clientObjective.updateMany).not.toHaveBeenCalled();
  });
  test('create write receipt loses access before idempotent record lookup or revision', async () => {
    const f = setup();
    f.tx.clientObjective.createMany.mockImplementationOnce(async () => {
      await revoke();
      return { count: 1 };
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjective.findFirstOrThrow).not.toHaveBeenCalled();
    expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });
  test('create duplicate receipt loses access before idempotent record lookup', async () => {
    const f = setup();
    f.tx.clientObjective.createMany.mockImplementationOnce(async () => {
      await revoke();
      return { count: 0 };
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjective.findFirstOrThrow).not.toHaveBeenCalled();
  });
  test('create idempotent record mismatch is hidden after pending lookup loses access', async () => {
    const f = setup();
    f.tx.clientObjective.findFirstOrThrow.mockImplementationOnce(async () => {
      await revoke();
      return record;
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });
  test('matching idempotent create receipt is hidden after pending lookup loses access', async () => {
    const f = setup();
    await f.service.create(ctx, clientId, { requestId });
    const saved = await f.tx.clientObjective.findFirstOrThrow();
    f.tx.clientObjective.createMany.mockResolvedValueOnce({ count: 0 });
    f.tx.clientObjective.findFirstOrThrow.mockImplementationOnce(async () => {
      await revoke();
      return saved;
    });
    await expectHidden(f.service.create(ctx, clientId, { requestId }));
    expect(f.tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
  });
  test.each([0, 1])(
    'updateMany count=%i is not disclosed after access closes during write',
    async (count) => {
      const f = setup();
      f.tx.clientObjective.updateMany.mockImplementationOnce(async () => {
        await revoke();
        return { count };
      });
      await expectHidden(f.service.update(ctx, clientId, objectiveId, 1, { outcome: 'Changed' }));
      expect(f.tx.clientObjective.findFirst).toHaveBeenCalledTimes(1);
      expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
    },
  );
  test('updated record receipt is hidden before revision when access closes during readback', async () => {
    const f = setup();
    f.tx.clientObjective.findFirst
      .mockResolvedValueOnce(record)
      .mockImplementationOnce(async () => {
        await revoke();
        return { ...record, version: 2 };
      });
    await expectHidden(f.service.update(ctx, clientId, objectiveId, 1, { outcome: 'Changed' }));
    expect(f.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });
  test.each(
    operations.filter((op) => ['create', 'update', 'transition', 'delete'].includes(op.name)),
  )('$name does not publish receipt after revision write loses access', async (op) => {
    const f = setup();
    f.tx.clientObjectiveRevision.create.mockImplementationOnce(async () => {
      await revoke();
      return { id: 'revision' };
    });
    await expectHidden(op.run(f));
    expect(f.tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
  });
  test('archive during pending list is refused even with a retained grant', async () => {
    const f = setup();
    f.tx.clientObjective.findMany.mockImplementationOnce(async () => {
      await db.exec("UPDATE clients SET status='archived'");
      return [record];
    });
    await expectHidden(f.service.list(ctx, clientId));
  });
  test('wall enabled during unwalled pending list refuses ungranted actor', async () => {
    await revoke();
    await db.exec('UPDATE clients SET memory_wall=false');
    const f = setup();
    f.tx.clientObjective.findMany.mockImplementationOnce(async () => {
      await db.exec('UPDATE clients SET memory_wall=true');
      return [record];
    });
    await expectHidden(f.service.list(ctx, clientId));
  });
  test('NotFound response contains no Objective or readiness payload', async () => {
    await revoke();
    try {
      await setup().service.get(ctx, clientId, objectiveId);
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toEqual({
        message: 'Client not found',
        error: 'Not Found',
        statusCode: 404,
      });
    }
  });
});
