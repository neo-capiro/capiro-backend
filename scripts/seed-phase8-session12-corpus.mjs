#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Phase 8 Session 12 — disposable-database rehearsal corpus.
 *
 * Unlike the Session 11 corpus script (`seed-phase8-session11-corpus.mjs`),
 * which inserts the FINAL row state directly, this script drives the REAL
 * compiled Session 7 control loop — `AnnualDefenseBudgetCycleController` +
 * `DefenseBudgetLifecycleWatcher`, backed by the REAL `PrismaLifecycleStore`
 * against this rehearsal database — through fixture discovery/fetch ports
 * (no network, following the exact non-network technique
 * `apps/defense-api/src/budget-lifecycle/testing/fixture-ports.ts` already
 * established for Session 7's own domain tests). This is deliberately a
 * behavioral corpus, not a final-state corpus: dedup, versioning/supersession
 * and adapter-failure isolation are proven by actually running the discovery
 * -> classify -> compare -> persist/version chain twice over real data, not
 * by asserting a pre-baked row is shaped correctly.
 *
 * Scenario, spanning two fiscal years (FY2029, FY2030), titles and excerpts
 * adapted from the same real, publicly-published document wording Sessions 7
 * and 11 already used (year changed only — same technique Session 10's
 * FY2032 merge-gate proof used):
 *
 *  FY2029 authorization  — HASC report, discovered twice identically (dedup
 *                          proof), then a corrected v2 supersedes v1 (version
 *                          proof)
 *  FY2029 appropriations — an omnibus/consolidated appropriations act with NO
 *                          proven Department of Defense division evidence:
 *                          real Session 7 ambiguity case, ambiguous ->
 *                          review_required (resolved later by the governed
 *                          CLI, see verify-phase8-session12-e2e.mjs)
 *  FY2029 alt. funding   — a continuing resolution (CR) AND a separate
 *                          emergency supplemental, both published: proves the
 *                          CR overlay does not erase the authorization/
 *                          appropriations baseline, and that CR + supplemental
 *                          remain separately attributable on their own stages
 *  FY2030 authorization  — HASC report, discovered and published successfully
 *  FY2030 appropriations — a DIFFERENT adapter (house-appropriations) whose
 *                          discovery is made to fail outright (simulated
 *                          publisher outage), proving one failed adapter/track
 *                          does not poison the healthy authorization track in
 *                          the SAME fiscal year, nor FY2029 at all
 *
 * No monetary data is seeded or invented anywhere: this domain carries none by
 * construction (see the Session 7 design doc).
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'apps/defense-api');

const usage = 'Usage: node scripts/seed-phase8-session12-corpus.mjs [--help] (requires DATABASE_URL for seeding)';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (process.argv.length !== 2 || !process.env.DATABASE_URL?.trim()) {
  console.error(usage);
  process.exit(2);
}

const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
const { AnnualDefenseBudgetCycleController } = require(
  path.join(appRoot, 'dist/budget-lifecycle/annual-cycle-controller.service.js'),
);
const { DefenseBudgetLifecycleWatcher } = require(
  path.join(appRoot, 'dist/budget-lifecycle/lifecycle-watcher.service.js'),
);
const { SourceAdapterRegistry } = require(
  path.join(appRoot, 'dist/budget-lifecycle/source-adapter.registry.js'),
);
const { PrismaLifecycleStore } = require(
  path.join(appRoot, 'dist/budget-lifecycle/prisma-lifecycle.store.js'),
);
const { FixtureDiscoveryPort, FixtureFetchPort } = require(
  path.join(appRoot, 'dist/budget-lifecycle/testing/fixture-ports.js'),
);

const sha = (seed) => createHash('sha256').update(`phase8-session12-rehearsal:${seed}`).digest('hex');
const NOW_ISO = new Date().toISOString();

const prisma = new PrismaClient();
const registry = new SourceAdapterRegistry();
const store = new PrismaLifecycleStore(prisma);
const controller = new AnnualDefenseBudgetCycleController(store);

/** A discovery port that fails outright for one named adapter, to simulate a
 * real publisher outage — the whole `discover()` call throws, exactly what
 * makes `DefenseBudgetLifecycleWatcher.runAdapter` record `status: 'failed'`
 * rather than merely one blocked candidate. */
class FailingAdapterDiscoveryPort {
  constructor(delegate, failingAdapterId) {
    this.delegate = delegate;
    this.failingAdapterId = failingAdapterId;
  }
  async discover(input) {
    if (input.adapterId === this.failingAdapterId) {
      throw new Error(
        `simulated publisher outage for ${this.failingAdapterId} (Session 12 poison-isolation rehearsal)`,
      );
    }
    return this.delegate.discover(input);
  }
}

const GOVINFO = 'https://www.govinfo.gov/content/pkg';
const pdf = (id) => `${GOVINFO}/${id}/pdf/${id}.pdf`;

// ── FY2029 authorization: HASC report, real wording pattern, year changed ──
const FY2029_HASC_V1 = {
  key: 'p8s12-fy2029-hasc-v1',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-999hrpt225'),
  packageId: 'CRPT-999hrpt225',
  title: 'House Report 999-225 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2029',
  contentExcerpt:
    'House Report 999-225 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2029 ' +
    '[House Report 999-225] [From the U.S. Government Publishing Office] 999th Congress ' +
    'HOUSE OF REPRESENTATIVES Report 999-225 NATIONAL DEFENSE AUTHORIZATION ACT FOR ' +
    'FISCAL YEAR 2029 REPORT of the COMMITTEE ON ARMED SERVICES',
  versionRank: 1,
  shaSeed: 'p8s12-crpt-999hrpt225-v1',
};
const FY2029_HASC_V2_CORRECTED = {
  ...FY2029_HASC_V1,
  key: 'p8s12-fy2029-hasc-v2-corrected',
  url: pdf('CRPT-999hrpt225-corrected'),
  title: 'House Report 999-225 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2029 (corrected)',
  versionRank: 2,
  shaSeed: 'p8s12-crpt-999hrpt225-v2-corrected',
};

// ── FY2029 appropriations: real Session 7 ambiguity case, year changed ─────
// A consolidated/omnibus appropriations act with the division evidence
// withheld. This is the real ambiguous scenario Session 7's own corpus
// proved cannot be faked by inventing a phrase: the pattern is
// `(consolidated|omnibus|further consolidated) appropriations` with no
// `division ... defense` evidence anywhere in the text.
const FY2029_OMNIBUS_NO_DIVISION = {
  key: 'p8s12-fy2029-omnibus-no-division',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-999publ301'),
  packageId: 'PLAW-999publ301',
  title: 'Public Law 999-301 - Further Consolidated Appropriations Act, 2029',
  contentExcerpt:
    '[999th Congress Public Law 301] [From the U.S. Government Publishing Office] FURTHER ' +
    'CONSOLIDATED APPROPRIATIONS ACT, 2029 Public Law 999-301 999th Congress An Act Making ' +
    'further consolidated appropriations for the fiscal year ending September 30, 2029, ' +
    'and for other purposes.',
  divisionEvidence: null,
  shaSeed: 'p8s12-plaw-999publ301-no-division',
};

// ── FY2029 alternative funding: CR overlay + a separately-attributable
//    emergency supplemental. Both coexist with, and do not erase, the
//    authorization/appropriations baseline above. ──────────────────────────
const FY2029_CONTINUING_RESOLUTION = {
  key: 'p8s12-fy2029-cr',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-999publ280'),
  packageId: 'PLAW-999publ280',
  title: 'Public Law 999-280 - Continuing Appropriations Act, 2029',
  contentExcerpt:
    '[999th Congress Public Law 280] [From the U.S. Government Publishing Office] MAKING ' +
    'FURTHER CONTINUING APPROPRIATIONS FOR THE FISCAL YEAR ENDING SEPTEMBER 30, 2029, AND ' +
    'FOR OTHER PURPOSES. Public Law 999-280 Continuing Appropriations Act, 2029 999th ' +
    'Congress An Act making continuing appropriations for the fiscal year ending ' +
    'September 30, 2029.',
  shaSeed: 'p8s12-plaw-999publ280-cr',
};
const FY2029_EMERGENCY_SUPPLEMENTAL = {
  key: 'p8s12-fy2029-emergency-supplemental',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-999publ290'),
  packageId: 'PLAW-999publ290',
  title: 'Public Law 999-290 - Security Supplemental Appropriations Act, 2029',
  contentExcerpt:
    '[999th Congress Public Law 290] MAKING EMERGENCY SUPPLEMENTAL APPROPRIATIONS FOR THE ' +
    'FISCAL YEAR ENDING SEPTEMBER 30, 2029, AND FOR OTHER PURPOSES. Public Law 999-290 ' +
    'SECURITY SUPPLEMENTAL APPROPRIATIONS ACT, 2029 ... emergency supplemental ' +
    'appropriations for fiscal year 2029',
  shaSeed: 'p8s12-plaw-999publ290-supplemental',
};

// ── FY2030 authorization: healthy, published ────────────────────────────────
const FY2030_HASC = {
  key: 'p8s12-fy2030-hasc',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-999hrpt226'),
  packageId: 'CRPT-999hrpt226',
  title: 'House Report 999-226 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2030',
  contentExcerpt:
    'House Report 999-226 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2030 ' +
    '[House Report 999-226] [From the U.S. Government Publishing Office] 999th Congress ' +
    'HOUSE OF REPRESENTATIVES Report 999-226 NATIONAL DEFENSE AUTHORIZATION ACT FOR ' +
    'FISCAL YEAR 2030 REPORT of the COMMITTEE ON ARMED SERVICES',
  shaSeed: 'p8s12-crpt-999hrpt226',
};
// FY2030 appropriations deliberately has NO fixture at all: the adapter that
// would carry it (house-appropriations) is made to fail outright below, so
// nothing is ever discovered for it, exactly the honest "not_filed/expected"
// gap this domain records rather than fabricating.
const FAILING_ADAPTER_ID = 'house-appropriations';

async function findExpectedSource(fiscalYear, authorityTrack, stage) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, dedup_key FROM defense_budget_expected_source
      WHERE fiscal_year = $1::int AND authority_track = $2 AND stage = $3
      LIMIT 1`,
    fiscalYear,
    authorityTrack,
    stage,
  );
  if (!rows[0]) {
    throw new Error(`No templated expected source for FY${fiscalYear} ${authorityTrack}/${stage}`);
  }
  return rows[0];
}

async function countObservations(expectedSourceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM defense_budget_source_observation WHERE expected_source_id = $1::uuid`,
    expectedSourceId,
  );
  return Number(rows[0].n);
}

async function runOnce(watcher, adapterId, runKeySuffix) {
  return watcher.runAdapter({
    adapterId,
    nowIso: NOW_ISO,
    leaseOwner: `p8s12-seed-${process.pid}`,
    runKey: `p8s12-seed-${adapterId}-${runKeySuffix}`,
    commit: true,
  });
}

async function main() {
  console.log('[phase8-session12-seed] 1. bootstrapping FY2029 and FY2030 (all five tracks each)');
  const summary2029 = await controller.ensureFiscalYear({ fiscalYear: 2029 });
  const summary2030 = await controller.ensureFiscalYear({ fiscalYear: 2030 });
  if (summary2029.cyclesEnsured !== 5 || summary2030.cyclesEnsured !== 5) {
    throw new Error('expected all five authority tracks to bootstrap for both fiscal years');
  }

  // ── FY2029 authorization: discover v1, re-discover identically (dedup),
  //    then discover a corrected v2 (immutable successor / supersession) ────
  console.log('[phase8-session12-seed] 2. FY2029 authorization: first discovery');
  const authExpected = await findExpectedSource(2029, 'authorization', 'hasc_report');
  const discoveryV1 = new FixtureDiscoveryPort([
    { source: FY2029_HASC_V1, expectedSourceDedupKey: authExpected.dedup_key },
  ]);
  const fetchV1 = new FixtureFetchPort([
    { source: FY2029_HASC_V1, expectedSourceDedupKey: authExpected.dedup_key },
  ]);
  const watcherAuth = new DefenseBudgetLifecycleWatcher(registry, controller, store, discoveryV1, fetchV1);
  const runV1 = await runOnce(watcherAuth, 'govinfo-committee-reports', 'v1');
  if (runV1.outcomes[0]?.outcome !== 'first_discovery') {
    throw new Error(`expected first_discovery, got ${JSON.stringify(runV1.outcomes)}`);
  }
  const countAfterV1 = await countObservations(authExpected.id);

  console.log('[phase8-session12-seed] 3. FY2029 authorization: re-discovering identical bytes (dedup proof)');
  const runV1Repeat = await runOnce(watcherAuth, 'govinfo-committee-reports', 'v1-repeat');
  if (runV1Repeat.outcomes[0]?.outcome !== 'unchanged') {
    throw new Error(`expected unchanged on repeat discovery, got ${JSON.stringify(runV1Repeat.outcomes)}`);
  }
  const countAfterRepeat = await countObservations(authExpected.id);
  if (countAfterRepeat !== countAfterV1) {
    throw new Error(
      `unchanged bytes must not create a new observation row: before=${countAfterV1} after=${countAfterRepeat}`,
    );
  }

  console.log('[phase8-session12-seed] 4. FY2029 authorization: corrected version supersedes v1');
  const discoveryV2 = new FixtureDiscoveryPort([
    { source: FY2029_HASC_V2_CORRECTED, expectedSourceDedupKey: authExpected.dedup_key },
  ]);
  const fetchV2 = new FixtureFetchPort([
    { source: FY2029_HASC_V2_CORRECTED, expectedSourceDedupKey: authExpected.dedup_key },
  ]);
  const watcherAuthV2 = new DefenseBudgetLifecycleWatcher(registry, controller, store, discoveryV2, fetchV2);
  const runV2 = await runOnce(watcherAuthV2, 'govinfo-committee-reports', 'v2-corrected');
  if (runV2.outcomes[0]?.outcome !== 'superseding_version') {
    throw new Error(`expected superseding_version, got ${JSON.stringify(runV2.outcomes)}`);
  }
  const countAfterV2 = await countObservations(authExpected.id);
  if (countAfterV2 !== countAfterV1 + 1) {
    throw new Error(
      `a genuinely changed version must create exactly one new observation row: before=${countAfterV1} after=${countAfterV2}`,
    );
  }

  // ── FY2029 appropriations: the real Session 7 ambiguity case ────────────
  console.log('[phase8-session12-seed] 5. FY2029 appropriations: ambiguous omnibus (no division evidence) -> review_required');
  const apprExpected = await findExpectedSource(2029, 'appropriations', 'appr_enacted');
  const discoveryOmnibus = new FixtureDiscoveryPort([
    { source: FY2029_OMNIBUS_NO_DIVISION, expectedSourceDedupKey: apprExpected.dedup_key },
  ]);
  const fetchOmnibus = new FixtureFetchPort([
    { source: FY2029_OMNIBUS_NO_DIVISION, expectedSourceDedupKey: apprExpected.dedup_key },
  ]);
  const watcherAppr = new DefenseBudgetLifecycleWatcher(registry, controller, store, discoveryOmnibus, fetchOmnibus);
  const runOmnibus = await runOnce(watcherAppr, 'govinfo-public-laws', 'omnibus');
  if (runOmnibus.outcomes[0]?.outcome !== 'review_required') {
    throw new Error(`expected review_required, got ${JSON.stringify(runOmnibus.outcomes)}`);
  }

  // ── FY2029 alternative funding: CR overlay + separate supplemental ───────
  console.log('[phase8-session12-seed] 6. FY2029 alternative_funding: continuing resolution overlay');
  const crExpected = await findExpectedSource(2029, 'alternative_funding', 'continuing_resolution');
  const discoveryCr = new FixtureDiscoveryPort([
    { source: FY2029_CONTINUING_RESOLUTION, expectedSourceDedupKey: crExpected.dedup_key },
  ]);
  const fetchCr = new FixtureFetchPort([
    { source: FY2029_CONTINUING_RESOLUTION, expectedSourceDedupKey: crExpected.dedup_key },
  ]);
  const watcherCr = new DefenseBudgetLifecycleWatcher(registry, controller, store, discoveryCr, fetchCr);
  const runCr = await runOnce(watcherCr, 'govinfo-public-laws', 'cr');
  if (runCr.outcomes[0]?.outcome !== 'first_discovery') {
    throw new Error(`expected the CR to classify and publish, got ${JSON.stringify(runCr.outcomes)}`);
  }

  console.log('[phase8-session12-seed] 7. FY2029 alternative_funding: emergency supplemental (separately attributable)');
  const supExpected = await findExpectedSource(2029, 'alternative_funding', 'emergency_supplemental');
  const discoverySup = new FixtureDiscoveryPort([
    { source: FY2029_EMERGENCY_SUPPLEMENTAL, expectedSourceDedupKey: supExpected.dedup_key },
  ]);
  const fetchSup = new FixtureFetchPort([
    { source: FY2029_EMERGENCY_SUPPLEMENTAL, expectedSourceDedupKey: supExpected.dedup_key },
  ]);
  const watcherSup = new DefenseBudgetLifecycleWatcher(registry, controller, store, discoverySup, fetchSup);
  const runSup = await runOnce(watcherSup, 'govinfo-public-laws', 'supplemental');
  if (runSup.outcomes[0]?.outcome !== 'first_discovery') {
    throw new Error(`expected the supplemental to classify and publish, got ${JSON.stringify(runSup.outcomes)}`);
  }

  // ── FY2029 authorization/appropriations must be UNCHANGED by the CR/supplemental ──
  const authAfterOverlay = await prisma.$queryRawUnsafe(
    `SELECT expected_state FROM defense_budget_expected_source WHERE id = $1::uuid`,
    authExpected.id,
  );
  if (authAfterOverlay[0].expected_state !== 'published') {
    throw new Error('the CR/supplemental overlay must not disturb the authorization baseline');
  }

  // ── FY2030 authorization: healthy discovery, published ───────────────────
  console.log('[phase8-session12-seed] 8. FY2030 authorization: healthy discovery');
  const auth2030Expected = await findExpectedSource(2030, 'authorization', 'hasc_report');
  const discovery2030 = new FixtureDiscoveryPort([
    { source: FY2030_HASC, expectedSourceDedupKey: auth2030Expected.dedup_key },
  ]);
  const fetch2030 = new FixtureFetchPort([
    { source: FY2030_HASC, expectedSourceDedupKey: auth2030Expected.dedup_key },
  ]);
  const watcher2030Auth = new DefenseBudgetLifecycleWatcher(registry, controller, store, discovery2030, fetch2030);
  const run2030Auth = await runOnce(watcher2030Auth, 'govinfo-committee-reports', 'fy2030');
  if (run2030Auth.status !== 'succeeded' || run2030Auth.outcomes[0]?.outcome !== 'first_discovery') {
    throw new Error(`expected FY2030 authorization to succeed, got ${JSON.stringify(run2030Auth)}`);
  }

  // ── FY2030 appropriations: adapter fails outright (poison-isolation proof) ──
  console.log('[phase8-session12-seed] 9. FY2030 appropriations: simulated adapter outage (poison-isolation proof)');
  const emptyDiscovery = new FixtureDiscoveryPort([]);
  const emptyFetch = new FixtureFetchPort([]);
  const failingDiscovery = new FailingAdapterDiscoveryPort(emptyDiscovery, FAILING_ADAPTER_ID);
  const watcherFailing = new DefenseBudgetLifecycleWatcher(registry, controller, store, failingDiscovery, emptyFetch);
  const runFailing = await runOnce(watcherFailing, FAILING_ADAPTER_ID, 'fy2030-outage');
  if (runFailing.status !== 'failed') {
    throw new Error(`expected the simulated outage to produce status=failed, got ${JSON.stringify(runFailing)}`);
  }

  // Prove the failure did not touch FY2030 authorization or any FY2029 row.
  const auth2030After = await prisma.$queryRawUnsafe(
    `SELECT expected_state FROM defense_budget_expected_source WHERE id = $1::uuid`,
    auth2030Expected.id,
  );
  if (auth2030After[0].expected_state !== 'published') {
    throw new Error('the FY2030 appropriations outage must not affect FY2030 authorization');
  }
  const fy2029StillIntact = await prisma.$queryRawUnsafe(
    `SELECT expected_state FROM defense_budget_expected_source WHERE id = $1::uuid`,
    authExpected.id,
  );
  if (fy2029StillIntact[0].expected_state !== 'published') {
    throw new Error('the FY2030 appropriations outage must not affect any FY2029 row');
  }

  // ── Schedule ticks: one completed, one failed (tick-health read model) ───
  // Same precedent as Session 11's own corpus: this is read-only aggregation
  // over already-persisted tick summaries (buildScheduleTickHealth), not a
  // scheduler activation. Seeded directly, exactly like Session 11 did, since
  // exercising the real ScheduleCoordinatorService is Session 10's own
  // covered territory (schedule-coordinator.spec.ts) and not what this
  // fiscal-year/track independence proof is about.
  console.log('[phase8-session12-seed] 10. seeding one healthy + one failed schedule tick (tick-health read model)');
  await prisma.$executeRawUnsafe(
    `INSERT INTO defense_budget_schedule_tick
       (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
        adapters_considered, adapters_due, adapters_succeeded, adapters_failed, adapters_skipped_lease,
        committed, failure_reason)
     VALUES
      ('p8s12-rehearsal-worker','p8s12-rehearsal-tick-1', now() - interval '20 minutes', now() - interval '15 minutes',
       'completed', false, 14, 2, 2, 0, 0, true, NULL),
      ('p8s12-rehearsal-worker','p8s12-rehearsal-tick-2', now() - interval '6 days 1 hour', now() - interval '6 days',
       'failed', false, 14, 1, 0, 1, 0, true, 'house-appropriations: simulated publisher outage')
     ON CONFLICT (worker_id, tick_key) DO NOTHING`,
  );

  console.log('SESSION12_REHEARSAL_CORPUS_SEEDED');
  console.log(
    JSON.stringify(
      {
        FY2029_AUTH_EXPECTED_SOURCE_ID: authExpected.id,
        FY2029_APPR_EXPECTED_SOURCE_ID: apprExpected.id,
        FY2029_CR_EXPECTED_SOURCE_ID: crExpected.id,
        FY2029_SUPPLEMENTAL_EXPECTED_SOURCE_ID: supExpected.id,
        FY2030_AUTH_EXPECTED_SOURCE_ID: auth2030Expected.id,
        FAILING_ADAPTER_ID,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
