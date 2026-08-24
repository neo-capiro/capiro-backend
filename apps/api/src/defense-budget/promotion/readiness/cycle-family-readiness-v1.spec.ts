/**
 * Phase 10B-2 — cycle-family-readiness-v1 spec.
 *
 * Covers the corpus-completeness half of the required test matrix:
 *   - incomplete family -> waiting_for_sources, no reconciliation
 *   - final required source becomes ingested -> family becomes ready
 *   - REVIEW source blocks readiness
 *   - REJECT source blocks promotion (readiness)
 *   - network/unavailable is not converted to not_filed
 *   - request and appropriations cannot satisfy each other's corpus
 *   - alternative funding cannot satisfy or overwrite annual corpus
 *   - identical readiness evaluation is idempotent
 */
import {
  evaluateCycleFamilyReadinessV1,
  readinessIngestionOutcomeFromBridgeResultV1,
  type CycleFamilyCorpusInputV1,
  type CycleFamilyReadinessIdentityV1,
  type ReadinessExpectedSourceInputV1,
} from './cycle-family-readiness-v1.js';

function identity(
  overrides: Partial<CycleFamilyReadinessIdentityV1> = {},
): CycleFamilyReadinessIdentityV1 {
  return {
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    familyGroup: 'rdte',
    ...overrides,
  };
}

function source(overrides: Partial<ReadinessExpectedSourceInputV1> = {}): ReadinessExpectedSourceInputV1 {
  return {
    expectedSourceId: 'exp-1',
    sourceFamily: 'pb_r1',
    optional: false,
    expectedState: 'expected',
    latestIngestion: null,
    ...overrides,
  };
}

function corpus(
  sources: readonly ReadinessExpectedSourceInputV1[],
  overrides: Partial<CycleFamilyCorpusInputV1> = {},
): CycleFamilyCorpusInputV1 {
  return {
    identity: identity(),
    cycleId: 'cycle-2027-authorization',
    expectedSources: sources,
    ...overrides,
  };
}

describe('evaluateCycleFamilyReadinessV1', () => {
  it('[waiting_for_sources] incomplete family: a required source still expected blocks readiness and no reconciliation-relevant state is produced', () => {
    const decision = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'expected' }),
      ]),
    );
    expect(decision.state).toBe('waiting_for_sources');
    expect(decision.blocks.map((b) => b.reason)).toEqual(['required_source_not_yet_resolved']);
    expect(decision.resolvedCount).toBe(1);
    expect(decision.requiredCount).toBe(2);
  });

  it('[ready_for_reconciliation] final required source becomes ingested: family becomes ready', () => {
    const stillWaiting = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'published', latestIngestion: 'ingestion_incomplete' }),
      ]),
    );
    expect(stillWaiting.state).toBe('waiting_for_sources');

    const nowReady = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'published', latestIngestion: 'ingested_pass' }),
      ]),
    );
    expect(nowReady.state).toBe('ready_for_reconciliation');
    expect(nowReady.blocks).toEqual([]);
    expect(nowReady.resolvedCount).toBe(2);
  });

  it('[review_required] a REVIEW-disposition source blocks readiness with its own reason, distinct from waiting', () => {
    const decision = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'published', latestIngestion: 'ingested_review' }),
      ]),
    );
    expect(decision.state).toBe('review_required');
    expect(decision.blocks).toEqual([
      {
        reason: 'required_source_review_required',
        detail: expect.stringContaining('REVIEW'),
      },
    ]);
  });

  it('[review_required] a REJECT-disposition source blocks promotion via review_required, and is never silently promoted', () => {
    const decision = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'published', latestIngestion: 'ingested_reject' }),
      ]),
    );
    expect(decision.state).toBe('review_required');
    expect(decision.blocks[0]?.reason).toBe('required_source_rejected');
    expect(decision.state).not.toBe('ready_for_reconciliation');
  });

  it('[negative control] network/unavailable is never converted to not_filed: a published-but-ingestion-incomplete source reports required_source_ingestion_incomplete, never not_filed semantics', () => {
    // "unavailable" here is the GOVERNED terminal state (a human/watcher already
    // decided the source cannot be fetched) — readiness reports it faithfully as
    // a block, but must NEVER be the state a transient fetch failure maps to.
    // A transient failure never reaches this input as expectedState="not_filed"
    // or "unavailable" in the first place (see readinessIngestionOutcomeFromBridgeResultV1
    // below, and the upstream watcher contract this module explicitly does not
    // re-derive) — this test proves the one thing THIS module is responsible for:
    // a bridge run that merely failed to complete (threw, transient infra error)
    // maps to 'ingestion_incomplete', which is treated exactly like "not yet
    // observed" and NEVER like the governed 'not_filed'/'unavailable' terminal.
    const transientFailureOutcome = readinessIngestionOutcomeFromBridgeResultV1({
      ingestionSucceeded: false,
      verificationDisposition: null,
    });
    expect(transientFailureOutcome).toBe('ingestion_incomplete');
    expect(transientFailureOutcome).not.toBe('not_filed' as never);

    const decision = evaluateCycleFamilyReadinessV1(
      corpus([
        source({
          expectedSourceId: 'r1',
          expectedState: 'published',
          latestIngestion: transientFailureOutcome,
        }),
      ]),
    );
    expect(decision.state).toBe('waiting_for_sources');
    expect(decision.blocks[0]?.reason).toBe('required_source_ingestion_incomplete');
  });

  it('[negative control] a genuinely governed not_filed/withdrawn/unavailable REQUIRED source blocks with its own reason and is reported, never silently dropped as zero', () => {
    for (const governedState of ['not_filed', 'withdrawn', 'unavailable'] as const) {
      const decision = evaluateCycleFamilyReadinessV1(
        corpus([source({ expectedSourceId: 'r1', expectedState: governedState, optional: false })]),
      );
      expect(decision.state).toBe('review_required');
      expect(decision.blocks).toHaveLength(1);
      expect(decision.blocks[0]?.detail).toContain(governedState);
    }
  });

  it('[optional terminal] an OPTIONAL source correctly marked not_filed/withdrawn/unavailable is excluded from the required corpus, not counted as missing', () => {
    const decision = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
        source({ expectedSourceId: 'r2', expectedState: 'not_filed', optional: true }),
      ]),
    );
    expect(decision.state).toBe('ready_for_reconciliation');
    expect(decision.requiredCount).toBe(1);
    expect(decision.excludedOptionalTerminalCount).toBe(1);
  });

  it('[scoping] request and appropriations are independent readiness identities: an appropriations-scoped corpus cannot be substituted for a request-scoped evaluation', () => {
    const requestIdentity = identity({ authorityTrack: 'request' });
    const approprIdentity = identity({ authorityTrack: 'appropriations' });
    expect(requestIdentity.authorityTrack).not.toBe(approprIdentity.authorityTrack);

    // The readiness KEY differs solely on authorityTrack — nothing in
    // evaluateCycleFamilyReadinessV1 reads a global "current FY" or merges
    // scopes; a corpus built for one identity is evaluated only against that
    // identity's own expected sources, by construction (the function takes no
    // other-track input at all).
    const requestReady = evaluateCycleFamilyReadinessV1({
      identity: requestIdentity,
      cycleId: 'cycle-2027-request',
      expectedSources: [
        source({ expectedSourceId: 'req-1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
      ],
    });
    const approprWaiting = evaluateCycleFamilyReadinessV1({
      identity: approprIdentity,
      cycleId: 'cycle-2027-appropriations',
      expectedSources: [source({ expectedSourceId: 'appr-1', expectedState: 'expected' })],
    });
    expect(requestReady.state).toBe('ready_for_reconciliation');
    expect(approprWaiting.state).toBe('waiting_for_sources');
  });

  it('[scoping] alternative_funding can never satisfy or overwrite the annual corpus: its track is unsupported and always waiting_for_sources regardless of its own corpus completeness', () => {
    const altFundingIdentity = identity({ authorityTrack: 'alternative_funding', familyGroup: 'rdte' });
    const decision = evaluateCycleFamilyReadinessV1({
      identity: altFundingIdentity,
      cycleId: 'cycle-2027-alt-funding',
      // Even a FULLY resolved corpus must not advance past waiting_for_sources
      // for this track — there is no Phase 4/5/6 certifier for it, and this
      // module refuses to invent one.
      expectedSources: [
        source({ expectedSourceId: 'alt-1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
      ],
    });
    expect(decision.state).toBe('waiting_for_sources');
    expect(decision.blocks[0]?.reason).toBe('unsupported_track');

    // And the annual (authorization) identity for the SAME fiscal year is
    // completely unaffected by the alt-funding corpus — different identity,
    // independently evaluated, no shared state.
    const annualReady = evaluateCycleFamilyReadinessV1(
      corpus([
        source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
      ]),
    );
    expect(annualReady.state).toBe('ready_for_reconciliation');
  });

  it('[idempotent] identical readiness evaluation on the identical corpus is idempotent: same input twice yields byte-identical decisions', () => {
    const input = corpus([
      source({ expectedSourceId: 'r1', expectedState: 'published', latestIngestion: 'ingested_pass' }),
      source({ expectedSourceId: 'r2', expectedState: 'published', latestIngestion: 'ingested_pass' }),
    ]);
    const first = evaluateCycleFamilyReadinessV1(input);
    const second = evaluateCycleFamilyReadinessV1(input);
    expect(second).toEqual(first);
  });

  it('[bridge mapping] readinessIngestionOutcomeFromBridgeResultV1 maps the exact three governed dispositions plus the incomplete case', () => {
    expect(
      readinessIngestionOutcomeFromBridgeResultV1({
        ingestionSucceeded: true,
        verificationDisposition: 'passed',
      }),
    ).toBe('ingested_pass');
    expect(
      readinessIngestionOutcomeFromBridgeResultV1({
        ingestionSucceeded: false,
        verificationDisposition: 'review',
      }),
    ).toBe('ingested_review');
    expect(
      readinessIngestionOutcomeFromBridgeResultV1({
        ingestionSucceeded: false,
        verificationDisposition: 'rejected',
      }),
    ).toBe('ingested_reject');
    expect(
      readinessIngestionOutcomeFromBridgeResultV1({
        ingestionSucceeded: false,
        verificationDisposition: null,
      }),
    ).toBe('ingestion_incomplete');
  });

  it('[negative control] no expected sources registered yet reports waiting_for_sources, not a fabricated ready state', () => {
    const decision = evaluateCycleFamilyReadinessV1(corpus([]));
    expect(decision.state).toBe('waiting_for_sources');
    expect(decision.blocks[0]?.reason).toBe('no_expected_sources');
  });
});
