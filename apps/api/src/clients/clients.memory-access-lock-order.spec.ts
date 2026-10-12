import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

// Execute only this production method. Loading ClientsService would construct
// unrelated asset/provider dependencies and is unnecessary for this contract.
const source = ts.createSourceFile(
  'clients.service.ts',
  readFileSync(join(__dirname, 'clients.service.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const owner = source.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'ClientsService',
);
const methods = owner?.members.filter(
  (node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && node.name.getText(source) === 'setMemoryAccess',
);
if (methods?.length !== 1) throw new Error('Expected one canonical setMemoryAccess method');
const method = methods[0]!;
class NotFoundException extends Error {
  readonly status = 404;
}
class BadRequestException extends Error {
  readonly status = 400;
}
type Context = { tenantId: string; userId: string; role: string };
type Input = { memoryWall: boolean; userIds: string[] };
type Result = { clientId: string; memoryWall: boolean; grantedUserIds: string[] };
type Arguments = Record<string, unknown>;
type Row = { userId: string };
type Tag = (parts: TemplateStringsArray, ...values: unknown[]) => Promise<Array<{ id: string }>>;
type Tx = {
  $queryRaw: Tag;
  client: {
    findFirst: (args: Arguments) => Promise<{ id: string; memoryWall: boolean } | null>;
    update: (args: Arguments) => Promise<unknown>;
  };
  tenantMembership: { findMany: (args: Arguments) => Promise<Row[]> };
  clientMemoryAccess: {
    findMany: (args: Arguments) => Promise<Row[]>;
    createMany: (args: Arguments) => Promise<unknown>;
    deleteMany: (args: Arguments) => Promise<unknown>;
  };
  auditLog: { create: (args: Arguments) => Promise<unknown> };
};
type Prisma = { withTenant: (tenant: string, callback: (tx: Tx) => Promise<Result>) => Promise<Result> };
type Fragment = { setMemoryAccess: (ctx: Context, client: string, input: Input) => Promise<Result> };
const sandbox = { module: { exports: {} }, NotFoundException, BadRequestException };
runInNewContext(
  ts.transpileModule(
    `class Fragment { constructor(prisma) { this.prisma = prisma; } ${method.getText(source)} }
     module.exports = Fragment;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText,
  sandbox,
);
const FragmentClass = sandbox.module.exports as new (prisma: Prisma) => Fragment;
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'user_admin',
};
const clientId = '33333333-3333-4333-8333-333333333333';
const input = { memoryWall: true, userIds: ['u2', 'u1', 'u2'] };

function fixture() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const record = <T>(name: string, value: T) => async (args: Arguments) => {
    calls.push({ name, args });
    return value;
  };
  const tx: Tx = {
    $queryRaw: async (parts, ...values) => {
      calls.push({ name: 'lock', args: { parts: [...parts], values } });
      return [{ id: clientId }];
    },
    client: {
      findFirst: record('client', { id: clientId, memoryWall: false }),
      update: record('update', {}),
    },
    tenantMembership: { findMany: record('members', [{ userId: 'u1' }, { userId: 'u2' }]) },
    clientMemoryAccess: {
      findMany: record('roster', [{ userId: 'old' }, { userId: 'u1' }]),
      createMany: record('add', {}),
      deleteMany: record('remove', {}),
    },
    auditLog: { create: record('audit', {}) },
  };
  const prisma: Prisma = {
    withTenant: async (tenant, callback) => {
      calls.push({ name: 'tenant', args: tenant });
      return callback(tx);
    },
  };
  return { tx, calls, service: new FragmentClass(prisma) };
}

describe('ClientsService.setMemoryAccess client-first lock contract (exact method fragment)', () => {
  test('binds tenant and client as separate parameters in the first transaction operation', async () => {
    const f = fixture();
    await f.service.setMemoryAccess(ctx, clientId, input);
    expect(f.calls.slice(0, 3).map((call) => call.name)).toEqual(['tenant', 'lock', 'client']);
    expect(f.calls[0]!.args).toBe(ctx.tenantId);
    const lock = f.calls[1]!.args as { parts: string[]; values: unknown[] };
    expect(lock.values).toEqual([ctx.tenantId, clientId]);
    expect(lock.parts.map((part) => part.replace(/\s+/g, ' ').trim())).toEqual([
      'SELECT id FROM clients WHERE tenant_id =',
      '::uuid AND id =',
      '::uuid FOR UPDATE',
    ]);
    expect(f.calls[2]!.args).toEqual({
      where: { id: clientId, tenantId: ctx.tenantId },
      select: { id: true, memoryWall: true },
    });
  });

  test('awaits the lock before any client, membership, roster, audit or mutation operation', async () => {
    const f = fixture();
    let release!: (rows: Array<{ id: string }>) => void;
    f.tx.$queryRaw = () => {
      f.calls.push({ name: 'pending lock', args: null });
      return new Promise((resolve) => { release = resolve; });
    };
    const operation = f.service.setMemoryAccess(ctx, clientId, input);
    await Promise.resolve();
    expect(f.calls.map((call) => call.name)).toEqual(['tenant', 'pending lock']);
    release([{ id: clientId }]);
    await operation;
    expect(f.calls.slice(2).map((call) => call.name)).toEqual([
      'client', 'members', 'roster', 'add', 'remove', 'update', 'audit',
    ]);
  });

  test('an absent tenant/client lock row retains 404 and stops before all owner reads and writes', async () => {
    const f = fixture();
    f.tx.$queryRaw = async () => {
      f.calls.push({ name: 'lock', args: null });
      return [];
    };
    await expect(f.service.setMemoryAccess(ctx, clientId, input)).rejects.toMatchObject({
      status: 404, message: 'Client not found',
    });
    expect(f.calls.map((call) => call.name)).toEqual(['tenant', 'lock']);
  });

  test('a lock error propagates unchanged before any owner operation', async () => {
    const f = fixture();
    const failure = new Error('synthetic lock timeout');
    f.tx.$queryRaw = async () => { throw failure; };
    await expect(f.service.setMemoryAccess(ctx, clientId, input)).rejects.toBe(failure);
    expect(f.calls.map((call) => call.name)).toEqual(['tenant']);
  });

  test('preserves the original findFirst absence 404 after a successful lock', async () => {
    const f = fixture();
    f.tx.client.findFirst = async () => null;
    await expect(f.service.setMemoryAccess(ctx, clientId, input)).rejects.toMatchObject({
      status: 404, message: 'Client not found',
    });
    expect(f.calls.map((call) => call.name)).toEqual(['tenant', 'lock']);
  });

  test('foreign-tenant membership still rejects the complete request before roster writes or audit', async () => {
    const f = fixture();
    f.tx.tenantMembership.findMany = async (args) => {
      f.calls.push({ name: 'members', args });
      return [{ userId: 'u1' }];
    };
    await expect(f.service.setMemoryAccess(ctx, clientId, input)).rejects.toMatchObject({
      status: 400, message: 'Cannot grant memory access to non-members of this tenant: u2',
    });
    expect(f.calls.map((call) => call.name)).toEqual(['tenant', 'lock', 'client', 'members']);
    expect(f.calls[3]!.args).toEqual({
      where: { tenantId: ctx.tenantId, userId: { in: ['u2', 'u1'] } },
      select: { userId: true },
    });
  });

  test('preserves replace-set writes, actor/tenant audit, sorted snapshots and ordered deduplicated return', async () => {
    const f = fixture();
    const result = await f.service.setMemoryAccess(ctx, clientId, input);
    expect(f.calls.slice(2)).toEqual([
      { name: 'client', args: { where: { id: clientId, tenantId: ctx.tenantId }, select: { id: true, memoryWall: true } } },
      { name: 'members', args: { where: { tenantId: ctx.tenantId, userId: { in: ['u2', 'u1'] } }, select: { userId: true } } },
      { name: 'roster', args: { where: { tenantId: ctx.tenantId, clientId }, select: { userId: true } } },
      { name: 'add', args: { data: [{ tenantId: ctx.tenantId, clientId, userId: 'u2', grantedBy: ctx.userId }] } },
      { name: 'remove', args: { where: { tenantId: ctx.tenantId, clientId, userId: { in: ['old'] } } } },
      { name: 'update', args: { where: { id: clientId }, data: { memoryWall: true } } },
      { name: 'audit', args: { data: {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: ctx.role,
        action: 'client.memory_wall.update', entityType: 'client', entityId: clientId,
        before: { memoryWall: false, grantedUserIds: ['old', 'u1'] },
        after: { memoryWall: true, grantedUserIds: ['u1', 'u2'] },
      } } },
    ]);
    expect(result).toEqual({ clientId, memoryWall: true, grantedUserIds: ['u2', 'u1'] });
    expect(input.userIds).toEqual(['u2', 'u1', 'u2']);
  });

  test('an unchanged flag and roster still audit but do not write client or grants', async () => {
    const f = fixture();
    f.tx.client.findFirst = async () => ({ id: clientId, memoryWall: true });
    f.tx.clientMemoryAccess.findMany = async () => [{ userId: 'u2' }, { userId: 'u1' }];
    await f.service.setMemoryAccess(ctx, clientId, input);
    expect(f.calls.map((call) => call.name)).toEqual(['tenant', 'lock', 'members', 'audit']);
    expect(f.calls[3]!.args).toMatchObject({ data: {
      before: { memoryWall: true, grantedUserIds: ['u1', 'u2'] },
      after: { memoryWall: true, grantedUserIds: ['u1', 'u2'] },
    } });
  });

  test('an empty complete roster removes every prior grant and retains the self-grant audit evidence', async () => {
    const f = fixture();
    f.tx.clientMemoryAccess.findMany = async () => [{ userId: ctx.userId }, { userId: 'old' }];
    const result = await f.service.setMemoryAccess(ctx, clientId, { memoryWall: true, userIds: [] });
    expect(f.calls.find((call) => call.name === 'add')).toBeUndefined();
    expect(f.calls.find((call) => call.name === 'remove')!.args).toEqual({ where: {
      tenantId: ctx.tenantId, clientId, userId: { in: [ctx.userId, 'old'] },
    } });
    expect(f.calls.find((call) => call.name === 'audit')!.args).toMatchObject({ data: {
      before: { grantedUserIds: [ctx.userId, 'old'].sort() },
      after: { grantedUserIds: [] },
    } });
    expect(result.grantedUserIds).toEqual([]);
  });

  test.each(['client', 'members', 'roster', 'add', 'remove', 'update', 'audit'] as const)(
    'preserves error propagation and stops later operations when %s fails',
    async (stage) => {
      const f = fixture();
      const failure = new Error(`synthetic ${stage} error`);
      const reject = async (args: Arguments) => {
        f.calls.push({ name: stage, args });
        throw failure;
      };
      if (stage === 'client') f.tx.client.findFirst = reject;
      if (stage === 'members') f.tx.tenantMembership.findMany = reject;
      if (stage === 'roster') f.tx.clientMemoryAccess.findMany = reject;
      if (stage === 'add') f.tx.clientMemoryAccess.createMany = reject;
      if (stage === 'remove') f.tx.clientMemoryAccess.deleteMany = reject;
      if (stage === 'update') f.tx.client.update = reject;
      if (stage === 'audit') f.tx.auditLog.create = reject;
      await expect(f.service.setMemoryAccess(ctx, clientId, input)).rejects.toBe(failure);
      const order = ['tenant', 'lock', 'client', 'members', 'roster', 'add', 'remove', 'update', 'audit'];
      expect(f.calls.map((call) => call.name)).toEqual(order.slice(0, order.indexOf(stage) + 1));
    },
  );
});
