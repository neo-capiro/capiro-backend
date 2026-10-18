import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { defaultMemoryGovernanceFields, type MemoryItem } from './memory.types.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const CLIO = '33333333-3333-4333-8333-333333333333';
const CANDIDATE = '44444444-4444-4444-8444-444444444444';
const PROPOSER = '55555555-5555-4555-8555-555555555555';
const APPROVER = '66666666-6666-4666-8666-666666666666';

function sqlText(strings: unknown, values: unknown[] = []): string {
  if (Array.isArray(strings)) return Prisma.sql(strings as TemplateStringsArray, ...values).text;
  const sql = strings as { strings?: string[]; raw?: string[] };
  return (sql.strings ?? sql.raw ?? []).join('?');
}

function harness(existingId?: string) {
  const queries: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: unknown, ...values: unknown[]) => {
      queries.push(sqlText(strings, values));
      return [{ id: existingId ?? values[0] }];
    }),
    $executeRaw: jest.fn(async (strings: unknown, ...values: unknown[]) => {
      queries.push(sqlText(strings, values));
      return 1;
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const service = new MemoryStoreService(
    prisma,
    {} as TenantContextStore,
    {} as MemoryAuthorizationService,
    new MemoryTransitionAuditService(),
    {} as MemoryCleanupOutboxService,
  );
  return { service, queries, tx };
}

function baseItem(): MemoryItem {
  return {
    id: '',
    tenantId: TENANT,
    clientId: null,
    ownerUserId: null,
    type: 'note',
    visibility: 'tenant',
    entityId: null,
    slug: `clio:${CLIO}`,
    title: 'FY27 position',
    aliases: [],
    tags: ['memory'],
    source: 'manual',
    sourceRef: CANDIDATE,
    provenance: 'human',
    sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Support the plus-up.' }],
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    schemaVersion: 1,
    ...defaultMemoryGovernanceFields(),
  };
}

describe('MemoryStoreService projection governance restoration', () => {
  it('refuses to overwrite a hidden Settings identity on the conflict path', async () => {
    const h = harness();
    h.tx.$queryRaw.mockImplementationOnce(async (strings: unknown, ...values: unknown[]) => {
      h.queries.push(sqlText(strings, values));
      return [];
    });
    await expect(
      h.service.upsertSystem(baseItem(), undefined, {
        expectedExistingId: null,
      }),
    ).rejects.toThrow('Memory changed before the Settings save');
    const insert = h.queries.find((sql) => sql.includes('INSERT INTO memory_items'));
    expect(insert).toContain('ON CONFLICT (tenant_id, type, slug) DO UPDATE SET');
    expect(insert).toContain('WHERE FALSE');
  });

  it('pins a previously read Settings identity and its current governed state under conflict', async () => {
    const h = harness();
    h.tx.$queryRaw
      .mockImplementationOnce(async (strings: unknown, ...values: unknown[]) => {
        h.queries.push(sqlText(strings, values));
        return [{ ready: true }];
      })
      .mockImplementationOnce(async (strings: unknown, ...values: unknown[]) => {
        h.queries.push(sqlText(strings, values));
        return [];
      });
    await expect(
      h.service.upsertSystem(baseItem(), undefined, {
        expectedExistingId: ITEM,
      }),
    ).rejects.toThrow('Memory changed before the Settings save');
    const insert = h.queries.find((sql) => sql.includes('INSERT INTO memory_items'));
    expect(insert).toMatch(/WHERE memory_items\.id = \$\d+::uuid/);
    expect(insert).toContain("memory_items.governed_status IN ('active', 'stale')");
    expect(insert).toContain('memory_items.effective_from <= now()');
    expect(insert).toContain('memory_items.valid_until > now()');
  });

  it('keeps generic projection SQL free of governed columns', async () => {
    const h = harness();
    await h.service.upsertSystem(baseItem());
    const sql = h.queries.join('\n');
    expect(sql).not.toContain('memory_class =');
    expect(sql).not.toContain('governed_status =');
  });

  it('synchronizes structural memory_scope with projection routing', async () => {
    const h = harness();
    await h.service.upsertSystem({ ...baseItem(), clientId: CLIO, memoryScope: 'client' });
    const sql = h.queries.join('\n');
    expect(sql).toContain('memory_scope');
    expect(sql).toContain('memory_scope = EXCLUDED.memory_scope');
  });

  it('restores candidate-approved authority in the projection transaction', async () => {
    const h = harness();
    await h.service.upsertSystem({
      ...baseItem(),
      memoryClass: 'institutional_authoritative',
      memoryAuthority: 'firm_approved',
      memoryScope: 'firm',
      governedStatus: 'active',
      sourceType: 'user_message',
      sourceId: CANDIDATE,
      sourceVersion: `candidate:${CANDIDATE}`,
      assertedByUserId: PROPOSER,
      approvedByUserId: APPROVER,
      approvedAt: '2026-07-30T00:01:00.000Z',
      conflictStatus: 'none',
      instructionsAllowed: false,
    });
    const sql = h.queries.join('\n');
    expect(sql).toContain('UPDATE memory_items');
    expect(sql).toContain('memory_class =');
    expect(sql).toContain("review_state = 'confirmed'");
    expect(sql).toContain('instructions_allowed =');
  });

  it('does not restore stale authority when the insert resolves to an existing item', async () => {
    const h = harness(ITEM);
    const id = await h.service.upsertSystem({
      ...baseItem(),
      memoryClass: 'client_steering',
      memoryAuthority: 'client_approved',
      memoryScope: 'client',
      governedStatus: 'active',
      sourceVersion: `candidate:${CANDIDATE}`,
      assertedByUserId: PROPOSER,
      approvedByUserId: APPROVER,
      approvedAt: '2026-07-30T00:01:00.000Z',
    });
    expect(id).toBe(ITEM);
    expect(h.queries.join('\n')).not.toContain('UPDATE memory_items');
  });
});
