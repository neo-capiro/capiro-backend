/** Deterministic, fail-closed qualification gates for Package 9. */

export type GateStatus = 'PASS' | 'NO_GO';
export type ActivationMode = 'shadow_only';

export interface ReviewedEvidence {
  reviewed?: boolean | null;
}

export interface SemanticEvidence extends ReviewedEvidence {
  truePositives?: number | null;
  falsePositives?: number | null;
  falseNegatives?: number | null;
  abstentions?: number | null;
}

export interface QualificationEvidence {
  financialCorrectness?: ReviewedEvidence & { sampleCount?: number | null; incorrectCount?: number | null } | null;
  semanticAccuracy?: SemanticEvidence | null;
  moneyAttribution?: ReviewedEvidence & { attributedAmount?: number | null; expectedAmount?: number | null } | null;
  coverage?: ReviewedEvidence & { coveredUnits?: number | null; requiredUnits?: number | null; denominatorComplete?: boolean | null } | null;
  lifecycle?: ReviewedEvidence & { requiredStages?: number | null; completedStages?: number | null } | null;
  annualReuse?: ReviewedEvidence & { demonstratedFiscalYears?: number | null } | null;
  reliability?: ReviewedEvidence & { availabilityPercent?: number | null; criticalIncidents?: number | null } | null;
  economics?: ReviewedEvidence & { savingsPercent?: number | null; qualityMaintained?: boolean | null; coverageMaintained?: boolean | null } | null;
  userOutcome?: ReviewedEvidence & { medianTimeReductionPercent?: number | null; completionRateMaintained?: boolean | null; criticalErrorRateNoHigher?: boolean | null } | null;
  ownership?: ReviewedEvidence & { accountableOwner?: string | null; accepted?: boolean | null } | null;
  rollback?: ReviewedEvidence & { tested?: boolean | null; recoveryTargetMinutes?: number | null } | null;
}

export interface QualificationGate {
  status: GateStatus;
  reasons: string[];
  metrics?: Record<string, number | null>;
}

export interface QualificationScorecard {
  status: GateStatus;
  activation: ActivationMode;
  gates: Record<QualificationGateName, QualificationGate>;
  reasons: string[];
}

export type QualificationGateName =
  | 'financialCorrectness' | 'semanticAccuracy' | 'moneyAttribution' | 'coverage'
  | 'lifecycle' | 'annualReuse' | 'reliability' | 'economics' | 'userOutcome'
  | 'ownership' | 'rollback';

const CONFIDENCE_Z = 1.959963984540054;

/** Returns a two-sided 95% Wilson lower bound for a binomial proportion. */
export function wilsonLowerBound(successes: number, trials: number): number | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(trials) || trials <= 0 || successes < 0 || successes > trials) return null;
  const p = successes / trials;
  const z2 = CONFIDENCE_Z ** 2;
  const denominator = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = CONFIDENCE_Z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

/** Scores only reviewed evidence. Every absent, malformed, or unreviewed value fails closed. */
export function buildQualificationScorecard(evidence: QualificationEvidence | null | undefined): QualificationScorecard {
  const gates: QualificationScorecard['gates'] = {
    financialCorrectness: gate(evidence?.financialCorrectness, e => {
      const sample = count(e.sampleCount), incorrect = count(e.incorrectCount);
      if (sample === null || sample < 1) return ['financial_sample_missing'];
      if (incorrect === null || incorrect > sample) return ['financial_error_count_invalid'];
      return incorrect === 0 ? [] : ['financial_errors_detected'];
    }),
    semanticAccuracy: semanticGate(evidence?.semanticAccuracy),
    moneyAttribution: gate(evidence?.moneyAttribution, e => {
      const attributed = finite(e.attributedAmount), expected = finite(e.expectedAmount);
      if (attributed === null || expected === null || expected <= 0) return ['money_attribution_totals_missing_or_invalid'];
      return attributed === expected ? [] : ['money_attribution_mismatch'];
    }),
    coverage: gate(evidence?.coverage, e => {
      const covered = count(e.coveredUnits), required = count(e.requiredUnits);
      const reasons: string[] = [];
      if (e.denominatorComplete !== true) reasons.push('coverage_denominator_incomplete');
      if (covered === null || required === null || required < 1 || covered > required) reasons.push('coverage_counts_missing_or_invalid');
      else if (covered !== required) reasons.push('required_coverage_incomplete');
      return reasons;
    }),
    lifecycle: gate(evidence?.lifecycle, e => {
      const required = count(e.requiredStages), completed = count(e.completedStages);
      if (required === null || required < 1 || completed === null || completed > required) return ['lifecycle_stage_counts_missing_or_invalid'];
      return completed === required ? [] : ['lifecycle_stages_incomplete'];
    }),
    annualReuse: gate(evidence?.annualReuse, e => count(e.demonstratedFiscalYears) !== null && count(e.demonstratedFiscalYears)! >= 2 ? [] : ['annual_reuse_not_demonstrated']),
    reliability: gate(evidence?.reliability, e => {
      const availability = finite(e.availabilityPercent), incidents = count(e.criticalIncidents);
      if (availability === null || incidents === null) return ['reliability_evidence_missing_or_invalid'];
      const reasons: string[] = [];
      if (availability < 99.5 || availability > 100) reasons.push('availability_below_threshold');
      if (incidents > 0) reasons.push('critical_reliability_incidents');
      return reasons;
    }),
    economics: gate(evidence?.economics, e => {
      const savings = finite(e.savingsPercent);
      const reasons: string[] = [];
      if (savings === null || savings < 30 || savings > 100) reasons.push('jeV_savings_below_30_percent_or_invalid');
      if (e.qualityMaintained !== true) reasons.push('quality_not_demonstrated_as_maintained');
      if (e.coverageMaintained !== true) reasons.push('coverage_not_demonstrated_as_maintained');
      return reasons;
    }),
    userOutcome: gate(evidence?.userOutcome, e => {
      const reduction = finite(e.medianTimeReductionPercent);
      const reasons: string[] = [];
      if (reduction === null || reduction < 30 || reduction > 100) reasons.push('median_time_reduction_below_30_percent_or_invalid');
      if (e.completionRateMaintained !== true) reasons.push('completion_rate_not_maintained');
      if (e.criticalErrorRateNoHigher !== true) reasons.push('critical_error_rate_not_maintained');
      return reasons;
    }),
    ownership: gate(evidence?.ownership, e => {
      const reasons: string[] = [];
      if (typeof e.accountableOwner !== 'string' || !e.accountableOwner.trim()) reasons.push('accountable_owner_missing');
      if (e.accepted !== true) reasons.push('ownership_not_accepted');
      return reasons;
    }),
    rollback: gate(evidence?.rollback, e => {
      const target = count(e.recoveryTargetMinutes);
      const reasons: string[] = [];
      if (e.tested !== true) reasons.push('rollback_not_tested');
      if (target === null || target < 1) reasons.push('rollback_recovery_target_missing_or_invalid');
      return reasons;
    }),
  };
  const reasons = Object.entries(gates).flatMap(([name, result]) => result.reasons.map(reason => `${name}:${reason}`));
  return { status: reasons.length === 0 ? 'PASS' : 'NO_GO', activation: 'shadow_only', gates, reasons };
}

function semanticGate(evidence: SemanticEvidence | null | undefined): QualificationGate {
  if (evidence?.reviewed !== true) return { status: 'NO_GO', reasons: [reviewReason(evidence)] };
  const tp = count(evidence.truePositives), fp = count(evidence.falsePositives);
  const fn = count(evidence.falseNegatives), abstentions = count(evidence.abstentions);
  if (tp === null || fp === null || fn === null || abstentions === null) return noGo('semantic_sample_counts_missing_or_invalid');
  const precisionN = tp + fp, recallN = tp + fn + abstentions;
  const precision = precisionN > 0 ? tp / precisionN : null;
  const recall = recallN > 0 ? tp / recallN : null;
  const precisionLower = precision === null ? null : wilsonLowerBound(tp, precisionN);
  const recallLower = recall === null ? null : wilsonLowerBound(tp, recallN);
  const reasons: string[] = [];
  if (precisionLower === null || precisionLower < 0.99) reasons.push('precision_95_ci_lower_below_99_percent_or_sample_missing');
  if (recallLower === null || recallLower < 0.95) reasons.push('recall_95_ci_lower_below_95_percent_or_sample_missing');
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons, metrics: { truePositives: tp, falsePositives: fp, falseNegatives: fn, abstentions, precision, precisionLower95: precisionLower, recall, recallLower95: recallLower } };
}

function gate<T extends ReviewedEvidence>(evidence: T | null | undefined, evaluate: (value: T) => string[]): QualificationGate {
  if (evidence?.reviewed !== true) return noGo(reviewReason(evidence));
  const reasons = evaluate(evidence);
  return { status: reasons.length ? 'NO_GO' : 'PASS', reasons };
}

function reviewReason(evidence: ReviewedEvidence | null | undefined): string {
  return evidence == null ? 'evidence_missing' : 'evidence_unreviewed';
}
function noGo(reason: string): QualificationGate { return { status: 'NO_GO', reasons: [reason] }; }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
