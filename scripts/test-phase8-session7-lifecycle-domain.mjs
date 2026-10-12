#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
/**
 * Phase 8 Session 7 — lifecycle domain gate.
 *
 * Runs against the BUILT @capiro/defense-domain output so CI exercises the same
 * artifact the services consume. Every assertion here is a Session 7 acceptance
 * requirement, not a unit-test convenience.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

console.error('Usage: node scripts/test-phase8-session7-lifecycle-domain.mjs (no arguments run the domain gate)');
if (process.argv.length > 2) process.exit(2);

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  // cycle
  DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION,
  DEFENSE_BUDGET_CYCLE_TEMPLATE_V1,
  bootstrapFiscalYearCycle,
  bootstrapRollingHorizon,
  rollingCycleHorizon,
  fiscalYearOfInstant,
  fiscalYearStart,
  expectedSourceFundingPosition,
  resolveUnobservedExpectedState,
  budgetCycleDedupKey,
  expectedSourceDedupKey,
  assertStageBelongsToTrack,
  resolveCycleTemplate,
  // classifier
  classifyLifecycleSource,
  validateClassificationAgainstContent,
  parseOfficialPackageId,
  billVersionRank,
  CLASSIFICATION_ACCEPT_THRESHOLD,
  // watcher
  detectSourceRevision,
  conditionalFetchHeaders,
  observationDedupKey,
  ingestionOutboxDedupKey,
  assertObservationQueueable,
  assertWatcherRunnableWithoutGpu,
  canAcquireWatcherLease,
  nextWatcherCheckAt,
  watcherSeasonForInstant,
  routeAlternativeFundingDiscovery,
  WATCHER_EXECUTION_CONTRACT,
  // signals / progression
  deriveLifecycleSignals,
  assertLifecycleSignalCarriesNoDollars,
  recomputeScopeForCorrection,
  assertStageEvidenceIsAppendOnly,
  governingStage,
  enactedMatchesConference,
  positionsByStage,
  // health
  buildCycleHealth,
  STAGE_TRACK,
  LIFECYCLE_STAGES,
} = domain;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

// ── Cycle identity and bootstrap ────────────────────────────────────────────

test('every lifecycle stage belongs to exactly one authority track', () => {
  for (const stage of LIFECYCLE_STAGES) {
    const track = STAGE_TRACK[stage];
    assert.ok(track, `stage ${stage} has no track`);
    assertStageBelongsToTrack(stage, track);
    assert.throws(
      () => assertStageBelongsToTrack(stage, track === 'authorization' ? 'appropriations' : 'authorization'),
      /cannot be recorded on/,
    );
  }
});

test('an unseen fiscal year bootstraps from governed templates alone', () => {
  const plan = bootstrapFiscalYearCycle({ fiscalYear: 2029 });
  assert.equal(plan.templateVersion, DEFENSE_BUDGET_CYCLE_TEMPLATE_VERSION);
  assert.equal(plan.cycles.length, 5);
  assert.ok(plan.expectedSources.length > 60);
  for (const source of plan.expectedSources) {
    assert.equal(source.fiscalYear, 2029);
    assert.equal(source.expectedState, 'expected');
    assert.match(source.dedupKey, /^[0-9a-f]{64}$/);
    assert.ok(!source.label.includes('{FY}'), 'label substituted');
  }
});

test('template covers every required source family group', () => {
  const families = new Set(DEFENSE_BUDGET_CYCLE_TEMPLATE_V1.entries.map((e) => e.sourceFamily));
  for (const required of [
    'pb_r1', 'pb_r2', 'pb_r2a', 'pb_r3', 'pb_r4', 'pb_p1', 'pb_p_series', 'pb_o1', 'pb_op5',
    'pb_milcon_c1', 'pb_dd1391',
    'auth_committee_mark', 'auth_committee_report', 'auth_chamber_action',
    'auth_conference_report', 'auth_public_law',
    'appr_committee_mark', 'appr_committee_report', 'appr_chamber_action',
    'appr_conference_jes', 'appr_public_law',
    'alt_supplemental', 'alt_reconciliation', 'alt_continuing_resolution', 'alt_rescission',
    'alt_transfer', 'alt_reprogramming',
    'exec_allocation', 'exec_obligation', 'exec_award',
  ]) {
    assert.ok(families.has(required), `template is missing source family ${required}`);
  }
});

/**
 * Regression guard for a real Session 7 bug: the classifier could resolve a real
 * emergency supplemental to stage `emergency_supplemental`, but no template
 * created an expected source for that stage. The dedup key therefore matched
 * nothing and the watcher blocked the candidate instead of classifying it. Any
 * stage the classifier can emit MUST have somewhere to land.
 */
test('every stage the classifier can emit has an expected-source template', () => {
  const templated = new Set(DEFENSE_BUDGET_CYCLE_TEMPLATE_V1.entries.map((e) => e.stage));
  const classifierStages = [
    'president_budget_request',
    'hasc_report', 'sasc_report', 'house_auth_action', 'senate_auth_action',
    'auth_conference', 'auth_enacted',
    'hac_d_report', 'sac_d_report', 'house_appr_action', 'senate_appr_action',
    'appr_conference_or_jes', 'appr_enacted',
    'supplemental', 'emergency_supplemental', 'reconciliation',
    'continuing_resolution', 'rescission',
  ];
  for (const stage of classifierStages) {
    assert.ok(templated.has(stage), `classifier can emit ${stage} but no template expects it`);
  }
});

test('every template stage is a declared lifecycle stage on the right track', () => {
  for (const entry of DEFENSE_BUDGET_CYCLE_TEMPLATE_V1.entries) {
    assert.ok(LIFECYCLE_STAGES.includes(entry.stage), `unknown stage ${entry.stage}`);
    assert.equal(
      STAGE_TRACK[entry.stage], entry.authorityTrack,
      `template puts ${entry.stage} on ${entry.authorityTrack}`,
    );
  }
});

test('PB exhibits are expected for every service component', () => {
  const components = new Set(
    DEFENSE_BUDGET_CYCLE_TEMPLATE_V1.entries
      .filter((e) => e.sourceFamily === 'pb_r2')
      .map((e) => e.component),
  );
  for (const component of ['ARMY', 'NAVY', 'AF', 'SF', 'DW']) {
    assert.ok(components.has(component), `no R-2 expectation for ${component}`);
  }
});

test('authorization and appropriations cycles are separate identities', () => {
  const auth = budgetCycleDedupKey({ fiscalYear: 2028, authorityTrack: 'authorization' });
  const appr = budgetCycleDedupKey({ fiscalYear: 2028, authorityTrack: 'appropriations' });
  assert.notEqual(auth, appr);
  assert.equal(auth, budgetCycleDedupKey({ fiscalYear: 2028, authorityTrack: 'authorization' }));
});

test('expected-source identity is order-independent and collision free', () => {
  const base = {
    fiscalYear: 2028, authorityTrack: 'authorization', sourceFamily: 'auth_committee_report',
    stage: 'hasc_report', chamber: 'house', committee: 'HASC', component: null,
  };
  assert.equal(expectedSourceDedupKey(base), expectedSourceDedupKey({ ...base }));
  assert.notEqual(
    expectedSourceDedupKey(base),
    expectedSourceDedupKey({ ...base, stage: 'sasc_report', chamber: 'senate', committee: 'SASC' }),
  );
});

test('fiscal years start on 1 October of the preceding calendar year', () => {
  assert.equal(fiscalYearStart(2028).toISOString(), '2027-10-01T00:00:00.000Z');
  assert.equal(fiscalYearOfInstant('2026-09-30T00:00:00Z'), 2026);
  assert.equal(fiscalYearOfInstant('2026-10-01T00:00:00Z'), 2027);
});

test('rolling horizon moves with the clock and needs no operator input', () => {
  assert.deepEqual([...rollingCycleHorizon('2026-10-05T00:00:00Z')], [2026, 2027, 2028]);
  const plans = bootstrapRollingHorizon({ nowIso: '2026-10-05T00:00:00Z' });
  assert.deepEqual(plans.map((p) => p.fiscalYear), [2026, 2027, 2028]);
});

test('an unknown template version is refused rather than defaulted', () => {
  assert.throws(() => resolveCycleTemplate('made-up-v9'), /Unknown defense budget cycle template/);
});

// ── Missing is never zero ───────────────────────────────────────────────────

test('an unpublished expected source has no known amount and no zero', () => {
  for (const state of ['expected', 'not_filed', 'withdrawn', 'unavailable', 'review_required']) {
    const position = expectedSourceFundingPosition(state);
    assert.equal(position.known, false);
    assert.equal(position.reason, state);
    assert.equal(typeof position.known, 'boolean');
    assert.ok(!Object.values(position).includes(0), 'no zero appears in the answer');
  }
});

test('even a published source carries no dollars until governed ingestion', () => {
  const position = expectedSourceFundingPosition('published');
  assert.equal(position.known, 'source_published');
  assert.equal(position.reason, 'requires_governed_ingestion');
});

test('optional families become not_filed, required families go to review', () => {
  const past = { expectedTo: '2024-01-01T00:00:00Z' };
  assert.equal(
    resolveUnobservedExpectedState({ plan: { ...past, optional: true }, nowIso: '2030-01-01T00:00:00Z' }),
    'not_filed',
  );
  assert.equal(
    resolveUnobservedExpectedState({ plan: { ...past, optional: false }, nowIso: '2030-01-01T00:00:00Z' }),
    'review_required',
  );
  assert.equal(
    resolveUnobservedExpectedState({ plan: { ...past, optional: false }, nowIso: '2023-06-01T00:00:00Z' }),
    'expected',
  );
});

// ── Classification ──────────────────────────────────────────────────────────

test('official GovInfo package identifiers parse to real document shapes', () => {
  assert.equal(parseOfficialPackageId('CRPT-118hrpt125').chamber, 'house');
  assert.equal(parseOfficialPackageId('CRPT-118srpt58').chamber, 'senate');
  assert.equal(parseOfficialPackageId('PLAW-118publ31').kind, 'public_law');
  assert.equal(parseOfficialPackageId('BUDGET-2024-BUD').budgetYear, 2024);
  const bill = parseOfficialPackageId('BILLS-118hr2670eh');
  assert.equal(bill.kind, 'bill');
  assert.equal(bill.billVersion, 'eh');
  assert.equal(parseOfficialPackageId('not-a-package').kind, 'unknown');
});

test('publisher bill versions rank reported below passed below enrolled', () => {
  assert.ok(billVersionRank('rh') < billVersionRank('eh'));
  assert.ok(billVersionRank('eh') < billVersionRank('enr'));
  assert.equal(billVersionRank('zz'), null);
});

test('a real HASC report classifies onto the authorization track', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
    packageId: 'CRPT-118hrpt125',
    title: 'House Report 118-125 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
    contentExcerpt:
      'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024 REPORT of the COMMITTEE ON ARMED SERVICES',
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.classification.authorityTrack, 'authorization');
  assert.equal(result.classification.stage, 'hasc_report');
  assert.equal(result.classification.fiscalYear, 2024);
  assert.ok(result.classification.confidence >= CLASSIFICATION_ACCEPT_THRESHOLD);
});

test('a real HAC-D report classifies onto appropriations from its own wording', () => {
  // This document states no "fiscal year" phrase at all; only "APPROPRIATIONS BILL, 2024".
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt121/pdf/CRPT-118hrpt121.pdf',
    packageId: 'CRPT-118hrpt121',
    title: 'House Report 118-121 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
    contentExcerpt:
      'DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024 REPORT of the COMMITTEE ON APPROPRIATIONS',
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.classification.authorityTrack, 'appropriations');
  assert.equal(result.classification.stage, 'hac_d_report');
  assert.equal(result.classification.fiscalYear, 2024);
});

test('a real SAC-D report reads its fiscal year from the September 30 wording', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/CRPT-118srpt81/pdf/CRPT-118srpt81.pdf',
    packageId: 'CRPT-118srpt81',
    title: 'Senate Report 118-81 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
    contentExcerpt:
      'making appropriations for the Department of Defense for the fiscal year ending September 30, 2024',
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.classification.stage, 'sac_d_report');
  assert.equal(result.classification.fiscalYear, 2024);
});

test('an omnibus vehicle without proven defence division stops in review', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/PLAW-118publ47/pdf/PLAW-118publ47.pdf',
    packageId: 'PLAW-118publ47',
    title: 'Public Law 118-47 - Further Consolidated Appropriations Act, 2024',
    contentExcerpt:
      'FURTHER CONSOLIDATED APPROPRIATIONS ACT, 2024 An Act Making further consolidated ' +
      'appropriations for the fiscal year ending September 30, 2024',
  });
  assert.equal(result.decision, 'review');
  assert.equal(result.classification, null, 'no track or stage is claimed');
  assert.match(result.reasons.join(' '), /without proven Department of Defense division/i);
});

test('the same omnibus is accepted once its own division text is present', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/PLAW-118publ47/pdf/PLAW-118publ47.pdf',
    packageId: 'PLAW-118publ47',
    title: 'Public Law 118-47 - Further Consolidated Appropriations Act, 2024',
    contentExcerpt:
      'FURTHER CONSOLIDATED APPROPRIATIONS ACT, 2024 An Act Making further consolidated ' +
      'appropriations for the fiscal year ending September 30, 2024 ... ' +
      'DIVISION A--DEPARTMENT OF DEFENSE APPROPRIATIONS ACT, 2024',
    divisionEvidence: 'DIVISION A--DEPARTMENT OF DEFENSE APPROPRIATIONS ACT, 2024',
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.classification.authorityTrack, 'appropriations');
  assert.equal(result.classification.stage, 'appr_enacted');
});

test('conflicting fiscal years in a title are refused, never guessed', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
    packageId: 'CRPT-118hrpt125',
    title: 'National Defense Authorization Act for Fiscal Year 2024 and Fiscal Year 2025',
    contentExcerpt: 'National Defense Authorization Act for Fiscal Year 2024',
  });
  assert.equal(result.decision, 'review');
  assert.match(result.reasons.join(' '), /more than one fiscal year/);
});

test('an unrecognised document kind stops in review', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/UNKNOWN-1/pdf/UNKNOWN-1.pdf',
    packageId: 'UNKNOWN-1',
    title: 'National Defense Authorization Act for Fiscal Year 2024',
    contentExcerpt: 'National Defense Authorization Act for Fiscal Year 2024',
  });
  assert.equal(result.decision, 'review');
  assert.match(result.reasons.join(' '), /document kind could not be determined/);
});

test('metadata with no corroboration is capped below the accept threshold', () => {
  const result = classifyLifecycleSource({
    url: 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
    packageId: 'CRPT-118hrpt125',
    title: 'National Defense Authorization Act for Fiscal Year 2024',
  });
  assert.equal(result.decision, 'review');
  assert.equal(result.corroborationDeferred, false);
  assert.ok(result.classification.confidence < CLASSIFICATION_ACCEPT_THRESHOLD);
});

test('a PDF-only publisher defers corroboration instead of failing', () => {
  const result = classifyLifecycleSource({
    url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_Budget_Request_Overview_Book.pdf',
    packageId: null,
    title: 'Department of Defense Fiscal Year 2024 Budget Request Overview',
    contentExcerptAvailable: false,
  });
  assert.equal(result.decision, 'accept');
  assert.equal(result.corroborationDeferred, true);
  assert.equal(result.classification.authorityTrack, 'request');
  assert.equal(result.classification.stage, 'president_budget_request');
});

test('content validation refuses a classification the document does not support', () => {
  const classification = {
    fiscalYear: 2024, authorityTrack: 'authorization', stage: 'hasc_report',
    sourceFamily: 'auth_committee_report', chamber: 'house', committee: 'HASC',
    component: null, confidence: 0.95,
  };
  assert.equal(
    validateClassificationAgainstContent(classification, {
      contentExcerpt: 'National Defense Authorization Act for Fiscal Year 2024',
    }).valid,
    true,
  );
  const wrongYear = validateClassificationAgainstContent(classification, {
    contentExcerpt: 'National Defense Authorization Act for Fiscal Year 2019',
  });
  assert.equal(wrongYear.valid, false);
  assert.equal(
    validateClassificationAgainstContent(classification, { contentExcerpt: '' }).valid,
    false,
  );
});

// ── Revision detection ──────────────────────────────────────────────────────

const at = (url, sha, versionRank = null) => ({ discoveredUrl: url, contentSha256: sha, versionRank });
const URL_A = 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf';
const URL_B = 'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125-r2.pdf';

test('first discovery creates a version and queues ingestion', () => {
  const outcome = detectSourceRevision({ next: at(URL_A, SHA_A) });
  assert.equal(outcome.kind, 'first_discovery');
  assert.equal(outcome.createsNewVersion, true);
  assert.equal(outcome.queuesIngestion, true);
});

test('same URL and same bytes is a true no-op', () => {
  const outcome = detectSourceRevision({ previous: at(URL_A, SHA_A), next: at(URL_A, SHA_A) });
  assert.equal(outcome.kind, 'unchanged');
  assert.equal(outcome.createsNewVersion, false);
  assert.equal(outcome.queuesIngestion, false);
});

test('same URL and changed bytes versions and supersedes', () => {
  const outcome = detectSourceRevision({ previous: at(URL_A, SHA_A), next: at(URL_A, SHA_B) });
  assert.equal(outcome.kind, 'changed');
  assert.equal(outcome.createsNewVersion, true);
  assert.equal(outcome.queuesIngestion, true);
  assert.equal(outcome.supersedesPrevious, true);
});

test('a replacement URL with identical bytes creates no paid work', () => {
  const outcome = detectSourceRevision({ previous: at(URL_A, SHA_A), next: at(URL_B, SHA_A) });
  assert.equal(outcome.kind, 'replacement_url');
  assert.equal(outcome.queuesIngestion, false, 'unchanged bytes never re-charge a parser');
  assert.equal(outcome.createsNewVersion, false);
});

test('an official version advance is recorded as supersession', () => {
  const outcome = detectSourceRevision({
    previous: at(URL_A, SHA_A, 2),
    next: at(URL_B, SHA_B, 3),
  });
  assert.equal(outcome.kind, 'superseding_version');
  assert.equal(outcome.supersedesPrevious, true);
});

test('an older official version never supersedes a newer one', () => {
  const outcome = detectSourceRevision({
    previous: at(URL_A, SHA_A, 3),
    next: at(URL_B, SHA_B, 2),
  });
  assert.equal(outcome.kind, 'changed');
  assert.equal(outcome.supersedesPrevious, false);
  assert.equal(outcome.queuesIngestion, false);
  assert.match(outcome.reason, /version regressed/);
});

test('a malformed content sha is refused', () => {
  assert.throws(() => detectSourceRevision({ next: at(URL_A, 'nope') }), /sha256/);
});

test('conditional headers are hints only and absent on first sight', () => {
  assert.deepEqual(conditionalFetchHeaders(null), {});
  assert.deepEqual(
    conditionalFetchHeaders({ discoveredUrl: URL_A, contentSha256: SHA_A, httpEtag: '"x"' }),
    { 'if-none-match': '"x"' },
  );
  // GovInfo serves Last-Modified but no ETag on PDF packages; both are optional.
  assert.deepEqual(
    conditionalFetchHeaders({
      discoveredUrl: URL_A, contentSha256: SHA_A, httpLastModified: 'Fri, 08 Nov 2024 16:28:24 GMT',
    }),
    { 'if-modified-since': 'Fri, 08 Nov 2024 16:28:24 GMT' },
  );
});

// ── Idempotency, queueing, concurrency ──────────────────────────────────────

test('observation identity is (expected source, bytes) and excludes the URL', () => {
  const key = observationDedupKey({ expectedSourceDedupKey: SHA_A, contentSha256: SHA_B });
  assert.equal(key, observationDedupKey({ expectedSourceDedupKey: SHA_A, contentSha256: SHA_B }));
  assert.notEqual(key, observationDedupKey({ expectedSourceDedupKey: SHA_B, contentSha256: SHA_B }));
});

test('outbox identity is (observation, job kind)', () => {
  const observation = observationDedupKey({ expectedSourceDedupKey: SHA_A, contentSha256: SHA_B });
  const one = ingestionOutboxDedupKey({ observationDedupKey: observation, jobKind: 'governed_source_ingestion' });
  assert.equal(
    one,
    ingestionOutboxDedupKey({ observationDedupKey: observation, jobKind: 'governed_source_ingestion' }),
  );
  assert.notEqual(
    one,
    ingestionOutboxDedupKey({
      observationDedupKey: observation,
      jobKind: 'governed_alternative_funding_ingestion',
    }),
  );
});

test('review, blocked and withdrawn observations are not queueable', () => {
  for (const state of ['review_required', 'blocked', 'withdrawn']) {
    assert.throws(() => assertObservationQueueable(state), /must not be queued/);
  }
  for (const state of ['changed', 'classified', 'ingested']) {
    assert.equal(assertObservationQueueable(state), state);
  }
});

test('one adapter has one live owner, and a crashed lease is reclaimable', () => {
  const lease = {
    adapterId: 'govinfo-bills', leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-06-15T12:10:00Z',
  };
  assert.equal(
    canAcquireWatcherLease({ existing: lease, candidateOwner: 'worker-b', nowIso: '2026-06-15T12:00:00Z' }).acquired,
    false,
  );
  assert.equal(
    canAcquireWatcherLease({ existing: lease, candidateOwner: 'worker-b', nowIso: '2026-06-15T12:20:00Z' }).acquired,
    true,
  );
  assert.equal(
    canAcquireWatcherLease({ existing: lease, candidateOwner: 'worker-a', nowIso: '2026-06-15T12:00:00Z' }).acquired,
    true,
  );
  assert.equal(canAcquireWatcherLease({ candidateOwner: 'w', nowIso: '2026-06-15T12:00:00Z' }).acquired, true);
});

test('cadence is per adapter and per season, and backs off on failure', () => {
  // Committee adapters are in season during markup; public-law packages are not.
  assert.equal(watcherSeasonForInstant('2026-06-15T00:00:00Z', 'hasc'), 'in_season');
  assert.equal(watcherSeasonForInstant('2026-12-15T00:00:00Z', 'govinfo-public-laws'), 'in_season');
  assert.equal(watcherSeasonForInstant('2026-06-15T00:00:00Z', 'govinfo-public-laws'), 'off_season');

  const cadence = { adapterId: 'hasc', inSeasonMinutes: 120, shoulderMinutes: 720, offSeasonMinutes: 4320 };
  const clean = nextWatcherCheckAt({ nowIso: '2026-06-15T00:00:00Z', cadence, consecutiveFailures: 0 });
  const failing = nextWatcherCheckAt({ nowIso: '2026-06-15T00:00:00Z', cadence, consecutiveFailures: 3 });
  assert.ok(new Date(failing) > new Date(clean), 'failures back the adapter off');
});

// ── GPU independence ────────────────────────────────────────────────────────

test('the watcher runs with NVIDIA disabled and refuses any GPU dependency', () => {
  const contract = assertWatcherRunnableWithoutGpu({
    nvidiaRouting: 'disabled', activeGpuCapacity: 0, requiresGpu: false,
  });
  assert.equal(contract.requiresGpu, false);
  assert.equal(contract.activeGpuCapacity, 0);
  assert.equal(contract.nvidiaQueuedPages, 0);
  assert.equal(contract.persistentNvidiaEndpoint, false);
  assert.equal(contract.productionParser, 'DETERMINISTIC_PRIMARY');
  assert.equal(WATCHER_EXECUTION_CONTRACT.nvidiaRouting, 'disabled');

  assert.throws(() => assertWatcherRunnableWithoutGpu({ requiresGpu: true }), /must not require GPU/);
  assert.throws(() => assertWatcherRunnableWithoutGpu({ activeGpuCapacity: 1 }), /activeGpuCapacity=1/);
  assert.throws(() => assertWatcherRunnableWithoutGpu({ nvidiaRouting: 'preferred' }), /nvidiaRouting=preferred/);
});

// ── Alternative funding ─────────────────────────────────────────────────────

test('alternative funding routes to governed ingestion and fabricates no dollars', () => {
  for (const stage of [
    'supplemental', 'emergency_supplemental', 'reconciliation',
    'continuing_resolution', 'rescission', 'transfer', 'reprogramming',
  ]) {
    const route = routeAlternativeFundingDiscovery({
      stage, sourceFamily: 'alt_supplemental', authorityTrack: 'alternative_funding',
    });
    assert.equal(route.jobKind, 'governed_alternative_funding_ingestion');
    assert.equal(route.fabricatesDollars, false);
    assert.ok(!Object.keys(route).some((k) => /amount|usd/i.test(k)));
  }
});

test('annual stages cannot be routed as alternative funding', () => {
  assert.throws(
    () => routeAlternativeFundingDiscovery({
      stage: 'hasc_report', sourceFamily: 'auth_committee_report', authorityTrack: 'authorization',
    }),
    /not an alternative-funding stage/,
  );
});

test('alternative-funding stages never sit on an annual track', () => {
  for (const stage of ['supplemental', 'reconciliation', 'rescission', 'transfer', 'reprogramming']) {
    assert.equal(STAGE_TRACK[stage], 'alternative_funding');
  }
});

// ── Signals ─────────────────────────────────────────────────────────────────

const obs = (key, track, stage, sha, at) => ({
  observationDedupKey: key, fiscalYear: 2024, authorityTrack: track, stage,
  contentSha256: sha, observedAt: at,
});

test('signals compare stages without collapsing or overwriting them', () => {
  const signals = deriveLifecycleSignals([
    obs('pb', 'request', 'president_budget_request', SHA_A, '2023-03-13T00:00:00Z'),
    obs('hasc', 'authorization', 'hasc_report', SHA_B, '2023-06-27T00:00:00Z'),
    obs('sasc', 'authorization', 'sasc_report', SHA_A, '2023-07-27T00:00:00Z'),
    obs('conf', 'authorization', 'auth_conference', SHA_B, '2023-12-07T00:00:00Z'),
    obs('enacted', 'authorization', 'auth_enacted', SHA_A, '2023-12-22T00:00:00Z'),
  ]);
  const kinds = signals.map((s) => s.signalKind).sort();
  assert.deepEqual(kinds, [
    'conference_to_enacted', 'house_to_senate', 'latest_mark_to_conference', 'pb_to_hasc', 'pb_to_sasc',
  ]);
  for (const signal of signals) {
    assert.match(signal.dedupKey, /^[0-9a-f]{64}$/);
    assert.notEqual(signal.fromObservationDedupKey, signal.toObservationDedupKey);
  }
});

test('a corrected source emits a correction signal against its own predecessor', () => {
  const signals = deriveLifecycleSignals([
    {
      ...obs('sasc-v2', 'authorization', 'sasc_report', SHA_B, '2023-08-01T00:00:00Z'),
      supersedesObservationDedupKey: 'sasc-v1',
    },
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signalKind, 'source_correction');
  assert.equal(signals[0].fromObservationDedupKey, 'sasc-v1');
});

test('authorization signals do not appear on the appropriations track', () => {
  const signals = deriveLifecycleSignals([
    obs('pb', 'request', 'president_budget_request', SHA_A, '2023-03-13T00:00:00Z'),
    obs('hacd', 'appropriations', 'hac_d_report', SHA_B, '2023-06-27T00:00:00Z'),
  ]);
  assert.deepEqual(signals.map((s) => s.signalKind), ['pb_to_hac_d']);
  assert.equal(signals[0].authorityTrack, 'appropriations');
});

test('a signal payload may not carry a funding amount at any depth', () => {
  assertLifecycleSignalCarriesNoDollars({ note: 'HASC marked the request' });
  assertLifecycleSignalCarriesNoDollars({ nested: { deep: { fine: true } } });
  for (const bad of [
    { authoritativeAmountUsd: '1' },
    { delta: { amountUsd: 1 } },
    { a: [{ b: { statedAmountUsd: 2 } }] },
    { obligatedUsd: 0 },
    { amountM: 1.5 },
  ]) {
    assert.throws(() => assertLifecycleSignalCarriesNoDollars(bad), /may not carry funding amounts/);
  }
});

// ── Progression guards ──────────────────────────────────────────────────────

test('a correction recomputes only its own stage and later stages on its track', () => {
  const scope = recomputeScopeForCorrection({
    fiscalYear: 2024, authorityTrack: 'authorization', correctedStage: 'sasc_report',
    observedStages: ['president_budget_request', 'hasc_report', 'sasc_report', 'auth_conference', 'auth_enacted', 'hac_d_report', 'appr_enacted'],
  });
  assert.deepEqual([...scope.stages].sort(), ['auth_conference', 'auth_enacted', 'sasc_report']);
  assert.deepEqual([...scope.untouchedEarlierStages].sort(), ['hasc_report']);
  assert.deepEqual([...scope.untouchedOtherTracks].sort(), ['appropriations', 'request']);
});

test('a correction on one track never reaches the other track', () => {
  const scope = recomputeScopeForCorrection({
    fiscalYear: 2024, authorityTrack: 'appropriations', correctedStage: 'sac_d_report',
    observedStages: ['hasc_report', 'auth_enacted', 'hac_d_report', 'sac_d_report', 'appr_enacted'],
  });
  assert.ok(!scope.stages.includes('auth_enacted'));
  assert.ok(!scope.stages.includes('hasc_report'));
  assert.deepEqual([...scope.untouchedOtherTracks], ['authorization']);
});

test('a correction cannot be recorded against the wrong track', () => {
  assert.throws(
    () => recomputeScopeForCorrection({
      fiscalYear: 2024, authorityTrack: 'appropriations', correctedStage: 'hasc_report',
      observedStages: ['hasc_report'],
    }),
    /belongs to authorization/,
  );
});

test('the same bytes cannot be reclassified into another stage', () => {
  const existing = [{ fiscalYear: 2024, authorityTrack: 'request', stage: 'president_budget_request', contentSha256: SHA_A }];
  // Re-observing the identical record is idempotent, not an overwrite.
  assertStageEvidenceIsAppendOnly({
    existing,
    incoming: { fiscalYear: 2024, authorityTrack: 'request', stage: 'president_budget_request', contentSha256: SHA_A },
  });
  // Different bytes on a different stage is an ordinary append.
  assertStageEvidenceIsAppendOnly({
    existing,
    incoming: { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'hasc_report', contentSha256: SHA_B },
  });
  // The PB's own bytes relabelled as a HASC mark would redefine the request.
  assert.throws(
    () => assertStageEvidenceIsAppendOnly({
      existing,
      incoming: { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'hasc_report', contentSha256: SHA_A },
    }),
    /would redefine an already-recorded position/,
  );
});

test('a stage cannot be written onto a track it does not belong to', () => {
  assert.throws(
    () => assertStageEvidenceIsAppendOnly({
      existing: [],
      incoming: { fiscalYear: 2024, authorityTrack: 'appropriations', stage: 'hasc_report', contentSha256: SHA_A },
    }),
    /Refusing to write a authorization position onto the appropriations track/,
  );
});

test('House and Senate positions are returned per stage, never merged', () => {
  const records = [
    { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'hasc_report', contentSha256: SHA_A },
    { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'sasc_report', contentSha256: SHA_B },
  ];
  const positions = positionsByStage(records, { fiscalYear: 2024, authorityTrack: 'authorization' });
  assert.equal(positions.hasc_report.length, 1);
  assert.equal(positions.sasc_report.length, 1);
  assert.notEqual(positions.hasc_report[0].contentSha256, positions.sasc_report[0].contentSha256);
});

test('an unobserved track has no governing stage rather than a default', () => {
  assert.equal(governingStage([], { fiscalYear: 2024, authorityTrack: 'authorization' }), null);
  const records = [
    { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'hasc_report', contentSha256: SHA_A },
    { fiscalYear: 2024, authorityTrack: 'authorization', stage: 'auth_enacted', contentSha256: SHA_B },
  ];
  assert.equal(governingStage(records, { fiscalYear: 2024, authorityTrack: 'authorization' }), 'auth_enacted');
});

test('enacted equals conference only when the governing source proves it', () => {
  assert.equal(
    enactedMatchesConference({ conferenceSha256: SHA_A, enactedSha256: SHA_A, governingSourceProvesIdentity: false }),
    false,
  );
  assert.equal(
    enactedMatchesConference({ conferenceSha256: SHA_A, enactedSha256: SHA_A, governingSourceProvesIdentity: true }),
    true,
  );
  assert.equal(
    enactedMatchesConference({ conferenceSha256: SHA_A, enactedSha256: SHA_B, governingSourceProvesIdentity: true }),
    false,
  );
});

// ── Cycle health ────────────────────────────────────────────────────────────

test('cycle health reports not_filed as its own count and zero GPU', () => {
  const health = buildCycleHealth({
    fiscalYear: 2028,
    nowIso: '2027-07-01T00:00:00Z',
    expectedSources: [
      { authorityTrack: 'authorization', stage: 'hasc_report', sourceFamily: 'auth_committee_report', expectedState: 'published', optional: false, adapterId: 'govinfo-committee-reports' },
      { authorityTrack: 'authorization', stage: 'sasc_report', sourceFamily: 'auth_committee_report', expectedState: 'expected', optional: false, adapterId: 'govinfo-committee-reports' },
      { authorityTrack: 'alternative_funding', stage: 'rescission', sourceFamily: 'alt_rescission', expectedState: 'not_filed', optional: true, adapterId: 'govinfo-public-laws' },
      { authorityTrack: 'appropriations', stage: 'appr_enacted', sourceFamily: 'appr_public_law', expectedState: 'review_required', optional: false, adapterId: 'govinfo-public-laws' },
    ],
    observations: [
      { authorityTrack: 'authorization', stage: 'hasc_report', observationState: 'ingested', adapterId: 'govinfo-committee-reports', observedAt: '2027-06-27T00:00:00Z' },
      { authorityTrack: 'appropriations', stage: 'appr_enacted', observationState: 'review_required', adapterId: 'govinfo-public-laws', observedAt: '2027-06-28T00:00:00Z' },
    ],
    watcherRuns: [
      { adapterId: 'govinfo-committee-reports', status: 'succeeded', finishedAt: '2027-06-30T00:00:00Z', nextCheckAt: '2027-07-01T03:00:00Z', consecutiveFailures: 0 },
      { adapterId: 'govinfo-public-laws', status: 'failed', finishedAt: '2027-06-01T00:00:00Z', nextCheckAt: '2027-07-01T06:00:00Z', consecutiveFailures: 2 },
    ],
    outbox: [{ state: 'succeeded' }, { state: 'dead_letter' }],
  });

  assert.equal(health.schemaVersion, 'defense_budget_cycle_health_v1');
  assert.equal(health.expectedSources, 4);
  assert.equal(health.published, 1);
  assert.equal(health.notFiled, 1, 'not_filed is its own count, not folded into zero');
  assert.equal(health.verified, 1);
  assert.equal(health.reviewRequired, 1);
  assert.equal(health.reviewBacklog, 2);
  assert.equal(health.parserFailures, 1);
  assert.equal(health.nvidiaQueuedPages, 0);
  assert.equal(health.activeGpuJobs, 0);
  assert.equal(health.nvidiaRouting, 'disabled');
  assert.equal(health.productionParser, 'DETERMINISTIC_PRIMARY');
  assert.equal(health.missingSourceMeansUnknownNotZero, true);
  assert.equal(health.lastDiscoveryAt, '2027-06-28T00:00:00Z');
  assert.equal(health.nextWatcherRunAt, '2027-07-01T03:00:00Z');
  assert.deepEqual(health.staleAdapters, ['govinfo-public-laws']);
  assert.ok(!JSON.stringify(health).match(/"[a-zA-Z]*[Aa]mount[a-zA-Z]*":/), 'no amount field');
});

test('cycle health carries no monetary field at all', () => {
  const health = buildCycleHealth({
    fiscalYear: 2028, nowIso: '2027-07-01T00:00:00Z',
    expectedSources: [], observations: [], watcherRuns: [], outbox: [],
  });
  for (const key of Object.keys(health)) {
    assert.ok(!/amount|usd|dollar|obligat|outlay/i.test(key), `unexpected monetary field: ${key}`);
  }
});
