#!/usr/bin/env tsx
/**
 * Reversible Memory Governance v2 backfill. PREPARE/DRY-RUN by default.
 *
 * Prepare a durable tenant-scoped snapshot without changing memory_items:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid>
 *
 * Execute only the exact prepared job after two explicit confirmations:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid> --execute --job-id <uuid> \
 *     --confirm-tenant <uuid> --confirm-job <uuid>
 *
 * Roll back only rows that still exactly match that job's expected post-state:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid> --rollback --job-id <uuid> \
 *     --confirm-tenant <uuid> --confirm-job <uuid>
 *
 * Execute and rollback never recompute classification. They consume the immutable
 * prepared snapshot. Later human changes are detected by exact governance-state
 * hashes and are skipped rather than overwritten.
 */
import { randomUUID } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  classifyLegacyMemory,
  type GovernedMemoryStatus,
  type MemoryAuthority,
  type MemoryClass,
} from '@capiro/meriv2-core';
import {
  MEMORY_GOVERNANCE_BACKFILL_CLASSIFIER_VERSION,
  governanceStateFromRow,
  governanceStatesEqual,
  hashBackfillPlan,
  hashGovernanceState,
  parseMemoryGovernanceBackfillArgs,
  type GovernanceState,
} from './lib/memory-governance-backfill';

dotenvConfig();

type Tx = Prisma.TransactionClient;

interface LegacyRow {
  id: string;
  tenantId: string;
  clientId: string | null;
  ownerUserId: string | null;
  type: string;
  visibility: string;
  slug: string;
  source: string;
  sourceRef: string | null;
  provenance: string;
  status: string;
  expiresAt: Date | null;
  legalHold: boolean;
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  sourceType: string;
  sourceId: string | null;
  reviewDueAt: Date | null;
  reviewCadenceDays: number | null;
  lastConfirmedAt: Date | null;
  createdAt: Date;
}

interface ClassificationPlan {
  id: string;
  memoryClass: MemoryClass;
  memoryAuthority: MemoryAuthority;
  memoryScope: 'firm' | 'client' | 'user_private';
  governedStatus: GovernedMemoryStatus;
  sourceType: string;
  sourceId: string | null;
  reason: string;
  quarantined: boolean;
}

interface PreparedRow {
  memoryItemId: string;
  shouldUpdate: boolean;
  quarantined: boolean;
  reason: string;
  beforeState: GovernanceState;
  expectedPostState: GovernanceState;
  beforeHash: string;
  expectedPostHash: string;
}

interface StoredJob {
  id: string;
  tenantId: string;
  classifierVersion: string;
  status: string;
  planHash: string;
  rowCount: number;
  changeCount: number;
  quarantineCount: number;
}

interface StoredRow {
  memoryItemId: string;
  shouldUpdate: boolean;
  quarantined: boolean;
  reason: string;
  beforeState: unknown;
  expectedPostState: unknown;
  beforeHash: string;
  expectedPostHash: string;
  applyStatus: string;
  rollbackStatus: string;
}

function sourceTypeFor(row: LegacyRow): string {
  if (row.type === 'playbook' || row.type.startsWith('firm-')) return 'firm_playbook';
  if (row.type.startsWith('client-')) return 'client_record';
  if (row.type.startsWith('user-')) return 'user_message';
  if (row.slug.startsWith('clio:')) return 'legacy_projection';
  if (row.source === 'meeting') return 'confirmed_meeting_outcome';
  if (row.source === 'crm' || row.source === 'client') return 'crm_record';
  return 'unknown';
}

function scopeFor(row: LegacyRow): 'firm' | 'client' | 'user_private' {
  if (row.clientId) return 'client';
  if (row.visibility === 'user' || row.ownerUserId) return 'user_private';
  return 'firm';
}

function buildPlan(row: LegacyRow, duplicateIds: Set<string>): ClassificationPlan {
  const classified = classifyLegacyMemory({
    type: row.type,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    clientId: row.clientId,
    provenance: row.provenance,
    source: row.source,
    slug: row.slug,
    expiresAt: row.expiresAt,
    legalHold: row.legalHold,
  });
  const duplicate = duplicateIds.has(row.id);
  const sourceType = sourceTypeFor(row);
  const missingSource = sourceType === 'unknown' && !row.sourceRef;
  const memoryScope = scopeFor(row);
  const classScopeMismatch =
    (classified.memoryClass === 'institutional_authoritative' && memoryScope !== 'firm') ||
    (classified.memoryClass === 'client_steering' && memoryScope !== 'client') ||
    (['user_preference', 'episodic_working'].includes(classified.memoryClass) &&
      memoryScope !== 'user_private');
  const quarantined =
    classified.confidence === 'ambiguous' || duplicate || missingSource || classScopeMismatch;
  return {
    id: row.id,
    memoryClass: quarantined ? 'legacy_unclassified' : classified.memoryClass,
    memoryAuthority: quarantined ? 'legacy_unclassified' : classified.authority,
    memoryScope,
    governedStatus: quarantined ? 'pending_review' : classified.status,
    sourceType,
    sourceId: row.sourceRef,
    reason: [
      classified.reason,
      ...(duplicate ? ['Duplicate client-scope identity requires human resolution.'] : []),
      ...(missingSource ? ['Source identity is missing or unknown.'] : []),
      ...(classScopeMismatch ? ['Class and scope do not align.'] : []),
    ].join(' '),
    quarantined,
  };
}

function expectedStateFor(row: LegacyRow, plan: ClassificationPlan): GovernanceState {
  const before = governanceStateFromRow(row);
  if (row.memoryClass !== 'legacy_unclassified') return before;
  let reviewDueAt = before.reviewDueAt;
  if (row.reviewCadenceDays !== null) {
    const base = row.lastConfirmedAt ?? row.createdAt;
    reviewDueAt = new Date(
      base.getTime() + row.reviewCadenceDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  return {
    memoryClass: plan.memoryClass,
    memoryAuthority: plan.memoryAuthority,
    memoryScope: plan.memoryScope,
    governedStatus: plan.governedStatus,
    sourceType: before.sourceType === 'unknown' ? plan.sourceType : before.sourceType,
    sourceId: before.sourceId ?? plan.sourceId,
    reviewDueAt,
  };
}

function preparedRowFor(row: LegacyRow, plan: ClassificationPlan): PreparedRow {
  const beforeState = governanceStateFromRow(row);
  const expectedPostState = expectedStateFor(row, plan);
  const shouldUpdate =
    row.memoryClass === 'legacy_unclassified' &&
    !governanceStatesEqual(beforeState, expectedPostState);
  return {
    memoryItemId: row.id,
    shouldUpdate,
    quarantined: plan.quarantined,
    reason: plan.reason.slice(0, 2000),
    beforeState,
    expectedPostState,
    beforeHash: hashGovernanceState(beforeState),
    expectedPostHash: hashGovernanceState(expectedPostState),
  };
}

function asGovernanceState(value: unknown): GovernanceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('backfill snapshot contains an invalid governance state');
  }
  const row = value as Record<string, unknown>;
  const required = [
    'memoryClass',
    'memoryAuthority',
    'memoryScope',
    'governedStatus',
    'sourceType',
  ];
  for (const key of required) {
    if (typeof row[key] !== 'string') {
      throw new Error(`backfill snapshot is missing ${key}`);
    }
  }
  if (row.sourceId !== null && typeof row.sourceId !== 'string') {
    throw new Error('backfill snapshot has invalid sourceId');
  }
  if (row.reviewDueAt !== null && typeof row.reviewDueAt !== 'string') {
    throw new Error('backfill snapshot has invalid reviewDueAt');
  }
  return {
    memoryClass: row.memoryClass as string,
    memoryAuthority: row.memoryAuthority as string,
    memoryScope: row.memoryScope as string,
    governedStatus: row.governedStatus as string,
    sourceType: row.sourceType as string,
    sourceId: row.sourceId as string | null,
    reviewDueAt: row.reviewDueAt as string | null,
  };
}

async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
}

async function requireMigration(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ governanceColumns: boolean; jobTable: boolean; rowTable: boolean; eventTable: boolean }>
  >(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memory_items'
        AND column_name = 'memory_class'
    ) AS "governanceColumns",
    to_regclass('public.memory_governance_backfill_job') IS NOT NULL AS "jobTable",
    to_regclass('public.memory_governance_backfill_row') IS NOT NULL AS "rowTable",
    to_regclass('public.memory_governance_backfill_event') IS NOT NULL AS "eventTable"
  `);
  const state = rows[0];
  if (
    !state?.governanceColumns ||
    !state.jobTable ||
    !state.rowTable ||
    !state.eventTable
  ) {
    throw new Error(
      'Phase 11 governance backfill migrations are not applied; no operation was performed',
    );
  }
}

async function selectLegacyRows(tx: Tx, tenantId: string, lock: 'share' | 'update') {
  const lockSql = lock === 'update' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
  return tx.$queryRaw<LegacyRow[]>(Prisma.sql`
    SELECT id::text AS id,
           tenant_id::text AS "tenantId",
           client_id::text AS "clientId",
           owner_user_id::text AS "ownerUserId",
           type, visibility, slug, source, source_ref AS "sourceRef", provenance,
           status, expires_at AS "expiresAt", legal_hold AS "legalHold",
           memory_class AS "memoryClass",
           memory_authority AS "memoryAuthority",
           memory_scope AS "memoryScope",
           governed_status AS "governedStatus",
           source_type AS "sourceType",
           source_id AS "sourceId",
           review_due_at AS "reviewDueAt",
           review_cadence_days AS "reviewCadenceDays",
           last_confirmed_at AS "lastConfirmedAt",
           created_at AS "createdAt"
    FROM memory_items
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY id
    ${lockSql}
  `);
}

async function selectDuplicateIds(tx: Tx, tenantId: string): Promise<Set<string>> {
  const duplicateRows = await tx.$queryRaw<Array<{ ids: string[] }>>(Prisma.sql`
    SELECT array_agg(id::text ORDER BY created_at, id) AS ids
    FROM memory_items
    WHERE tenant_id = ${tenantId}::uuid AND client_id IS NOT NULL
    GROUP BY client_id, type, slug
    HAVING count(*) > 1
  `);
  return new Set(duplicateRows.flatMap((row) => row.ids));
}

async function insertEvent(
  tx: Tx,
  input: {
    tenantId: string;
    jobId: string;
    memoryItemId?: string | null;
    eventType: string;
    reasonCode: string;
    expectedHash?: string | null;
    observedHash?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const metadata = JSON.stringify(input.metadata ?? {});
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO memory_governance_backfill_event
      (tenant_id, job_id, memory_item_id, event_type, reason_code,
       expected_hash, observed_hash, metadata_jsonb)
    VALUES (
      ${input.tenantId}::uuid,
      ${input.jobId}::uuid,
      ${input.memoryItemId ?? null}::uuid,
      ${input.eventType},
      ${input.reasonCode},
      ${input.expectedHash ?? null},
      ${input.observedHash ?? null},
      CAST(${metadata} AS jsonb)
    )
  `);
}

async function prepareJob(prisma: PrismaClient, tenantId: string) {
  const jobId = randomUUID();
  return prisma.$transaction(async (tx) => {
    await setTenant(tx, tenantId);
    const rows = await selectLegacyRows(tx, tenantId, 'share');
    const duplicateIds = await selectDuplicateIds(tx, tenantId);
    const preparedRows = rows.map((row) => preparedRowFor(row, buildPlan(row, duplicateIds)));
    const planHash = hashBackfillPlan(
      preparedRows.map((row) => ({
        memoryItemId: row.memoryItemId,
        shouldUpdate: row.shouldUpdate,
        quarantined: row.quarantined,
        reason: row.reason,
        beforeHash: row.beforeHash,
        expectedPostHash: row.expectedPostHash,
      })),
    );
    const changeCount = preparedRows.filter((row) => row.shouldUpdate).length;
    const quarantineCount = preparedRows.filter((row) => row.quarantined).length;
    const metadata = JSON.stringify({
      dryRun: true,
      canonicalRowsMutated: 0,
      snapshotFields: [
        'memoryClass',
        'memoryAuthority',
        'memoryScope',
        'governedStatus',
        'sourceType',
        'sourceId',
        'reviewDueAt',
      ],
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO memory_governance_backfill_job
        (id, tenant_id, classifier_version, status, plan_hash,
         row_count, change_count, quarantine_count, metadata_jsonb)
      VALUES (
        ${jobId}::uuid,
        ${tenantId}::uuid,
        ${MEMORY_GOVERNANCE_BACKFILL_CLASSIFIER_VERSION},
        'prepared',
        ${planHash},
        ${preparedRows.length},
        ${changeCount},
        ${quarantineCount},
        CAST(${metadata} AS jsonb)
      )
    `);
    for (const row of preparedRows) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO memory_governance_backfill_row
          (job_id, tenant_id, memory_item_id, should_update, quarantined, reason,
           before_state_jsonb, expected_post_state_jsonb, before_hash,
           expected_post_hash, apply_status, rollback_status)
        VALUES (
          ${jobId}::uuid,
          ${tenantId}::uuid,
          ${row.memoryItemId}::uuid,
          ${row.shouldUpdate},
          ${row.quarantined},
          ${row.reason},
          CAST(${JSON.stringify(row.beforeState)} AS jsonb),
          CAST(${JSON.stringify(row.expectedPostState)} AS jsonb),
          ${row.beforeHash},
          ${row.expectedPostHash},
          ${row.shouldUpdate ? 'planned' : 'not_needed'},
          ${row.shouldUpdate ? 'pending' : 'not_applied'}
        )
      `);
    }
    await insertEvent(tx, {
      tenantId,
      jobId,
      eventType: 'prepared',
      reasonCode: 'dry_run_snapshot_created',
      expectedHash: planHash,
      metadata: {
        rowCount: preparedRows.length,
        changeCount,
        quarantineCount,
        canonicalRowsMutated: 0,
      },
    });
    return {
      ok: true,
      job: 'backfill-memory-governance-v2',
      mode: 'prepare',
      tenantId,
      jobId,
      classifierVersion: MEMORY_GOVERNANCE_BACKFILL_CLASSIFIER_VERSION,
      status: 'prepared',
      planHash,
      totalRows: preparedRows.length,
      wouldUpdate: changeCount,
      quarantineCount,
      canonicalRowsMutated: 0,
      nextCommand: {
        action: 'execute',
        required: ['--execute', '--job-id', '--confirm-tenant', '--confirm-job'],
      },
      productionExecutedByThisTask: false,
    };
  });
}

async function lockJob(tx: Tx, tenantId: string, jobId: string): Promise<StoredJob> {
  const jobs = await tx.$queryRaw<StoredJob[]>(Prisma.sql`
    SELECT id::text AS id,
           tenant_id::text AS "tenantId",
           classifier_version AS "classifierVersion",
           status,
           plan_hash AS "planHash",
           row_count AS "rowCount",
           change_count AS "changeCount",
           quarantine_count AS "quarantineCount"
    FROM memory_governance_backfill_job
    WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid
    FOR UPDATE
  `);
  const job = jobs[0];
  if (!job) throw new Error('backfill job was not found for the confirmed tenant');
  return job;
}

async function selectStoredRows(tx: Tx, tenantId: string, jobId: string) {
  return tx.$queryRaw<StoredRow[]>(Prisma.sql`
    SELECT memory_item_id::text AS "memoryItemId",
           should_update AS "shouldUpdate",
           quarantined,
           reason,
           before_state_jsonb AS "beforeState",
           expected_post_state_jsonb AS "expectedPostState",
           before_hash AS "beforeHash",
           expected_post_hash AS "expectedPostHash",
           apply_status AS "applyStatus",
           rollback_status AS "rollbackStatus"
    FROM memory_governance_backfill_row
    WHERE tenant_id = ${tenantId}::uuid AND job_id = ${jobId}::uuid
    ORDER BY memory_item_id
  `);
}

async function selectJobMemoryRows(tx: Tx, tenantId: string, jobId: string) {
  return tx.$queryRaw<LegacyRow[]>(Prisma.sql`
    SELECT m.id::text AS id,
           m.tenant_id::text AS "tenantId",
           m.client_id::text AS "clientId",
           m.owner_user_id::text AS "ownerUserId",
           m.type, m.visibility, m.slug, m.source, m.source_ref AS "sourceRef", m.provenance,
           m.status, m.expires_at AS "expiresAt", m.legal_hold AS "legalHold",
           m.memory_class AS "memoryClass",
           m.memory_authority AS "memoryAuthority",
           m.memory_scope AS "memoryScope",
           m.governed_status AS "governedStatus",
           m.source_type AS "sourceType",
           m.source_id AS "sourceId",
           m.review_due_at AS "reviewDueAt",
           m.review_cadence_days AS "reviewCadenceDays",
           m.last_confirmed_at AS "lastConfirmedAt",
           m.created_at AS "createdAt"
    FROM memory_items m
    WHERE m.tenant_id = ${tenantId}::uuid
      AND EXISTS (
        SELECT 1 FROM memory_governance_backfill_row r
        WHERE r.tenant_id = ${tenantId}::uuid
          AND r.job_id = ${jobId}::uuid
          AND r.memory_item_id = m.id
      )
    ORDER BY m.id
    FOR UPDATE
  `);
}

async function applyGovernanceState(
  tx: Tx,
  tenantId: string,
  memoryItemId: string,
  state: GovernanceState,
): Promise<void> {
  const reviewDueAt = state.reviewDueAt ? new Date(state.reviewDueAt) : null;
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE memory_items
    SET memory_class = ${state.memoryClass},
        memory_authority = ${state.memoryAuthority},
        memory_scope = ${state.memoryScope},
        governed_status = ${state.governedStatus},
        source_type = ${state.sourceType},
        source_id = ${state.sourceId},
        review_due_at = ${reviewDueAt}
    WHERE tenant_id = ${tenantId}::uuid AND id = ${memoryItemId}::uuid
  `);
  if (updated !== 1) throw new Error(`memory item ${memoryItemId} changed or disappeared`);
}

async function writeTransitionAudit(
  tx: Tx,
  input: {
    tenantId: string;
    jobId: string;
    memoryItemId: string;
    fromState: GovernanceState;
    toState: GovernanceState;
    reasonCode: string;
    reason: string;
    expectedHash: string;
    observedHash: string;
  },
): Promise<void> {
  const metadata = JSON.stringify({
    backfillJobId: input.jobId,
    classifierVersion: MEMORY_GOVERNANCE_BACKFILL_CLASSIFIER_VERSION,
    expectedHash: input.expectedHash,
    observedHash: input.observedHash,
  });
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO memory_transition_audit
      (tenant_id, memory_item_id, effective_tenant_id, client_id,
       from_status, to_status, reason_code, reason, source_type, source_id,
       metadata_jsonb)
    SELECT tenant_id, id, tenant_id, client_id,
           ${input.fromState.governedStatus},
           ${input.toState.governedStatus},
           ${input.reasonCode},
           ${input.reason.slice(0, 2000)},
           ${input.toState.sourceType},
           ${input.toState.sourceId},
           CAST(${metadata} AS jsonb)
    FROM memory_items
    WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.memoryItemId}::uuid
  `);
}

async function executeJob(prisma: PrismaClient, tenantId: string, jobId: string) {
  return prisma.$transaction(async (tx) => {
    await setTenant(tx, tenantId);
    const job = await lockJob(tx, tenantId, jobId);
    if (job.status === 'executed') {
      return {
        ok: true,
        job: 'backfill-memory-governance-v2',
        mode: 'execute',
        tenantId,
        jobId,
        status: 'executed',
        idempotent: true,
        productionExecutedByThisTask: false,
      };
    }
    if (job.status !== 'prepared') {
      throw new Error(`backfill job cannot execute from terminal status ${job.status}`);
    }
    const storedRows = await selectStoredRows(tx, tenantId, jobId);
    if (storedRows.length !== job.rowCount) {
      throw new Error('backfill job snapshot row count does not match its immutable header');
    }
    await insertEvent(tx, {
      tenantId,
      jobId,
      eventType: 'execute_started',
      reasonCode: 'explicit_job_confirmation_accepted',
      expectedHash: job.planHash,
      metadata: { changeCount: job.changeCount },
    });
    const currentRows = await selectJobMemoryRows(tx, tenantId, jobId);
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const drifts: Array<{ row: StoredRow; observedHash: string }> = [];
    for (const row of storedRows.filter((candidate) => candidate.shouldUpdate)) {
      const current = currentById.get(row.memoryItemId);
      const observedHash = current
        ? hashGovernanceState(governanceStateFromRow(current))
        : 'missing';
      if (observedHash !== row.beforeHash) drifts.push({ row, observedHash });
    }
    if (drifts.length) {
      for (const drift of drifts) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE memory_governance_backfill_row
          SET apply_status = 'blocked_drift',
              rollback_status = 'not_applied',
              updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid
            AND job_id = ${jobId}::uuid
            AND memory_item_id = ${drift.row.memoryItemId}::uuid
        `);
        await insertEvent(tx, {
          tenantId,
          jobId,
          memoryItemId: drift.row.memoryItemId,
          eventType: 'execute_blocked_drift',
          reasonCode: 'before_state_changed_after_prepare',
          expectedHash: drift.row.beforeHash,
          observedHash: drift.observedHash,
        });
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE memory_governance_backfill_job
        SET status = 'execute_blocked_drift', updated_at = now(),
            metadata_jsonb = metadata_jsonb || CAST(${JSON.stringify({ driftCount: drifts.length })} AS jsonb)
        WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid
      `);
      return {
        ok: false,
        job: 'backfill-memory-governance-v2',
        mode: 'execute',
        tenantId,
        jobId,
        status: 'execute_blocked_drift',
        driftCount: drifts.length,
        mutatedRows: 0,
        productionExecutedByThisTask: false,
      };
    }

    let applied = 0;
    for (const row of storedRows) {
      if (!row.shouldUpdate) continue;
      const beforeState = asGovernanceState(row.beforeState);
      const expectedPostState = asGovernanceState(row.expectedPostState);
      await applyGovernanceState(tx, tenantId, row.memoryItemId, expectedPostState);
      await writeTransitionAudit(tx, {
        tenantId,
        jobId,
        memoryItemId: row.memoryItemId,
        fromState: beforeState,
        toState: expectedPostState,
        reasonCode: row.quarantined ? 'backfill_quarantined' : 'backfill_classified',
        reason: row.reason,
        expectedHash: row.expectedPostHash,
        observedHash: row.beforeHash,
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE memory_governance_backfill_row
        SET apply_status = 'applied', applied_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid
          AND job_id = ${jobId}::uuid
          AND memory_item_id = ${row.memoryItemId}::uuid
      `);
      await insertEvent(tx, {
        tenantId,
        jobId,
        memoryItemId: row.memoryItemId,
        eventType: 'row_applied',
        reasonCode: row.quarantined ? 'backfill_quarantined' : 'backfill_classified',
        expectedHash: row.expectedPostHash,
        observedHash: row.beforeHash,
      });
      applied += 1;
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE memory_governance_backfill_job
      SET status = 'executed', executed_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid
    `);
    await insertEvent(tx, {
      tenantId,
      jobId,
      eventType: 'execute_completed',
      reasonCode: 'exact_prepared_snapshot_applied',
      expectedHash: job.planHash,
      metadata: { applied, notNeeded: job.rowCount - job.changeCount },
    });
    return {
      ok: true,
      job: 'backfill-memory-governance-v2',
      mode: 'execute',
      tenantId,
      jobId,
      status: 'executed',
      planHash: job.planHash,
      applied,
      notNeeded: job.rowCount - job.changeCount,
      productionExecutedByThisTask: false,
    };
  });
}

async function rollbackJob(prisma: PrismaClient, tenantId: string, jobId: string) {
  return prisma.$transaction(async (tx) => {
    await setTenant(tx, tenantId);
    const job = await lockJob(tx, tenantId, jobId);
    if (job.status === 'rolled_back' || job.status === 'rollback_partial') {
      return {
        ok: true,
        job: 'backfill-memory-governance-v2',
        mode: 'rollback',
        tenantId,
        jobId,
        status: job.status,
        idempotent: true,
        terminal: true,
        productionExecutedByThisTask: false,
      };
    }
    if (job.status !== 'executed') {
      throw new Error(`backfill job cannot roll back from status ${job.status}`);
    }
    const storedRows = (await selectStoredRows(tx, tenantId, jobId)).filter(
      (row) => row.applyStatus === 'applied',
    );
    await insertEvent(tx, {
      tenantId,
      jobId,
      eventType: 'rollback_started',
      reasonCode: 'explicit_job_confirmation_accepted',
      expectedHash: job.planHash,
      metadata: { appliedRows: storedRows.length },
    });
    const currentRows = await selectJobMemoryRows(tx, tenantId, jobId);
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    let restored = 0;
    let skippedDrift = 0;
    for (const row of storedRows) {
      const current = currentById.get(row.memoryItemId);
      const observedHash = current
        ? hashGovernanceState(governanceStateFromRow(current))
        : 'missing';
      if (observedHash !== row.expectedPostHash) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE memory_governance_backfill_row
          SET rollback_status = 'skipped_drift',
              rollback_checked_at = now(),
              rollback_observed_hash = ${observedHash},
              updated_at = now()
          WHERE tenant_id = ${tenantId}::uuid
            AND job_id = ${jobId}::uuid
            AND memory_item_id = ${row.memoryItemId}::uuid
        `);
        await insertEvent(tx, {
          tenantId,
          jobId,
          memoryItemId: row.memoryItemId,
          eventType: 'row_skipped_drift',
          reasonCode: current
            ? 'post_state_changed_after_execute'
            : 'memory_item_missing_after_execute',
          expectedHash: row.expectedPostHash,
          observedHash,
        });
        skippedDrift += 1;
        continue;
      }
      const beforeState = asGovernanceState(row.beforeState);
      const expectedPostState = asGovernanceState(row.expectedPostState);
      await applyGovernanceState(tx, tenantId, row.memoryItemId, beforeState);
      await writeTransitionAudit(tx, {
        tenantId,
        jobId,
        memoryItemId: row.memoryItemId,
        fromState: expectedPostState,
        toState: beforeState,
        reasonCode: 'backfill_rollback_restored',
        reason: 'Restored the exact governance metadata captured before the confirmed backfill job.',
        expectedHash: row.beforeHash,
        observedHash,
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE memory_governance_backfill_row
        SET rollback_status = 'restored',
            rollback_checked_at = now(),
            rollback_observed_hash = ${observedHash},
            updated_at = now()
        WHERE tenant_id = ${tenantId}::uuid
          AND job_id = ${jobId}::uuid
          AND memory_item_id = ${row.memoryItemId}::uuid
      `);
      await insertEvent(tx, {
        tenantId,
        jobId,
        memoryItemId: row.memoryItemId,
        eventType: 'row_restored',
        reasonCode: 'expected_post_state_unchanged',
        expectedHash: row.expectedPostHash,
        observedHash,
      });
      restored += 1;
    }
    const status = skippedDrift === 0 ? 'rolled_back' : 'rollback_partial';
    await tx.$executeRaw(Prisma.sql`
      UPDATE memory_governance_backfill_job
      SET status = ${status}, rolled_back_at = now(), updated_at = now(),
          metadata_jsonb = metadata_jsonb || CAST(${JSON.stringify({ restored, skippedDrift })} AS jsonb)
      WHERE tenant_id = ${tenantId}::uuid AND id = ${jobId}::uuid
    `);
    await insertEvent(tx, {
      tenantId,
      jobId,
      eventType: 'rollback_completed',
      reasonCode:
        skippedDrift === 0
          ? 'all_unchanged_rows_restored'
          : 'later_changes_preserved',
      expectedHash: job.planHash,
      metadata: { restored, skippedDrift, status },
    });
    return {
      ok: true,
      job: 'backfill-memory-governance-v2',
      mode: 'rollback',
      tenantId,
      jobId,
      status,
      restored,
      skippedDrift,
      laterHumanChangesOverwritten: 0,
      productionExecutedByThisTask: false,
    };
  });
}

async function main(): Promise<void> {
  const args = parseMemoryGovernanceBackfillArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await requireMigration(prisma);
    const result =
      args.action === 'prepare'
        ? await prepareJob(prisma, args.tenantId)
        : args.action === 'execute'
          ? await executeJob(prisma, args.tenantId, args.jobId!)
          : await rollbackJob(prisma, args.tenantId, args.jobId!);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ('ok' in result && result.ok === false) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      job: 'backfill-memory-governance-v2',
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
