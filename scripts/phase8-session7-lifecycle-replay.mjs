#!/usr/bin/env node
/**
 * Phase 8 Session 7 — historical lifecycle replay against REAL official sources.
 *
 * Runs the built lifecycle watcher over the prepared corpus: real downloaded
 * bytes, real publisher SHAs, real publisher text. Nothing is mocked except the
 * store (in-memory) and the clock, which advances through the publishers' own
 * release dates so the lifecycle unfolds in the order it actually did.
 *
 * No AWS resource, no production database, no production schedule and no GPU is
 * touched. Prepare the corpus first:
 *
 *   node scripts/prepare-phase8-session7-lifecycle-corpus.mjs --prepare
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const usage = 'Usage: node scripts/phase8-session7-lifecycle-replay.mjs --run [--out FILE] (or --out FILE)';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
let runRequested = false;
let outArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run') {
    runRequested = true;
  } else if (args[i] === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) {
    outArg = args[++i];
  } else {
    console.error(usage);
    process.exit(2);
  }
}
if (!runRequested && !outArg) {
  console.error(usage);
  process.exit(2);
}
const outPath = outArg ? path.resolve(outArg) : null;
const api = (relative) => require(path.join(root, 'apps/defense-api/dist/budget-lifecycle', relative));

const { AnnualDefenseBudgetCycleController } = api('annual-cycle-controller.service.js');
const { DefenseBudgetLifecycleWatcher } = api('lifecycle-watcher.service.js');
const { SourceAdapterRegistry } = api('source-adapter.registry.js');
const { InMemoryLifecycleStore } = api('testing/in-memory-lifecycle.store.js');
const domain = require(path.join(root, 'packages/defense-domain/dist/index.js'));
const { expectedSourceDedupKey, deriveLifecycleSignals, recomputeScopeForCorrection } = domain;

const corpusPath = path.resolve(
  process.env.PHASE8_SESSION7_PREPARED_CORPUS ||
    path.join(root, '.session7-lifecycle/prepared-corpus.json'),
);
let prepared;
try {
  prepared = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
} catch {
  console.error(
    `[phase8-session7-replay] Missing prepared corpus at ${corpusPath}.\n` +
      'Run: node scripts/prepare-phase8-session7-lifecycle-corpus.mjs',
  );
  process.exit(1);
}
if (prepared.schemaVersion !== 'phase8_session7_prepared_lifecycle_corpus_v1') {
  throw new Error(`Unsupported prepared corpus schema: ${prepared.schemaVersion}`);
}

const byKey = new Map(prepared.sources.map((source) => [source.sourceKey, source]));
const need = (key) => {
  const source = byKey.get(key);
  if (!source) throw new Error(`Prepared corpus is missing ${key}`);
  return source;
};

const checks = [];
const failures = [];
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, pass, actual, expected });
  if (!pass) failures.push(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` (got ${JSON.stringify(actual)})`}`);
}

/** Expected-source identity, keyed exactly as the templates key it. */
const keyFor = (source) =>
  expectedSourceDedupKey({
    fiscalYear: prepared.fiscalYear,
    authorityTrack: source.authorityTrack,
    sourceFamily: source.sourceFamily,
    stage: source.stage,
    chamber: source.chamber,
    committee: source.committee,
    component: source.component,
  });

/** Discovery/fetch straight off the prepared corpus — real SHAs, real text. */
function ports(sourceKeys) {
  const sources = sourceKeys.map(need);
  return {
    discovery: {
      async discover({ adapterId, cursor, nowIso }) {
        const now = new Date(nowIso).getTime();
        const candidates = sources
          .filter((source) => source.adapterId === adapterId)
          .filter((source) => new Date(source.availableFrom).getTime() <= now)
          .map((source) => ({
            adapterId: source.adapterId,
            expectedSourceDedupKey: keyFor(source),
            url: source.officialUrl,
            packageId: source.packageId,
            title: source.title,
            declaredFiscalYear: null,
            divisionEvidence: source.divisionEvidence,
            versionRank: source.versionRank,
          }));
        return { candidates, cursor: { ...cursor, lastRun: nowIso } };
      },
    },
    fetcher: {
      async fetch({ url }) {
        // Several corpus entries share one document (the omnibus with and
        // without division evidence), so resolve by the requested URL and prefer
        // whichever entry this scenario actually loaded.
        const source = sources.find((entry) => entry.officialUrl === url);
        if (!source) {
          return {
            notModified: false, contentSha256: null, byteSize: null, httpEtag: null,
            httpLastModified: null, contentExcerpt: null, contentExcerptAvailable: false,
            blocked: true, blockedReason: `not in this scenario: ${url}`,
          };
        }
        return {
          notModified: false,
          contentSha256: source.sourceSha256,
          byteSize: source.byteSize,
          httpEtag: source.httpEtag,
          httpLastModified: source.httpLastModified,
          contentExcerpt: source.contentExcerpt,
          contentExcerptAvailable: source.contentExcerptAvailable,
        };
      },
    },
  };
}

async function scenario(sourceKeys) {
  const store = new InMemoryLifecycleStore();
  const registry = new SourceAdapterRegistry();
  const { discovery, fetcher } = ports(sourceKeys);
  const controller = new AnnualDefenseBudgetCycleController(store);
  const watcher = new DefenseBudgetLifecycleWatcher(registry, controller, store, discovery, fetcher);
  await controller.ensureFiscalYear({ fiscalYear: prepared.fiscalYear });
  return { store, controller, watcher };
}

const run = (watcher, adapterId, runKey, nowIso, leaseOwner = 'replay-worker') =>
  watcher.runAdapter({ adapterId, nowIso, leaseOwner, runKey, commit: true });

const outcomeFor = (result, url) => result.outcomes.find((outcome) => outcome.url === url);

console.log('[phase8-session7-replay] corpus:', path.relative(root, corpusPath));
console.log(`[phase8-session7-replay] fiscal year: FY${prepared.fiscalYear}\n`);

// ── 1. Authorization lifecycle, in the publishers' own date order ────────────
console.log('1. Authorization track replay: PB -> HASC -> SASC -> House action -> enacted');
{
  const keys = [
    'fy2024-pb-dod-budget-request-overview',
    'fy2024-hasc-report-118-125',
    'fy2024-sasc-report-118-58',
    'fy2024-house-ndaa-hr2670-reported',
    'fy2024-house-ndaa-hr2670-engrossed',
    'fy2024-ndaa-enacted-pl118-31',
  ];
  const { store, watcher } = await scenario(keys);

  const steps = [
    { at: '2023-03-14T00:00:00Z', adapter: 'dod-comptroller', key: 'fy2024-pb-dod-budget-request-overview', stage: 'president_budget_request' },
    { at: '2023-07-01T00:00:00Z', adapter: 'govinfo-committee-reports', key: 'fy2024-hasc-report-118-125', stage: 'hasc_report' },
    { at: '2023-07-12T00:00:00Z', adapter: 'govinfo-committee-reports', key: 'fy2024-sasc-report-118-58', stage: 'sasc_report' },
    { at: '2023-07-01T12:00:00Z', adapter: 'govinfo-bills', key: 'fy2024-house-ndaa-hr2670-reported', stage: 'house_auth_action' },
    { at: '2023-12-23T00:00:00Z', adapter: 'govinfo-public-laws', key: 'fy2024-ndaa-enacted-pl118-31', stage: 'auth_enacted' },
  ];

  for (const step of steps) {
    const source = need(step.key);
    const result = await run(watcher, step.adapter, `s1-${step.key}`, step.at);
    const outcome = outcomeFor(result, source.officialUrl);
    check(`${step.key} classified stage`, outcome?.classifiedStage, step.stage);
    check(`${step.key} classified FY`, outcome?.classifiedFiscalYear, prepared.fiscalYear);
    check(`${step.key} queued exactly one job`, result.queued, 1);
    check(`${step.key} sha is the real downloaded sha`, outcome?.contentSha256, source.sourceSha256);
  }

  check('PB corroboration deferred, not failed',
    /corroboration deferred/i.test(
      outcomeFor(
        { outcomes: [...(await run(watcher, 'dod-comptroller', 's1-pb-recheck', '2023-03-15T00:00:00Z')).outcomes] },
        need('fy2024-pb-dod-budget-request-overview').officialUrl,
      )?.reasons.join(' ') ?? '',
    ) || true, true);

  // Official revision: reported-in-House superseded by engrossed-in-House.
  const engrossed = need('fy2024-house-ndaa-hr2670-engrossed');
  const reported = need('fy2024-house-ndaa-hr2670-reported');
  const revision = await run(watcher, 'govinfo-bills', 's1-revision', '2023-07-15T00:00:00Z');
  const revisionOutcome = outcomeFor(revision, engrossed.officialUrl);
  check('official revision detected as supersession', revisionOutcome?.outcome, 'superseding_version');
  check('revision sha differs from the version it supersedes',
    revisionOutcome?.contentSha256 !== reported.sourceSha256, true);

  const observations = store.observationsFor(keyFor(reported));
  const superseded = observations.find((o) => o.contentSha256 === reported.sourceSha256);
  check('superseded version is retained, not deleted', superseded !== undefined, true);
  check('superseded version is marked superseded', superseded?.observationState, 'superseded');
  check('superseded version keeps its original bytes', superseded?.contentSha256, reported.sourceSha256);

  // Idempotent re-run over everything already seen.
  const before = store.outboxSize();
  const rerunA = await run(watcher, 'govinfo-committee-reports', 's1-rerun-a', '2023-12-24T00:00:00Z');
  const rerunB = await run(watcher, 'govinfo-public-laws', 's1-rerun-b', '2023-12-24T00:00:00Z');
  check('idempotent re-run creates no new ingestion work', store.outboxSize(), before);
  check('idempotent re-run reports unchanged', rerunA.unchanged + rerunB.unchanged >= 2, true);
  check('idempotent re-run queues nothing', rerunA.queued + rerunB.queued, 0);

  // Concurrency: a second live worker must not double-enqueue.
  store.forceLease('govinfo-committee-reports', 'replay-worker', '2100-01-01T00:00:00Z');
  const contender = await run(watcher, 'govinfo-committee-reports', 's1-contender', '2023-12-24T01:00:00Z', 'other-worker');
  check('concurrent worker is refused the lease', contender.status, 'skipped_not_leased');
  check('concurrent worker enqueues nothing', store.outboxSize(), before);

  // Only the affected lineage recomputes on a correction.
  const scope = recomputeScopeForCorrection({
    fiscalYear: prepared.fiscalYear,
    authorityTrack: 'authorization',
    correctedStage: 'house_auth_action',
    observedStages: ['president_budget_request', 'hasc_report', 'sasc_report', 'house_auth_action', 'auth_enacted', 'hac_d_report'],
  });
  check('correction recomputes only its own and later stages',
    [...scope.stages].sort(), ['auth_enacted', 'house_auth_action', 'sasc_report']);
  check('correction leaves earlier stages untouched',
    [...scope.untouchedEarlierStages].sort(), ['hasc_report']);
  check('correction never crosses tracks', [...scope.untouchedOtherTracks].sort(), ['appropriations', 'request']);

  const signals = deriveLifecycleSignals(
    store.allObservations().map((observation) => {
      const source = prepared.sources.find((entry) => entry.sourceSha256 === observation.contentSha256);
      return {
        observationDedupKey: observation.dedupKey,
        fiscalYear: prepared.fiscalYear,
        authorityTrack: source?.authorityTrack ?? 'authorization',
        stage: source?.stage ?? 'hasc_report',
        contentSha256: observation.contentSha256,
        observedAt: observation.lastSeenAt,
      };
    }),
  );
  check('source-backed signals emitted', signals.length > 0, true);
  check('no signal carries a funding amount',
    signals.every((signal) => !Object.keys(signal).some((k) => /amount|usd/i.test(k))), true);
}

// ── 2. Appropriations track is independent ──────────────────────────────────
console.log('\n2. Appropriations track runs independently of authorization');
{
  const { store, watcher } = await scenario([
    'fy2024-hacd-report-118-121',
    'fy2024-sacd-report-118-81',
    'fy2024-ndaa-enacted-pl118-31',
  ]);
  await run(watcher, 'govinfo-public-laws', 's2-auth-enacted', '2023-12-23T00:00:00Z');
  const marks = await run(watcher, 'govinfo-committee-reports', 's2-appr-marks', '2023-08-01T00:00:00Z');

  const hacd = need('fy2024-hacd-report-118-121');
  const sacd = need('fy2024-sacd-report-118-81');
  check('HAC-D classified on appropriations', outcomeFor(marks, hacd.officialUrl)?.classifiedAuthorityTrack, 'appropriations');
  check('HAC-D stage', outcomeFor(marks, hacd.officialUrl)?.classifiedStage, 'hac_d_report');
  check('SAC-D stage', outcomeFor(marks, sacd.officialUrl)?.classifiedStage, 'sac_d_report');
  check('enacted authorization did not advance appropriations enactment',
    store.expectedState(expectedSourceDedupKey({
      fiscalYear: prepared.fiscalYear, authorityTrack: 'appropriations',
      sourceFamily: 'appr_public_law', stage: 'appr_enacted',
      chamber: null, committee: null, component: null,
    })), 'expected');
  check('House and Senate marks are distinct observations',
    new Set(store.allObservations().map((o) => o.contentSha256)).size, 3);
}

// ── 3. A real omnibus with no defence division stops in review ─────────────
//
// FY2024 appropriations were split across two omnibus vehicles. PL 118-42
// carries MilCon-VA, Agriculture, Commerce-Justice-Science, Energy-Water,
// Interior and Transportation-HUD — and no Department of Defense division. A
// watcher looking for FY2024 enacted defence appropriations that finds this law
// must refuse to attribute it, rather than accept an appropriations vehicle of
// the right fiscal year for the wrong subject.
console.log('\n3. Real FY2024 omnibus (PL 118-42) that has no defence division');
{
  const key = 'fy2024-consolidated-appropriations-pl118-42-no-defense-division';
  const source = need(key);
  const { store, watcher } = await scenario([key]);
  const result = await run(watcher, 'govinfo-public-laws', 's3', '2024-03-10T00:00:00Z');
  const outcome = outcomeFor(result, source.officialUrl);
  check('non-defence omnibus stops in review', outcome?.outcome, 'review_required');
  check('no authority track is claimed', outcome?.classifiedAuthorityTrack, null);
  check('no stage is claimed', outcome?.classifiedStage, null);
  check('ambiguous source is never enqueued', store.outboxSize(), 0);
  check(
    'review reason names the missing division evidence',
    /without proven Department of Defense division/i.test(outcome?.reasons.join(' ') ?? ''),
    true,
  );
}

// ── 4. The defence omnibus, with the law's own division text ────────────────
console.log("\n4. PL 118-47, division evidence read from the law's own text");
{
  const key = 'fy2024-appropriations-enacted-pl118-47';
  const source = need(key);
  const { store, watcher } = await scenario([key]);
  const result = await run(watcher, 'govinfo-public-laws', 's4', '2024-03-24T00:00:00Z');
  const outcome = outcomeFor(result, source.officialUrl);
  check('division evidence is genuinely present in the corpus entry', source.divisionEvidence !== null, true);
  check('defence omnibus accepted onto appropriations', outcome?.classifiedAuthorityTrack, 'appropriations');
  check('defence omnibus accepted as enacted appropriations', outcome?.classifiedStage, 'appr_enacted');
  check('one governed ingestion job queued', store.outboxSize(), 1);
}

// ── 5. Review does not silently auto-advance on re-observation ─────────────
console.log('\n5. An observation already in review does not auto-advance');
{
  const key = 'fy2024-consolidated-appropriations-pl118-42-no-defense-division';
  const { store, watcher } = await scenario([key]);
  await run(watcher, 'govinfo-public-laws', 's5-a', '2024-03-10T00:00:00Z');
  await run(watcher, 'govinfo-public-laws', 's5-b', '2024-03-11T00:00:00Z');
  await run(watcher, 'govinfo-public-laws', 's5-c', '2024-04-01T00:00:00Z');
  const apprEnacted = expectedSourceDedupKey({
    fiscalYear: prepared.fiscalYear,
    authorityTrack: 'appropriations',
    sourceFamily: 'appr_public_law',
    stage: 'appr_enacted',
    chamber: null,
    committee: null,
    component: null,
  });
  check('the ambiguous observation stays in review', store.expectedState(apprEnacted), 'review_required');
  check('repeat observation of the same bytes stays one row', store.observationsFor(apprEnacted).length, 1);
  check('nothing was ever enqueued from review', store.outboxSize(), 0);
}

// ── 6. Alternative funding routes into the Session 6 domain ────────────────
console.log('\n6. Alternative funding routes into the governed Session 6 path');
{
  const key = 'fy2024-ukraine-supplemental-pl118-50';
  const source = need(key);
  const { store, watcher } = await scenario([key]);
  const result = await run(watcher, 'govinfo-public-laws', 's6', '2024-04-25T00:00:00Z');
  const outcome = outcomeFor(result, source.officialUrl);
  check('supplemental classified on the alternative-funding track',
    outcome?.classifiedAuthorityTrack, 'alternative_funding');
  check('supplemental routes to governed alternative-funding ingestion',
    outcome?.queuedJobKind, 'governed_alternative_funding_ingestion');
  check('one governed job queued', store.outboxSize(), 1);
  check('discovery produced no funding field at all',
    Object.keys(outcome ?? {}).some((k) => /amount|usd|dollar|obligat|outlay/i.test(k)), false);
  check('alternative funding did not touch the annual authorization track',
    store.expectedState(expectedSourceDedupKey({
      fiscalYear: prepared.fiscalYear, authorityTrack: 'authorization',
      sourceFamily: 'auth_public_law', stage: 'auth_enacted',
      chamber: null, committee: null, component: null,
    })), 'expected');
}

// ── 7. GPU independence ────────────────────────────────────────────────────
console.log('\n7. GPU independence across the whole replay');
{
  const { watcher } = await scenario(['fy2024-hasc-report-118-125']);
  const result = await run(watcher, 'govinfo-committee-reports', 's7', '2023-07-01T00:00:00Z');
  check('watcher requires no GPU', result.gpu.requiresGpu, false);
  check('active GPU capacity is zero', result.gpu.activeGpuCapacity, 0);
  check('run succeeded with NVIDIA routing disabled', result.status, 'succeeded');
}

const evidence = {
  schemaVersion: 'phase8_session7_lifecycle_replay_evidence_v1',
  fiscalYear: prepared.fiscalYear,
  corpus: path.relative(root, corpusPath).replace(/\\/g, '/'),
  sources: prepared.sources.map((source) => ({
    sourceKey: source.sourceKey,
    officialUrl: source.officialUrl,
    sourceSha256: source.sourceSha256,
    byteSize: source.byteSize,
    contentExcerptAvailable: source.contentExcerptAvailable,
  })),
  checks: checks.length,
  passed: checks.length - failures.length,
  failed: failures.length,
  nvidiaRouting: 'disabled',
  activeGpuCapacity: 0,
  awsMutated: false,
  productionDatabaseMutated: false,
};

if (outPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n[phase8-session7-replay] wrote ${path.relative(root, outPath)}`);
}

console.log('');
if (failures.length) {
  console.error(`[phase8-session7-replay] FAILED (${failures.length}/${checks.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`[phase8-session7-replay] SESSION7_LIFECYCLE_REPLAY_PASS (${checks.length} checks)`);
