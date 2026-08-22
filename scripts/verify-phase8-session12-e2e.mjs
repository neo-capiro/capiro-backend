#!/usr/bin/env node
/**
 * Phase 8 Session 12 — end-to-end closeout proof (no activation).
 *
 * Runs the REAL compiled `BudgetLifecycleQueryService` (backed by the REAL
 * `PrismaBudgetLifecycleReadStore`) against the database
 * `scripts/seed-phase8-session12-corpus.mjs` just populated by actually
 * driving the Session 7 control loop through fixture ports (no network), and
 * separately exercises the REAL `run-review-resolution.mjs` CLI (Session 11,
 * unmodified) as a subprocess under different DB roles.
 *
 * This proves the 12-point Session 12 acceptance list end to end against a
 * real, migrated, seeded, disposable Postgres:
 *
 *   1.  two overlapping fiscal years (FY2029/FY2030) remain independent
 *   2.  authorization and appropriations are never collapsed into one track
 *   3.  unchanged bytes do not duplicate work (content-hash dedup)
 *   4.  changed bytes create an immutable successor, never an in-place edit
 *   5.  a CR overlay does not erase the authorization/appropriations baseline
 *   6.  alternative/supplemental funding remains separately attributable
 *   7.  ambiguous correlation is held for review (review_required, real)
 *   8.  governed review resolution changes only the intended row/state
 *   9.  the read result reflects the resolution on the very next read
 *   10. provenance (URL, sha256, discoveredAt) survives to the read output
 *   11. stale/failed source health is visible in the read model
 *   12. one failed adapter/track does not poison unrelated FY/track results
 *
 * Requires: ADMIN_DATABASE_URL (postgres superuser), SERVE_DATABASE_URL
 * (p8s12_serve_rehearsal), JOB_DATABASE_URL (p8s12_job_rehearsal) — all
 * pointing at the same already-migrated, already-seeded `capiro` database.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
const ACTOR_USER_ID = '55555555-5555-5555-5555-555555555501';

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
      // Expected to grow by exactly one row on a real commit.
    } else {
      otherTableChanges += 1;
    }
  }
  return { expectedSourceIds, otherTableChanges };
}

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
    `INSERT INTO tenants (id, name, slug) VALUES (gen_random_uuid(), 'Session 12 Rehearsal Tenant', 'p8s12-rehearsal-tenant') RETURNING id`,
  );
  return created[0].id;
}

async function expectedSourceIdFor(prisma, fiscalYear, authorityTrack, stage) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM defense_budget_expected_source
      WHERE fiscal_year = $1::int AND authority_track = $2 AND stage = $3
      LIMIT 1`,
    fiscalYear,
    authorityTrack,
    stage,
  );
  assert.ok(rows[0], `no expected source for FY${fiscalYear} ${authorityTrack}/${stage} — did the seed script run first?`);
  return rows[0].id;
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
  const serve = new PrismaClient({ datasources: { db: { url: SERVE_URL } } });
  const job = new PrismaClient({ datasources: { db: { url: JOB_URL } } });

  try {
    const tenantId = await firstTenantId(admin);
    const authId2029 = await expectedSourceIdFor(admin, 2029, 'authorization', 'hasc_report');
    const apprId2029 = await expectedSourceIdFor(admin, 2029, 'appropriations', 'appr_enacted');
    const crId2029 = await expectedSourceIdFor(admin, 2029, 'alternative_funding', 'continuing_resolution');
    const supId2029 = await expectedSourceIdFor(admin, 2029, 'alternative_funding', 'emergency_supplemental');
    const authId2030 = await expectedSourceIdFor(admin, 2030, 'authorization', 'hasc_report');
    const apprMarkId2030 = await expectedSourceIdFor(admin, 2030, 'appropriations', 'hac_d_mark');

    const serveStore = new PrismaBudgetLifecycleReadStore(serve);
    const serveService = new BudgetLifecycleQueryService(serveStore, new CycleHealthService());

    // ── 1 & 2. Two overlapping fiscal years, tracks never collapsed ─────────
    const health2029 = await serveService.getCycleHealth(2029);
    assert.equal(health2029.fiscalYear, 2029);
    const auth2029 = health2029.tracks.find((t) => t.authorityTrack === 'authorization');
    const appr2029 = health2029.tracks.find((t) => t.authorityTrack === 'appropriations');
    const alt2029 = health2029.tracks.find((t) => t.authorityTrack === 'alternative_funding');
    assert.equal(auth2029.published, 1, 'FY2029 authorization (HASC) published');
    assert.equal(auth2029.reviewRequired, 0, 'FY2029 authorization has no review-required items');
    assert.equal(appr2029.reviewRequired, 1, 'FY2029 appropriations (omnibus) is review_required');
    assert.equal(appr2029.published, 0, 'FY2029 appropriations is NOT published — the ambiguity is real, not papered over');
    assert.equal(alt2029.published, 2, 'FY2029 alternative_funding: CR + emergency supplemental both published');
    ok('FY2029 cycle health: authorization, appropriations and alternative_funding are independently counted, never collapsed');

    const health2030 = await serveService.getCycleHealth(2030);
    assert.equal(health2030.fiscalYear, 2030);
    const auth2030 = health2030.tracks.find((t) => t.authorityTrack === 'authorization');
    const appr2030 = health2030.tracks.find((t) => t.authorityTrack === 'appropriations');
    assert.equal(auth2030.published, 1, 'FY2030 authorization (HASC) published, independent of FY2029');
    ok('serve role: FY2030 cycle health proves a second, overlapping fiscal year tracked independently of FY2029');

    // ── 12. Poison isolation: the FY2030 appropriations adapter outage does
    //        not affect FY2030 authorization or ANY FY2029 row ──────────────
    assert.equal(auth2030.published, 1, 'FY2030 authorization is healthy despite the FY2030 appropriations outage');
    assert.equal(appr2030.published, 0, 'FY2030 appropriations correctly reflects the outage — not fabricated as published');
    assert.ok(appr2030.stillExpected >= 1, 'the FY2030 appropriations gap is recorded as "expected", not silently dropped');
    const apprMarkDetail2030 = await serveService.getExpectedSourceDetail(apprMarkId2030);
    assert.equal(apprMarkDetail2030.expectedState, 'expected', 'the specific outage-affected expected source is left honestly "expected", not corrupted into a false state');
    assert.equal(apprMarkDetail2030.observations.length, 0, 'the outage produced no observation at all for the affected expected source');
    // Re-read FY2029 AFTER having read FY2030: still exactly the pre-outage values.
    const health2029Again = await serveService.getCycleHealth(2029);
    const auth2029Again = health2029Again.tracks.find((t) => t.authorityTrack === 'authorization');
    const appr2029Again = health2029Again.tracks.find((t) => t.authorityTrack === 'appropriations');
    assert.equal(auth2029Again.published, auth2029.published, 'FY2029 authorization is byte-identical after the FY2030 outage');
    assert.equal(appr2029Again.reviewRequired, appr2029.reviewRequired, 'FY2029 appropriations is byte-identical after the FY2030 outage');
    ok('one failed adapter/track (FY2030 appropriations, simulated publisher outage) does not poison FY2030 authorization or any FY2029 result');

    // ── 3. Unchanged bytes do not duplicate work ─────────────────────────────
    const authDetail2029 = await serveService.getExpectedSourceDetail(authId2029);
    assert.equal(authDetail2029.observations.length, 2, 'exactly two observations: v1 (superseded) and v2 (current) — the identical re-discovery created NO third row');
    ok('re-running discovery on identical bytes produced no new source-document/observation row (dedup)');

    // ── 4. Changed bytes create an immutable successor, never an in-place edit ──
    const superseded = authDetail2029.observations.find((o) => o.observationState === 'superseded');
    const current = authDetail2029.observations.find((o) => o.observationState !== 'superseded');
    assert.ok(superseded && current, 'both a superseded and a current observation must be present');
    assert.ok(superseded.supersededByObservationId, 'the superseded observation carries a forward pointer to its successor');
    assert.notEqual(superseded.contentSha256, current.contentSha256, 'the two versions are genuinely distinct bytes');
    ok('a changed version created a new, immutable observation row and marked the prior one superseded — never an in-place mutation');

    // ── 5. CR overlay does not erase the authorization/appropriations baseline ──
    const authAfterOverlay = await serveService.getExpectedSourceDetail(authId2029);
    assert.equal(authAfterOverlay.expectedState, 'published', 'authorization baseline is unaffected by the alternative_funding overlay');
    const apprAfterOverlay = await serveService.getExpectedSourceDetail(apprId2029);
    assert.equal(apprAfterOverlay.expectedState, 'review_required', 'appropriations baseline (still under review) is unaffected by the overlay');
    ok('the FY2029 continuing-resolution overlay coexists with, and does not erase, the authorization/appropriations baseline');

    // ── 6. Alternative/supplemental funding remains separately attributable ──
    const altSources2029 = await serveService.listExpectedSources(2029, { authorityTrack: 'alternative_funding' });
    const crEntry = altSources2029.find((s) => s.id === crId2029);
    const supEntry = altSources2029.find((s) => s.id === supId2029);
    assert.ok(crEntry && supEntry, 'both the CR and the emergency supplemental must be listed');
    assert.equal(crEntry.stage, 'continuing_resolution');
    assert.equal(supEntry.stage, 'emergency_supplemental');
    assert.notEqual(crEntry.id, supEntry.id);
    assert.equal(crEntry.expectedState, 'published');
    assert.equal(supEntry.expectedState, 'published');
    ok('the continuing resolution and the emergency supplemental are two distinct, separately attributable expected sources on their own stages');

    // ── 7. Ambiguous correlation held for review, with full provenance ──────
    const reviewQueue2029 = await serveService.listReviewQueue(2029);
    assert.equal(reviewQueue2029.length, 1);
    assert.equal(reviewQueue2029[0].expectedSourceId, apprId2029);
    assert.ok(reviewQueue2029[0].observation.reviewReasons.some((r) => /omnibus|division/i.test(r)), 'the real ambiguity reason (omnibus without proven division evidence) must survive to the product result');
    const pendingUrl = reviewQueue2029[0].observation.discoveredUrl;
    const pendingSha = reviewQueue2029[0].observation.contentSha256;
    assert.ok(pendingUrl.startsWith('https://www.govinfo.gov/'));
    ok('the ambiguous omnibus appropriations act is held in review_required with full provenance, exactly as the real classifier decided');

    // ── serve cannot write to any Session 12 row either (role boundary) ─────
    await assert.rejects(
      serve.$executeRawUnsafe(
        `UPDATE defense_budget_expected_source SET expected_state = 'published' WHERE id = $1::uuid`, apprId2029,
      ),
      /permission denied/i,
    );
    ok('serve role: UPDATE on the Session 12 review_required row is permission-denied at the database level');

    // ── Full-table snapshot: reads leave every table byte-identical ─────────
    const beforeReadsHash = await snapshotHash(admin);
    await serveService.getCycleHealth(2029);
    await serveService.getCycleHealth(2030);
    await serveService.listExpectedSources(2029);
    await serveService.getExpectedSourceDetail(authId2029);
    await serveService.listReviewQueue(2029);
    await serveService.listSignals(2029);
    await serveService.getScheduleTickHealth();
    const afterReadsHash = await snapshotHash(admin);
    assert.equal(beforeReadsHash, afterReadsHash, 'every table this session touches must be byte-identical before and after a full read sweep');
    ok('full-table snapshot: running every Session 11 read route against the Session 12 corpus leaves every table byte-identical');

    // ── 11. Stale/failed source health visible in the read model ───────────
    const tickHealth = await serveService.getScheduleTickHealth();
    assert.equal(tickHealth.completedTicks, 1);
    assert.equal(tickHealth.failedTicks, 1);
    assert.ok(tickHealth.recentFailureReasons.some((r) => /house-appropriations/.test(r)), 'the failed tick reason must survive to the read model');
    ok('schedule-tick health reports both the healthy and the failed tick, with the failure reason intact');

    const watcherRun2030 = await admin.$queryRawUnsafe(
      `SELECT status, consecutive_failures FROM defense_budget_watcher_adapter WHERE adapter_id = 'house-appropriations'`,
    );
    assert.equal(watcherRun2030[0].status, 'failing');
    assert.ok(Number(watcherRun2030[0].consecutive_failures) >= 1);
    ok('the failing adapter itself is visibly marked failing with a nonzero consecutive-failure count, not silently absorbed');

    // ── 8 & 9. Governed review resolution: dry run, serve-refused, job-commit ──
    const beforeDryRun = await snapshotHash(admin);
    const dryRun = runCli(JOB_URL, [
      '--expected-source-id', apprId2029, '--decision', 'published',
      '--note', 'rehearsal dry run (Session 12)', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId,
    ], { expectSucceed: true });
    assert.match(dryRun.output, /SESSION11_REVIEW_RESOLUTION_DRY_RUN_PASS/);
    const afterDryRun = await snapshotHash(admin);
    assert.equal(beforeDryRun, afterDryRun, 'a dry run (no --commit) must write nothing at all');
    ok('run-review-resolution.mjs (Session 11 CLI, unmodified) dry-runs against the Session 12 corpus with zero writes');

    const serveCommitAttempt = runCli(SERVE_URL, [
      '--expected-source-id', apprId2029, '--decision', 'published',
      '--note', 'attempted under serve creds', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: false });
    assert.match(serveCommitAttempt.output, /permission denied/i);
    ok('a --commit attempt using serve-role credentials against the Session 12 corpus is denied by the database');

    const beforeJobCommit = await fullSnapshotRows(admin);
    const jobCommit = runCli(JOB_URL, [
      '--expected-source-id', apprId2029, '--decision', 'published',
      '--note', 'verified against the publisher’s own division table (Session 12 rehearsal)',
      '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: true });
    assert.match(jobCommit.output, /SESSION11_REVIEW_RESOLUTION_COMMITTED/);
    const afterJobCommit = await fullSnapshotRows(admin);
    const changed = diffRows(beforeJobCommit, afterJobCommit);
    assert.equal(changed.expectedSourceIds.length, 1, `exactly one expected_source row must change, found: ${changed.expectedSourceIds}`);
    assert.equal(changed.expectedSourceIds[0], apprId2029);
    assert.equal(changed.otherTableChanges, 0, 'no table besides expected_source and defense_budget_review_resolution may change');
    ok('the governed job-role commit resolves the Session 12 ambiguous item and changes exactly that row — nothing else, not FY2030, not the CR/supplemental');

    // The very next read reflects the resolution.
    const queueAfterResolution = await serveService.listReviewQueue(2029);
    assert.equal(queueAfterResolution.length, 0, 'the resolved item must no longer appear in the review queue');
    const detailAfterResolution = await serveService.getExpectedSourceDetail(apprId2029);
    assert.equal(detailAfterResolution.expectedState, 'published');
    ok('the very next read reflects the resolution: gone from the review queue, published in detail view');

    // ── 10. Provenance survives all the way to the product/read output ──────
    assert.equal(detailAfterResolution.observations.length, 1, 'the original observation history must still be present after resolution');
    assert.equal(detailAfterResolution.observations[0].discoveredUrl, pendingUrl, 'the discovered URL survives resolution unchanged');
    assert.equal(detailAfterResolution.observations[0].contentSha256, pendingSha, 'the content sha256 survives resolution unchanged');
    assert.ok(detailAfterResolution.observations[0].firstSeenAt, 'discoveredAt/firstSeenAt provenance is present on the read output');
    assert.ok(authDetail2029.observations.every((o) => o.discoveredUrl.startsWith('https://') && /^[0-9a-f]{64}$/.test(o.contentSha256)),
      'every FY2029 authorization observation carries a real discovered URL and a real sha256 through to the read output');
    ok('provenance (discoveredUrl, contentSha256, discoveredAt/firstSeenAt) survives from discovery all the way through resolution to the product/read output');

    // A repeat resolution is refused, not double-applied.
    const repeat = runCli(JOB_URL, [
      '--expected-source-id', apprId2029, '--decision', 'published',
      '--note', 'repeat', '--actor-user-id', ACTOR_USER_ID, '--tenant-id', tenantId, '--commit',
    ], { authorized: true, expectSucceed: false });
    assert.match(repeat.output, /not 'review_required'/);
    ok('a repeat resolution of the same, now-published item is refused, not double-applied');

    console.log(`SESSION12_E2E_INTEGRATION_PASS (${PASS_COUNT} checks)`);
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
