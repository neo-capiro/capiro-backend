import { createHash } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const SOURCE = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '55555555-5555-4555-8555-555555555555';
const CREATED = '66666666-6666-4666-8666-666666666666';

const proposerContext = {
  tenantId: TENANT,
  userId: PROPOSER,
  role: 'standard_user',
} as TenantContext;
const reviewerContext = {
  tenantId: TENANT,
  userId: REVIEWER,
  role: 'user_admin',
} as TenantContext;

interface ItemFixture {
  id: string;
  tenant_id: string;
  client_id: string | null;
  owner_user_id: string | null;
  type: string;
  visibility: string;
  slug: string;
  title: string;
  sections_jsonb: Array<{ key: string; heading: string; owner: 'human'; body: string }>;
  status: string;
  governed_status: string;
  memory_class: string;
  memory_scope: string;
  legal_hold: boolean;
  conflict_group_id: string | null;
}

function item(overrides: Partial<ItemFixture> = {}): ItemFixture {
  return {
    id: SOURCE,
    tenant_id: TENANT,
    client_id: null,
    owner_user_id: null,
    type: 'playbook',
    visibility: 'tenant',
    slug: 'firm:positions',
    title: 'Firm Positions',
    sections_jsonb: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Old truth.' }],
    status: 'active',
    governed_status: 'active',
    memory_class: 'institutional_authoritative',
    memory_scope: 'firm',
    legal_hold: false,
    conflict_group_id: null,
    ...overrides,
  };
}

function payload(
  kind: 'correction' | 'restore' | 'contradiction',
  body: string,
  scope: 'firm' | 'client' | 'user_private' = 'firm',
) {
  return {
    key: 'Firm Positions',
    value: body,
    source: `memory_${kind}`,
    scope,
    ownerUserId: scope === 'user_private' ? PROPOSER : null,
    clientId: null,
    canonicalItem: {
      type: scope === 'user_private' ? 'user-profile' : 'playbook',
      slug: 'firm:positions~v555555555555',
      title: 'Firm Positions',
      sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body }],
    },
    versionProposal: { kind, sourceItemId: SOURCE, targetItemId: SOURCE },
  };
}

function sqlText(strings: unknown): string {
  return Array.isArray((strings as { raw?: string[] }).raw)
    ? (strings as { raw: string[] }).raw.join('?')
    : String(strings);
}

function makeHarness(
  options: {
    source?: ItemFixture;
    descendant?: ItemFixture | null;
    candidateKind?: 'correction' | 'restore' | 'contradiction';
    candidateBody?: string;
  } = {},
) {
  const source = options.source ?? item();
  const candidateBody = options.candidateBody ?? 'New truth.';
  const created = item({
    id: CREATED,
    slug: 'firm:positions~v555555555555',
    sections_jsonb: [
      {
        key: 'memory',
        heading: 'Memory',
        owner: 'human',
        body: candidateBody,
      },
    ],
  });
  const candidateKind = options.candidateKind ?? 'correction';
  const candidate = {
    id: CANDIDATE,
    proposed_by: PROPOSER,
    source_kind: `memory_${candidateKind}`,
    payload_jsonb: payload(candidateKind, candidateBody),
  };
  const executeSql: string[] = [];
  const querySql: string[] = [];

  const tx = {
    $queryRaw: async (strings: unknown) => {
      const sql = sqlText(strings);
      querySql.push(sql);
      if (/set_config\('app\.memory_version_activation'/i.test(sql)) {
        return [{ set_config: 'on' }];
      }
      if (/FROM memory_candidate/i.test(sql)) return [candidate];
      if (/WITH RECURSIVE lineage/i.test(sql)) {
        return options.descendant ? [options.descendant] : [];
      }
      if (/INSERT INTO memory_items/i.test(sql)) return [created];
      if (/FROM memory_items/i.test(sql)) return [source];
      return [];
    },
    $executeRaw: async (strings: unknown) => {
      executeSql.push(sqlText(strings));
      return 1;
    },
  } as unknown as Prisma.TransactionClient;

  const expectedEmbedHash = createHash('sha256')
    .update(`${created.title}: ${candidateBody}`)
    .digest('hex');
  const prisma = {
    withTenantUser: jest.fn(
      async <T>(
        _tenantId: string,
        _userId: string,
        fn: (arg: Prisma.TransactionClient) => Promise<T>,
      ) => fn(tx),
    ),
    // embedAndUpsert sees the exact hash and returns before any Bedrock call.
    $queryRawUnsafe: jest.fn(async () => [{ content_hash: expectedEmbedHash }]),
  } as unknown as PrismaService;
  const tenantCtx = { require: jest.fn(() => proposerContext) } as unknown as TenantContextStore;
  const authorization = {
    loadItemInTx: jest.fn(async () => ({
      id: source.id,
      tenantId: TENANT,
      clientId: source.client_id,
      ownerUserId: source.owner_user_id,
      clientStatus: 'active',
      memoryClass: source.memory_class,
      scope: source.memory_scope,
      status: source.governed_status,
      legalHold: source.legal_hold,
    })),
    loadCandidateInTx: jest.fn(async () => ({
      id: CANDIDATE,
      tenantId: TENANT,
      clientId: null,
      ownerUserId: PROPOSER,
      proposedByUserId: PROPOSER,
      clientStatus: null,
      memoryClass: 'institutional_authoritative',
      scope: 'firm',
      status: 'pending_review',
      legalHold: false,
    })),
    evaluateInTx: jest.fn(async () => ({ allowed: true, basis: 'admin' as const })),
  } as unknown as MemoryAuthorizationService;
  const audit = {
    record: jest.fn(async () => 'audit-id'),
  } as unknown as MemoryTransitionAuditService;
  const outbox = {
    enqueue: jest.fn(async () => undefined),
  } as unknown as MemoryCleanupOutboxService;
  const service = new ImmutableMemoryVersionService(
    prisma,
    tenantCtx,
    authorization,
    audit,
    outbox,
  );
  return { service, executeSql, querySql, audit, outbox };
}

async function governed<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = original;
  }
}

describe('ImmutableMemoryVersionService', () => {
  test('shared correction is pending and leaves the active row unchanged', async () => {
    await governed(async () => {
      const h = makeHarness();
      const result = await h.service.proposeCorrection(proposerContext, SOURCE, 'New truth.');
      expect(result).toMatchObject({
        status: 'pending_review',
        activeItemUnchanged: true,
        candidateId: expect.any(String),
      });
      expect(h.executeSql.some((sql) => /INSERT INTO memory_candidate/i.test(sql))).toBe(true);
      expect(h.executeSql.some((sql) => /UPDATE memory_items/i.test(sql))).toBe(false);
    });
  });

  test('approved correction inserts a new id and supersedes exactly one prior version', async () => {
    await governed(async () => {
      const h = makeHarness();
      const result = await h.service.approveCandidate(reviewerContext, CANDIDATE);
      expect(result).toMatchObject({
        outcome: 'activated',
        memoryItemId: CREATED,
        controllingItemId: CREATED,
      });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(true);
      expect(h.executeSql.filter((sql) => /SET status = 'superseded'/i.test(sql))).toHaveLength(1);
      expect(h.outbox.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        TENANT,
        expect.objectContaining({ operation: 'supersede_projections' }),
      );
    });
  });

  test('rejected correction writes no memory version', async () => {
    await governed(async () => {
      const h = makeHarness();
      const result = await h.service.rejectCandidate(reviewerContext, CANDIDATE, 'Not accurate.');
      expect(result).toEqual({ candidateId: CANDIDATE, outcome: 'rejected' });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
      expect(h.executeSql.some((sql) => /UPDATE memory_items/i.test(sql))).toBe(false);
    });
  });

  test('restore creates a new id and never reopens the historical row', async () => {
    await governed(async () => {
      const h = makeHarness({
        source: item({ status: 'superseded', governed_status: 'superseded' }),
        candidateKind: 'restore',
        candidateBody: 'Old truth.',
        descendant: null,
      });
      const result = await h.service.approveCandidate(reviewerContext, CANDIDATE);
      expect(result).toMatchObject({ outcome: 'activated', memoryItemId: CREATED });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(true);
      expect(h.executeSql.some((sql) => /SET status = 'active'/i.test(sql))).toBe(false);
    });
  });

  test('exact duplicate links the controlling item without another insert', async () => {
    await governed(async () => {
      const h = makeHarness({ candidateBody: '  old   truth. ' });
      const result = await h.service.approveCandidate(reviewerContext, CANDIDATE);
      expect(result).toMatchObject({
        outcome: 'duplicate',
        memoryItemId: SOURCE,
        controllingItemId: SOURCE,
      });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
      expect(h.executeSql.some((sql) => /duplicate_memory_item_id/i.test(sql))).toBe(true);
    });
  });

  test('contradiction retains both versions in one open conflict group', async () => {
    await governed(async () => {
      const h = makeHarness({ candidateKind: 'contradiction', candidateBody: 'Opposite truth.' });
      const result = await h.service.approveCandidate(reviewerContext, CANDIDATE);
      expect(result).toMatchObject({
        outcome: 'conflict',
        memoryItemId: CREATED,
        controllingItemId: SOURCE,
        conflictGroupId: expect.any(String),
      });
      expect(h.executeSql.some((sql) => /conflict_status = 'open'/i.test(sql))).toBe(true);
      expect(h.executeSql.some((sql) => /SET status = 'superseded'/i.test(sql))).toBe(false);
    });
  });

  test('legal-held memory cannot be destructively corrected', async () => {
    await governed(async () => {
      const h = makeHarness({ source: item({ legal_hold: true }) });
      await expect(h.service.approveCandidate(reviewerContext, CANDIDATE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
      expect(h.executeSql.some((sql) => /UPDATE memory_items/i.test(sql))).toBe(false);
    });
  });
});
