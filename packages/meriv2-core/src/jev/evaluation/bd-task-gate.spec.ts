import { describe, expect, it } from '@jest/globals';
import {
  BD_EVALUATION_MIN_REVIEWED_CASES,
  bdTaskReviewFixtureSchema,
  type BdEvalCase,
  type BdTaskReviewFixture,
} from '../bd-fixture-schema';
import { evaluateBdTaskGate } from './bd-task-gate';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from '../task-registry';

/**
 * SYNTHETIC unit tests. Every case below is programmatically generated with
 * deterministic fake ids/hashes and NO human reviewer identity. These tests
 * prove the gate LOGIC only (fail-closed rules, metrics, stratification).
 * They are not — and must never be reported as — semantic accuracy evidence,
 * and the synthetic pass case is not real evaluation data.
 */

interface CaseOverrides {
  count?: number;
  task?: 'bd_entity' | 'bd_signal';
  split?: 'tuning' | 'heldout';
  status?: 'proposed' | 'approved';
  expectedOutcome?: string;
  jevOutcome?: string | null;
  jevAction?: 'propose' | 'abstain' | null;
  jevLatencyMs?: number;
  jevUsage?: { inputTokens: number; outputTokens: number } | null;
  /** bd_entity effect: actually merge the two records as one legal entity. */
  mergeEffect?: boolean;
  /** bd_signal effect: apply a direct label (with proof unless directLabelUnproven). */
  directLabelEffect?: boolean;
  directLabelUnproven?: boolean;
  directLabelForeignSource?: boolean;
  /** Proof cites a real in-case source record but a mismatched financial stage. */
  directLabelTupleMismatch?: boolean;
  requireHumanFollowUp?: boolean;
  sourceAvailability?: 'available' | 'empty_in_queried_scope' | 'partial' | 'stale' | 'error';
  sourceFamily?: string;
  companyKey?: string;
}

function syntheticCase(index: number, overrides: CaseOverrides = {}): BdEvalCase {
  const task = overrides.task ?? 'bd_signal';
  const approved = (overrides.status ?? 'approved') === 'approved';
  const difficultNegative = index % 5 === 0;
  const split = overrides.split ?? (index % 3 === 0 ? 'tuning' : 'heldout');
  const expectedOutcome = overrides.expectedOutcome ?? (task === 'bd_entity'
    ? (index % 4 === 0 ? 'same_legal_entity' : index % 4 === 1 ? 'related_not_same'
      : index % 4 === 2 ? 'different' : 'insufficient_evidence')
    : (index % 5 === 0 ? 'explicit_link' : index % 5 === 1 ? 'conditional_alignment'
      : index % 5 === 2 ? 'thematic_fit' : index % 5 === 3 ? 'unrelated' : 'insufficient_evidence'));
  const sources = [{
    sourceRecordId: `rec-${index}`,
    sourceFamily: overrides.sourceFamily ?? (index % 2 === 0 ? 'usaspending' : 'sam'),
    snapshotId: `snap-${index}`,
    snapshotHash: `hash-${index}-abcdef`,
    retrievedAt: '2026-09-01',
    locator: `https://example.test/records/${index}`,
  }];
  const jevOutcome = overrides.jevOutcome !== undefined ? overrides.jevOutcome
    : (index % 20 === 7 ? (task === 'bd_entity' ? 'different' : 'thematic_fit') : expectedOutcome);
  const followUp = overrides.requireHumanFollowUp ?? false;
  const base = {
    id: `synthetic-${index}`,
    task,
    split,
    grouping: {
      companyKey: overrides.companyKey ?? `${split}-company-${index % 40}`,
      sourceKey: `${split}-source-${index % 6}`,
      timeKey: `${split}-2026-Q${(index % 4) + 1}`,
    },
    strata: {
      sourceFamily: sources[0]!.sourceFamily,
      sector: `sector-${index % 5}`,
      companySize: (['micro', 'small', 'mid', 'large', 'unknown'] as const)[index % 5]!,
      taskCategory: `category-${index % 3}`,
      sourceAvailability: overrides.sourceAvailability
        ?? (index % 6 === 5 ? 'partial' : 'available'),
    },
    sources,
    expectedOutcome,
    rationale: `synthetic rationale ${index}`,
    humanReview: approved
      ? {
        status: 'approved' as const,
        reviewer: { reviewerId: 'synthetic-reviewer-id', reviewedAt: '2026-09-20T00:00:00.000Z' },
        difficultNegative,
        adjudication: difficultNegative ? {
          required: true as const,
          reviewerIds: ['synthetic-reviewer-a', 'synthetic-reviewer-b'],
          adjudicatorId: 'synthetic-adjudicator',
          adjudicatedAt: '2026-09-21T00:00:00.000Z',
          finalOutcomeConfirmed: true,
        } : null,
      }
      : { status: 'proposed' as const, reviewer: null, reviewedAt: null,
        difficultNegative: false, adjudication: null },
    observations: {
      baseline: {
        outcome: expectedOutcome, action: 'propose' as const, confidence: 0.8,
        latencyMs: 50, usage: { inputTokens: 100, outputTokens: 20 }, failureState: null,
      },
      jev: {
        outcome: jevOutcome,
        action: (overrides.jevAction !== undefined ? overrides.jevAction
          : (jevOutcome === null ? null : 'propose' as const)),
        confidence: 0.9,
        latencyMs: overrides.jevLatencyMs ?? 40,
        usage: overrides.jevUsage !== undefined ? overrides.jevUsage
          : { inputTokens: 120, outputTokens: 30 },
        failureState: jevOutcome === null ? 'timeout' : null,
      },
    },
  };
  if (task === 'bd_entity') {
    return {
      ...base,
      input: {
        organizationA: { publicId: `org-a-${index}`, nameHash: `namehash-a-${index}-abcdef` },
        organizationB: { publicId: `org-b-${index}`, nameHash: `namehash-b-${index}-abcdef` },
      },
      effect: {
        kind: 'bd_entity_effect' as const,
        exactIdentityMergePerformed: overrides.mergeEffect ?? false,
        requiredHumanFollowUp: followUp,
      },
    } as BdEvalCase;
  }
  const applyDirectLabel = overrides.directLabelEffect ?? false;
  const unproven = overrides.directLabelUnproven ?? false;
  const foreign = overrides.directLabelForeignSource ?? false;
  const mismatchedTuple = overrides.directLabelTupleMismatch ?? false;
  const supportedStage = (index % 6 === 3) ? 'obligated' : 'awarded';
  return {
    ...base,
    input: {
      companyPublicId: `company-${index}`,
      signalSourceRecordId: `rec-${index}`,
      recordType: 'award' as const,
      financialStage: supportedStage,
    },
    effect: {
      kind: 'bd_signal_effect' as const,
      directLabelApplied: applyDirectLabel,
      directLabelProof: applyDirectLabel && !unproven ? {
        resolvedCompanyPublicId: `company-${index}`,
        sourceRecordId: foreign ? 'rec-not-in-case' : `rec-${index}`,
        recordType: 'award' as const,
        financialStage: mismatchedTuple ? 'requested' : supportedStage,
        locator: `https://example.test/records/${index}`,
      } : null,
      requiredHumanFollowUp: followUp,
    },
  } as BdEvalCase;
}

const SIGNAL_OUTCOMES = ['explicit_link', 'conditional_alignment', 'thematic_fit', 'unrelated', 'insufficient_evidence'];
const ENTITY_OUTCOMES = ['same_legal_entity', 'related_not_same', 'different', 'insufficient_evidence'];

function fullThresholdMap(task: 'bd_entity' | 'bd_signal'): {
  minPrecisionByOutcome: Record<string, number>;
  minRecallByOutcome: Record<string, number>;
} {
  const outcomes = task === 'bd_entity' ? ENTITY_OUTCOMES : SIGNAL_OUTCOMES;
  return {
    minPrecisionByOutcome: Object.fromEntries(outcomes.map((o) => [o, 0])),
    minRecallByOutcome: Object.fromEntries(outcomes.map((o) => [o, 0])),
  };
}

function syntheticFixture(overrides: CaseOverrides = {}): BdTaskReviewFixture {
  const task = overrides.task ?? 'bd_signal';
  const registration = JEV_TASK_REGISTRY[task];
  const count = overrides.count ?? 120;
  const cases = Array.from({ length: count }, (_, index) => syntheticCase(index, overrides));
  return bdTaskReviewFixtureSchema.parse({
    version: 'bd_task_review_fixture_v2' as const,
    registryVersion: JEV_TASK_REGISTRY_VERSION,
    task,
    pinned: {
      modelVersion: registration.modelVersion,
      questionVersion: registration.questionVersion,
      registryVersion: JEV_TASK_REGISTRY_VERSION,
      candidateGenerator: registration.candidateGenerator,
      priceVersion: registration.costBudget.priceVersion,
    },
    ceilings: { maxP95LatencyMs: 8_000, maxMedianLatencyMs: 500, maxEstimatedCostUsd: 1 },
    thresholds: {
      ...fullThresholdMap(task),
      maxAbstainShare: 0.5,
      maxReviewShare: 0.5,
    },
    cases,
  });
}

describe('bd task gate (synthetic — logic only, never semantic accuracy)', () => {
  it('passes for a synthetic structurally valid fixture (gate logic only)', () => {
    const fixture = syntheticFixture();
    const result = evaluateBdTaskGate(fixture);
    expect(result.reasons).toEqual([]);
    expect(result.approved).toBe(true);
    expect(result.metrics.reviewedCases).toBe(120);
    expect(result.metrics.confusionMatrix.explicit_link!.explicit_link).toBeGreaterThan(0);
    expect(result.metrics.severeErrors).toEqual([]);
    expect(result.metrics.strata.sourceFamily.usaspending!.count).toBeGreaterThan(0);
    // Input-only pricing: 120 approved × 120 input tokens × $0.042/M.
    expect(result.metrics.estimatedCostUsd).toBeCloseTo((120 * 120 * 0.042) / 1_000_000, 9);
  });

  it('fails closed on insufficient reviewed cases (proposed never counts)', () => {
    const fixture = syntheticFixture({ count: 60 });
    const result = evaluateBdTaskGate(fixture);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(
      `insufficient_reviewed_cases: 60 < ${BD_EVALUATION_MIN_REVIEWED_CASES} approved for task bd_signal`);
    const allProposed = evaluateBdTaskGate(syntheticFixture({ count: 5, status: 'proposed' }));
    expect(allProposed.approved).toBe(false);
    expect(allProposed.metrics.proposedCases).toBe(5);
    expect(allProposed.metrics.reviewedCases).toBe(0);
  });

  it('fails closed when all cases are proposed-labeled', () => {
    const result = evaluateBdTaskGate(syntheticFixture({ count: 120, status: 'proposed' }));
    expect(result.approved).toBe(false);
    expect(result.metrics.reviewedCases).toBe(0);
    expect(result.reasons.join(' ')).toContain('insufficient_reviewed_cases');
    expect(result.reasons.join(' ')).toContain('no_heldout_cohort');
  });

  it('fails closed on cohort partition leakage (company/source/time shared across splits)', () => {
    const result = evaluateBdTaskGate(syntheticFixture({ count: 120, companyKey: 'one-company' }));
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('cohort_partition_leak:companyKey');
  });

  it('fails closed on missing strata (single source family)', () => {
    const result = evaluateBdTaskGate(syntheticFixture({ count: 120, sourceFamily: 'sam' }));
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('missing_strata');
  });

  it('flags unreviewed exact-identity merge effects even on proposed cases', () => {
    // Merge effect on a PROPOSED (unreviewed) case must be severe.
    const result = evaluateBdTaskGate(syntheticFixture({
      count: 120, task: 'bd_entity', status: 'proposed', mergeEffect: true }));
    expect(result.metrics.severeErrors.some((e) => e.kind === 'unreviewed_exact_identity_merge')).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('severe_invariant_violations');
    // The same merge on an approved case is not severe by itself (suggestions are allowed).
    const approvedMerge = evaluateBdTaskGate(syntheticFixture({
      count: 120, task: 'bd_entity', mergeEffect: true }));
    expect(approvedMerge.metrics.severeErrors).toEqual([]);
  });

  it('flags direct signal labels lacking deterministic proof, including foreign source records', () => {
    // The schema itself rejects an unproven direct label at parse time; the gate
    // additionally defends against post-parse corruption (proof stripped or
    // pointing at a foreign source record).
    const unproven = syntheticFixture({ count: 120, directLabelEffect: true });
    for (const item of unproven.cases) {
      if (item.task === 'bd_signal') item.effect.directLabelProof = null;
    }
    const unprovenResult = evaluateBdTaskGate(unproven);
    expect(unprovenResult.approved).toBe(false);
    expect(unprovenResult.metrics.severeErrors.every((e) => e.kind === 'direct_signal_label_without_proof')).toBe(true);

    const foreign = syntheticFixture({ count: 120, directLabelEffect: true });
    for (const item of foreign.cases) {
      if (item.task === 'bd_signal' && item.effect.directLabelProof) {
        item.effect.directLabelProof.sourceRecordId = 'rec-not-in-case';
      }
    }
    const foreignResult = evaluateBdTaskGate(foreign);
    expect(foreignResult.approved).toBe(false);
    expect(foreignResult.metrics.severeErrors.some((e) =>
      e.detail.includes('not present in the case sources'))).toBe(true);

    // A fully proven direct label is not severe.
    const proven = evaluateBdTaskGate(syntheticFixture({ count: 120, directLabelEffect: true }));
    expect(proven.metrics.severeErrors).toEqual([]);
    expect(proven.approved).toBe(true);
  });

  it('fails closed on predeclared precision/recall threshold failure', () => {
    const fixture = syntheticFixture({ count: 120, jevOutcome: 'unrelated' });
    fixture.thresholds.minRecallByOutcome = { explicit_link: 0.5 };
    const result = evaluateBdTaskGate(fixture);
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('recall_threshold_failed:explicit_link');
    expect(result.metrics.perOutcomeRecall.explicit_link).toBeLessThan(0.5);

    const precisionFixture = syntheticFixture({ count: 120, jevOutcome: 'explicit_link' });
    precisionFixture.thresholds.minPrecisionByOutcome = { thematic_fit: 0.9 };
    const precisionResult = evaluateBdTaskGate(precisionFixture);
    expect(precisionResult.approved).toBe(false);
    expect(precisionResult.reasons.join(' ')).toContain('precision_threshold_failed:thematic_fit');

    // Threshold for an outcome with no approved cases fails closed.
    const missing = syntheticFixture();
    missing.thresholds.minPrecisionByOutcome = { no_such_outcome: 0.5 };
    const missingResult = evaluateBdTaskGate(missing);
    expect(missingResult.approved).toBe(false);
    expect(missingResult.reasons.join(' ')).toContain('threshold_outcome_missing_precision');
  });

  it('fails closed on abstain/review-share thresholds and computes the recorded human-review share', () => {
    const abstainFixture = syntheticFixture({ count: 120, jevAction: 'abstain' });
    abstainFixture.thresholds.maxAbstainShare = 0.1;
    const abstainResult = evaluateBdTaskGate(abstainFixture);
    expect(abstainResult.approved).toBe(false);
    expect(abstainResult.reasons.join(' ')).toContain('abstain_share_threshold_failed');
    expect(abstainResult.metrics.abstainShare).toBe(1);

    const reviewFixture = syntheticFixture({ count: 120, requireHumanFollowUp: true });
    reviewFixture.thresholds.maxReviewShare = 0.1;
    const reviewResult = evaluateBdTaskGate(reviewFixture);
    expect(reviewResult.approved).toBe(false);
    expect(reviewResult.reasons.join(' ')).toContain('review_share_threshold_failed');
    expect(reviewResult.metrics.reviewShare).toBe(1);
    // reviewShare is the recorded requiredHumanFollowUp share, not leakage share.
    expect(evaluateBdTaskGate(syntheticFixture({ count: 120 })).metrics.reviewShare).toBe(0);
  });

  it('fails closed on latency and cost ceilings (input-only pricing)', () => {
    const slow = evaluateBdTaskGate(syntheticFixture({ count: 120, jevLatencyMs: 9_000 }));
    expect(slow.approved).toBe(false);
    expect(slow.reasons.join(' ')).toContain('p95_latency_ceiling_exceeded');
    const expensive = evaluateBdTaskGate(syntheticFixture({
      count: 120, jevUsage: { inputTokens: 900_000, outputTokens: 0 } }));
    expect(expensive.approved).toBe(false);
    expect(expensive.reasons.join(' ')).toContain('cost_ceiling_exceeded');
    // Output tokens are free: huge output alone stays under the $1 ceiling.
    const outputHeavy = evaluateBdTaskGate(syntheticFixture({
      count: 120, jevUsage: { inputTokens: 120, outputTokens: 900_000_000 } }));
    expect(outputHeavy.approved).toBe(true);
    expect(outputHeavy.metrics.estimatedCostUsd).toBeCloseTo((120 * 120 * 0.042) / 1_000_000, 9);
  });

  it('fails closed on unadjudicated difficult negatives and version pin mismatches', () => {
    const unadjudicated = syntheticFixture({ count: 120 });
    for (const item of unadjudicated.cases) {
      if (item.humanReview.status === 'approved' && item.humanReview.difficultNegative) {
        item.humanReview.adjudication = null;
      }
    }
    const result = evaluateBdTaskGate(unadjudicated);
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('unadjudicated_difficult_negatives');

    const unpinned = syntheticFixture();
    unpinned.pinned.modelVersion = 'jev-0.0.0';
    const unpinnedResult = evaluateBdTaskGate(unpinned);
    expect(unpinnedResult.approved).toBe(false);
    expect(unpinnedResult.reasons.join(' ')).toContain('model_version_mismatch');
  });

  it('never authorizes rollout changes and keeps price to the approved public version', () => {
    const result = evaluateBdTaskGate(syntheticFixture());
    expect(result.authorization).toContain('none');
    expect(result.registryVersion).toBe(JEV_TASK_REGISTRY_VERSION);
  });

  it('rejects schema-level fabrication: unadjudicated difficult negative, unproven direct label, task mismatch', () => {
    const bad = syntheticCase(0);
    if (bad.humanReview.status === 'approved') {
      bad.humanReview.difficultNegative = true;
      bad.humanReview.adjudication = null;
    }
    expect(() => bdTaskReviewFixtureSchema.parse({ ...syntheticFixture(), cases: [bad] })).toThrow();

    const unproven = syntheticCase(0, { directLabelEffect: true, directLabelUnproven: true });
    expect(() => bdTaskReviewFixtureSchema.parse({ ...syntheticFixture(), cases: [unproven] })).toThrow();

    // Mixed-task fixture is rejected: every case task must equal the fixture task.
    const entityCase = syntheticCase(0, { task: 'bd_entity' });
    const mixed = syntheticFixture();
    expect(() => bdTaskReviewFixtureSchema.parse({ ...mixed, cases: [entityCase, ...mixed.cases.slice(1)] }))
      .toThrow(/single-task/);
  });

  it('reports per-outcome confusion matrices and precision/recall over approved cases', () => {
    const result = evaluateBdTaskGate(syntheticFixture({ count: 120 }));
    for (const outcome of SIGNAL_OUTCOMES) {
      expect(result.metrics.perOutcomePrecision[outcome]).toBeGreaterThanOrEqual(0);
      expect(result.metrics.perOutcomeRecall[outcome]).toBeGreaterThanOrEqual(0);
    }
    // Observed columns are exactly the distinct actual observation labels.
    const allObserved = new Set<string>();
    for (const row of Object.values(result.metrics.confusionMatrix)) {
      for (const [observed, count] of Object.entries(row)) {
        if (count > 0) allObserved.add(observed);
      }
    }
    const expectedObserved = new Set(
      syntheticFixture({ count: 120 }).cases
        .filter((c) => c.humanReview.status === 'approved')
        .map((c) => (c.observations.jev.outcome === null
          ? `failure:${c.observations.jev.failureState}` : c.observations.jev.action === 'abstain'
            ? 'abstain' : c.observations.jev.outcome!)),
    );
    expect(allObserved).toEqual(new Set([...allObserved].filter((o) => expectedObserved.has(o))));
    expect(Object.keys(result.metrics.confusionMatrix).sort())
      .toEqual([...new Set(syntheticFixture({ count: 120 }).cases
        .filter((c) => c.humanReview.status === 'approved')
        .map((c) => c.expectedOutcome))].sort());
  });

  it('builds observed columns from actual observation labels including failure:<state> and abstain', () => {
    const fixture = syntheticFixture({ count: 120, jevOutcome: null });
    for (const item of fixture.cases) {
      if (item.humanReview.status === 'approved' && item.task === 'bd_signal') {
        item.observations.jev.outcome = null;
        item.observations.jev.action = null;
        item.observations.jev.failureState = 'timeout';
      }
    }
    const mixed = syntheticFixture({ count: 120, jevAction: 'abstain' });
    const mixedResult = evaluateBdTaskGate(mixed);
    const columns = Object.keys(mixedResult.metrics.confusionMatrix.explicit_link ?? {});
    expect(columns).toContain('abstain');
    expect(mixedResult.metrics.confusionMatrix.explicit_link!.abstain).toBeGreaterThan(0);
    const result = evaluateBdTaskGate(fixture);
    const failColumns = Object.keys(result.metrics.confusionMatrix.explicit_link ?? {});
    expect(failColumns).toContain('failure:timeout');
    // Both representations carry the same observed-column set across every row.
    const columnSets = Object.values(result.metrics.confusionMatrix).map((row) => Object.keys(row).sort());
    for (const set of columnSets) expect(set).toEqual(columnSets[0]!);
  });

  it('fails closed on duplicated adjudication reviewer ids (schema + gate)', () => {
    const duplicated = { ...adjudicationCase(), humanReview: {
      status: 'approved' as const,
      reviewer: { reviewerId: 'synthetic-reviewer-id', reviewedAt: '2026-09-20T00:00:00.000Z' },
      difficultNegative: true,
      adjudication: {
        required: true as const,
        reviewerIds: ['same-reviewer', 'same-reviewer'],
        adjudicatorId: 'synthetic-adjudicator',
        adjudicatedAt: '2026-09-21T00:00:00.000Z',
        finalOutcomeConfirmed: true,
      },
    } };
    expect(() => bdTaskReviewFixtureSchema.parse({ ...syntheticFixture(), cases: [duplicated] })).toThrow(/DISTINCT/);
    // Post-parse corruption with duplicated ids is also rejected by the gate.
    const corrupted = syntheticFixture({ count: 120 });
    for (const item of corrupted.cases) {
      if (item.humanReview.status === 'approved' && item.humanReview.adjudication) {
        item.humanReview.adjudication.reviewerIds = ['same-reviewer', 'same-reviewer'] as unknown as typeof item.humanReview.adjudication.reviewerIds;
      }
    }
    const result = evaluateBdTaskGate(corrupted);
    expect(result.approved).toBe(false);
    expect(result.reasons.join(' ')).toContain('duplicated_adjudication_reviewer_ids');
  });

  it('fails closed on direct-label proof that mismatches the exact evaluated tuple', () => {
    const mismatch = evaluateBdTaskGate(syntheticFixture({
      count: 120, directLabelEffect: true, directLabelTupleMismatch: true }));
    expect(mismatch.approved).toBe(false);
    expect(mismatch.metrics.severeErrors.some((e) => e.detail.includes('exact evaluated tuple'))).toBe(true);
    // Unsupported financial stage / record type are rejected by the schema itself.
    const badStage = syntheticCase(0, { directLabelEffect: true });
    (badStage as { input: { financialStage: string } }).input.financialStage = 'speculative';
    expect(() => bdTaskReviewFixtureSchema.parse({ ...syntheticFixture(), cases: [badStage] })).toThrow();
    const badType = syntheticCase(0, { directLabelEffect: true });
    (badType as { input: { recordType: string } }).input.recordType = 'rumor';
    expect(() => bdTaskReviewFixtureSchema.parse({ ...syntheticFixture(), cases: [badType] })).toThrow();
  });

  it('fails closed on empty or partial predeclared threshold maps', () => {
    const empty = syntheticFixture();
    empty.thresholds.minPrecisionByOutcome = {};
    empty.thresholds.minRecallByOutcome = {};
    const emptyResult = evaluateBdTaskGate(empty);
    expect(emptyResult.approved).toBe(false);
    expect(emptyResult.reasons.join(' ')).toContain('threshold_map_incomplete_precision:explicit_link');
    expect(emptyResult.reasons.join(' ')).toContain('threshold_map_incomplete_recall:insufficient_evidence');

    const partial = syntheticFixture();
    partial.thresholds.minPrecisionByOutcome = { explicit_link: 0 };
    partial.thresholds.minRecallByOutcome = { explicit_link: 0, thematic_fit: 0 };
    const partialResult = evaluateBdTaskGate(partial);
    expect(partialResult.approved).toBe(false);
    expect(partialResult.reasons.join(' ')).toContain('threshold_map_incomplete_precision:thematic_fit');
    expect(partialResult.reasons.join(' ')).toContain('threshold_map_incomplete_recall:unrelated');

    // A full threshold map covering every allowed outcome passes the completeness rule.
    const full = evaluateBdTaskGate(syntheticFixture());
    expect(full.reasons.join(' ')).not.toContain('threshold_map_incomplete');
  });

  it('fails closed on missing/thin strata in every required dimension, not source family alone', () => {
    const sourceFamily = evaluateBdTaskGate(syntheticFixture({ count: 120, sourceFamily: 'sam' }));
    expect(sourceFamily.reasons.join(' ')).toContain('missing_strata:sourceFamily');
    expect(sourceFamily.approved).toBe(false);

    const singleSector = syntheticFixture();
    for (const item of singleSector.cases) item.strata.sector = 'only-sector';
    const sectorResult = evaluateBdTaskGate(singleSector);
    expect(sectorResult.approved).toBe(false);
    expect(sectorResult.reasons.join(' ')).toContain('missing_strata:sector');

    const singleSize = syntheticFixture();
    for (const item of singleSize.cases) item.strata.companySize = 'unknown';
    const sizeResult = evaluateBdTaskGate(singleSize);
    expect(sizeResult.approved).toBe(false);
    expect(sizeResult.reasons.join(' ')).toContain('missing_strata:companySize');

    const singleCategory = syntheticFixture();
    for (const item of singleCategory.cases) item.strata.taskCategory = 'only-category';
    const categoryResult = evaluateBdTaskGate(singleCategory);
    expect(categoryResult.approved).toBe(false);
    expect(categoryResult.reasons.join(' ')).toContain('missing_strata:taskCategory');

    const singleAvailability = syntheticFixture({ count: 120, sourceAvailability: 'available' });
    const availabilityResult = evaluateBdTaskGate(singleAvailability);
    expect(availabilityResult.approved).toBe(false);
    expect(availabilityResult.reasons.join(' ')).toContain('missing_strata:sourceAvailability');
  });

  it('keeps reviewShare distinct from abstain share in metrics', () => {
    const result = evaluateBdTaskGate(syntheticFixture({ count: 120, requireHumanFollowUp: true }));
    expect(result.metrics.reviewShare).toBe(1);
    expect(result.metrics.abstainShare).toBe(0);
  });
});

/** One approved difficult-negative case with valid two-reviewer adjudication. */
function adjudicationCase(): BdEvalCase {
  const base = syntheticCase(0);
  if (base.humanReview.status === 'approved') {
    base.humanReview.difficultNegative = true;
    base.humanReview.adjudication = {
      required: true,
      reviewerIds: ['synthetic-reviewer-a', 'synthetic-reviewer-b'],
      adjudicatorId: 'synthetic-adjudicator',
      adjudicatedAt: '2026-09-21T00:00:00.000Z',
      finalOutcomeConfirmed: true,
    };
  }
  return base;
}
