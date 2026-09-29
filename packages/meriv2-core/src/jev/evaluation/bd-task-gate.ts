import type { BdEvalCase, BdTaskReviewFixture } from '../bd-fixture-schema';
import { BD_EVALUATION_MIN_REVIEWED_CASES } from '../bd-fixture-schema';
import { BD_ENTITY_OUTCOMES } from '../bd-entity-question';
import { BD_SIGNAL_OUTCOMES } from '../bd-signal-question';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from '../task-registry';

/**
 * Pure, predeclared canary gate evaluator for exactly ONE BD task
 * (bd_entity or bd_signal) at a time.
 *
 * The gate is fail-closed: any missing metadata, unpinned version, insufficient
 * reviewed coverage, label leakage, threshold/ceiling failure, or severe
 * invariant violation produces `approved: false` with explicit reasons.
 * Proposed/unreviewed cases are reported but never count toward approval.
 *
 * Severe invariants govern RECORDED APPLICATION EFFECTS, not semantic
 * suggestions: a Jev `same_legal_entity` suggestion is always allowed, but an
 * exact-identity merge effect on an unreviewed case is severe, and an applied
 * direct signal label without its deterministic identifier/source/stage/locator
 * proof is severe. Effects on proposed/unreviewed cases ARE checked.
 *
 * Pricing uses the approved public price version already recorded in the task
 * registry: $0.042 per million INPUT tokens; OUTPUT tokens are free.
 *
 * This evaluator makes NO registry changes: BD-ENTITY and BD-SIGNAL remain
 * `shadow_only`/`proposed`; this worker is not authorized to approve a task or
 * raise the rollout ceiling. A passing synthetic unit test proves only the gate
 * logic, never semantic accuracy.
 */

export type BdGateSevereErrorKind =
  'unreviewed_exact_identity_merge' | 'direct_signal_label_without_proof';

export interface BdGateSevereError {
  caseId: string;
  kind: BdGateSevereErrorKind;
  detail: string;
}

export interface BdGateStratumCounts {
  count: number;
  errors: number;
}

export type BdGateStrataBreakdown = Record<string, BdGateStratumCounts>;

export interface BdGateOutcomeMetrics {
  /** Confusion matrix: matrix[expected][observed] = count (observed includes 'abstain' and 'failure:*'). */
  confusionMatrix: Record<string, Record<string, number>>;
  perOutcomePrecision: Record<string, number>;
  perOutcomeRecall: Record<string, number>;
}

export interface BdGateMetrics extends BdGateOutcomeMetrics {
  reviewedCases: number;
  proposedCases: number;
  /** Share of approved cases where the Jev decision abstained. */
  abstainShare: number;
  /** Share of approved cases whose recorded effect required human follow-up. */
  reviewShare: number;
  severeErrors: BdGateSevereError[];
  latencyMs: { p50: number; p95: number };
  tokens: { input: number; output: number };
  estimatedCostUsd: number | null;
  strata: {
    sourceFamily: BdGateStrataBreakdown;
    sector: BdGateStrataBreakdown;
    companySize: BdGateStrataBreakdown;
    taskCategory: BdGateStrataBreakdown;
    sourceAvailability: BdGateStrataBreakdown;
  };
}

export interface BdGateResult {
  task: 'bd_entity' | 'bd_signal';
  registryVersion: string;
  approved: boolean;
  reasons: string[];
  metrics: BdGateMetrics;
  /** Explicitly never an authorization to change rollout state. */
  authorization: 'none; registry status remains shadow/proposed; approval requires an authorized owner';
}

/** Approved public price: $0.042 per million input tokens; output tokens are free. */
export const BD_GATE_PRICE_INPUT_USD_PER_MILLION = 0.042;
export const BD_GATE_PRICE_OUTPUT_USD_PER_MILLION = 0;
/** Approved public price version already recorded in the BD task registry entries. */
export const BD_GATE_PRICE_VERSION = 'typesafe-public-2026-09-15-usd-0.042-per-million-input-v1';

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))
  ]!;
}

function observationLabel(caseItem: BdEvalCase): string {
  const observation = caseItem.observations.jev;
  if (observation.outcome === null) return `failure:${observation.failureState ?? 'unknown'}`;
  return observation.action === 'abstain' ? 'abstain' : observation.outcome;
}

/** Severe invariant checks over the RECORDED EFFECT of every case (approved or proposed). */
function collectSevereErrors(cases: readonly BdEvalCase[]): BdGateSevereError[] {
  const errors: BdGateSevereError[] = [];
  for (const caseItem of cases) {
    if (caseItem.task === 'bd_entity') {
      const effect = caseItem.effect;
      if (effect.kind === 'bd_entity_effect' && effect.exactIdentityMergePerformed) {
        if (caseItem.humanReview.status !== 'approved') {
          errors.push({
            caseId: caseItem.id,
            kind: 'unreviewed_exact_identity_merge',
            detail: 'exact-identity merge effect recorded on a case without approved human review',
          });
        }
      }
    } else {
      const effect = caseItem.effect;
      if (effect.kind === 'bd_signal_effect' && effect.directLabelApplied) {
        const proof = effect.directLabelProof;
        if (
          !proof ||
          !proof.resolvedCompanyPublicId.trim() ||
          !proof.sourceRecordId.trim() ||
          !proof.recordType.trim() ||
          !proof.financialStage.trim() ||
          !proof.locator.trim()
        ) {
          errors.push({
            caseId: caseItem.id,
            kind: 'direct_signal_label_without_proof',
            detail:
              'applied direct signal label lacks deterministic identifier/source/stage/locator proof',
          });
        } else {
          // The cited source record must exist among the case's snapshot sources.
          const cited = caseItem.sources.find(
            (source) => source.sourceRecordId === proof.sourceRecordId,
          );
          if (!cited) {
            errors.push({
              caseId: caseItem.id,
              kind: 'direct_signal_label_without_proof',
              detail:
                'applied direct signal label cites a source record not present in the case sources',
            });
          } else if (
            proof.resolvedCompanyPublicId !== caseItem.input.companyPublicId ||
            proof.sourceRecordId !== caseItem.input.signalSourceRecordId ||
            proof.recordType !== caseItem.input.recordType ||
            proof.financialStage !== caseItem.input.financialStage ||
            proof.locator !== cited.locator
          ) {
            errors.push({
              caseId: caseItem.id,
              kind: 'direct_signal_label_without_proof',
              detail:
                'applied direct signal label proof does not match the exact evaluated tuple ' +
                `(company ${caseItem.input.companyPublicId}, record ${caseItem.input.signalSourceRecordId}, ` +
                `type ${caseItem.input.recordType}, stage ${caseItem.input.financialStage}, source locator ${cited.locator})`,
            });
          }
        }
      }
    }
  }
  return errors;
}

export function evaluateBdTaskGate(fixture: BdTaskReviewFixture): BdGateResult {
  const task = fixture.task;
  const registration = JEV_TASK_REGISTRY[task];
  const reasons: string[] = [];

  // ── Pinned version requirements (fail closed on mismatch) ──
  if (
    fixture.registryVersion !== JEV_TASK_REGISTRY_VERSION ||
    fixture.pinned.registryVersion !== JEV_TASK_REGISTRY_VERSION
  ) {
    reasons.push(
      `registry_version_mismatch: fixture ${fixture.registryVersion}/${fixture.pinned.registryVersion} vs current ${JEV_TASK_REGISTRY_VERSION}`,
    );
  }
  if (fixture.pinned.modelVersion !== registration.modelVersion) {
    reasons.push(
      `model_version_mismatch: ${fixture.pinned.modelVersion} vs ${registration.modelVersion}`,
    );
  }
  if (fixture.pinned.questionVersion !== registration.questionVersion) {
    reasons.push(
      `question_version_mismatch: ${fixture.pinned.questionVersion} vs ${registration.questionVersion}`,
    );
  }
  if (
    fixture.pinned.candidateGenerator.id !== registration.candidateGenerator.id ||
    fixture.pinned.candidateGenerator.version !== registration.candidateGenerator.version
  ) {
    reasons.push(
      `candidate_generator_mismatch: ${fixture.pinned.candidateGenerator.id}.${fixture.pinned.candidateGenerator.version} vs ${registration.candidateGenerator.id}.${registration.candidateGenerator.version}`,
    );
  }
  if (fixture.pinned.priceVersion !== registration.costBudget.priceVersion) {
    reasons.push(
      `price_version_mismatch: ${fixture.pinned.priceVersion} vs ${registration.costBudget.priceVersion}`,
    );
  }
  if (registration.costBudget.priceVersion !== BD_GATE_PRICE_VERSION) {
    reasons.push(
      `registry_price_version_not_approved_public_price: ${registration.costBudget.priceVersion}`,
    );
  }

  // ── Reviewed-case volume and review discipline ──
  const approvedCases = fixture.cases.filter((c) => c.humanReview.status === 'approved');
  const proposedCases = fixture.cases.filter((c) => c.humanReview.status === 'proposed');
  if (approvedCases.length < BD_EVALUATION_MIN_REVIEWED_CASES) {
    reasons.push(
      `insufficient_reviewed_cases: ${approvedCases.length} < ${BD_EVALUATION_MIN_REVIEWED_CASES} approved for task ${task}`,
    );
  }

  // ── Held-out cohort partitioned by company/source/time ──
  const heldout = approvedCases.filter((c) => c.split === 'heldout');
  const heldoutShare = approvedCases.length ? heldout.length / approvedCases.length : 0;
  if (!heldout.length) {
    reasons.push('no_heldout_cohort: zero approved held-out cases');
  } else if (heldoutShare < 0.2) {
    reasons.push(`heldout_cohort_too_small: ${(heldoutShare * 100).toFixed(1)}% of approved cases`);
  }
  const partitionKeys = ['companyKey', 'sourceKey', 'timeKey'] as const;
  for (const key of partitionKeys) {
    const tuningKeys = new Set(
      approvedCases.filter((c) => c.split === 'tuning').map((c) => c.grouping[key]),
    );
    const leaked = heldout.filter((c) => tuningKeys.has(c.grouping[key]));
    if (leaked.length) {
      reasons.push(
        `cohort_partition_leak:${key}:${leaked.length} held-out cases share a ${key} with tuning cases`,
      );
    }
  }

  // ── Positive / hard-negative coverage ──
  const severeOutcome = task === 'bd_entity' ? 'same_legal_entity' : 'explicit_link';
  const positives = approvedCases.filter((c) => c.expectedOutcome === severeOutcome);
  const hardNegatives = approvedCases.filter(
    (c) => c.humanReview.status === 'approved' && c.humanReview.difficultNegative,
  );
  if (positives.length < 20) {
    reasons.push(
      `insufficient_positive_coverage: ${positives.length} approved ${severeOutcome} cases < 20`,
    );
  }
  if (hardNegatives.length < 20) {
    reasons.push(
      `insufficient_hard_negative_coverage: ${hardNegatives.length} approved difficult negatives < 20`,
    );
  }

  // ── Label leakage (structural suspicion: all-match with no provenance) ──
  const suspiciousLeakage = approvedCases.filter(
    (c) =>
      c.observations.jev.outcome === c.expectedOutcome &&
      (c.observations.jev.usage === null || c.observations.jev.latencyMs === 0),
  );
  if (approvedCases.length && suspiciousLeakage.length === approvedCases.length) {
    reasons.push(
      'label_leakage_suspected: every approved case matches expected outcome with no recorded usage/latency provenance',
    );
  }

  // ── Adjudication of difficult negatives ──
  const unadjudicated = approvedCases.filter(
    (c) =>
      c.humanReview.status === 'approved' &&
      c.humanReview.difficultNegative &&
      c.humanReview.adjudication === null,
  );
  if (unadjudicated.length) {
    reasons.push(`unadjudicated_difficult_negatives: ${unadjudicated.length}`);
  }
  // Approved difficult-negative adjudication must name exactly two DISTINCT reviewer ids.
  const duplicatedReviewerIds = approvedCases.filter(
    (c) =>
      c.humanReview.status === 'approved' &&
      c.humanReview.difficultNegative &&
      c.humanReview.adjudication !== null &&
      new Set(c.humanReview.adjudication.reviewerIds).size !== 2,
  );
  if (duplicatedReviewerIds.length) {
    reasons.push(
      `duplicated_adjudication_reviewer_ids: ${duplicatedReviewerIds.length} approved difficult negative(s) name duplicated reviewer ids`,
    );
  }

  // ── Severe invariants over ALL cases (approved and proposed) via recorded effects ──
  const severeErrors = collectSevereErrors(fixture.cases);
  if (severeErrors.length) {
    reasons.push(
      `severe_invariant_violations: ${severeErrors.length} (${[...new Set(severeErrors.map((e) => e.kind))].join(', ')})`,
    );
  }

  // ── Metrics over APPROVED cases only ──
  // Observed columns come from the ACTUAL observationLabel values so that
  // `failure:<state>` and `abstain` are represented consistently in JSON and Markdown.
  const allowedOutcomes = (
    task === 'bd_entity' ? BD_ENTITY_OUTCOMES : BD_SIGNAL_OUTCOMES
  ) as readonly string[];
  const observedColumns = [...new Set(approvedCases.map((c) => observationLabel(c)))].sort();
  const confusionMatrix: Record<string, Record<string, number>> = {};
  for (const expected of [...new Set(approvedCases.map((c) => c.expectedOutcome))].sort()) {
    confusionMatrix[expected] = Object.fromEntries(
      observedColumns.map((observed) => [observed, 0]),
    );
  }
  let abstains = 0;
  let reviewRequired = 0;
  for (const caseItem of approvedCases) {
    const label = observationLabel(caseItem);
    const row = confusionMatrix[caseItem.expectedOutcome];
    if (row) row[label] = (row[label] ?? 0) + 1;
    if (label === 'abstain') abstains += 1;
    if (caseItem.effect.requiredHumanFollowUp) reviewRequired += 1;
  }

  const perOutcomePrecision: Record<string, number> = {};
  const perOutcomeRecall: Record<string, number> = {};
  for (const outcome of Object.keys(confusionMatrix)) {
    const truePositive = confusionMatrix[outcome]?.[outcome] ?? 0;
    const predicted = Object.values(confusionMatrix).reduce(
      (sum, row) => sum + (row[outcome] ?? 0),
      0,
    );
    const actual = Object.values(confusionMatrix[outcome] ?? {}).reduce(
      (sum, count) => sum + count,
      0,
    );
    perOutcomePrecision[outcome] = predicted ? truePositive / predicted : 0;
    perOutcomeRecall[outcome] = actual ? truePositive / actual : 0;
  }

  const abstainShare = approvedCases.length ? abstains / approvedCases.length : 0;
  const reviewShare = approvedCases.length ? reviewRequired / approvedCases.length : 0;

  // ── Predeclared per-outcome precision/recall and share thresholds ──
  // Every allowed outcome for this task MUST have both a precision and a recall
  // threshold predeclared; an empty or partial threshold map fails closed.
  const declaredPrecision = new Set(Object.keys(fixture.thresholds.minPrecisionByOutcome));
  const declaredRecall = new Set(Object.keys(fixture.thresholds.minRecallByOutcome));
  for (const outcome of allowedOutcomes) {
    if (!declaredPrecision.has(outcome)) {
      reasons.push(
        `threshold_map_incomplete_precision:${outcome}: no predeclared minimum precision for allowed outcome (task ${task})`,
      );
    }
    if (!declaredRecall.has(outcome)) {
      reasons.push(
        `threshold_map_incomplete_recall:${outcome}: no predeclared minimum recall for allowed outcome (task ${task})`,
      );
    }
  }
  for (const [outcome, minimum] of Object.entries(fixture.thresholds.minPrecisionByOutcome)) {
    const actual = perOutcomePrecision[outcome];
    if (actual === undefined) {
      reasons.push(
        `threshold_outcome_missing_precision: no approved case has expected outcome ${outcome}`,
      );
    } else if (actual < minimum) {
      reasons.push(`precision_threshold_failed:${outcome}:${actual.toFixed(3)} < ${minimum}`);
    }
  }
  for (const [outcome, minimum] of Object.entries(fixture.thresholds.minRecallByOutcome)) {
    const actual = perOutcomeRecall[outcome];
    if (actual === undefined) {
      reasons.push(
        `threshold_outcome_missing_recall: no approved case has expected outcome ${outcome}`,
      );
    } else if (actual < minimum) {
      reasons.push(`recall_threshold_failed:${outcome}:${actual.toFixed(3)} < ${minimum}`);
    }
  }
  if (approvedCases.length) {
    if (abstainShare > fixture.thresholds.maxAbstainShare) {
      reasons.push(
        `abstain_share_threshold_failed:${(abstainShare * 100).toFixed(1)}% > ${(fixture.thresholds.maxAbstainShare * 100).toFixed(1)}%`,
      );
    }
    if (reviewShare > fixture.thresholds.maxReviewShare) {
      reasons.push(
        `review_share_threshold_failed:${(reviewShare * 100).toFixed(1)}% > ${(fixture.thresholds.maxReviewShare * 100).toFixed(1)}%`,
      );
    }
  }

  const latencies = approvedCases.map((c) => c.observations.jev.latencyMs);
  const inputTokens = approvedCases.reduce(
    (sum, c) => sum + (c.observations.jev.usage?.inputTokens ?? 0),
    0,
  );
  const outputTokens = approvedCases.reduce(
    (sum, c) => sum + (c.observations.jev.usage?.outputTokens ?? 0),
    0,
  );
  const priced = registration.costBudget.priceVersion === BD_GATE_PRICE_VERSION;
  const estimatedCostUsd = priced
    ? (inputTokens * BD_GATE_PRICE_INPUT_USD_PER_MILLION +
        outputTokens * BD_GATE_PRICE_OUTPUT_USD_PER_MILLION) /
      1_000_000
    : null;

  // ── Cost/latency ceilings ──
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  if (approvedCases.length) {
    if (p50 > fixture.ceilings.maxMedianLatencyMs) {
      reasons.push(
        `median_latency_ceiling_exceeded: p50 ${p50}ms > ${fixture.ceilings.maxMedianLatencyMs}ms`,
      );
    }
    if (p95 > fixture.ceilings.maxP95LatencyMs) {
      reasons.push(
        `p95_latency_ceiling_exceeded: p95 ${p95}ms > ${fixture.ceilings.maxP95LatencyMs}ms`,
      );
    }
    if (estimatedCostUsd === null) {
      reasons.push('cost_not_priced: registry price version is not the approved public price');
    } else if (estimatedCostUsd > fixture.ceilings.maxEstimatedCostUsd) {
      reasons.push(
        `cost_ceiling_exceeded: $${estimatedCostUsd.toFixed(6)} > $${fixture.ceilings.maxEstimatedCostUsd}`,
      );
    }
  }

  const strataFor = (
    dimension: 'sourceFamily' | 'sector' | 'companySize' | 'taskCategory' | 'sourceAvailability',
  ): BdGateStrataBreakdown => {
    const breakdown: BdGateStrataBreakdown = {};
    for (const caseItem of approvedCases) {
      const key = caseItem.strata[dimension];
      const entry = breakdown[key] ?? { count: 0, errors: 0 };
      entry.count += 1;
      const label = observationLabel(caseItem);
      if (label !== caseItem.expectedOutcome && label !== 'abstain') entry.errors += 1;
      breakdown[key] = entry;
    }
    return breakdown;
  };

  // ── Strata coverage: fail closed when ANY required dimension is missing/thin ──
  if (approvedCases.length) {
    const sourceFamilies = new Set(approvedCases.map((c) => c.strata.sourceFamily));
    if (sourceFamilies.size < 2) {
      reasons.push(
        `missing_strata:sourceFamily: only ${sourceFamilies.size} source family represented; at least 2 required`,
      );
    }
    const stratumChecks: Array<{
      dimension: 'sourceFamily' | 'sector' | 'companySize' | 'taskCategory' | 'sourceAvailability';
      label: string;
      minimum: number;
    }> = [
      { dimension: 'sector', label: 'sector', minimum: 2 },
      { dimension: 'companySize', label: 'companySize', minimum: 2 },
      { dimension: 'taskCategory', label: 'taskCategory', minimum: 2 },
      { dimension: 'sourceAvailability', label: 'sourceAvailability', minimum: 2 },
    ];
    for (const check of stratumChecks) {
      const values = new Set(approvedCases.map((c) => c.strata[check.dimension]));
      if (values.size < check.minimum) {
        reasons.push(
          `missing_strata:${check.label}: only ${values.size} ${check.label} value(s) represented; at least ${check.minimum} required`,
        );
      }
    }
  }

  const metrics: BdGateMetrics = {
    confusionMatrix,
    perOutcomePrecision,
    perOutcomeRecall,
    reviewedCases: approvedCases.length,
    proposedCases: proposedCases.length,
    abstainShare,
    reviewShare,
    severeErrors,
    latencyMs: { p50, p95 },
    tokens: { input: inputTokens, output: outputTokens },
    estimatedCostUsd,
    strata: {
      sourceFamily: strataFor('sourceFamily'),
      sector: strataFor('sector'),
      companySize: strataFor('companySize'),
      taskCategory: strataFor('taskCategory'),
      sourceAvailability: strataFor('sourceAvailability'),
    },
  };

  return {
    task,
    registryVersion: JEV_TASK_REGISTRY_VERSION,
    approved: reasons.length === 0,
    reasons,
    metrics,
    authorization:
      'none; registry status remains shadow/proposed; approval requires an authorized owner',
  };
}
