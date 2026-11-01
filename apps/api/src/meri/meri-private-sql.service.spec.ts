import { EventEmitter } from 'node:events';
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { MeriPrivateSqlService } from './meri-private-sql.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { withMeriToolRequestControl } from './meri-tool-request-control.js';
import type { PrivateSqlExecutionContext } from './analytics/private-sql-db.service.js';

const id = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const ctx = {
  tenantId: id('1'),
  userId: id('2'),
  tenantSlug: 'fixture',
  clerkUserId: 'synthetic',
  role: 'standard_user',
} as TenantContext;
const client = id('3'),
  other = id('4');
const query = {
  source: 'client_records',
  sql: 'SELECT COUNT(*) AS total FROM client_objectives',
  parameters: [],
};

function fixture(selected: string | null = null, requested?: string) {
  const receipt = {
    identityRevision: 'a'.repeat(64),
    membershipRevision: 'b'.repeat(64),
    contextRevision: 'c'.repeat(64),
    clientIds: [client, other],
  };
  const current = {
    read: jest.fn(async (_ctx: unknown, _req: unknown, input: any) => {
      if (
        input.expect &&
        Object.entries(input.expect).some(
          ([key, value]) => receipt[key as keyof typeof receipt] !== value,
        )
      )
        throw new ForbiddenException();
      return { ...receipt };
    }),
  };
  const scope = {
    clientId: requested ?? selected,
    identityRevision: receipt.identityRevision,
    membershipRevision: receipt.membershipRevision,
  };
  const correlation = {
    binding: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      conversationId: id('5'),
      runId: id('6'),
      attemptId: id('7'),
      workerId: id('8'),
      writerFence: 1,
    },
    subject: {
      kind: selected ? 'client' : 'personal',
      entityType: selected ? 'client' : 'user',
      entityIds: [selected ?? ctx.userId],
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      policyRevision: 'policy',
      scopes: [
        {
          tenantId: ctx.tenantId,
          kind: selected ? 'client' : 'private-user',
          resourceId: selected ?? ctx.userId,
          policyRevision: 'policy',
        },
      ],
      rosterVersionId: null,
    },
    policyRevision: 'policy',
    normalizationContext: { capiroDataScope: scope },
  };
  const req = Object.assign(new EventEmitter(), {
    headers: {
      authorization: 'Bearer synthetic',
      'x-internal-service-secret': 'synthetic-service',
      'x-meri-deadline-at': String(Date.now() + 30_000),
      'x-meri-read-correlation': Buffer.from(canonicalizeCoreRetainedJson(correlation)).toString(
        'base64url',
      ),
    },
  }) as unknown as Request;
  new ToolServiceSecretGuard({
    get: (name: string) =>
      name === 'INTERNAL_SERVICE_SECRET'
        ? 'synthetic-service'
        : name === 'NODE_ENV'
          ? 'test'
          : true,
  } as any).verifyRequest(req);
  let during = async () => {};
  const surface = ['client_objectives', 'client_activity'].map((name) => ({
    name, description: 'Synthetic', grain: '', fields: [{ name: 'id', type: 'string' as const, pgType: 'uuid', nullable: false, description: 'ID' }],
    primaryKey: ['id'], relationships: [], coverage: { basis: 'authorized_client_records', limitations: [] },
    freshness: { field: null, sourceAsOf: null, sourceVersion: null },
  }));
  const db = {
    runPrivateSql: jest.fn(async (_gated: unknown, context: PrivateSqlExecutionContext) => {
      await context.assertCurrent();
      await during();
      await context.assertCurrent();
      return { columns: [{ name: 'total', type: 'integer' as const, pgType: 'int8', nullable: true }], rows: [{ total: '0' }], surface };
    }),
    describe: jest.fn(async (context: PrivateSqlExecutionContext) => {
      await context.assertCurrent();
      await during();
      await context.assertCurrent();
      return surface;
    }),
  };
  const audit = jest.fn(async (_ctx: unknown, _summary: any) => {}),
    tools = { recordPrivateSqlQuery: audit };
  const service = new MeriPrivateSqlService(current as any, db as any, tools as any);
  const read = (
    input: unknown = { ...query, ...(requested ? { clientId: requested } : {}) },
    operation: 'query_capiro_data' | 'describe_capiro_data' = 'query_capiro_data',
  ) => withMeriToolRequestControl(req, () => service.read(ctx, req, operation, input));
  return {
    receipt,
    current,
    scope,
    req,
    db,
    audit,
    read,
    correlation,
    setDuring(fn: () => Promise<void>) {
      during = fn;
    },
  };
}

describe('interactive private query binding', () => {
  it.each([
    [null, undefined],
    [null, client],
    [client, undefined],
    [client, client],
  ] as const)('binds conversation %s and optional narrowing %s', async (selected, requested) => {
    const f = fixture(selected, requested),
      page = await f.read();
    expect(page).toMatchObject({
      version: '0.3.0',
      ok: true,
      scope: { kind: 'client_records', clientId: requested ?? selected },
      rows: [{ total: '0' }],
    });
    expect(f.current.read.mock.calls.every((call) => call[2].clientId === selected)).toBe(true);
    expect(f.current.read.mock.calls[1]![2].expect).toEqual({
      identityRevision: 'a'.repeat(64),
      membershipRevision: 'b'.repeat(64),
      contextRevision: 'c'.repeat(64),
    });
    const bound = f.db.runPrivateSql.mock.calls[0]![1];
    expect(bound.scopeKind).toBe((requested ?? selected) === null ? 'general' : 'client');
  });
  it('rejects a selected-client broadening and an invisible General narrowing before SQL', async () => {
    const selected = fixture(client, other);
    await expect(selected.read()).rejects.toThrow();
    expect(selected.db.runPrivateSql).not.toHaveBeenCalled();
    const general = fixture(null, client);
    general.receipt.clientIds = [other];
    await expect(general.read()).rejects.toThrow();
    expect(general.db.runPrivateSql).not.toHaveBeenCalled();
  });
  it.each(['identityRevision', 'membershipRevision', 'contextRevision'] as const)(
    'withholds an aggregate after %s changes',
    async (key) => {
      const f = fixture();
      f.setDuring(async () => {
        f.receipt[key] = 'd'.repeat(64);
      });
      await expect(f.read()).rejects.toThrow();
      expect(f.db.runPrivateSql).toHaveBeenCalledTimes(1);
    },
  );
  it('checks describe currentness and publishes the reader surface without physical metadata', async () => {
    const f = fixture(),
      page = await f.read({ source: 'client_records' }, 'describe_capiro_data');
    expect(page.ok).toBe(true);
    if (!page.ok || !('relations' in page)) throw Error('metadata expected');
    expect(page.relations.map((r) => r.name)).toEqual(['client_objectives', 'client_activity']);
    expect(JSON.stringify(page)).not.toContain('"table"');
    const denied = fixture();
    denied.setDuring(async () => {
      denied.receipt.membershipRevision = 'd'.repeat(64);
    });
    await expect(
      denied.read({ source: 'client_records' }, 'describe_capiro_data'),
    ).rejects.toThrow();
  });
  it('refuses stale native scope, malformed selectors and missing service proof', async () => {
    for (const input of [
      { ...query, clientId: null },
      { ...query, source: 'public' },
      { ...query, clientId: 'bad' },
    ]) {
      const f = fixture();
      await expect(f.read(input)).rejects.toThrow();
      expect(f.db.runPrivateSql).not.toHaveBeenCalled();
    }
    const stale = fixture();
    stale.receipt.identityRevision = 'd'.repeat(64);
    await expect(stale.read()).rejects.toThrow();
    expect(stale.db.runPrivateSql).not.toHaveBeenCalled();
    const proof = fixture();
    proof.req.headers['x-internal-service-secret'] = 'wrong';
    try {
      new ToolServiceSecretGuard({ get: () => true } as any).verifyRequest(proof.req);
    } catch {}
    await expect(proof.read()).rejects.toThrow();
    expect(proof.db.runPrivateSql).not.toHaveBeenCalled();
  });
  it('makes zero SQL calls on prior abort/expiry and withholds a late cancelled result', async () => {
    const before = fixture();
    Object.assign(before.req, { aborted: true });
    await expect(before.read()).rejects.toThrow();
    expect(before.db.runPrivateSql).not.toHaveBeenCalled();
    const expired = fixture();
    expired.req.headers['x-meri-deadline-at'] = String(Date.now() - 1);
    await expect(expired.read()).rejects.toThrow();
    expect(expired.db.runPrivateSql).not.toHaveBeenCalled();
    const late = fixture();
    late.setDuring(async () => {
      late.req.emit('aborted');
    });
    await expect(late.read()).rejects.toThrow();
  });
  it('fences authority changes during the audit await and stores no private query text or values', async () => {
    const f = fixture();
    f.audit.mockImplementation(async () => {
      f.receipt.membershipRevision = 'd'.repeat(64);
    });
    await expect(
      f.read({
        ...query,
        sql: 'SELECT COUNT(*) AS total FROM client_objectives WHERE outcome=$1',
        parameters: ['private value'],
      }),
    ).rejects.toThrow();
    expect(f.audit).toHaveBeenCalledWith(ctx, {
      relations: ['client_objectives'],
      rowCount: 1,
      durationMs: expect.any(Number),
      outcome: 'ok',
    });
    const create = jest.fn(async () => {}),
      tools = Object.assign(Object.create(MeriToolsService.prototype), {
        prisma: { withSystem: async (fn: any) => fn({ meriAnalyticsQueryLog: { create } }) },
      });
    await tools.recordPrivateSqlQuery(ctx, f.audit.mock.calls[0]![1]);
    const stored = JSON.stringify(create.mock.calls);
    expect(stored).toContain('query_capiro_data');
    expect(stored).not.toContain('private value');
    expect(stored).not.toContain('SELECT');
  });
  it('keeps explicit/omitted public input equivalent and rejects private internal dispatch', () => {
    const tools = Object.create(MeriToolsService.prototype) as any,
      input = { sql: 'SELECT pe_code FROM program_elements', parameters: [] };
    expect(tools.publicCapiroDataInput(input)).toEqual(input);
    expect(tools.publicCapiroDataInput({ ...input, source: 'public' })).toEqual(input);
    for (const extra of [{ source: 'client_records' }, { source: 'other' }, { clientId: client }])
      expect(() => tools.publicCapiroDataInput({ ...input, ...extra })).toThrow();
  });
});
