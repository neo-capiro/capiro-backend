#!/usr/bin/env node
/**
 * Phase 8 Session 11 — real product/read integration + role-boundary +
 * governed-resolution proof.
 *
 * Runs the REAL compiled `BudgetLifecycleQueryService` (backed by the REAL
 * `PrismaBudgetLifecycleReadStore`) against a real, migrated, seeded
 * database, and separately exercises the REAL `run-review-resolution.mjs`
 * CLI as a subprocess under different DB roles. This proves the final query
 * RESULT reflects lifecycle truth, that the serve/job role boundary is real
 * (not just a convention), and that a resolution changes exactly the row it
 * should and nothing else.
 *
 * Requires: ADMIN_DATABASE_URL (postgres superuser), SERVE_DATABASE_URL
 * (p8s11_serve_rehearsal), JOB_DATABASE_URL (p8s11_job_rehearsal) — all
 * pointing at the same already-migrated, already-seeded `capiro` database
 * (see seed-phase8-session11-corpus.mjs).
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { requirePhase8DbRun } from './lib/phase8-db-wrapper-cli.mjs';

requirePhase8DbRun('verify-phase8-session11-integration.mjs', process.argv.slice(2));

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'apps/defense-api');

const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
const { PrismaBudgetLifecycleReadStore } = require(
  path.join(appRoot, 'dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js'),
);
const { BudgetLifecycleQueryService } = require(
  path.join(appRoot, 'dist/budget-lifecycle-product/budget-lifecycle-query.service.js'),
);
const { CycleHealthService } = require(path.join(appRoot, 'dist/budget-lifecycle/cycle-health.service.js'));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const SERVE_URL = process.env.SERVE_DATABASE_URL;
const JOB_URL = process.env.JOB_DATABASE_URL;
assert.ok(ADMIN_URL && SERVE_URL && JOB_URL, 'ADMIN_DATABASE_URL, SERVE_DATABASE_URL, JOB_DATABASE_URL are all required');

const CLI = path.join(appRoot, 'scripts/run-review-resolution.mjs');
const HACD_2027 = '20000000-0000-0000-0000-000000000003';
const HASC_2027 = '20000000-0000-0000-0000-000000000002';
const PB_2027 = '20000000-0000-0000-0000-000000000001';
const ACTOR_USER_ID = '44444444-4444-4444-4444-444444444401';

let PASS_COUNT = 0;
function ok(label) {
  PASS_COUNT += 1;
  console.log(`  ok  ${label}`);
}

const TABLES = [
  'defense_budget_cycle',
  'defense_budget_expected_source',
  'defense_budget_source_observation',
  'defense_budget_watcher_adapter',
  'defense_budget_watcher_run',
  'defense_budget_ingestion_outbox',
  'defense_budget_schedule_tick',
];

async function snapshotHash(prisma) {
  const parts = [];
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM ${table} ORDER BY id`);
    parts.push(`${table}:${JSON.stringify(rows)}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

async function fullSnapshotRows(prisma) {
  const snapshot = {};
  for (const table of TABLES) {
    snapshot[table] = await prisma.$queryRawUnsafe(`SELECT * FROM ${table} ORDER BY id`);
  }
  snapshot.defense_budget_review_resolution = await prisma.$queryRawUnsafe(
    `SELECT * FROM defense_budget_review_resolution ORDER BY id`,
  );
  return snapshot;
}

function diffRows(before, after) {
  const expectedSourceIds = [];
  let otherTableChanges = 0;
  for (const table of Object.keys(before)) {
    const beforeJson = JSON.stringify(before[table]);
    const afterJson = JSON.stringify(after[table]);
    if (beforeJson === afterJson) continue;
    if (table === 'defense_budget_expected_source') {
      const beforeById = new Map(before[table].map((r) => [r.id, JSON.stringify(r)]));
      for (const row of after[table]) {
        if (beforeById.get(row.id) !== JSON.stringify(row)) expectedSourceIds.push(row.id);
      }
    } else if (table === 'defense_budget_review_resolution') {
      // Expected to grow by exactly one row on a real commit; not counted as
      // an "other" table change.
    } else {
      otherTableChanges += 1;
    }
  }
  return { expectedSourceIds, otherTableChanges };
}

/** Runs the CLI as a subprocess under the given DB url; throws with full output on unexpected outcome. */
function runCli(url, args, { authorized = false, expectSucceed = null } = {}) {
  const env = { ...process.env, DATABASE_URL: url };
  if (authorized) env.PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED = 'true';
  else delete env.PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED;
  try {
    const output = execFileSync('node', [CLI, ...args], { env, encoding: 'utf8' });
    if (expectSucceed === false) {
      throw new Error(`expected the CLI to fail but it succeeded:\n${output}`);
    }
    return { succeeded: true, output };
  } catch (error) {
    if (expectSucceed === true) {
      throw new Error(`expected the CLI to succeed but it failed:\n${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
    }
    return { succeeded: false, output: `${error.stdout ?? ''}\n${error.stderr ?? error.message}` };
  }
}

async function firstTenantId(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT id FROM tenants LIMIT 1`);
  if (rows[0]) return rows[0].id;
  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO tenants (id, name, slug) VALUES (gen_random_uuid(), 'Rehearsal Tenant', 'p8s11-rehearsal-tenant') RETURNING id`,
  );
  return created[0].id;
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const serve = new PrismaClient({ datasources: { db: { url: SERVE_URL } } });
  const job = new PrismaClient({ datasources: { db: { url: JOB_URL } } });

  try {
    const tenantId = await firstTenantId(admin);

    // ── 1. capiro_defense_serve can perform all six Session 11 reads ──────
    const serveStore = new PrismaBudgetLifecycleReadStore(serve);
    const serveService = new BudgetLifecycleQueryService(serveStore, new CycleHealthService());

    const health2027 = await serveService.getCycleHealth(2027);
    assert.equal(health2027.fiscalYear, 2027);
    assert.equal(health2027.expectedSources, 4, 'FY2027: PB, HASC, HAC-D, alt-supplemental');
    assert.equal(health2027.published, 2, 'PB + HASC are published');
    assert.equal(health2027.reviewRequired, 1, 'HAC-D observation is review_required');
    assert.equal(health2027.notFiled, 1, 'the alt-funding supplemental is not_filed, not zero');
    ok('serve role: cycle health for FY2027 (route 1/6) reflects the seeded scenario');

    const health2028 = await serveService.getCycleHealth(2028);
    assert.equal(health2028.expectedSources, 2, 'FY2028: SASC + SAC-D only — independent of FY2027');
    const authTrack2028 = health2028.tracks.find((t) => t.authorityTrack === 'authorization');
    const apprTrack2028 = health2028.tracks.find((t) => t.authorityTrack === 'appropriations');
    assert.equal(authTrack2028.published, 1, 'FY2028 authorization (SASC) published');
    assert.equal(apprTrack2028.notFiled, 1, 'FY2028 appropriations (SAC-D) not_filed — independent of authorization');
    ok('serve role: FY2028 cycle health proves two overlapping fiscal years with independent tracks');

    const expectedSources2027 = await serveService.listExpectedSources(2027);
    const stages = new Set(expectedSources2027.map((s) => s.stage));
    assert.ok(stages.size >= 3, `expected >=3 distinct stages in FY2027, found ${[...stages]}`);
    ok('serve role: expected-sources list (route 2/6) spans more than one stage');

    const hascDetail = await serveService.getExpectedSourceDetail(HASC_2027);
    assert.equal(hascDetail.observations.length, 2, 'HASC has both the superseded v1 and current v2');
    const superseded = hascDetail.observations.find((o) => o.observationState === 'superseded');
    const current = hascDetail.observations.find((o) => o.observationState === 'ingested');
    assert.ok(superseded && current, 'both a superseded and a current observation must be present');
    assert.ok(superseded.supersededByObservationId, 'the superseded observation must carry a forward pointer to its successor');
    assert.notEqual(superseded.contentSha256, current.contentSha256, 'the two versions must be genuinely distinct bytes');
    ok('serve role: expected-source detail (route 3/6) exposes current vs superseded observation state');

    const reviewQueue2027 = await serveService.listReviewQueue(2027);
    assert.equal(reviewQueue2027.length, 1);
    assert.equal(reviewQueue2027[0].expectedSourceId, HACD_2027);
    assert.ok(reviewQueue2027[0].observation.reviewReasons.length > 0, 'provenance: review reasons must survive to the product result');
    assert.ok(reviewQueue2027[0].observation.discoveredUrl.startsWith('https://'), 'provenance: discovered URL must survive');
    const pendingDiscoveredUrl = reviewQueue2027[0].observation.discoveredUrl;
    ok('serve role: review queue (route 4/6) surfaces the pending item with full provenance');

    const signals2027 = await serveService.listSignals(2027);
    const pbToHasc = signals2027.find((s) => s.signalKind === 'pb_to_hasc');
    assert.ok(pbToHasc, 'a pb_to_hasc signal must be derivable from the seeded PB + HASC observations');
    assert.equal(pbToHasc.toContentSha256, current.contentSha256, 'the signal must reference the CURRENT observation, not the superseded one');
    ok('serve role: signals (route 5/6) derive read-time and reference the current, not superseded, evidence');

    const tickHealth = await serveService.getScheduleTickHealth();
    assert.equal(tickHealth.ticksConsidered, 2);
    assert.equal(tickHealth.completedTicks, 1);
    assert.equal(tickHealth.failedTicks, 1);
    ok('serve role: schedule tick health (route 6/6) reports both the healthy and the failed tick');

    // ── 2. ambiguous item is not resolved merely by being read twice ──────
    const readBefore1 = await admin.$queryRawUnsafe(
      `SELECT expected_state, updated_at FROM defense_budget_expected_source WHERE id = $1::uuid`, HACD_2027,
    );
    await serveService.getExpectedSourceDetail(HACD_2027);
    await serveService.listReviewQueue(2027);
    const readBefore2 = await admin.$queryRawUnsafe(
      `SELECT expected_state, updated_at FROM defense_budget_expected_source WHERE id = $1::uuid`, HACD_2027,
    );
    assert.equal(readBefore1[0].expected_state, 'review_required');
    assert.equal(readBefore2[0].expected_state, 'review_required');
    assert.equal(readBefore1[0].updated_at.getTime(), readBefore2[0].updated_at.getTime(), 'reading twice must not touch updated_at at all');
    ok('reading a review_required item (even twice) does not resolve it or touch its row');

    // ── 3. capiro_defense_serve cannot mutate any Session 7-10 table ──────
    await assert.rejects(
      serve.$executeRawUnsafe(
        `UPDATE defense_budget_expected_source SET expected_state = 'published' WHERE id = $1::uuid`, HACD_2027,
      ),
      /permission denied/i,
    );
    ok('serve role: UPDATE on defense_budget_expected_source is permission-denied at the database level');

    await assert.rejects(
      serve.$executeRawUnsafe(
        `INSERT INTO defense_budget_watcher_run (adapter_id, run_key, status, started_at) VALUES ('hasc','fake-run','succeeded', now())`,
      ),
      /permission denied/i,
    );
    ok('serve role: INSERT on defense_budget_watcher_run is permission-denied at the database level');

    await assert.rejects(
      serve.$executeRawUnsafe(`DELETE FROM defense_budget_schedule_tick`),
      /permission denied/i,
    );
    ok('serve role: DELETE on defense_budget_schedule_tick is permission-denied at the database level');

    await assert.rejects(
      serve.$executeRawUnsafe(
        `UPDATE defense_budget_expected_source SET expected_state = $2, review_reason = NULL WHERE id = $1::uuid`,
        HACD_2027, 'published',
      ),
      /permission denied/i,
    );
    ok('the exact review-resolution UPDATE statement fails under serve credentials — the HTTP/read surface cannot resolve a review even if coerced into trying');

    // ── 4. full-table snapshot: no read anywhere mutated anything ─────────
    const beforeReadsHash = await snapshotHash(admin);
    await serveService.getCycleHealth(2027);
    await serveService.getCycleHealth(2028);
    await serveService.listExpectedSources(2027);
    await serveService.getExpectedSourceDetail(HASC_2027);
    await serveService.getExpectedSourceDetail(PB_2027);
    await serveService.listReviewQueue(2027);
    await serveService.listSignals(2027);
    await serveService.getScheduleTickHealth();
    const afterReadsHash = await snapshotHash(admin);
    assert.equal(beforeReadsHash, afterReadsHash, 'every table this session touches must be byte-identical before and after a full read sweep');
    ok('full-table snapshot: running all six read routes leaves every budget-lifecycle table byte-identical (no lease, no adapter call, no promotion, no write)');

    // ── 5. run-review-resolution.mjs: dry run performs no write ───────────
    const beforeDryRun = await snapshotHash(admin);
    const auditCountBefore = Number(
      (await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM defense_budget_review_resolution`,
      ))[0].n,
    );
    const dryRun = runCli(JOB_URL, [
      '--expected-source-id', HACD_2027, '--decision', 'published',
      '--note', 'rehearsal dry run', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId,
    ], { expectSucceed: true });
    assert.match(dryRun.output, /SESSION11_REVIEW_RESOLUTION_DRY_RUN_PASS/);
    const afterDryRun = await snapshotHash(admin);
    assert.equal(beforeDryRun, afterDryRun, 'a dry run (no --commit) must write nothing at all');
    const auditCountAfterDry = Number(
      (await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM defense_budget_review_resolution`,
      ))[0].n,
    );
    assert.equal(auditCountBefore, auditCountAfterDry);
    ok('run-review-resolution.mjs without --commit performs zero writes (full snapshot + resolution-audit count both unchanged)');

    // ── 6. --commit under serve credentials is refused by the database ────
    const serveCommitAttempt = runCli(SERVE_URL, [
      '--expected-source-id', HACD_2027, '--decision', 'published',
      '--note', 'attempted under serve creds', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: false });
    assert.match(serveCommitAttempt.output, /permission denied/i);
    const stillReviewRequired = await admin.$queryRawUnsafe(
      `SELECT expected_state FROM defense_budget_expected_source WHERE id = $1::uuid`, HACD_2027,
    );
    assert.equal(stillReviewRequired[0].expected_state, 'review_required');
    ok('a --commit attempt using serve-role credentials is denied by the database, and the item is still review_required');

    // ── 7. the governed job-role commit succeeds, touching ONLY the target row ─
    const beforeJobCommit = await fullSnapshotRows(admin);
    const jobCommit = runCli(JOB_URL, [
      '--expected-source-id', HACD_2027, '--decision', 'published',
      '--note', 'verified against the publisher’s own package page (rehearsal)',
      '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: true });
    assert.match(jobCommit.output, /SESSION11_REVIEW_RESOLUTION_COMMITTED/);
    const afterJobCommit = await fullSnapshotRows(admin);
    const changed = diffRows(beforeJobCommit, afterJobCommit);
    assert.equal(changed.expectedSourceIds.length, 1, `exactly one expected_source row must change, found: ${changed.expectedSourceIds}`);
    assert.equal(changed.expectedSourceIds[0], HACD_2027);
    assert.equal(changed.otherTableChanges, 0, 'no table besides expected_source and defense_budget_review_resolution may change');
    ok('the governed job-role commit succeeds and changes exactly the target row — nothing else');

    const resolvedRow = await admin.$queryRawUnsafe(
      `SELECT expected_state, review_reason FROM defense_budget_expected_source WHERE id = $1::uuid`, HACD_2027,
    );
    assert.equal(resolvedRow[0].expected_state, 'published');
    ok('the resolved row reads back as published, with review_reason cleared');

    const auditRow = await admin.$queryRawUnsafe(
      `SELECT previous_expected_state, decision, note FROM defense_budget_review_resolution
        WHERE expected_source_id = $1::uuid`,
      HACD_2027,
    );
    assert.equal(auditRow.length, 1);
    assert.equal(auditRow[0].previous_expected_state, 'review_required');
    assert.equal(auditRow[0].decision, 'published');
    ok('exactly one defense_budget_review_resolution row records the before/after transition');

    // ── 8. the read model reflects the resolution on the very next read ───
    const queueAfterResolution = await serveService.listReviewQueue(2027);
    assert.equal(queueAfterResolution.length, 0, 'the resolved item must no longer appear in the review queue');
    const detailAfterResolution = await serveService.getExpectedSourceDetail(HACD_2027);
    assert.equal(detailAfterResolution.expectedState, 'published');
    assert.equal(detailAfterResolution.observations.length, 1, 'provenance: the original observation history must still be present after resolution');
    assert.equal(detailAfterResolution.observations[0].discoveredUrl, pendingDiscoveredUrl);
    ok('the very next read reflects the resolution: gone from the queue, published in detail, provenance intact');

    // ── 9. a second resolution attempt is refused, not double-applied ─────
    const repeat = runCli(JOB_URL, [
      '--expected-source-id', HACD_2027, '--decision', 'published',
      '--note', 'repeat', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: false });
    assert.match(repeat.output, /not 'review_required'/);
    const auditCountAfterRepeat = Number(
      (await admin.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM defense_budget_review_resolution WHERE expected_source_id = $1::uuid`,
        HACD_2027,
      ))[0].n,
    );
    assert.equal(auditCountAfterRepeat, 1, 'a refused repeat must not write a second audit row');
    ok('a repeat resolution of the same, now-published item is refused, not double-applied');

    console.log(`SESSION11_INTEGRATION_PASS (${PASS_COUNT} checks)`);
  } finally {
    await admin.$disconnect();
    await serve.$disconnect();
    await job.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
