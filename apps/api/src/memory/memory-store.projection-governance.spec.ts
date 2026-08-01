import type { PrismaService } from '../prisma/prisma.service.js';
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

function sqlText(strings: unknown): string {
  if (Array.isArray(strings)) return strings.join('?');
  const sql = strings as { strings?: string[]; raw?: string[] };
  return (sql.strings ?? sql.raw ?? []).join('?');
}

function harness() {
  const queries: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: unknown) => {
      queries.push(sqlText(strings));
      return [{ id: ITEM }];
    }),
    $executeRaw: jest.fn(async (strings: unknown) => {
      queries.push(sqlText(strings));
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
  return { service, queries };
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
  it('keeps generic projection SQL free of governed columns', async () => {
    const h = harness();
    await h.service.upsertSystem(baseItem());
    const sql = h.queries.join('\n');
    expect(sql).not.toContain('memory_class =');
    expect(sql).not.toContain('governed_status =');
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
});
