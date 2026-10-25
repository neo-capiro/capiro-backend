import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { commitContactTransfer, readContactTransfer } from './prospect-contact-transfer-command.js';
import { contactTransferDigest, parseContactTransfer } from './prospect-contact-transfer-input.js';
import { ProspectContactTransfersService } from './prospect-contact-transfers.service.js';

jest.mock('../../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-transfer',
  role: 'standard_user',
} as TenantContext;
const prospectId = id(3),
  clientId = id(4),
  timestamp = '2026-10-25T00:00:00.000Z';
const input = () => ({
  schemaVersion: 1,
  requestId: id(5),
  prospectId,
  clientId,
  expectedProspectUpdatedAt: timestamp,
  items: [
    { sourceId: id(6), expectedVersion: 1, action: 'create', createRequestId: id(9) },
    {
      sourceId: id(7),
      expectedVersion: 1,
      action: 'link',
      personId: id(10),
      expectedUpdatedAt: timestamp,
    },
    { sourceId: id(8), expectedVersion: 1, action: 'skip' },
  ],
});
type Row = Record<string, any>;
function harness() {
  const source = (n: number) => ({
    id: id(n),
    tenant_id: ctx.tenantId,
    prospect_id: prospectId,
    name: `Synthetic ${n}`,
    title: 'CEO',
    email: null,
    phone: null,
    notes: 'Reviewed',
    version: 1,
    removed_at: null,
  });
  const state = {
    sources: [6, 7, 8, 11].map(source),
    people: [
      {
        ...source(7),
        id: id(10),
        tenantId: ctx.tenantId,
        clientId,
        updatedAt: new Date(timestamp),
      },
    ] as Row[],
    receipts: new Map<string, Row>(),
    creates: new Map<string, Row>(),
    audits: 0,
  };
  const controls = {
    member: true,
    role: 'standard_user',
    client: true,
    wall: true,
    feature: true,
    prospect: true,
    linked: clientId as string | null,
    converted: true,
    prospectTime: timestamp,
    failAudit: false,
    failReceipt: false,
    loseResponse: false,
    afterClientLock: undefined as undefined | (() => void),
    afterRollback: undefined as undefined | (() => Promise<void>),
  };
  const statements: string[] = [];
  const key = (tenant: string, actor: string, request: string) =>
    JSON.stringify([tenant, actor, request]);
  const unpack = (args: any[]) =>
    Array.isArray(args[0])
      ? { sql: args[0].join('?'), v: args.slice(1) }
      : { sql: args[0].sql, v: args[0].values };
  const tx = {
    tenantMembership: {
      findFirst: async ({ where }: Row) =>
        controls.member &&
        where.tenantId === ctx.tenantId &&
        where.userId === ctx.userId &&
        where.user.clerkUserId === ctx.clerkUserId
          ? { role: controls.role }
          : null,
    },
    clientPerson: {
      create: async ({ data }: Row) => {
        const row = { ...data, id: id(20 + state.people.length), updatedAt: new Date(timestamp) };
        state.people.push(row);
        return row;
      },
      findFirst: async ({ where }: Row) =>
        state.people.find(
          (p) =>
            p.id === where.id && p.tenantId === where.tenantId && p.clientId === where.clientId,
        ) ?? null,
    },
    auditLog: {
      create: async () => {
        if (controls.failAudit) throw Error('audit failure');
        state.audits++;
      },
    },
    $queryRawUnsafe: async (sql: string, ...v: any[]) => {
      statements.push(sql);
      if (sql.includes('FROM business_development_prospects'))
        return controls.prospect
          ? [{ linkedClientId: controls.linked, status: 'active', dismissedAt: null }]
          : [];
      if (sql.includes('FROM tenants'))
        return [
          { settings: { clioFeatureFlags: { 'businessDevelopment.enabled': controls.feature } } },
        ];
      if (sql.includes('FROM tenant_memberships'))
        return controls.member ? [{ userId: ctx.userId, clerkUserId: ctx.clerkUserId }] : [];
      if (sql.includes('SELECT (NOT c.memory_wall')) return [{ allowed: controls.wall }];
      if (sql.includes('FROM clients'))
        return controls.client ? [{ status: 'active', memoryWall: false }] : [];
      if (sql.includes('set_config')) return [];
      throw Error(`Unexpected synthetic query ${sql} ${v.length}`);
    },
    $queryRaw: async (...args: any[]) => {
      const { sql, v } = unpack(args);
      statements.push(sql);
      if (sql.includes('pg_advisory')) {
        expect(sql).toContain('::text');
        return [];
      }
      if (sql.includes('FROM prospect_contact_transfer_receipts')) {
        const row = state.receipts.get(key(v[0], v[1], v[2]));
        return row ? [structuredClone(row)] : [];
      }
      if (sql.includes('FROM business_development_prospects'))
        return controls.prospect && v[0] === ctx.tenantId && v[1] === prospectId
          ? [
              {
                updatedAt: new Date(controls.prospectTime),
                linkedClientId: controls.linked,
                convertedAt: controls.converted ? new Date(timestamp) : null,
              },
            ]
          : [];
      if (sql.includes('account_owner_version')) {
        controls.afterClientLock?.();
        return controls.client && v[1] === clientId ? [{ version: 0, primary: null }] : [];
      }
      if (sql.includes('FROM tenant_memberships tm'))
        return controls.member ? [{ role: controls.role }] : [];
      if (sql.includes('FROM client_memory_access')) return [];
      if (sql.includes('FROM business_development_prospect_contacts'))
        return structuredClone(
          state.sources
            .filter(
              (s) =>
                s.tenant_id === v[0] &&
                s.prospect_id === v[1] &&
                v[2].includes(s.id) &&
                !s.removed_at,
            )
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      if (sql.includes('FROM client_people'))
        return structuredClone(
          state.people.filter((p) => p.tenantId === v[0] && p.clientId === v[1]),
        );
      if (sql.includes('FROM client_person_create_receipts')) {
        const row = state.creates.get(v[3]);
        return row ? [structuredClone(row)] : [];
      }
      if (sql.includes('INSERT INTO client_person_create_receipts')) {
        const row = {
          requestId: v[3],
          payloadDigest: v[4],
          personId: v[5],
          createdAt: new Date(timestamp),
        };
        state.creates.set(v[3], row);
        return [row];
      }
      throw Error(`Unexpected synthetic query ${sql}`);
    },
    $executeRaw: async (...args: any[]) => {
      const { sql, v } = unpack(args);
      statements.push(sql);
      if (!sql.includes('INSERT INTO prospect_contact_transfer_receipts'))
        throw Error('Unexpected insert');
      if (controls.failReceipt) throw Error('receipt failure');
      state.receipts.set(key(v[0], v[1], v[2]), {
        requestId: v[2],
        prospectId: v[3],
        clientId: v[4],
        payloadDigest: v[5],
        status: v[6],
        result: v[7] ? JSON.parse(v[7]) : null,
        createdAt: new Date(timestamp),
      });
      return 1;
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, callback: (transaction: typeof tx) => Promise<any>) => {
      const before = structuredClone(state);
      let result;
      try {
        result = await callback(tx);
      } catch (error) {
        Object.assign(state, before);
        const after = controls.afterRollback;
        controls.afterRollback = undefined;
        await after?.();
        throw error;
      }
      if (controls.loseResponse) {
        controls.loseResponse = false;
        throw Error('commit response lost');
      }
      return result;
    },
  };
  const kb = { indexPersonFireAndForget: jest.fn() };
  const service = new ProspectContactTransfersService(prisma as never, kb as never);
  return {
    state,
    controls,
    statements,
    kb,
    service,
    save: (raw: unknown = input()) => commitContactTransfer(prisma as never, ctx, prospectId, raw),
    read: (context = ctx, prospect = prospectId) =>
      readContactTransfer(prisma as never, context, prospect, id(5)),
  };
}

test('one reviewed create/link/skip batch preserves every source and uses normal title placement', async () => {
  const h = harness(),
    before = structuredClone(h.state.sources);
  const { receipt, createdIds } = await h.save();
  expect(receipt).toMatchObject({
    status: 'completed',
    result: {
      items: [
        { sourceId: id(6), sourceVersion: 1, action: 'create', personId: createdIds[0] },
        { sourceId: id(7), sourceVersion: 1, action: 'link', personId: id(10) },
        { sourceId: id(8), sourceVersion: 1, action: 'skip', personId: null },
      ],
    },
  });
  expect(h.state.sources).toEqual(before);
  expect(h.state.people[1]).toMatchObject({
    name: 'Synthetic 6',
    title: 'CEO',
    placementSource: 'auto_title',
    hierarchyLevel: 'executive',
  });
  expect(h.state.creates.size).toBe(1);
  expect(h.state.audits).toBe(1);
  expect(h.statements.findIndex((s) => s.includes('account_owner_version'))).toBeLessThan(
    h.statements.findIndex((s) => s.includes('FROM tenant_memberships tm')),
  );
});
test('identical retry and lookup recover history after source/target contact deletion', async () => {
  const h = harness(),
    original = await h.save();
  h.state.sources = [];
  h.state.people = [];
  expect(await h.save()).toEqual({ receipt: original.receipt, createdIds: [] });
  expect(await h.read()).toEqual(original.receipt);
  expect(h.state.audits).toBe(1);
  await expect(
    h.save({ ...input(), items: [{ sourceId: id(6), expectedVersion: 1, action: 'skip' }] }),
  ).rejects.toMatchObject({ status: 409 });
});
test.each([
  'source',
  'prospect',
  'link-version',
  'link-fields',
  'skip-version',
  'new-exact-match',
  'missing-source',
])(
  'changed %s refuses the entire batch, with no contact/audit create and an immutable outcome',
  async (change) => {
    const h = harness();
    if (change === 'source') h.state.sources[0]!.version++;
    if (change === 'prospect') h.controls.prospectTime = '2026-10-25T01:00:00.000Z';
    if (change === 'link-version')
      h.state.people[0]!.updatedAt = new Date('2026-10-25T01:00:00.000Z');
    if (change === 'link-fields') h.state.people[0]!.phone = 'changed';
    if (change === 'skip-version') h.state.sources[2]!.version++;
    if (change === 'new-exact-match')
      h.state.people.push({
        ...h.state.sources[0],
        id: id(12),
        tenantId: ctx.tenantId,
        clientId,
        updatedAt: new Date(timestamp),
      });
    if (change === 'missing-source') h.state.sources.splice(0, 1);
    const before = structuredClone(h.state.people),
      result = await h.save();
    expect(result.receipt).toMatchObject({
      status: 'refused',
      result: null,
      refusal: { code: 'PROSPECT_CONTACT_TRANSFER_REFUSED' },
    });
    expect(result.createdIds).toEqual([]);
    expect(h.state.people).toEqual(before);
    expect(h.state.creates.size).toBe(0);
    expect(h.state.audits).toBe(0);
    expect(await h.save()).toEqual(result);
    expect(await h.read()).toEqual(result.receipt);
  },
);
test.each(['member', 'role', 'wall'])(
  'rechecks %s after waiting for the canonical client lock',
  async (change) => {
    const h = harness();
    h.controls.afterClientLock = () => {
      if (change === 'member') h.controls.member = false;
      if (change === 'role') h.controls.role = 'view_only';
      if (change === 'wall') h.controls.wall = false;
    };
    await expect(h.save()).rejects.toMatchObject({ status: change === 'wall' ? 404 : 403 });
    expect(h.state.receipts.size).toBe(0);
    expect(h.state.creates.size).toBe(0);
  },
);
test.each(['feature', 'linked', 'converted', 'prospect', 'client'])(
  'requires current %s before admitting a transfer',
  async (field) => {
    const h = harness();
    (h.controls as Row)[field] = field === 'linked' ? id(50) : false;
    await expect(h.save()).rejects.toMatchObject({ status: 404 });
    expect(h.state.receipts.size).toBe(0);
  },
);
test.each(['failAudit', 'failReceipt'])(
  'rolls back all writes on %s and leaves the uncertain request unresolved',
  async (field) => {
    const h = harness();
    (h.controls as Row)[field] = true;
    await expect(h.save()).rejects.toThrow();
    expect(h.state.people).toHaveLength(1);
    expect(h.state.creates.size).toBe(0);
    expect(h.state.receipts.size).toBe(0);
    expect(h.state.audits).toBe(0);
    (h.controls as Row)[field] = false;
    expect((await h.save()).receipt.status).toBe('completed');
  },
);
test('lost commit response is recovered without creating or indexing again', async () => {
  const h = harness();
  h.controls.loseResponse = true;
  await expect(h.service.transfer(ctx, prospectId, input())).rejects.toThrow('response lost');
  expect(h.kb.indexPersonFireAndForget).not.toHaveBeenCalled();
  expect(await h.service.transfer(ctx, prospectId, input())).toEqual(await h.read());
  expect(h.state.people).toHaveLength(2);
  expect(h.kb.indexPersonFireAndForget).not.toHaveBeenCalled();
});
test('indexing happens only after a fresh committed create, never on link/skip/replay', async () => {
  const h = harness();
  await h.service.transfer(ctx, prospectId, input());
  await h.service.transfer(ctx, prospectId, input());
  expect(h.kb.indexPersonFireAndForget).toHaveBeenCalledTimes(1);
  expect(h.kb.indexPersonFireAndForget).toHaveBeenCalledWith(ctx.tenantId, h.state.people[1]!.id);
});
test('a reused per-person create request is never adopted by a different transfer after deletion', async () => {
  const h = harness();
  await h.save();
  h.state.people.splice(1, 1);
  const result = await h.save({ ...input(), requestId: id(55) });
  expect(result.receipt.status).toBe('refused');
  expect(h.state.people).toHaveLength(1);
  expect(h.state.creates.size).toBe(1);
});
test('current authority gates historical receipts for actor, tenant, route and wall', async () => {
  const h = harness();
  await h.save();
  await expect(h.read({ ...ctx, userId: id(70) })).rejects.toMatchObject({ status: 403 });
  await expect(h.read({ ...ctx, tenantId: id(71) })).rejects.toMatchObject({ status: 403 });
  await expect(h.read(ctx, id(72))).rejects.toMatchObject({ status: 404 });
  h.controls.wall = false;
  await expect(h.read()).rejects.toMatchObject({ status: 404 });
});
test('a concurrent completed retry wins over an original rollback before refusal persistence', async () => {
  const h = harness();
  h.state.sources[0]!.version++;
  h.controls.afterRollback = async () => {
    h.state.sources[0]!.version = 1;
    await h.save();
  };
  expect((await h.save()).receipt.status).toBe('completed');
  expect(h.state.audits).toBe(1);
});
test('canonical sort binds the same exact manifest and actor', () => {
  const a = parseContactTransfer(prospectId, input()),
    b = parseContactTransfer(prospectId, { ...input(), items: input().items.reverse() });
  expect(a).toEqual(b);
  expect(contactTransferDigest(ctx, a)).toBe(contactTransferDigest(ctx, b));
  expect(contactTransferDigest({ ...ctx, userId: id(75) }, a)).not.toBe(
    contactTransferDigest(ctx, a),
  );
});
test.each([
  { extra: true },
  { prospectId: id(80) },
  { requestId: 'invalid' },
  { schemaVersion: 2 },
  { items: [] },
  { items: [input().items[0], input().items[0]] },
  { items: [{ ...input().items[0], expectedVersion: 1.5 }] },
  { items: [{ ...input().items[1], extra: true }] },
  { items: [{ ...input().items[0] }, { ...input().items[0], sourceId: id(90) }] },
  {
    items: Array.from({ length: 51 }, (_, i) => ({
      sourceId: id(100 + i),
      expectedVersion: 1,
      action: 'skip',
    })),
  },
])('rejects malformed or ambiguous manifests %# before any transaction', (patch) => {
  expect(() => parseContactTransfer(prospectId, { ...input(), ...patch })).toThrow(
    BadRequestException,
  );
});
