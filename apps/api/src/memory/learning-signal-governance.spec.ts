import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import {
  MemoryCandidateReviewService,
  candidateKindFor,
} from './memory-candidate-review.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import type { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';

/**
 * Phase 27D — governance integration and supersession execution.
 *
 * Covers the ONE canonical decision path
 * (ImmutableMemoryVersionService.decideLearningSignalCandidate) that may
 * resolve a Phase 27C conflict flag into a real change to active memory,
 * and the MemoryCandidateReviewService.resolveConflict routing that fronts
 * it. Named `learning-signal-governance` deliberately (see
 * scripts/validate-knowledge-plane-phase27.mjs) so it runs under the phase27
 * validator even though it lives in apps/api/src/memory/, not src/learning/.
 */

const TENANT = 'a1111111-1111-4111-8111-111111111111';
const PROPOSER = 'a2222222-2222-4222-8222-222222222222';
const REVIEWER = 'a3333333-3333-4333-8333-333333333333';
const CLIENT = 'a4444444-4444-4444-8444-444444444444';
const TARGET = 'a5555555-5555-4555-8555-555555555555';
const CANDIDATE = 'a6666666-6666-4666-8666-666666666666';
const CREATED = 'a7777777-7777-4777-8777-777777777777';

const proposerContext = {
  tenantId: TENANT,
  userId: PROPOSER,
  role: 'standard_user',
} as TenantContext;
const reviewerContext = { tenantId: TENANT, userId: REVIEWER, role: 'user_admin' } as TenantContext;

interface TargetFixture {
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

function target(overrides: Partial<TargetFixture> = {}): TargetFixture {
  return {
    id: TARGET,
    tenant_id: TENANT,
    client_id: CLIENT,
    owner_user_id: null,
    type: 'client-compass',
    visibility: 'tenant',
    slug: 'client:steering:cadence',
    title: 'Reporting cadence',
    sections_jsonb: [
      {
        key: 'memory',
        heading: 'Memory',
        owner: 'human',
        body: 'Client wants monthly congressional updates.',
      },
    ],
    status: 'active',
    governed_status: 'active',
    memory_class: 'client_steering',
    memory_scope: 'client',
    legal_hold: false,
    conflict_group_id: null,
    ...overrides,
  };
}

function candidatePayload(value = 'Client now wants weekly congressional updates.') {
  return {
    key: 'learning-signal:crm.fill_with_meri:cadence:sig-1',
    value,
    source: 'learning_signal',
    scope: 'client',
    ownerUserId: null,
    clientId: CLIENT,
    canonicalItem: null,
  };
}

function sqlText(strings: unknown): string {
  return Array.isArray((strings as { raw?: string[] }).raw)
    ? (strings as { raw: string[] }).raw.join('?')
    : String(strings);
}

function makeVersionHarness(
  options: {
    target?: TargetFixture;
    candidateScope?: string;
    candidateProposedBy?: string;
    executeOverride?: (sql: string) => number | null;
    reviewerAuthorized?: boolean;
  } = {},
) {
  const targetRow = options.target ?? target();
  const created = target({
    id: CREATED,
    slug: `${targetRow.slug}~v${CANDIDATE.replace(/-/g, '')}`,
    sections_jsonb: [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'New content.' }],
  });
  const candidate = {
    id: CANDIDATE,
    proposed_by: options.candidateProposedBy ?? PROPOSER,
    source_kind: 'learning_signal',
    scope: options.candidateScope ?? 'client',
    // Deliberately always CLIENT, independent of any target({client_id: ...})
    // override — the cross-client security test relies on this staying
    // fixed while only the target's client_id changes, to prove the guard
    // actually compares them rather than just checking either is truthy.
    client_id: CLIENT,
    payload_jsonb: candidatePayload(),
    contradicts_memory_item_id: targetRow.id,
  };

  const executeSql: string[] = [];
  const querySql: string[] = [];

  const tx = {
    $queryRaw: async (strings: unknown) => {
      const sql = sqlText(strings);
      querySql.push(sql);
      if (/set_config\('app\.memory_version_activation'/i.test(sql)) return [{ set_config: 'on' }];
      if (/INSERT INTO memory_items/i.test(sql)) return [created];
      if (/FROM memory_candidate/i.test(sql)) return [candidate];
      if (/FROM memory_items/i.test(sql)) return [targetRow];
      return [];
    },
    $executeRaw: async (strings: unknown) => {
      const sql = sqlText(strings);
      executeSql.push(sql);
      const override = options.executeOverride?.(sql);
      return override ?? 1;
    },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    withTenantUser: jest.fn(
      async <T>(
        _tenantId: string,
        _userId: string,
        fn: (arg: Prisma.TransactionClient) => Promise<T>,
      ) => fn(tx),
    ),
    // Governance is under test, not provider embedding. The existing projection
    // hash makes the real post-commit embedder return before any network call.
    $queryRawUnsafe: jest.fn(async () => [
      {
        content_hash: createHash('sha256')
          .update(`${created.title}: ${candidate.payload_jsonb.value}`)
          .digest('hex'),
      },
    ]),
  } as unknown as PrismaService;

  const tenantCtx = { require: jest.fn(() => proposerContext) } as unknown as TenantContextStore;
  const authorization = {
    loadCandidateInTx: jest.fn(async () => ({
      id: CANDIDATE,
      tenantId: TENANT,
      clientId: candidate.scope === 'client' ? CLIENT : null,
      ownerUserId: candidate.proposed_by,
      proposedByUserId: candidate.proposed_by,
      clientStatus: 'active',
      memoryClass: 'client_steering',
      scope: candidate.scope,
      status: 'pending_review',
      legalHold: false,
    })),
    evaluateInTx: jest.fn(async () =>
      options.reviewerAuthorized === false
        ? { allowed: false, reason: 'missing_grant' as const }
        : { allowed: true, basis: 'admin' as const },
    ),
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
  return {
    service,
    executeSql,
    querySql,
    audit,
    outbox,
    authorization,
    candidate,
    targetRow,
    created,
  };
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

/** MemoryCandidateReviewService.enabled() requires all three review-surface switches armed. */
async function reviewEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    'MEMORY_CLIENT_REVIEW',
    'MEMORY_GOVERNANCE_LIFECYCLE',
    'MEMORY_GOVERNANCE_ENFORCE',
  ] as const;
  const originals = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = 'enforce';
  try {
    return await fn();
  } finally {
    keys.forEach((key, i) => {
      if (originals[i] === undefined) delete process.env[key];
      else process.env[key] = originals[i];
    });
  }
}

describe('candidateKindFor', () => {
  test('a learning_signal candidate with an open conflict flag is learning_signal_conflict', () => {
    expect(
      candidateKindFor({
        sourceKind: 'learning_signal',
        contradictsMemoryItemId: TARGET,
        conflictStatus: 'open',
      }),
    ).toBe('learning_signal_conflict');
  });

  test('a learning_signal candidate with no conflict flag is standard — nothing to govern', () => {
    expect(
      candidateKindFor({
        sourceKind: 'learning_signal',
        contradictsMemoryItemId: null,
        conflictStatus: null,
      }),
    ).toBe('standard');
    expect(
      candidateKindFor({
        sourceKind: 'learning_signal',
        contradictsMemoryItemId: TARGET,
        conflictStatus: 'none',
      }),
    ).toBe('standard');
  });

  test('correction/restore/contradiction sourceKinds are unaffected', () => {
    expect(
      candidateKindFor({
        sourceKind: 'memory_correction',
        contradictsMemoryItemId: null,
        conflictStatus: null,
      }),
    ).toBe('correction');
    expect(
      candidateKindFor({
        sourceKind: 'memory_contradiction',
        contradictsMemoryItemId: null,
        conflictStatus: null,
      }),
    ).toBe('contradiction');
  });
});

describe('ImmutableMemoryVersionService.decideLearningSignalCandidate', () => {
  test('duplicate: existing memory stays canonical, no new active row', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      const result = await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'duplicate',
      );
      expect(result).toMatchObject({
        decision: 'duplicate',
        outcome: 'duplicate',
        memoryItemId: TARGET,
        controllingItemId: TARGET,
      });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
      expect(h.executeSql.some((sql) => /last_confirmed_at/i.test(sql))).toBe(true);
      // AI feedback-loop guard: the candidate's own memory_authority bookkeeping
      // (finishCandidate) is a pure CASE-on-memory_scope expression with no
      // evidence-count/lineage parameter — assert the exact scope-only form,
      // not merely that some UPDATE happened to mention the column.
      expect(
        h.executeSql.some((sql) =>
          /memory_authority = CASE memory_scope WHEN 'firm' THEN 'firm_approved'/i.test(sql),
        ),
      ).toBe(true);
    });
  });

  test('corroborate_existing: same mechanism as duplicate, distinct outcome label', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      const result = await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'corroborate_existing',
      );
      expect(result).toMatchObject({
        decision: 'corroborate_existing',
        outcome: 'corroborated',
        memoryItemId: TARGET,
      });
    });
  });

  test('repeated corroboration never escalates authority (AI self-loop cannot compound)', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'corroborate_existing',
      );
      const second = await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'corroborate_existing',
      );
      expect(second.outcome).toBe('corroborated');
      // Both calls produce the byte-identical scope-only authority
      // expression — repetition cannot parameterize a stronger tier because
      // there is no input slot for "how many times has this been confirmed."
      const authoritySql = h.executeSql.filter((sql) => /memory_authority = CASE/i.test(sql));
      expect(authoritySql).toHaveLength(2);
      expect(authoritySql[0]).toBe(authoritySql[1]);
    });
  });

  test('supersede_existing: old row superseded, new row active with lineage, candidate finished', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      const result = await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'supersede_existing',
      );
      expect(result).toMatchObject({
        decision: 'supersede_existing',
        outcome: 'activated',
        memoryItemId: CREATED,
        controllingItemId: CREATED,
      });
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(true);
      expect(h.executeSql.filter((sql) => /SET status = 'superseded'/i.test(sql))).toHaveLength(1);
      expect(h.executeSql.some((sql) => /committed_memory_item_id/i.test(sql))).toBe(true);
      expect(h.outbox.enqueue).toHaveBeenCalledWith(
        expect.anything(),
        TENANT,
        expect.objectContaining({ operation: 'supersede_projections' }),
      );
    });
  });

  test('conflict_requires_review: both rows survive, sharing one conflict group', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      const result = await h.service.decideLearningSignalCandidate(
        reviewerContext,
        CANDIDATE,
        'conflict_requires_review',
      );
      expect(result).toMatchObject({
        decision: 'conflict_requires_review',
        outcome: 'conflict',
        memoryItemId: CREATED,
        controllingItemId: TARGET,
      });
      expect(result.conflictGroupId).toBeTruthy();
      expect(h.executeSql.some((sql) => /governed_status = 'conflicted'/i.test(sql))).toBe(true);
      // Old row's own status column is untouched by a conflict outcome —
      // only governed_status/conflict_status move, matching the existing
      // human contradiction flow's exact behavior.
      expect(h.executeSql.some((sql) => /SET status = 'superseded'/i.test(sql))).toBe(false);
    });
  });

  test('legal_hold blocks supersede_existing but not conflict_requires_review', async () => {
    await governed(async () => {
      const held = makeVersionHarness({ target: target({ legal_hold: true }) });
      await expect(
        held.service.decideLearningSignalCandidate(
          reviewerContext,
          CANDIDATE,
          'supersede_existing',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const heldToo = makeVersionHarness({ target: target({ legal_hold: true }) });
      await expect(
        heldToo.service.decideLearningSignalCandidate(
          reviewerContext,
          CANDIDATE,
          'conflict_requires_review',
        ),
      ).resolves.toMatchObject({ outcome: 'conflict' });
    });
  });

  test('self-approval is denied for shared scope without an admin role', async () => {
    await governed(async () => {
      const h = makeVersionHarness({ candidateProposedBy: PROPOSER });
      await expect(
        h.service.decideLearningSignalCandidate(proposerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  test("SECURITY: a candidate cannot resolve a conflict against a different client's memory item", async () => {
    await governed(async () => {
      const otherClient = 'a8888888-8888-4888-8888-888888888888';
      const h = makeVersionHarness({ target: target({ client_id: otherClient }) });
      await expect(
        h.service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
    });
  });

  test('an unauthorized reviewer is denied before anything is read or written', async () => {
    await governed(async () => {
      const h = makeVersionHarness({ reviewerAuthorized: false });
      await expect(
        h.service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.querySql.some((sql) => /INSERT INTO memory_items/i.test(sql))).toBe(false);
    });
  });

  test('a target that no longer exists is a 404, not a silent no-op', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      // Simulate the flagged item having been deleted/never existed by
      // making the memory_items lookup return nothing.
      const originalQueryRaw = (h.service as unknown as { prisma: PrismaService }).prisma;
      void originalQueryRaw;
      const brokenHarness = makeVersionHarness();
      // Override just the loadItem branch by replacing the harness's tx via
      // a second harness whose FROM memory_items query returns no rows.
      const tx = {
        $queryRaw: async (strings: unknown) => {
          const sql = sqlText(strings);
          if (/set_config/i.test(sql)) return [{ set_config: 'on' }];
          if (/FROM memory_candidate/i.test(sql)) return [brokenHarness.candidate];
          if (/FROM memory_items/i.test(sql)) return [];
          return [];
        },
        $executeRaw: async () => 1,
      } as unknown as Prisma.TransactionClient;
      (
        brokenHarness.service as unknown as { prisma: { withTenantUser: unknown } }
      ).prisma.withTenantUser = jest.fn(
        async (_t: string, _u: string, fn: (arg: Prisma.TransactionClient) => Promise<unknown>) =>
          fn(tx),
      );
      await expect(
        brokenHarness.service.decideLearningSignalCandidate(
          reviewerContext,
          CANDIDATE,
          'duplicate',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  test('a target that is no longer controlling rejects with 400, not a stale write', async () => {
    await governed(async () => {
      const h = makeVersionHarness({
        target: target({ status: 'superseded', governed_status: 'superseded' }),
      });
      await expect(
        h.service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  test('an already-resolved candidate (concurrent decision) is a 404, never double-processed', async () => {
    await governed(async () => {
      // The FOR UPDATE lock query filters on status='pending' AND
      // conflict_status='open' — once a first decision commits, a second
      // concurrent call finds no matching row. Simulate that directly.
      const tx = {
        $queryRaw: async (strings: unknown) => {
          const sql = sqlText(strings);
          if (/FROM memory_candidate/i.test(sql)) return [];
          return [];
        },
        $executeRaw: async () => 1,
      } as unknown as Prisma.TransactionClient;
      const prisma = {
        withTenantUser: jest.fn(
          async (_t: string, _u: string, fn: (arg: Prisma.TransactionClient) => Promise<unknown>) =>
            fn(tx),
        ),
      } as unknown as PrismaService;
      const authorization = {} as unknown as MemoryAuthorizationService;
      const audit = {} as unknown as MemoryTransitionAuditService;
      const outbox = {} as unknown as MemoryCleanupOutboxService;
      const tenantCtx = { require: jest.fn() } as unknown as TenantContextStore;
      const service = new ImmutableMemoryVersionService(
        prisma,
        tenantCtx,
        authorization,
        audit,
        outbox,
      );
      await expect(
        service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'duplicate'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  test('atomicity: if superseding the old row loses its race, the new row and the candidate are never finished', async () => {
    await governed(async () => {
      const h = makeVersionHarness({
        executeOverride: (sql) => (/SET status = 'superseded'/i.test(sql) ? 0 : null),
      });
      await expect(
        h.service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toThrow(/not.*supersede|did not supersede/i);
      expect(h.executeSql.some((sql) => /committed_memory_item_id/i.test(sql))).toBe(false);
    });
  });

  test('atomicity: if opening the conflict loses its race, the candidate is never finished', async () => {
    await governed(async () => {
      const h = makeVersionHarness({
        executeOverride: (sql) => (/governed_status = 'conflicted'/i.test(sql) ? 0 : null),
      });
      await expect(
        h.service.decideLearningSignalCandidate(
          reviewerContext,
          CANDIDATE,
          'conflict_requires_review',
        ),
      ).rejects.toThrow(/conflict/i);
      expect(h.executeSql.some((sql) => /committed_memory_item_id/i.test(sql))).toBe(false);
    });
  });

  test('rejects an unsupported decision string', async () => {
    await governed(async () => {
      const h = makeVersionHarness();
      await expect(
        h.service.decideLearningSignalCandidate(reviewerContext, CANDIDATE, 'approve_new' as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('MemoryCandidateReviewService.resolveConflict', () => {
  function makeReviewHarness(candidateKind: 'learning_signal_conflict' | 'standard') {
    const findFirst = jest.fn(async () =>
      candidateKind === 'learning_signal_conflict'
        ? { sourceKind: 'learning_signal', contradictsMemoryItemId: TARGET, conflictStatus: 'open' }
        : { sourceKind: 'explicit_user', contradictsMemoryItemId: null, conflictStatus: null },
    );
    const tx = { memoryCandidate: { findFirst } };
    const prisma = {
      withTenantUser: jest.fn(
        async (_t: string, _u: string, fn: (arg: unknown) => Promise<unknown>) => fn(tx),
      ),
    } as unknown as PrismaService;
    const authorization = {} as unknown as MemoryAuthorizationService;
    const candidates = {} as unknown as MemoryCandidateService;
    const decideLearningSignalCandidate = jest.fn(async () => ({
      candidateId: CANDIDATE,
      decision: 'supersede_existing' as const,
      outcome: 'activated' as const,
      memoryItemId: CREATED,
      controllingItemId: CREATED,
    }));
    const versions = { decideLearningSignalCandidate } as unknown as ImmutableMemoryVersionService;
    const assertAssignedForDecision = jest.fn(async () => undefined);
    const completeDecision = jest.fn(async () => ({}) as never);
    const workflow = {
      assertAssignedForDecision,
      completeDecision,
    } as unknown as MemoryReviewWorkflowService;
    const service = new MemoryCandidateReviewService(
      prisma,
      authorization,
      candidates,
      versions,
      workflow,
    );
    return { service, decideLearningSignalCandidate, assertAssignedForDecision, completeDecision };
  }

  test('routes a valid decision on a learning_signal_conflict candidate through to the version service', async () => {
    await reviewEnabled(async () => {
      const h = makeReviewHarness('learning_signal_conflict');
      const result = await h.service.resolveConflict(
        reviewerContext,
        CANDIDATE,
        'supersede_existing',
        'looks right',
      );
      expect(h.decideLearningSignalCandidate).toHaveBeenCalledWith(
        reviewerContext,
        CANDIDATE,
        'supersede_existing',
        'looks right',
      );
      expect(h.assertAssignedForDecision).toHaveBeenCalledWith(
        reviewerContext,
        CANDIDATE,
        'resolve_conflict',
      );
      expect(h.completeDecision).toHaveBeenCalledWith(reviewerContext, CANDIDATE, 'approved');
      expect(result).toMatchObject({
        candidateKind: 'learning_signal_conflict',
        outcome: 'activated',
      });
    });
  });

  test('refuses a candidate that has no conflict to resolve', async () => {
    await reviewEnabled(async () => {
      const h = makeReviewHarness('standard');
      await expect(
        h.service.resolveConflict(reviewerContext, CANDIDATE, 'supersede_existing'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.decideLearningSignalCandidate).not.toHaveBeenCalled();
    });
  });

  test('refuses an unrecognized decision string before touching the workflow', async () => {
    await reviewEnabled(async () => {
      const h = makeReviewHarness('learning_signal_conflict');
      await expect(
        h.service.resolveConflict(reviewerContext, CANDIDATE, 'maybe' as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(h.assertAssignedForDecision).not.toHaveBeenCalled();
    });
  });
});
