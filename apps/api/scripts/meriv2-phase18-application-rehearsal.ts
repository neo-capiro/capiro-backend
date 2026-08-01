#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../src/memory/memory-authorization.service.js';
import { MemoryTransitionAuditService } from '../src/memory/memory-transition-audit.service.js';
import { ExactMemoryCleanupOutboxService, exactProjectionIdempotencyKey } from '../src/memory/exact-memory-cleanup-outbox.service.js';
import { MemoryCandidateService } from '../src/memory/memory-candidate.service.js';
import { ImmutableMemoryVersionService } from '../src/memory/immutable-memory-version.service.js';
import { MemoryConflictService } from '../src/memory/memory-conflict.service.js';
import { MemoryStoreService } from '../src/memory/memory-store.service.js';
import { ExactMemoryProjectionWorkerService } from '../src/memory/exact-memory-projection-worker.service.js';
import type {
  StrictMemoryProjectorService,
  StrictProjectionExpectation,
  StrictProjectionReceipt,
} from '../src/memory/strict-memory-projector.service.js';
import type { MemoryIngestService } from '../src/memory/memory-ingest.service.js';
import type { TenantContextStore } from '../src/tenant/tenant-context.store.js';
import { ContextCompilerService } from '../src/context/context-compiler.service.js';

const TENANT_A = '18180000-0000-4000-8000-000000000001';
const TENANT_B = '18180000-0000-4000-8000-000000000002';
const PROPOSER = '18180000-0000-4000-8000-000000000011';
const REVIEWER_A = '18180000-0000-4000-8000-000000000012';
const REVIEWER_B = '18180000-0000-4000-8000-000000000013';
const OUTSIDER = '18180000-0000-4000-8000-000000000014';
const CLIENT_A = '18180000-0000-4000-8000-000000000021';
const IMPERSONATION = '18180000-0000-4000-8000-000000000031';

const ctx = (userId: string, role: TenantContext['role'], tenantId = TENANT_A): TenantContext => ({
  tenantId,
  userId,
  clerkUserId: `phase18_${userId}`,
  role,
});

const proposerCtx = ctx(PROPOSER, 'standard_user');
const reviewerACtx = ctx(REVIEWER_A, 'user_admin');
const reviewerBCtx = ctx(REVIEWER_B, 'user_admin');
const outsiderCtx = ctx(OUTSIDER, 'standard_user');

function assertOneFulfilled<T>(settled: PromiseSettledResult<T>[]): T {
  const fulfilled = settled.filter(
    (entry): entry is PromiseFulfilledResult<T> => entry.status === 'fulfilled',
  );
  const rejected = settled.filter(
    (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
  );
  assert.equal(fulfilled.length, 1, 'exactly one concurrent approval must succeed');
  assert.equal(rejected.length, 1, 'exactly one concurrent approval must lose the row lock race');
  return fulfilled[0]!.value;
}

async function seed(prisma: PrismaService): Promise<void> {
  await prisma.withSystem(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`);
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE id IN ('${PROPOSER}'::uuid, '${REVIEWER_A}'::uuid, '${REVIEWER_B}'::uuid, '${OUTSIDER}'::uuid)`);
    await tx.$executeRawUnsafe(`
      INSERT INTO users (id, clerk_user_id, email)
      VALUES
        ('${PROPOSER}'::uuid, 'phase18-proposer', 'phase18-proposer@invalid.example'),
        ('${REVIEWER_A}'::uuid, 'phase18-reviewer-a', 'phase18-reviewer-a@invalid.example'),
        ('${REVIEWER_B}'::uuid, 'phase18-reviewer-b', 'phase18-reviewer-b@invalid.example'),
        ('${OUTSIDER}'::uuid, 'phase18-outsider', 'phase18-outsider@invalid.example')
    `);
    await tx.$executeRawUnsafe(`
      INSERT INTO tenants (id, slug, name, status, settings_jsonb)
      VALUES
        ('${TENANT_A}'::uuid, 'phase18-a', 'Phase 18 Tenant A', 'active',
         '{"clioFeatureFlags":{"meriv2.contextPacketV2":true,"meriv2.contextPacketV2.in-editor":true}}'::jsonb),
        ('${TENANT_B}'::uuid, 'phase18-b', 'Phase 18 Tenant B', 'active', '{}'::jsonb)
    `);
    await tx.$executeRawUnsafe(`
      INSERT INTO tenant_memberships (tenant_id, user_id, role, status)
      VALUES
        ('${TENANT_A}'::uuid, '${PROPOSER}'::uuid, 'standard_user', 'active'),
        ('${TENANT_A}'::uuid, '${REVIEWER_A}'::uuid, 'user_admin', 'active'),
        ('${TENANT_A}'::uuid, '${REVIEWER_B}'::uuid, 'user_admin', 'active'),
        ('${TENANT_A}'::uuid, '${OUTSIDER}'::uuid, 'standard_user', 'active'),
        ('${TENANT_B}'::uuid, '${OUTSIDER}'::uuid, 'standard_user', 'active')
    `);
    await tx.$executeRawUnsafe(`
      INSERT INTO clients (id, tenant_id, name, status, memory_wall)
      VALUES ('${CLIENT_A}'::uuid, '${TENANT_A}'::uuid, 'Phase 18 Walled Client', 'active', true)
    `);
  });
}

async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.withSystem(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ('${TENANT_A}'::uuid, '${TENANT_B}'::uuid)`);
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE id IN ('${PROPOSER}'::uuid, '${REVIEWER_A}'::uuid, '${REVIEWER_B}'::uuid, '${OUTSIDER}'::uuid)`);
  });
}

async function committedItemId(prisma: PrismaService, candidateId: string): Promise<string> {
  const rows = await prisma.withSystem((tx) =>
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT committed_memory_item_id::text AS id FROM memory_candidate WHERE id = $1::uuid`,
      candidateId,
    ),
  );
  assert.ok(rows[0]?.id, `candidate ${candidateId} must bind a canonical memory item`);
  return rows[0]!.id;
}

async function createApprovedFirmItem(
  candidates: MemoryCandidateService,
  prisma: PrismaService,
  suffix: string,
  type = 'playbook',
  slug = `phase18-${suffix}`,
): Promise<{ candidateId: string; itemId: string }> {
  const proposal = await candidates.proposeSaveMemory(
    TENANT_A,
    PROPOSER,
    {
      scope: 'firm',
      ownerUserId: null,
      key: `phase18:${suffix}`,
      value: `Phase 18 ${suffix} body`,
      source: 'phase18_rehearsal',
      canonicalItem: {
        type: type as never,
        slug,
        title: `Phase 18 ${suffix}`,
        sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body: `Phase 18 ${suffix} body` }],
      },
    },
    false,
    'phase18_rehearsal',
  );
  assert.equal(proposal.status, 'pending');
  await candidates.approve(TENANT_A, proposal.candidateId, REVIEWER_A, reviewerACtx);
  return { candidateId: proposal.candidateId, itemId: await committedItemId(prisma, proposal.candidateId) };
}

function successfulProjector(): StrictMemoryProjectorService {
  return {
    projectClioMemoryStrict: async (
      tenantId: string,
      clioMemoryId: string,
      expected?: StrictProjectionExpectation,
    ): Promise<StrictProjectionReceipt> => {
      if (!expected) throw new Error('phase18 expectation missing');
      return {
        outcome: 'projected',
        tenantId,
        clioMemoryId,
        sourceVersion: expected.sourceVersion,
        contentHash: expected.contentHash,
        idempotencyKey:
          expected.idempotencyKey ??
          exactProjectionIdempotencyKey(clioMemoryId, expected.sourceVersion, expected.contentHash),
        memoryItemId: expected.memoryItemId ?? null,
        embeddingRequired: false,
      };
    },
  } as StrictMemoryProjectorService;
}

async function insertExactJob(
  prisma: PrismaService,
  input: {
    id?: string;
    status?: string;
    attempts?: number;
    leaseExpired?: boolean;
    hash?: string;
  } = {},
): Promise<string> {
  const id = input.id ?? randomUUID();
  const clioId = randomUUID();
  const version = new Date('2026-07-31T22:00:00.000Z');
  const hash = input.hash ?? 'a'.repeat(64);
  const key = exactProjectionIdempotencyKey(clioId, version.toISOString(), hash);
  await prisma.withSystem((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO memory_cleanup_outbox
       (id, tenant_id, memory_item_id, clio_memory_id, operation, idempotency_key,
        status, attempts, next_attempt_at, expected_source_version, expected_content_hash,
        lease_owner, lease_expires_at, started_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, 'index_memory_item', $4,
        $5, $6, now() - interval '1 minute', $7::timestamptz, $8,
        CASE WHEN $5 = 'running' THEN 'phase18-stale' ELSE NULL END,
        CASE WHEN $9::boolean THEN now() - interval '1 minute' ELSE NULL END,
        CASE WHEN $5 = 'running' THEN now() - interval '2 minutes' ELSE NULL END)`,
      id,
      TENANT_A,
      clioId,
      key,
      input.status ?? 'pending',
      input.attempts ?? 0,
      version.toISOString(),
      hash,
      input.leaseExpired ?? false,
    ),
  );
  return id;
}

async function jobStatus(prisma: PrismaService, id: string): Promise<string> {
  const rows = await prisma.withSystem((tx) =>
    tx.$queryRawUnsafe<Array<{ status: string }>>(
      'SELECT status FROM memory_cleanup_outbox WHERE id = $1::uuid',
      id,
    ),
  );
  return rows[0]?.status ?? 'missing';
}

async function rehearseOutbox(prisma: PrismaService, cleanupOutbox: ExactMemoryCleanupOutboxService) {
  const pendingBefore = await prisma.withSystem((tx) =>
    tx.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM memory_cleanup_outbox
       WHERE tenant_id = $1::uuid AND status = 'pending'`,
      TENANT_A,
    ),
  );
  assert.ok(Number(pendingBefore[0]?.count ?? 0) > 0, 'failed request-time fast path must leave durable jobs');

  const exactSuccess = new ExactMemoryProjectionWorkerService(prisma, successfulProjector());
  const initial = await exactSuccess.drainPending(100, 30);
  assert.ok(initial.succeeded > 0, 'exact worker must complete candidate projection jobs');

  const retryId = await insertExactJob(prisma);
  const failing = new ExactMemoryProjectionWorkerService(prisma, {
    projectClioMemoryStrict: async () => {
      throw new Error('phase18_projector_failure');
    },
  } as StrictMemoryProjectorService);
  const failed = await failing.drainPending(1, 30);
  assert.equal(failed.failed, 1);
  assert.equal(await jobStatus(prisma, retryId), 'failed');
  await prisma.withSystem((tx) =>
    tx.$executeRawUnsafe(
      `UPDATE memory_cleanup_outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1::uuid`,
      retryId,
    ),
  );
  const retried = await exactSuccess.drainPending(1, 30);
  assert.equal(retried.succeeded, 1);
  assert.equal(await jobStatus(prisma, retryId), 'completed');

  const staleId = await insertExactJob(prisma, { status: 'running', attempts: 1, leaseExpired: true });
  const stale = await exactSuccess.drainPending(1, 30);
  assert.equal(stale.succeeded, 1);
  assert.equal(await jobStatus(prisma, staleId), 'completed');

  const deadId = await insertExactJob(prisma, { status: 'running', attempts: 8, leaseExpired: true });
  const dead = await exactSuccess.drainPending(1, 30);
  assert.ok(dead.deadLettered >= 1);
  assert.equal(await jobStatus(prisma, deadId), 'dead_letter');

  const mismatchId = await insertExactJob(prisma, { hash: 'b'.repeat(64) });
  const mismatch = new ExactMemoryProjectionWorkerService(prisma, {
    projectClioMemoryStrict: async (tenantId, clioMemoryId, expected) => ({
      outcome: 'projected',
      tenantId,
      clioMemoryId,
      sourceVersion: expected?.sourceVersion ?? null,
      contentHash: 'c'.repeat(64),
      idempotencyKey: expected?.idempotencyKey ?? null,
      memoryItemId: expected?.memoryItemId ?? null,
      embeddingRequired: false,
    }),
  } as StrictMemoryProjectorService);
  const mismatchResult = await mismatch.drainPending(1, 30);
  assert.equal(mismatchResult.failed, 1);
  assert.equal(await jobStatus(prisma, mismatchId), 'failed');

  const fastPathClio = randomUUID();
  const fastPathJob = randomUUID();
  await prisma.withSystem((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO memory_cleanup_outbox
       (id, tenant_id, memory_item_id, clio_memory_id, operation, idempotency_key, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'revoke_projections', $5, 'pending')`,
      fastPathJob,
      TENANT_A,
      randomUUID(),
      fastPathClio,
      `revoke_projections:${fastPathClio}`,
    ),
  );
  await cleanupOutbox.markIndexedOnFastPath(TENANT_A, fastPathClio, 'revoke_projections');
  assert.equal(await jobStatus(prisma, fastPathJob), 'completed');

  return { initial, failed, retried, stale, dead, mismatchResult };
}

async function main(): Promise<void> {
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';

  const prisma = new PrismaService();
  await prisma.$connect();
  let currentCtx: TenantContext = reviewerACtx;
  const tenantCtx = { require: () => currentCtx } as TenantContextStore;
  const authorization = new MemoryAuthorizationService(prisma);
  const transitions = new MemoryTransitionAuditService();
  const ingest = {
    projectClioMemory: async () => undefined,
    projectClioMemoryStrict: async () => undefined,
  } as unknown as MemoryIngestService;
  const cleanupOutbox = new ExactMemoryCleanupOutboxService(prisma, ingest);
  const config = { get: () => undefined } as unknown as ConfigService<Record<string, unknown>, true>;
  const candidates = new MemoryCandidateService(
    prisma,
    ingest,
    config as never,
    transitions,
    cleanupOutbox,
    authorization,
  );
  (candidates as unknown as { dispatchProjectionFastPath: () => void }).dispatchProjectionFastPath =
    () => undefined;

  try {
    await seed(prisma);

    const self = await candidates.proposeSaveMemory(
      TENANT_A,
      REVIEWER_A,
      {
        scope: 'firm',
        ownerUserId: null,
        key: 'phase18:self-review',
        value: 'Self review must fail',
        source: 'phase18_rehearsal',
      },
      true,
      'phase18_rehearsal',
    );
    await assert.rejects(
      candidates.approve(TENANT_A, self.candidateId, REVIEWER_A, reviewerACtx),
      /reviewer other than the proposer/i,
    );

    const firmProposal = await candidates.proposeSaveMemory(
      TENANT_A,
      PROPOSER,
      {
        scope: 'firm',
        ownerUserId: null,
        key: 'phase18:firm-soul',
        value: 'We are a government affairs firm.',
        source: 'phase18_rehearsal',
        canonicalItem: {
          type: 'firm-soul',
          slug: 'firm',
          title: 'Phase 18 Firm Soul',
          sections: [
            { key: 'who', heading: 'Who', owner: 'human', body: 'We are a government affairs firm.' },
          ],
        },
      },
      false,
      'phase18_rehearsal',
    );
    assert.equal(firmProposal.status, 'pending');
    const concurrent = await Promise.allSettled([
      candidates.approve(TENANT_A, firmProposal.candidateId, REVIEWER_A, reviewerACtx),
      candidates.approve(TENANT_A, firmProposal.candidateId, REVIEWER_B, reviewerBCtx),
    ]);
    assertOneFulfilled(concurrent);
    const firmItemId = await committedItemId(prisma, firmProposal.candidateId);

    const packet = await new ContextCompilerService(prisma).compile({
      tenantId: TENANT_A,
      effectiveTenantId: TENANT_A,
      userId: PROPOSER,
      surface: 'in-editor',
      layers: ['firm-identity'],
      traceId: 'phase18-context-persistence',
      ref: { rehearsal: 'phase18' },
    });
    assert.equal(packet.version, 2);
    assert.equal(packet.persisted, true);
    assert.ok(packet.packetId);
    const packetRows = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; packet_version: number }>>(
        'SELECT id::text AS id, packet_version FROM context_packet WHERE id = $1::uuid AND tenant_id = $2::uuid',
        packet.packetId,
        TENANT_A,
      ),
    );
    assert.equal(packetRows[0]?.id, packet.packetId);
    assert.equal(packetRows[0]?.packet_version, 2);

    const privateProposal = await candidates.proposeSaveMemory(
      TENANT_A,
      PROPOSER,
      {
        scope: 'user_private',
        ownerUserId: PROPOSER,
        key: 'phase18:private',
        value: 'Private owner-only preference',
        source: 'phase18_rehearsal',
        canonicalItem: {
          type: 'user-voice',
          slug: 'phase18-private',
          title: 'Phase 18 Private Memory',
          sections: [{ key: 'voice', heading: 'Voice', owner: 'human', body: 'Private owner-only preference' }],
        },
      },
      false,
      'phase18_rehearsal',
    );
    assert.equal(privateProposal.status, 'auto_committed');
    const privateItemId = await committedItemId(prisma, privateProposal.candidateId);
    await authorization.requireItem(proposerCtx, privateItemId, 'read');
    await assert.rejects(authorization.requireItem(outsiderCtx, privateItemId, 'read'));

    const clientProposal = await candidates.proposeSaveMemory(
      TENANT_A,
      PROPOSER,
      {
        scope: 'client',
        ownerUserId: null,
        clientId: CLIENT_A,
        key: 'phase18:walled-client',
        value: 'Walled client steering memory',
        source: 'phase18_rehearsal',
        canonicalItem: {
          type: 'client-soul',
          slug: 'phase18-walled-client',
          title: 'Phase 18 Walled Client',
          sections: [{ key: 'position', heading: 'Position', owner: 'human', body: 'Walled client steering memory' }],
        },
      },
      false,
      'phase18_rehearsal',
    );
    await assert.rejects(
      candidates.approve(TENANT_A, clientProposal.candidateId, REVIEWER_A, reviewerACtx),
      /ethical_wall/i,
    );
    await prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_memory_access (tenant_id, client_id, user_id, granted_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        TENANT_A,
        CLIENT_A,
        REVIEWER_A,
        REVIEWER_B,
      ),
    );
    await assert.rejects(
      candidates.approve(TENANT_A, clientProposal.candidateId, REVIEWER_A, reviewerACtx),
      /missing_grant/i,
    );
    await prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO memory_access_grant
         (tenant_id, client_id, user_id, permissions, status, granted_by_user_id, reason, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, ARRAY['review','approve','propose','edit','resolve_conflict'],
                 'active', $4::uuid, 'Phase 18 scoped reviewer rehearsal', now() + interval '1 day')`,
        TENANT_A,
        CLIENT_A,
        REVIEWER_A,
        REVIEWER_B,
      ),
    );
    await candidates.approve(TENANT_A, clientProposal.candidateId, REVIEWER_A, reviewerACtx);

    const versions = new ImmutableMemoryVersionService(
      prisma,
      tenantCtx,
      authorization,
      transitions,
      cleanupOutbox,
    );
    (versions as unknown as { embedAfterCommit: () => void }).embedAfterCommit = () => undefined;

    const correction = await versions.proposeCorrection(
      proposerCtx,
      firmItemId,
      'Corrected institutional statement for Phase 18.',
    );
    assert.equal(correction.status, 'pending_review');
    if (correction.status !== 'pending_review') throw new Error('expected correction candidate');
    const correctionDecision = await versions.approveCandidate(reviewerACtx, correction.candidateId);
    assert.equal(correctionDecision.outcome, 'activated');
    const correctedItemId = correctionDecision.memoryItemId!;

    const contradiction = await versions.proposeContradiction(
      proposerCtx,
      correctedItemId,
      'Contradictory institutional statement for Phase 18.',
    );
    assert.equal(contradiction.status, 'pending_review');
    if (contradiction.status !== 'pending_review') throw new Error('expected contradiction candidate');
    const conflictDecision = await versions.approveCandidate(reviewerACtx, contradiction.candidateId);
    assert.equal(conflictDecision.outcome, 'conflict');
    const conflictService = new MemoryConflictService(prisma, authorization, transitions);
    const resolution = await conflictService.resolve(
      reviewerACtx,
      correctedItemId,
      correctedItemId,
      'Phase 18 selects the reviewed controlling version.',
    );
    assert.ok(resolution.resolvedCount >= 1);

    const revokeFixture = await createApprovedFirmItem(candidates, prisma, 'revoke-restore');
    currentCtx = reviewerACtx;
    const store = new MemoryStoreService(
      prisma,
      tenantCtx,
      authorization,
      transitions,
      cleanupOutbox,
    );
    const revoked = await store.forgetMemory(revokeFixture.itemId, 'Phase 18 reversible revoke');
    assert.equal(revoked.found, true);
    const restore = await versions.proposeRestore(proposerCtx, revokeFixture.itemId);
    assert.equal(restore.status, 'pending_review');
    if (restore.status !== 'pending_review') throw new Error('expected restore candidate');
    const restored = await versions.approveCandidate(reviewerBCtx, restore.candidateId);
    assert.equal(restored.outcome, 'activated');
    assert.notEqual(restored.memoryItemId, revokeFixture.itemId);

    const heldFixture = await createApprovedFirmItem(candidates, prisma, 'legal-hold');
    await prisma.withSystem((tx) =>
      tx.$executeRawUnsafe('UPDATE memory_items SET legal_hold = true WHERE id = $1::uuid', heldFixture.itemId),
    );
    currentCtx = reviewerACtx;
    const held = await store.forgetMemory(heldFixture.itemId, 'must not revoke');
    assert.equal(held.blockedByLegalHold, true);

    await prisma.withTenantUser(TENANT_A, REVIEWER_A, async (tx) => {
      await transitions.record(tx, TENANT_A, {
        subject: { memoryItemId: firmItemId },
        actorUserId: REVIEWER_A,
        effectiveTenantId: TENANT_B,
        toStatus: 'superseded',
        reasonCode: 'superseded',
        reason: 'Phase 18 impersonation evidence rehearsal.',
        impersonationSessionId: IMPERSONATION,
        metadata: { rehearsal: 'phase18', contentIncluded: false },
      });
    });
    const impersonationRows = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM memory_transition_audit
         WHERE tenant_id = $1::uuid AND impersonation_session_id = $2::uuid
           AND effective_tenant_id = $3::uuid`,
        TENANT_A,
        IMPERSONATION,
        TENANT_B,
      ),
    );
    assert.equal(Number(impersonationRows[0]?.count ?? 0), 1);

    const outbox = await rehearseOutbox(prisma, cleanupOutbox);
    const counts = await prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          candidates: bigint;
          items: bigint;
          transitions: bigint;
          packets: bigint;
          outbox: bigint;
        }>
      >(
        `SELECT
           (SELECT count(*) FROM memory_candidate WHERE tenant_id = $1::uuid)::bigint AS candidates,
           (SELECT count(*) FROM memory_items WHERE tenant_id = $1::uuid)::bigint AS items,
           (SELECT count(*) FROM memory_transition_audit WHERE tenant_id = $1::uuid)::bigint AS transitions,
           (SELECT count(*) FROM context_packet WHERE tenant_id = $1::uuid)::bigint AS packets,
           (SELECT count(*) FROM memory_cleanup_outbox WHERE tenant_id = $1::uuid)::bigint AS outbox`,
        TENANT_A,
      ),
    );

    console.log(
      JSON.stringify({
        marker: 'MERIV2_PHASE18_APPLICATION_REHEARSAL_OK',
        tenantIsolation: true,
        independentApproval: true,
        concurrentApproval: true,
        privateOwnerIsolation: true,
        ethicalWallDenial: true,
        clientGrantApproval: true,
        correction: true,
        conflictAndResolution: true,
        revokeAndRestore: true,
        legalHold: true,
        impersonationEvidence: true,
        contextPacketV2Persistence: true,
        outbox,
        counts: Object.fromEntries(
          Object.entries(counts[0] ?? {}).map(([key, value]) => [key, Number(value)]),
        ),
      }),
    );
  } finally {
    await cleanup(prisma).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_PHASE18_APPLICATION_REHEARSAL_FAILED',
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
