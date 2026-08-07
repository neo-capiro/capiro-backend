/**
 * Phase 7 Workstream L — the outbox drainer against a real database.
 *
 * Invoked by `scripts/pe-budget-phase7-migration-rehearsal.sh` immediately
 * after the engine rehearsal, against the same disposable PostgreSQL container.
 * Never point this at a shared database.
 *
 * It runs after the engine rehearsal on purpose: that script leaves behind a
 * genuinely committed activation, two canonical rows, a suppressed hydration
 * outbox, and — because `rollback()` now pauses a drain that actually exists —
 * a paused scope. Rebuilding that state by hand would prove the fixture, not
 * the system.
 *
 * What this proves that a unit test cannot:
 *
 *   * `FOR UPDATE SKIP LOCKED` really partitions a backlog. Proved by holding
 *     rows locked in an uncommitted transaction on one connection and claiming
 *     from another under a statement timeout, so a claim that would have
 *     blocked fails instead of hanging.
 *   * the claim's eligibility SQL agrees with `isClaimableV1` row for row,
 *     across the whole attempt range and both sides of every boundary.
 *   * Workstream E's rollback pause is no longer a no-op, and a paused drain
 *     claims nothing.
 *   * a poison row survives its attempts, keeps its error, and holds its run
 *     out of COMPLETED.
 *   * a row abandoned by a dead drainer is recoverable rather than stranded.
 *   * the before/after money columns are filled from the two snapshots, exactly,
 *     with NUMERIC scale padding normalized away.
 *   * a delta is append-only and the stage-authority check refuses a
 *     congressional field with no authority naming it.
 */
import { PrismaClient } from '@prisma/client';
import { Client as PgClient } from 'pg';
import {
  drainPromotionOutboxBatchV1,
  isClaimableV1,
  type OutboxRowStatusV1,
} from '../src/defense-budget/promotion/promotion-outbox-drain-v1.js';
import {
  createOutboxDrainRepositoryPrismaV1,
  outboxClaimSqlV1,
  type OutboxDrainPrismaLikeV1,
} from '../src/defense-budget/promotion/promotion-outbox-drain-repository-prisma-v1.js';
import { createCanonicalDeltaHandlerV1 } from '../src/defense-budget/promotion/canonical-delta-engine-v1.js';
import {
  createCanonicalDeltaWriterPrismaV1,
  createCanonicalRowLookupPrismaV1,
} from '../src/defense-budget/promotion/canonical-delta-repository-prisma-v1.js';
import {
  isDrainPausedV1,
  resumeDrainV1,
} from '../src/defense-budget/promotion/side-effect-drain-pause-prisma-v1.js';

const ADMIN_URL = required('ADMIN_DATABASE_URL');
const PROMOTER_URL = required('PROMOTER_DATABASE_URL');

/** The environment the engine rehearsal committed into. */
const ENVIRONMENT = 'engine';
const DOMAIN = 'defense_budget';
const ENGINE_SNAPSHOT_ID = '99999999-9999-9999-9999-999999999999';
/** Two staging snapshots of this script's own, so a change can have both sides. */
const OLD_SNAPSHOT_ID = '88888888-8888-8888-8888-888888888801';
const NEW_SNAPSHOT_ID = '88888888-8888-8888-8888-888888888802';
const SHA = (c: string) => c.repeat(64);
/** Short enough that the rehearsal can age a row past it without sleeping. */
const LEASE_MS = 1_000;

let passed = 0;
function ok(message: string): void {
  passed += 1;
  console.log(`[p7-drain]   ok  ${message}`);
}
function fail(message: string): never {
  console.error(`[p7-drain] FAILED: ${message}`);
  process.exit(1);
}
function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  ok(message);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const okHandler = { publish: async () => undefined };
const failHandler = (message: string) => ({
  publish: async () => {
    throw new Error(message);
  },
});

async function main(): Promise<void> {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const promoter = new PrismaClient({ datasources: { db: { url: PROMOTER_URL } } });

  try {
    const prisma = promoter as unknown as OutboxDrainPrismaLikeV1;
    const repository = createOutboxDrainRepositoryPrismaV1(prisma, { processingLeaseMs: LEASE_MS });
    const deltaHandler = createCanonicalDeltaHandlerV1(
      createCanonicalRowLookupPrismaV1(prisma),
      createCanonicalDeltaWriterPrismaV1(prisma),
    );

    /* =================================================================== */
    /* 1. The rollback pause is real                                       */
    /* =================================================================== */
    //
    // The engine rehearsal ends with a rollback. Until Workstream L, the
    // repository's pauseSideEffectDrain was an honest no-op, so this row could
    // not exist. Its presence is the proof that the port is now wired.
    const pauseRows = await admin.$queryRawUnsafe<{ paused: boolean; reason: string }[]>(
      `SELECT paused, reason FROM defense_budget_side_effect_drain_pause
        WHERE domain = $1 AND environment = $2`,
      DOMAIN,
      ENVIRONMENT,
    );
    check(pauseRows.length === 1, 'the engine rollback wrote a pause row');
    check(pauseRows[0]?.paused === true, 'the scope is paused');
    check(
      (pauseRows[0]?.reason ?? '').includes('rollback'),
      `the pause says why: ${pauseRows[0]?.reason}`,
    );

    const pendingBefore = await countByStatus(admin, ENVIRONMENT);
    check(
      (pendingBefore.PENDING ?? 0) >= 3,
      `hydration and rollback rows are waiting (${JSON.stringify(pendingBefore)})`,
    );

    /* =================================================================== */
    /* 2. A paused drain claims nothing                                    */
    /* =================================================================== */
    const pausedResult = await drainPromotionOutboxBatchV1(
      { domain: DOMAIN, environment: ENVIRONMENT, now: new Date() },
      repository,
      okHandler,
    );
    check(pausedResult.paused, 'the drain reports itself paused');
    check(pausedResult.claimed === 0, 'a paused drain claimed nothing');

    // And the claim statement refuses independently of the policy check, so the
    // window between the two round trips is closed too.
    const claimedWhilePaused = await promoter.$queryRawUnsafe<{ id: string }[]>(
      outboxClaimSqlV1({ processingLeaseMs: LEASE_MS }),
      DOMAIN,
      ENVIRONMENT,
      new Date().toISOString(),
      100,
    );
    check(claimedWhilePaused.length === 0, 'the claim statement itself honours the pause');

    /* =================================================================== */
    /* 3. Resume                                                           */
    /* =================================================================== */
    const resumed = await resumeDrainV1(promoter.defenseBudgetSideEffectDrainPause, {
      domain: DOMAIN,
      environment: ENVIRONMENT,
      resumedBy: 'rehearsal:operator',
    });
    check(resumed.resumed, 'the promoter role can resume the drain');
    check(
      !(await isDrainPausedV1(promoter.defenseBudgetSideEffectDrainPause, DOMAIN, ENVIRONMENT)),
      'the scope reads as running again',
    );

    /* =================================================================== */
    /* 4. A change with both sides                                         */
    /* =================================================================== */
    const activationId = await scalar(
      admin,
      `SELECT id::text FROM defense_budget_promotion_activation
        WHERE environment = $1 AND activation_kind = 'PROMOTION' LIMIT 1`,
      ENVIRONMENT,
    );
    const runId = await scalar(
      admin,
      `SELECT run_id::text FROM defense_budget_promotion_activation WHERE id = $1::uuid`,
      activationId,
    );

    // Two staging snapshots holding the same natural key at different values.
    // Inserted as the table owner, which the canonical-row boundary trigger
    // permits alongside the promoter; the snapshots stay STAGING so the rows are
    // writable at all.
    for (const [id, key] of [
      [OLD_SNAPSHOT_ID, 'snap-drain-old'],
      [NEW_SNAPSHOT_ID, 'snap-drain-new'],
    ]) {
      await admin.$executeRawUnsafe(`
        INSERT INTO defense_budget_canonical_snapshot
          (id, snapshot_key, environment, cycle_id, fiscal_year, status,
           required_scopes, completed_scopes, mapping_registry_hash)
        VALUES ('${id}', '${key}', '${ENVIRONMENT}', 'cycle-fy2027', 2027, 'STAGING',
                '[]'::jsonb, '[]'::jsonb, '${SHA('a')}')
        ON CONFLICT DO NOTHING`);
    }

    const NATURAL_KEY = 'ARMY|OMA|SAG-DRAIN|2027|hascMark';
    // 1.25 and 2.5 are stored into NUMERIC(24,9) and come back padded to
    // 1.250000000. If the adapter did not normalize, the delta would compare
    // padded against canonical and report a change on an unchanged row.
    await insertCanonicalRow(admin, OLD_SNAPSHOT_ID, runId, NATURAL_KEY, '1.25', '1250');
    await insertCanonicalRow(admin, NEW_SNAPSHOT_ID, runId, NATURAL_KEY, '2.5', '2500');

    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_outbox
        (activation_id, dedupe_key, old_snapshot_id, new_snapshot_id, canonical_entity,
         canonical_natural_key, family, fiscal_year, funding_field, stage,
         change_classification, suppress_alert, is_correction, is_rollback)
      VALUES ('${activationId}', 'dedupe-two-sided', '${OLD_SNAPSHOT_ID}', '${NEW_SNAPSHOT_ID}',
              'canonical_om_sag_year', '${NATURAL_KEY}', 'om', 2027, 'hascMark', NULL,
              'material_change', false, false, false)
      ON CONFLICT DO NOTHING`);

    /* =================================================================== */
    /* 5. SKIP LOCKED really partitions the backlog                        */
    /* =================================================================== */
    const holder = new PgClient({ connectionString: PROMOTER_URL });
    await holder.connect();
    let heldIds: string[] = [];
    try {
      await holder.query('BEGIN');
      const held = await holder.query<{ id: string }>(
        outboxClaimSqlV1({ processingLeaseMs: LEASE_MS }),
        [DOMAIN, ENVIRONMENT, new Date().toISOString(), 2],
      );
      heldIds = held.rows.map((row) => row.id);
      check(heldIds.length === 2, `one drainer holds ${heldIds.length} rows, uncommitted`);

      // A statement timeout turns "would have blocked" into a clean failure
      // rather than a hung rehearsal. Without SKIP LOCKED this query waits on
      // the open transaction above and trips the timeout.
      const contender = new PgClient({ connectionString: PROMOTER_URL });
      await contender.connect();
      try {
        await contender.query(`SET statement_timeout = '5s'`);
        const second = await contender.query<{ id: string }>(
          outboxClaimSqlV1({ processingLeaseMs: LEASE_MS }),
          [DOMAIN, ENVIRONMENT, new Date().toISOString(), 100],
        );
        const secondIds = second.rows.map((row) => row.id);
        const overlap = secondIds.filter((id) => heldIds.includes(id));
        check(overlap.length === 0, 'a concurrent drainer claimed none of the locked rows');
        check(
          secondIds.length > 0,
          `it claimed the rest of the backlog instead (${secondIds.length})`,
        );
      } finally {
        await contender.end().catch(() => undefined);
      }
    } finally {
      // Rolling back releases the lock and reverts the held rows to PENDING,
      // which is exactly what a drainer dying mid-claim would leave behind.
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }

    const revertedStatuses = await statusesFor(admin, heldIds);
    check(
      revertedStatuses.every((status) => status === 'PENDING'),
      'an uncommitted claim leaves its rows PENDING, not stranded',
    );

    // Everything the contender claimed is PROCESSING and committed; put it back
    // so the rest of the rehearsal drains from a known state.
    await admin.$executeRawUnsafe(
      `UPDATE defense_budget_promotion_outbox SET status = 'PENDING', last_attempted_at = NULL
        WHERE status = 'PROCESSING'`,
    );

    /* =================================================================== */
    /* 6. The claim SQL agrees with the policy                             */
    /* =================================================================== */
    await assertSqlMatchesPolicy(admin, promoter, activationId);

    /* =================================================================== */
    /* 7. A full drain: money resolved, deltas written                     */
    /* =================================================================== */
    const drained = await drainPromotionOutboxBatchV1(
      { domain: DOMAIN, environment: ENVIRONMENT, now: new Date() },
      repository,
      deltaHandler,
    );
    check(!drained.paused && drained.claimed >= 4, `drained ${drained.claimed} rows`);
    check(drained.poisoned === 0 && drained.retried === 0, 'every row published first time');

    const twoSided = await admin.$queryRawUnsafe<
      {
        old_original_value: string | null;
        old_value_millions: string | null;
        new_value_millions: string | null;
        status: string;
      }[]
    >(
      `SELECT old_original_value, old_value_millions::text AS old_value_millions,
              new_value_millions::text AS new_value_millions, status
         FROM defense_budget_promotion_outbox WHERE dedupe_key = 'dedupe-two-sided'`,
    );
    const row = twoSided[0];
    check(row?.status === 'DONE', 'the two-sided row is DONE');
    check(
      row?.old_value_millions === '1.250000000' && row?.new_value_millions === '2.500000000',
      `both sides of the money were resolved from the snapshots (${row?.old_value_millions} -> ${row?.new_value_millions})`,
    );
    check(row?.old_original_value === '1250', 'the printed original came across too');

    const delta = await admin.$queryRawUnsafe<
      {
        delta_kind: string;
        money_delta_millions: string | null;
        stage: string | null;
        funding_field: string | null;
        alert_eligible: boolean;
        changed_axes: unknown;
      }[]
    >(
      `SELECT delta_kind, money_delta_millions::text AS money_delta_millions, stage, funding_field,
              alert_eligible, changed_axes
         FROM defense_budget_canonical_delta
        WHERE canonical_natural_key = $1`,
      NATURAL_KEY,
    );
    check(delta.length === 1, 'exactly one delta was written for the change');
    check(delta[0]?.delta_kind === 'increase', `it is an increase (${delta[0]?.delta_kind})`);
    check(
      delta[0]?.money_delta_millions === '1.250000000',
      `the difference is exact (${delta[0]?.money_delta_millions})`,
    );
    check(
      delta[0]?.stage === 'hasc' && delta[0]?.funding_field === 'hascMark',
      'stage and field came from the canonical row, not the outbox row',
    );
    check(delta[0]?.alert_eligible === true, 'an unsuppressed material change is alert-eligible');

    // The suppressed hydration rows must not have produced an alertable delta.
    const alertable = await scalar(
      admin,
      `SELECT count(*)::text FROM defense_budget_canonical_delta d
         JOIN defense_budget_promotion_outbox o ON o.id = d.outbox_id
        WHERE o.change_classification = 'initial_hydration' AND d.alert_eligible = true`,
    );
    check(alertable === '0', 'baseline hydration produced no alert-eligible delta');

    /* =================================================================== */
    /* 8. Replay is idempotent                                             */
    /* =================================================================== */
    await admin.$executeRawUnsafe(
      `UPDATE defense_budget_promotion_outbox SET status = 'PENDING', processed_at = NULL,
              last_attempted_at = NULL WHERE dedupe_key = 'dedupe-two-sided'`,
    );
    const replay = await drainPromotionOutboxBatchV1(
      { domain: DOMAIN, environment: ENVIRONMENT, now: new Date() },
      repository,
      deltaHandler,
    );
    check(replay.claimed === 1 && replay.done === 1, 'the replayed row published again');
    const deltaCount = await scalar(
      admin,
      `SELECT count(*)::text FROM defense_budget_canonical_delta WHERE canonical_natural_key = $1`,
      NATURAL_KEY,
    );
    check(deltaCount === '1', 'the replay wrote no second delta');

    /* =================================================================== */
    /* 9. A delta is append-only, and the authority check is live          */
    /* =================================================================== */
    await expectRefused(
      admin,
      `UPDATE defense_budget_canonical_delta SET severity = 'critical'
        WHERE canonical_natural_key = '${NATURAL_KEY}'`,
      'a computed delta cannot be revised',
    );
    await expectRefused(
      admin,
      `DELETE FROM defense_budget_canonical_delta WHERE canonical_natural_key = '${NATURAL_KEY}'`,
      'a computed delta cannot be deleted',
    );
    await expectRefused(
      admin,
      `INSERT INTO defense_budget_canonical_delta
         (delta_key, activation_id, outbox_id, new_snapshot_id, canonical_entity,
          canonical_natural_key, family, funding_field, stage, delta_kind, changed_axes,
          change_classification, suppress_alert)
       SELECT 'delta-no-authority', '${activationId}', o.id, '${NEW_SNAPSHOT_ID}',
              'canonical_om_sag_year', 'no-authority', 'om', 'hascMark', NULL, 'increase',
              '["money"]'::jsonb, 'material_change', false
         FROM defense_budget_promotion_outbox o WHERE o.dedupe_key = 'dedupe-two-sided'`,
      'a congressional mark with no authority naming it is refused',
    );
    await expectRefused(
      admin,
      `INSERT INTO defense_budget_canonical_delta
         (delta_key, activation_id, outbox_id, new_snapshot_id, canonical_entity,
          canonical_natural_key, family, delta_kind, changed_axes,
          change_classification, suppress_alert, alert_eligible)
       SELECT 'delta-suppressed-alert', '${activationId}', o.id, '${NEW_SNAPSHOT_ID}',
              'canonical_om_sag_year', 'suppressed', 'om', 'increase',
              '["money"]'::jsonb, 'correction', true, true
         FROM defense_budget_promotion_outbox o WHERE o.dedupe_key = 'dedupe-two-sided'`,
      'a correction cannot carry an alert-eligible delta',
    );

    /* =================================================================== */
    /* 10. The run reaches COMPLETED only with nothing left                */
    /* =================================================================== */
    const runStatus = await scalar(
      admin,
      `SELECT status FROM defense_budget_promotion_run WHERE id = $1::uuid`,
      runId,
    );
    check(runStatus === 'COMPLETED', `the drained run is COMPLETED (${runStatus})`);

    /* =================================================================== */
    /* 11. A poison row survives its attempts and holds the run            */
    /* =================================================================== */
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_outbox
        (activation_id, dedupe_key, new_snapshot_id, canonical_entity, canonical_natural_key,
         family, change_classification, suppress_alert)
      VALUES ('${activationId}', 'dedupe-poison', '${NEW_SNAPSHOT_ID}', 'canonical_om_sag_year',
              'POISON-KEY', 'om', 'material_change', false)`);

    let attempts = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      // `now` is advanced rather than slept through: the backoff is measured
      // from last_attempted_at, and a rehearsal that slept for the real curve
      // would take minutes to prove a five-attempt ceiling.
      const now = new Date(Date.now() + pass * 60 * 60 * 1000);
      const result = await drainPromotionOutboxBatchV1(
        { domain: DOMAIN, environment: ENVIRONMENT, now },
        repository,
        failHandler('downstream refused this row'),
      );
      attempts += result.claimed;
      if (result.poisoned > 0) break;
    }
    const poison = await admin.$queryRawUnsafe<
      { status: string; attempts: number; last_error: string | null }[]
    >(`SELECT status, attempts, last_error FROM defense_budget_promotion_outbox
        WHERE dedupe_key = 'dedupe-poison'`);
    check(poison[0]?.status === 'POISON', `the row was quarantined (${poison[0]?.status})`);
    check(
      Number(poison[0]?.attempts) === 5,
      `it was retried to the ceiling and no further (${poison[0]?.attempts} attempts over ${attempts} claims)`,
    );
    check(
      (poison[0]?.last_error ?? '').includes('downstream refused'),
      'it kept the error that quarantined it',
    );

    const afterPoison = await scalar(
      admin,
      `SELECT status FROM defense_budget_promotion_run WHERE id = $1::uuid`,
      runId,
    );
    check(
      afterPoison === 'COMMITTED_WITH_SIDE_EFFECT_FAILURE',
      `one poison row outranks every success (${afterPoison})`,
    );

    const stillClaimed = await drainPromotionOutboxBatchV1(
      { domain: DOMAIN, environment: ENVIRONMENT, now: new Date(Date.now() + 86_400_000) },
      repository,
      okHandler,
    );
    check(stillClaimed.claimed === 0, 'a quarantined row is never claimed again');

    /* =================================================================== */
    /* 12. A row abandoned by a dead drainer is recoverable                */
    /* =================================================================== */
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_outbox
        (activation_id, dedupe_key, new_snapshot_id, canonical_entity, canonical_natural_key,
         family, change_classification, suppress_alert, status, attempts, last_attempted_at)
      VALUES ('${activationId}', 'dedupe-abandoned', '${NEW_SNAPSHOT_ID}', 'canonical_om_sag_year',
              'ABANDONED-KEY', 'om', 'material_change', false, 'PROCESSING', 1, now())`);

    const tooSoon = await repository.claimBatch({
      domain: DOMAIN,
      environment: ENVIRONMENT,
      limit: 10,
      now: new Date(),
    });
    check(
      !tooSoon.some((claimed) => claimed.dedupeKey === 'dedupe-abandoned'),
      'a live drainer inside its lease keeps its rows',
    );

    const afterLease = await repository.claimBatch({
      domain: DOMAIN,
      environment: ENVIRONMENT,
      limit: 10,
      now: new Date(Date.now() + LEASE_MS + 1_000),
    });
    check(
      afterLease.some((claimed) => claimed.dedupeKey === 'dedupe-abandoned'),
      'once the lease expires the row is reclaimed rather than stranded',
    );

    console.log(`[p7-drain] DRAIN REHEARSAL PASSED — ${passed} checks`);
  } finally {
    await admin.$disconnect().catch(() => undefined);
    await promoter.$disconnect().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function scalar(client: PrismaClient, sql: string, ...params: unknown[]): Promise<string> {
  const rows = await client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
  const first = rows[0];
  if (first == null) fail(`query returned no row: ${sql}`);
  return String(Object.values(first)[0]);
}

async function countByStatus(
  client: PrismaClient,
  environment: string,
): Promise<Record<string, number>> {
  const rows = await client.$queryRawUnsafe<{ status: string; count: number }[]>(
    `SELECT o.status, count(*)::int AS count
       FROM defense_budget_promotion_outbox o
       JOIN defense_budget_promotion_activation a ON a.id = o.activation_id
      WHERE a.environment = $1
      GROUP BY o.status`,
    environment,
  );
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

async function statusesFor(client: PrismaClient, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  // Ids come from this database's own rows, so an inlined list is safe and
  // avoids depending on how the driver serializes an array parameter.
  const list = ids.map((id) => `'${id}'::uuid`).join(', ');
  const rows = await client.$queryRawUnsafe<{ status: string }[]>(
    `SELECT status FROM defense_budget_promotion_outbox WHERE id IN (${list})`,
  );
  return rows.map((row) => row.status);
}

async function insertCanonicalRow(
  client: PrismaClient,
  snapshotId: string,
  runId: string,
  naturalKey: string,
  millions: string,
  original: string,
): Promise<void> {
  await client.$executeRawUnsafe(`
    INSERT INTO defense_budget_canonical_row
      (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key, family,
       fiscal_year, funding_field, stage, canonical_row_hash,
       money_original_value, money_original_unit, money_value_millions,
       direct_or_derived, source_projection_id, source_assertion_id, evidence_ids,
       artifact_id, artifact_content_sha256, verification_candidate_id, verification_run_id,
       source_document_id, source_pdf_sha256, mapping_registry_hash)
    VALUES ('${snapshotId}', '${runId}', 'canonical_om_sag_year', '${naturalKey}', 'om',
            2027, 'hascMark', 'hasc', '${sha(snapshotId + naturalKey)}',
            '${original}', 'thousands', ${millions},
            'direct', 'proj-${snapshotId}', 'assert-1', '["ev-1"]'::jsonb,
            'artifact-1', '${SHA('a')}', 'cand-1', 'run-1',
            'doc-1', '${SHA('b')}', '${SHA('c')}')
    ON CONFLICT DO NOTHING`);
}

/** A deterministic 64-hex string; the column only requires the shape. */
function sha(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 0xffffffff;
  return hash.toString(16).padStart(8, '0').repeat(8);
}

async function expectRefused(client: PrismaClient, sql: string, message: string): Promise<void> {
  try {
    await client.$executeRawUnsafe(sql);
  } catch {
    ok(`${message} — refused`);
    return;
  }
  fail(`${message} — the database ACCEPTED a statement it must refuse`);
}

/**
 * Seed one row per interesting (status, attempts, age) combination and assert
 * the claim query selects exactly the set `isClaimableV1` predicts.
 *
 * This is the check that stops the generated SQL and the policy drifting apart.
 * Both sides of every boundary are covered, because "eligible one millisecond
 * too early" is the failure that a coarser fixture would miss.
 */
async function assertSqlMatchesPolicy(
  admin: PrismaClient,
  promoter: PrismaClient,
  activationId: string,
): Promise<void> {
  const now = new Date('2026-09-01T00:00:00.000Z');
  const cases: {
    key: string;
    status: OutboxRowStatusV1;
    attempts: number;
    ageMs: number | null;
  }[] = [
    { key: 'p-fresh', status: 'PENDING', attempts: 0, ageMs: null },
    { key: 'p-failed-early', status: 'FAILED', attempts: 1, ageMs: 1_999 },
    { key: 'p-failed-due', status: 'FAILED', attempts: 1, ageMs: 2_000 },
    { key: 'p-failed-3-early', status: 'FAILED', attempts: 3, ageMs: 7_999 },
    { key: 'p-failed-3-due', status: 'FAILED', attempts: 3, ageMs: 8_000 },
    { key: 'p-failed-capped', status: 'FAILED', attempts: 40, ageMs: 299_999 },
    { key: 'p-failed-capped-due', status: 'FAILED', attempts: 40, ageMs: 300_000 },
    { key: 'p-processing-live', status: 'PROCESSING', attempts: 1, ageMs: 999 },
    { key: 'p-processing-stale', status: 'PROCESSING', attempts: 1, ageMs: 1_000 },
    { key: 'p-processing-unstamped', status: 'PROCESSING', attempts: 1, ageMs: null },
    { key: 'p-done', status: 'DONE', attempts: 1, ageMs: 86_400_000 },
    { key: 'p-poison', status: 'POISON', attempts: 5, ageMs: 86_400_000 },
  ];

  // The probe below is a real claim: it marks every eligible row PROCESSING,
  // including the genuine backlog this rehearsal still needs to drain. Record
  // what that backlog looked like so it can be put back exactly.
  const before = await admin.$queryRawUnsafe<
    { id: string; status: string; attempts: number; last_attempted_at: Date | null }[]
  >(
    `SELECT o.id::text, o.status, o.attempts, o.last_attempted_at
       FROM defense_budget_promotion_outbox o
       JOIN defense_budget_promotion_activation a ON a.id = o.activation_id
      WHERE a.environment = $1`,
    ENVIRONMENT,
  );

  for (const item of cases) {
    const stamp =
      item.ageMs == null ? 'NULL' : `'${new Date(now.getTime() - item.ageMs).toISOString()}'`;
    await admin.$executeRawUnsafe(`
      INSERT INTO defense_budget_promotion_outbox
        (activation_id, dedupe_key, new_snapshot_id, canonical_entity, canonical_natural_key,
         family, change_classification, suppress_alert, status, attempts, last_attempted_at)
      VALUES ('${activationId}', '${item.key}', '${NEW_SNAPSHOT_ID}', 'canonical_om_sag_year',
              '${item.key}', 'om', 'material_change', false,
              '${item.status}', ${item.attempts}, ${stamp}::timestamptz)
      ON CONFLICT DO NOTHING`);
  }

  const claimed = await promoter.$queryRawUnsafe<{ dedupe_key: string }[]>(
    outboxClaimSqlV1({ processingLeaseMs: LEASE_MS }),
    DOMAIN,
    ENVIRONMENT,
    now.toISOString(),
    100,
  );
  const claimedKeys = new Set(claimed.map((row) => row.dedupe_key));

  for (const item of cases) {
    const predicted = isClaimableV1({
      status: item.status,
      attempts: item.attempts,
      lastAttemptedAt: item.ageMs == null ? null : new Date(now.getTime() - item.ageMs),
      now,
      leaseMs: LEASE_MS,
    });
    const actual = claimedKeys.has(item.key);
    if (predicted !== actual) {
      fail(
        `claim SQL disagrees with isClaimableV1 for ${item.key}: policy says ${predicted}, SQL says ${actual}`,
      );
    }
  }
  ok(`claim SQL matches the policy across ${cases.length} boundary cases`);

  // Drop the fixtures and restore the genuine backlog the probe just claimed,
  // so the drain below starts from the state the engine rehearsal left.
  await admin.$executeRawUnsafe(
    `DELETE FROM defense_budget_promotion_outbox WHERE dedupe_key LIKE 'p-%'`,
  );
  for (const row of before) {
    const stamp =
      row.last_attempted_at == null ? 'NULL' : `'${row.last_attempted_at.toISOString()}'`;
    await admin.$executeRawUnsafe(
      `UPDATE defense_budget_promotion_outbox
          SET status = '${row.status}', attempts = ${Number(row.attempts)},
              last_attempted_at = ${stamp}::timestamptz
        WHERE id = '${row.id}'::uuid`,
    );
  }
}

main().catch((error) => {
  console.error('[p7-drain] FAILED:', error);
  process.exit(1);
});
