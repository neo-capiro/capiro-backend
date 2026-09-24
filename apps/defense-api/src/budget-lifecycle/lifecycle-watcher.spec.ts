import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  expectedSourceDedupKey,
  ingestionOutboxDedupKey,
  observationDedupKey,
  recomputeScopeForCorrection,
  deriveLifecycleSignals,
  type AuthorityTrack,
  type LifecycleStage,
  type SourceFamily,
} from '@capiro/defense-domain';

import { AnnualDefenseBudgetCycleController } from './annual-cycle-controller.service.js';
import { DefenseBudgetLifecycleWatcher } from './lifecycle-watcher.service.js';
import { SourceAdapterRegistry } from './source-adapter.registry.js';
import { InMemoryLifecycleStore } from './testing/in-memory-lifecycle.store.js';
import {
  FY2024_APPROPRIATIONS_ENACTED,
  FY2024_APPROPRIATIONS_ENACTED_NO_DIVISION,
  FY2024_HACD_REPORT,
  FY2024_HASC_REPORT,
  FY2024_HOUSE_NDAA_PASSED,
  FY2024_HOUSE_NDAA_REPORTED,
  FY2024_NDAA_ENACTED,
  FY2024_PB,
  FY2024_SACD_REPORT,
  FY2024_SASC_REPORT,
  FY2024_UKRAINE_SUPPLEMENTAL,
  FixtureDiscoveryPort,
  FixtureFetchPort,
  sha,
  type FixtureCandidate,
  type FixtureSource,
} from './testing/fixture-ports.js';

const NOW = '2024-06-15T12:00:00.000Z';

interface Harness {
  store: InMemoryLifecycleStore;
  discovery: FixtureDiscoveryPort;
  fetcher: FixtureFetchPort;
  watcher: DefenseBudgetLifecycleWatcher;
  controller: AnnualDefenseBudgetCycleController;
}

function harness(): Harness {
  const store = new InMemoryLifecycleStore();
  const registry = new SourceAdapterRegistry();
  const discovery = new FixtureDiscoveryPort();
  const fetcher = new FixtureFetchPort();
  const controller = new AnnualDefenseBudgetCycleController(store);
  const watcher = new DefenseBudgetLifecycleWatcher(
    registry,
    controller,
    store,
    discovery,
    fetcher,
  );
  return { store, discovery, fetcher, watcher, controller };
}

/** Expected-source identity for a stage of FY2024, exactly as templates key it. */
function key(input: {
  authorityTrack: AuthorityTrack;
  stage: LifecycleStage;
  sourceFamily: SourceFamily;
  chamber?: 'house' | 'senate' | 'joint' | null;
  committee?: string | null;
  fiscalYear?: number;
}): string {
  return expectedSourceDedupKey({
    fiscalYear: input.fiscalYear ?? 2024,
    authorityTrack: input.authorityTrack,
    sourceFamily: input.sourceFamily,
    stage: input.stage,
    chamber: input.chamber ?? null,
    committee: input.committee ?? null,
    component: null,
  });
}

const KEYS = {
  pb: key({
    authorityTrack: 'request',
    stage: 'president_budget_request',
    sourceFamily: 'pb_overview',
  }),
  hascReport: key({
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    sourceFamily: 'auth_committee_report',
    chamber: 'house',
    committee: 'HASC',
  }),
  sascReport: key({
    authorityTrack: 'authorization',
    stage: 'sasc_report',
    sourceFamily: 'auth_committee_report',
    chamber: 'senate',
    committee: 'SASC',
  }),
  houseAuthAction: key({
    authorityTrack: 'authorization',
    stage: 'house_auth_action',
    sourceFamily: 'auth_chamber_action',
    chamber: 'house',
  }),
  authEnacted: key({
    authorityTrack: 'authorization',
    stage: 'auth_enacted',
    sourceFamily: 'auth_public_law',
  }),
  hacdReport: key({
    authorityTrack: 'appropriations',
    stage: 'hac_d_report',
    sourceFamily: 'appr_committee_report',
    chamber: 'house',
    committee: 'HAC-D',
  }),
  sacdReport: key({
    authorityTrack: 'appropriations',
    stage: 'sac_d_report',
    sourceFamily: 'appr_committee_report',
    chamber: 'senate',
    committee: 'SAC-D',
  }),
  apprEnacted: key({
    authorityTrack: 'appropriations',
    stage: 'appr_enacted',
    sourceFamily: 'appr_public_law',
  }),
  supplemental: key({
    authorityTrack: 'alternative_funding',
    stage: 'supplemental',
    sourceFamily: 'alt_supplemental',
  }),
};

async function bootstrap(h: Harness): Promise<void> {
  await h.controller.ensureFiscalYear({ fiscalYear: 2024 });
}

function load(h: Harness, candidates: readonly FixtureCandidate[]): void {
  h.discovery.load(candidates);
  h.fetcher.load(candidates);
}

async function run(
  h: Harness,
  adapterId: string,
  runKey: string,
  options: { commit?: boolean; nowIso?: string; leaseOwner?: string } = {},
) {
  return h.watcher.runAdapter({
    adapterId,
    nowIso: options.nowIso ?? NOW,
    leaseOwner: options.leaseOwner ?? 'worker-a',
    runKey,
    commit: options.commit ?? true,
  });
}

function candidate(
  source: FixtureSource,
  expectedKey: string,
  extra: Partial<FixtureCandidate> = {},
): FixtureCandidate {
  return { source, expectedSourceDedupKey: expectedKey, ...extra };
}

describe('Session 7 — cycle bootstrap', () => {
  it('bootstraps an unseen fiscal year from templates with no bespoke manifest', async () => {
    const h = harness();
    const summary = await h.controller.ensureFiscalYear({ fiscalYear: 2028 });
    assert.equal(summary.fiscalYear, 2028);
    assert.equal(summary.cyclesEnsured, 5, 'all five authority tracks are created');
    assert.ok(summary.expectedSourcesEnsured > 60, 'template yields a full expected-source set');
    assert.equal(summary.templateVersion, 'defense_budget_cycle_template_v1');
  });

  it('lets multiple fiscal-year cycles coexist without colliding', async () => {
    const h = harness();
    for (const fiscalYear of [2027, 2028, 2029]) {
      await h.controller.ensureFiscalYear({ fiscalYear });
    }
    const years = new Set(h.store.expectedSources().map((source) => source.fiscalYear));
    assert.deepEqual([...years].sort(), [2027, 2028, 2029]);
  });

  it('is idempotent: re-running does not duplicate or reset expected sources', async () => {
    const h = harness();
    const first = await h.controller.ensureFiscalYear({ fiscalYear: 2028 });
    const before = h.store.expectedSources().length;
    await h.controller.ensureFiscalYear({ fiscalYear: 2028 });
    assert.equal(h.store.expectedSources().length, before);
    assert.equal(first.expectedSourcesEnsured, before);
  });

  it('keeps authorization and appropriations as independent tracks', async () => {
    const h = harness();
    await bootstrap(h);
    const auth = h.store.expectedSources().filter((s) => s.authorityTrack === 'authorization');
    const appr = h.store.expectedSources().filter((s) => s.authorityTrack === 'appropriations');
    assert.ok(auth.length >= 8);
    assert.ok(appr.length >= 8);
    const sharedIds = auth.filter((a) => appr.some((b) => b.id === a.id));
    assert.equal(sharedIds.length, 0, 'no expected source belongs to both tracks');
  });

  it('rolls the prior/current/upcoming horizon forward from the clock alone', async () => {
    const h = harness();
    // October belongs to the NEXT fiscal year, so FY2027 is current here.
    const summaries = await h.controller.ensureRollingHorizon({ nowIso: '2026-10-05T00:00:00Z' });
    assert.deepEqual(
      summaries.map((s) => s.fiscalYear),
      [2026, 2027, 2028],
    );
  });
});

describe('Session 7 — missing sources are never zero', () => {
  it('marks an optional unfilled family not_filed and reports no known amount', async () => {
    const h = harness();
    await bootstrap(h);
    const optional = h.store
      .expectedSources()
      .filter((source) => source.optional && source.authorityTrack === 'alternative_funding');
    assert.ok(optional.length > 0);

    const results = await h.controller.reconcileUnobserved({
      expectedSources: optional,
      nowIso: '2030-01-01T00:00:00Z',
    });
    assert.ok(results.length > 0);
    for (const result of results) {
      assert.equal(result.expectedState, 'not_filed');
      assert.equal(result.fundingPosition.known, false);
      assert.equal(result.fundingPosition.reason, 'not_filed');
      // The critical assertion: there is no numeric zero anywhere in the answer.
      assert.notEqual(result.fundingPosition as unknown, 0);
    }
  });

  it('sends a required unfilled family to review rather than defaulting it', async () => {
    const h = harness();
    await bootstrap(h);
    const required = h.store
      .expectedSources()
      .filter((source) => !source.optional && source.authorityTrack === 'authorization');
    const results = await h.controller.reconcileUnobserved({
      expectedSources: required,
      nowIso: '2030-01-01T00:00:00Z',
    });
    assert.ok(results.length > 0);
    for (const result of results) assert.equal(result.expectedState, 'review_required');
  });
});

describe('Session 7 — discovery, fingerprinting and versioning', () => {
  it('bootstraps an unseen FY from first discovery and writes to its exact template identity', async () => {
    const h = harness();
    await h.controller.ensureFiscalYear({ fiscalYear: 2023 });
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);

    const result = await run(h, 'govinfo-committee-reports', 'unseen-fy-run');

    assert.equal(result.status, 'succeeded');
    assert.equal(result.changed, 1);
    assert.equal(result.queued, 1);
    assert.equal(result.outcomes[0]!.expectedSourceDedupKey, KEYS.hascReport);
    assert.equal(h.store.expectedState(KEYS.hascReport), 'published');

    const expected = h.store
      .expectedSources()
      .find((source) => source.dedupKey === KEYS.hascReport)!;
    assert.equal(expected.fiscalYear, 2024);
    assert.notEqual(
      expected.cycleId,
      h.store.expectedSources().find((s) => s.fiscalYear === 2023)!.cycleId,
    );
    const [observation] = h.store.observationsFor(KEYS.hascReport);
    assert.ok(observation);
    assert.equal(observation.expectedSourceId, expected.id);
    assert.equal(observation.cycleId, expected.cycleId);
    assert.equal(result.outcomes[0]!.classifiedFiscalYear, 2024);
    assert.equal(
      h.store
        .expectedSources()
        .filter((s) => s.fiscalYear === 2023)
        .some((s) => s.id === observation.expectedSourceId),
      false,
    );

    const [outbox] = h.store.outboxEntries();
    assert.equal(h.store.outboxSize(), 1);
    assert.equal(outbox!.observationId, observation.id);
  });

  it('dry-run of an unseen FY classifies without bootstrapping or writing', async () => {
    const h = harness();
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);

    const result = await run(h, 'govinfo-committee-reports', 'unseen-fy-dry-run', {
      commit: false,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.changed, 1);
    assert.equal(result.queued, 0);
    assert.equal(h.store.expectedSources().length, 0);
    assert.equal(h.store.allObservations().length, 0);
    assert.equal(h.store.outboxSize(), 0);
    assert.match(result.outcomes[0]!.reasons.join(' '), /dry run/);
  });

  it('replays official-source bytes across two coexisting prior-year cycles without identity collision', async () => {
    const h = harness();
    await h.controller.ensureFiscalYear({ fiscalYear: 2023 });
    await h.controller.ensureFiscalYear({ fiscalYear: 2024 });
    const priorYear = h.store.expectedSources().filter((source) => source.fiscalYear === 2023);
    const priorHascKey = key({
      authorityTrack: 'authorization',
      stage: 'hasc_report',
      sourceFamily: 'auth_committee_report',
      chamber: 'house',
      committee: 'HASC',
      fiscalYear: 2023,
    });
    const priorHasc = priorYear.find((source) => source.dedupKey === priorHascKey)!;
    const priorObservation = await h.store.recordObservation({
      expectedSourceId: priorHasc.id,
      cycleId: priorHasc.cycleId,
      adapterId: FY2024_HASC_REPORT.adapterId,
      discoveredUrl: FY2024_HASC_REPORT.url,
      contentSha256: sha(FY2024_HASC_REPORT.shaSeed),
      byteSize: null,
      httpEtag: null,
      httpLastModified: null,
      observationState: 'changed',
      revisionKind: 'first_discovery',
      classifiedFiscalYear: 2023,
      classifiedAuthorityTrack: 'authorization',
      classifiedStage: 'hasc_report',
      classifiedSourceFamily: 'auth_committee_report',
      classificationConfidence: 1,
      reviewReasons: [],
      versionRank: null,
      dedupKey: observationDedupKey({
        expectedSourceDedupKey: priorHascKey,
        contentSha256: sha(FY2024_HASC_REPORT.shaSeed),
      }),
      observedAt: NOW,
    });
    await h.store.setExpectedSourceState({
      expectedSourceId: priorHasc.id,
      expectedState: 'published',
      reviewReason: null,
    });
    const priorYearHistory = h.store
      .expectedSources()
      .filter((source) => source.fiscalYear === 2023)
      .map((source) => [source.id, source.dedupKey, source.expectedState]);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);

    const first = await run(h, 'govinfo-committee-reports', 'annual-replay-1');
    assert.equal(first.changed, 1);
    assert.equal(first.queued, 1);
    const observationsAfterFirst = h.store.allObservations().length;
    const outboxAfterFirst = h.store.outboxSize();
    const fy2024Expected = h.store
      .expectedSources()
      .find((source) => source.dedupKey === KEYS.hascReport)!;
    assert.equal(fy2024Expected.fiscalYear, 2024);
    assert.equal(
      priorYear.some((source) => source.dedupKey === fy2024Expected.dedupKey),
      false,
    );

    const replay = await run(h, 'govinfo-committee-reports', 'annual-replay-2');
    assert.equal(replay.unchanged, 1);
    assert.equal(replay.changed, 0);
    assert.equal(replay.queued, 0);
    assert.equal(h.store.allObservations().length, observationsAfterFirst);
    assert.equal(h.store.outboxSize(), outboxAfterFirst);
    assert.deepEqual(
      h.store
        .expectedSources()
        .filter((source) => source.fiscalYear === 2023)
        .map((source) => [source.id, source.dedupKey, source.expectedState]),
      priorYearHistory,
      'replay of newer-year bytes leaves the older year history intact',
    );
    assert.equal(h.store.observationsFor(priorHascKey)[0]!.id, priorObservation.observation.id);
    assert.equal(h.store.observationsFor(KEYS.hascReport).length, 1);
  });

  it('discovers, classifies and versions a first official source', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);

    const result = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(result.status, 'succeeded');
    assert.equal(result.changed, 1);
    assert.equal(result.queued, 1);

    const [outcome] = result.outcomes;
    assert.equal(outcome!.outcome, 'first_discovery');
    assert.equal(outcome!.classifiedFiscalYear, 2024);
    assert.equal(outcome!.classifiedAuthorityTrack, 'authorization');
    assert.equal(outcome!.classifiedStage, 'hasc_report');
    assert.equal(outcome!.classifiedSourceFamily, 'auth_committee_report');
    assert.equal(h.store.expectedState(KEYS.hascReport), 'published');
  });

  it('treats an unchanged recheck as a no-op that creates no work', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    await run(h, 'govinfo-committee-reports', 'run-1');
    const outboxAfterFirst = h.store.outboxSize();

    const second = await run(h, 'govinfo-committee-reports', 'run-2');
    assert.equal(second.unchanged, 1);
    assert.equal(second.changed, 0);
    assert.equal(second.queued, 0);
    assert.equal(h.store.outboxSize(), outboxAfterFirst, 'no additional ingestion work');
    assert.equal(h.store.observationsFor(KEYS.hascReport).length, 1, 'still one observation');
  });

  it('sends a conditional request on recheck and honours a 304 without re-hashing', async () => {
    const h = harness();
    await bootstrap(h);
    const withValidators: FixtureSource = {
      ...FY2024_SASC_REPORT,
      httpEtag: '"abc123"',
      httpLastModified: 'Fri, 08 Nov 2024 14:31:01 GMT',
    };
    load(h, [candidate(withValidators, KEYS.sascReport)]);
    await run(h, 'govinfo-committee-reports', 'run-1');

    load(h, [candidate(withValidators, KEYS.sascReport, { notModified: true })]);
    const second = await run(h, 'govinfo-committee-reports', 'run-2');

    const lastRequest = h.fetcher.requests.at(-1)!;
    assert.equal(lastRequest.conditionalHeaders['if-none-match'], '"abc123"');
    assert.equal(second.unchanged, 1);
    assert.equal(second.queued, 0);
    const [outcome] = second.outcomes;
    // A 304 does not become the content identity; the prior SHA is retained.
    assert.equal(outcome!.contentSha256, sha(withValidators.shaSeed));
  });

  it('treats identical bytes at a new URL as relocation, not new content', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    await run(h, 'govinfo-committee-reports', 'run-1');

    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport, {
        urlOverride:
          'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125-v2.pdf',
      }),
    ]);
    const second = await run(h, 'govinfo-committee-reports', 'run-2');
    assert.equal(second.outcomes[0]!.outcome, 'replacement_url');
    assert.equal(second.queued, 0, 'relocation must not incur a second parse');
    assert.equal(h.store.observationsFor(KEYS.hascReport).length, 1);
  });

  it('versions a changed source and supersedes the prior version without deleting it', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    await run(h, 'govinfo-committee-reports', 'run-1');
    const firstId = h.store.observationsFor(KEYS.hascReport)[0]!.id;

    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport, {
        shaSeedOverride: 'crpt-118hrpt125-corrected',
      }),
    ]);
    const second = await run(h, 'govinfo-committee-reports', 'run-2');
    assert.equal(second.outcomes[0]!.outcome, 'changed');
    assert.equal(second.queued, 1);

    const observations = h.store.observationsFor(KEYS.hascReport);
    assert.equal(observations.length, 2, 'both versions exist');
    const previous = observations.find((o) => o.id === firstId)!;
    assert.equal(previous.observationState, 'superseded');
    assert.equal(previous.contentSha256, sha('crpt-118hrpt125'), 'prior evidence unchanged');
  });

  it('recognises an official publisher version advance as supersession', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HOUSE_NDAA_REPORTED, KEYS.houseAuthAction)]);
    await run(h, 'govinfo-bills', 'run-1');

    load(h, [candidate(FY2024_HOUSE_NDAA_PASSED, KEYS.houseAuthAction)]);
    const second = await run(h, 'govinfo-bills', 'run-2');
    assert.equal(second.outcomes[0]!.outcome, 'superseding_version');
    assert.match(second.outcomes[0]!.reasons.join(' '), /version advanced 2 -> 3/);
  });

  it('records a withdrawn source as withdrawn, never as zero', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_SASC_REPORT, KEYS.sascReport, { withdrawn: true })]);
    const result = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(result.outcomes[0]!.outcome, 'withdrawn');
    assert.equal(h.store.expectedState(KEYS.sascReport), 'withdrawn');
    assert.equal(result.queued, 0);
  });

  it('records a failed download as blocked without inventing content', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [
      candidate(FY2024_SASC_REPORT, KEYS.sascReport, { blockedReason: 'HTTP 503 from publisher' }),
    ]);
    const result = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(result.outcomes[0]!.outcome, 'blocked');
    assert.equal(result.outcomes[0]!.contentSha256, null);
    assert.equal(result.queued, 0);
  });

  it('refuses a candidate URL that is not on the adapter own official host', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport, {
        urlOverride: 'https://defensenews.example.com/leaked/CRPT-118hrpt125.pdf',
      }),
    ]);
    const result = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(result.outcomes[0]!.outcome, 'refused_non_official');
    assert.equal(result.queued, 0);
    assert.equal(h.store.allObservations().length, 0);
  });
});

describe('Session 7 — ambiguity stops in review', () => {
  it('refuses to attribute an omnibus vehicle without proven defence division evidence', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_APPROPRIATIONS_ENACTED_NO_DIVISION, KEYS.apprEnacted)]);

    const result = await run(h, 'govinfo-public-laws', 'run-1');
    const [outcome] = result.outcomes;
    assert.equal(outcome!.outcome, 'review_required');
    assert.equal(outcome!.classifiedAuthorityTrack, null, 'no track is claimed');
    assert.equal(outcome!.classifiedStage, null, 'no stage is claimed');
    assert.equal(result.queued, 0, 'an ambiguous source is never enqueued');
    assert.equal(h.store.outboxSize(), 0);
    assert.equal(h.store.expectedState(KEYS.apprEnacted), 'review_required');
    assert.match(outcome!.reasons.join(' '), /without proven Department of Defense division/i);
  });

  it('accepts the same omnibus once the law own division text is supplied', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_APPROPRIATIONS_ENACTED, KEYS.apprEnacted)]);

    const result = await run(h, 'govinfo-public-laws', 'run-1');
    const [outcome] = result.outcomes;
    assert.equal(outcome!.outcome, 'first_discovery');
    assert.equal(outcome!.classifiedAuthorityTrack, 'appropriations');
    assert.equal(outcome!.classifiedStage, 'appr_enacted');
    assert.equal(outcome!.classifiedFiscalYear, 2024);
    assert.equal(result.queued, 1);
  });
});

describe('Session 7 — queueing, idempotency and concurrency', () => {
  it('queues exactly one governed ingestion job for a changed source', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HACD_REPORT, KEYS.hacdReport)]);
    await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(h.store.outboxSize(), 1);

    // Repeated observation of the same bytes.
    await run(h, 'govinfo-committee-reports', 'run-2');
    await run(h, 'govinfo-committee-reports', 'run-3');
    assert.equal(h.store.outboxSize(), 1, 'repeated observation does not duplicate the job');
  });

  it('derives one stable outbox identity per observation and job kind', () => {
    const observation = observationDedupKey({
      expectedSourceDedupKey: KEYS.hacdReport,
      contentSha256: sha('crpt-118hrpt121'),
    });
    const a = ingestionOutboxDedupKey({
      observationDedupKey: observation,
      jobKind: 'governed_source_ingestion',
    });
    const b = ingestionOutboxDedupKey({
      observationDedupKey: observation,
      jobKind: 'governed_source_ingestion',
    });
    const other = ingestionOutboxDedupKey({
      observationDedupKey: observation,
      jobKind: 'governed_alternative_funding_ingestion',
    });
    assert.equal(a, b, 'deterministic');
    assert.notEqual(a, other, 'job kinds do not collide');
  });

  it('stops a second live worker from running the same adapter', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    h.store.forceLease('govinfo-committee-reports', 'worker-a', '2024-06-15T12:10:00.000Z');

    const blocked = await run(h, 'govinfo-committee-reports', 'run-b', { leaseOwner: 'worker-b' });
    assert.equal(blocked.status, 'skipped_not_leased');
    assert.equal(blocked.discovered, 0);
    assert.equal(h.store.outboxSize(), 0, 'the losing worker enqueues nothing');
  });

  it('lets a second worker resume after a crashed worker lease expires', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    // worker-a "crashed" holding a lease that has since expired.
    h.store.forceLease('govinfo-committee-reports', 'worker-a', '2024-06-15T11:00:00.000Z');

    const resumed = await run(h, 'govinfo-committee-reports', 'run-b', { leaseOwner: 'worker-b' });
    assert.equal(resumed.status, 'succeeded');
    assert.equal(resumed.queued, 1);
  });

  it('never queues more ingestion work than the changed sources it observed', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport),
      candidate(FY2024_SASC_REPORT, KEYS.sascReport),
      candidate(FY2024_APPROPRIATIONS_ENACTED_NO_DIVISION, KEYS.apprEnacted),
    ]);
    const reports = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.ok(reports.queued <= reports.changed);
    const laws = await run(h, 'govinfo-public-laws', 'run-2');
    assert.ok(laws.queued <= laws.changed);
  });
});

describe('Session 7 — GPU independence', () => {
  it('runs the whole loop with NVIDIA routing disabled and zero GPU capacity', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_HASC_REPORT, KEYS.hascReport)]);
    const result = await run(h, 'govinfo-committee-reports', 'run-1');
    assert.equal(result.gpu.requiresGpu, false);
    assert.equal(result.gpu.activeGpuCapacity, 0);
    assert.equal(result.status, 'succeeded');
  });

  it('declares no GPU dependency on any registered official adapter', () => {
    const registry = new SourceAdapterRegistry();
    for (const adapter of registry.list()) {
      assert.equal(adapter.requiresGpu, false, `${adapter.adapterId} must not require GPU`);
      assert.equal(adapter.authoritative, true, `${adapter.adapterId} must be an official source`);
    }
  });

  it('classifies a PDF-only publisher source with corroboration deferred, not failed', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_PB, KEYS.pb)]);
    const result = await run(h, 'dod-comptroller', 'run-1');
    const [outcome] = result.outcomes;
    assert.equal(outcome!.outcome, 'first_discovery');
    assert.equal(outcome!.classifiedStage, 'president_budget_request');
    assert.match(outcome!.reasons.join(' '), /corroboration deferred to deterministic parsing/i);
  });
});

describe('Session 7 — historical lifecycle replay (real FY2024 sources)', () => {
  it('walks PB -> House committee -> Senate committee -> chamber action -> enacted', async () => {
    const h = harness();
    await bootstrap(h);

    const steps: { adapterId: string; candidates: FixtureCandidate[]; expect: LifecycleStage }[] = [
      {
        adapterId: 'dod-comptroller',
        candidates: [candidate(FY2024_PB, KEYS.pb)],
        expect: 'president_budget_request',
      },
      {
        adapterId: 'govinfo-committee-reports',
        candidates: [candidate(FY2024_HASC_REPORT, KEYS.hascReport)],
        expect: 'hasc_report',
      },
      {
        adapterId: 'govinfo-committee-reports',
        candidates: [candidate(FY2024_SASC_REPORT, KEYS.sascReport)],
        expect: 'sasc_report',
      },
      {
        adapterId: 'govinfo-bills',
        candidates: [candidate(FY2024_HOUSE_NDAA_PASSED, KEYS.houseAuthAction)],
        expect: 'house_auth_action',
      },
      {
        adapterId: 'govinfo-public-laws',
        candidates: [candidate(FY2024_NDAA_ENACTED, KEYS.authEnacted)],
        expect: 'auth_enacted',
      },
    ];

    const observed: LifecycleStage[] = [];
    for (const [index, step] of steps.entries()) {
      load(h, step.candidates);
      const result = await run(h, step.adapterId, `replay-${index}`);
      assert.equal(result.status, 'succeeded', `${step.expect} step failed`);
      const [outcome] = result.outcomes;
      assert.equal(outcome!.classifiedStage, step.expect);
      observed.push(outcome!.classifiedStage!);
    }

    assert.deepEqual(observed, [
      'president_budget_request',
      'hasc_report',
      'sasc_report',
      'house_auth_action',
      'auth_enacted',
    ]);
    // Five distinct stages, five distinct observations. Nothing was overwritten.
    assert.equal(h.store.allObservations().length, 5);
    assert.equal(h.store.outboxSize(), 5);
  });

  it('runs the appropriations track independently of the authorization track', async () => {
    const h = harness();
    await bootstrap(h);

    load(h, [candidate(FY2024_NDAA_ENACTED, KEYS.authEnacted)]);
    await run(h, 'govinfo-public-laws', 'auth-enacted');
    load(h, [
      candidate(FY2024_HACD_REPORT, KEYS.hacdReport),
      candidate(FY2024_SACD_REPORT, KEYS.sacdReport),
    ]);
    await run(h, 'govinfo-committee-reports', 'appr-marks');

    // An enacted authorization did not advance, close or overwrite the
    // appropriations track: its marks are still exactly what was observed.
    assert.equal(h.store.expectedState(KEYS.authEnacted), 'published');
    assert.equal(h.store.expectedState(KEYS.hacdReport), 'published');
    assert.equal(h.store.expectedState(KEYS.sacdReport), 'published');
    assert.equal(
      h.store.expectedState(KEYS.apprEnacted),
      'expected',
      'appropriations not enacted yet',
    );
  });

  it('recomputes only the affected lineage when a corrected source arrives', async () => {
    const h = harness();
    await bootstrap(h);

    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport),
      candidate(FY2024_SASC_REPORT, KEYS.sascReport),
    ]);
    await run(h, 'govinfo-committee-reports', 'marks');
    load(h, [candidate(FY2024_NDAA_ENACTED, KEYS.authEnacted)]);
    await run(h, 'govinfo-public-laws', 'enacted');

    const beforeShas = h.store
      .allObservations()
      .map((o) => o.contentSha256)
      .sort();

    // An authoritative corrected SASC report supersedes only its own version.
    load(h, [
      candidate(FY2024_SASC_REPORT, KEYS.sascReport, {
        shaSeedOverride: 'crpt-118srpt58-corrected',
      }),
    ]);
    const correction = await run(h, 'govinfo-committee-reports', 'correction');
    assert.equal(correction.outcomes[0]!.outcome, 'changed');

    const scope = recomputeScopeForCorrection({
      fiscalYear: 2024,
      authorityTrack: 'authorization',
      correctedStage: 'sasc_report',
      observedStages: ['hasc_report', 'sasc_report', 'auth_enacted', 'hac_d_report'],
    });
    assert.deepEqual([...scope.stages].sort(), ['auth_enacted', 'sasc_report']);
    assert.deepEqual(scope.untouchedEarlierStages, ['hasc_report']);
    assert.deepEqual(scope.untouchedOtherTracks, ['appropriations']);

    // Prior evidence is still present and unmodified.
    const afterShas = h.store
      .allObservations()
      .map((o) => o.contentSha256)
      .sort();
    for (const before of beforeShas)
      assert.ok(afterShas.includes(before), 'prior evidence immutable');
  });

  it('emits source-backed signals without any funding amount', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_PB, KEYS.pb)]);
    await run(h, 'dod-comptroller', 's-pb');
    load(h, [
      candidate(FY2024_HASC_REPORT, KEYS.hascReport),
      candidate(FY2024_SASC_REPORT, KEYS.sascReport),
    ]);
    await run(h, 'govinfo-committee-reports', 's-marks');

    const signals = deriveLifecycleSignals([
      {
        observationDedupKey: 'obs-pb',
        fiscalYear: 2024,
        authorityTrack: 'request',
        stage: 'president_budget_request',
        contentSha256: sha('budget-2024-bud'),
        observedAt: '2024-03-11T00:00:00Z',
      },
      {
        observationDedupKey: 'obs-hasc',
        fiscalYear: 2024,
        authorityTrack: 'authorization',
        stage: 'hasc_report',
        contentSha256: sha('crpt-118hrpt125'),
        observedAt: '2024-06-15T00:00:00Z',
      },
      {
        observationDedupKey: 'obs-sasc',
        fiscalYear: 2024,
        authorityTrack: 'authorization',
        stage: 'sasc_report',
        contentSha256: sha('crpt-118srpt58'),
        observedAt: '2024-07-15T00:00:00Z',
      },
    ]);

    const kinds = signals.map((signal) => signal.signalKind).sort();
    assert.deepEqual(kinds, ['house_to_senate', 'pb_to_hasc', 'pb_to_sasc']);
    for (const signal of signals) {
      assert.ok(
        !Object.keys(signal).some((k) => /amount|usd/i.test(k)),
        'no money field on a signal',
      );
    }
  });
});

describe('Session 7 — alternative funding routes into the Session 6 domain', () => {
  it('classifies a real supplemental and queues governed alternative-funding ingestion', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_UKRAINE_SUPPLEMENTAL, KEYS.supplemental)]);

    const result = await run(h, 'govinfo-public-laws', 'supp-1');
    const [outcome] = result.outcomes;
    assert.equal(outcome!.classifiedAuthorityTrack, 'alternative_funding');
    assert.equal(outcome!.classifiedStage, 'emergency_supplemental');
    assert.equal(outcome!.queuedJobKind, 'governed_alternative_funding_ingestion');
    assert.equal(result.queued, 1);

    // Discovery recorded that a vehicle exists and classified it. It produced no
    // provision, allocation or dollar — those need governed Session 6 ingestion.
    assert.ok(
      !Object.keys(outcome!).some((k) => /amount|usd|dollar/i.test(k)),
      'no funding field on a discovery outcome',
    );
  });

  it('keeps alternative funding off the annual authorization and appropriations tracks', async () => {
    const h = harness();
    await bootstrap(h);
    load(h, [candidate(FY2024_UKRAINE_SUPPLEMENTAL, KEYS.supplemental)]);
    await run(h, 'govinfo-public-laws', 'supp-1');

    assert.equal(h.store.expectedState(KEYS.supplemental), 'published');
    assert.equal(h.store.expectedState(KEYS.authEnacted), 'expected');
    assert.equal(h.store.expectedState(KEYS.apprEnacted), 'expected');
  });
});
