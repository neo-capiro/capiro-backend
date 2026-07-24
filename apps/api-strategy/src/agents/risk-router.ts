/*
 * Stage F RiskRouter — PURE module (no Nest, no DB, no deps), same discipline
 * as run-state.ts. Classifies a Watcher check's findings + proposed edit-set
 * into the SpChangeSetRisk ladder (plan §F2) and decides auto-apply
 * eligibility. "LLM proposes, symbolic layer disposes" — risk is NEVER taken
 * from a model's self-assessment; it is computed here from what the findings
 * and ops structurally ARE.
 *
 * Ladder (first match wins, top-down):
 *   firmLevel                      => critical  (hard rule, see below)
 *   any critical finding           => critical
 *   any warning w/ structural op   => high      (add/remove reshapes the plan)
 *   any warning (retime-only)      => medium    (date shifts only)
 *   info-only / no findings        => low
 *
 * autoApplyEligible is true ONLY for risk === 'low' — and never for firm-level
 * (redundant given firm => critical, but enforced independently as a hard rule
 * so a future ladder edit cannot accidentally make firm proposals auto-apply)
 * — and only when there is at least one op to apply (an empty edit-set has
 * nothing to auto-apply; ChangeSet approval rejects empty subsets for the same
 * reason).
 *
 * requiresImpactSummary is the firm-level obligation: a firm-scoped calendar
 * proposal fans out across MULTIPLE strategies, so the proposal must carry a
 * cross-strategy impact summary before a human can meaningfully review it.
 * Strategy-scoped proposals (even critical ones) surface through the normal
 * single-strategy review rail and do not require one.
 */

export type WatcherFindingSeverity = 'info' | 'warning' | 'critical';

/** A single deterministic Watcher check result (F1 produces these). */
export interface WatcherFinding {
  /** Stable machine code, e.g. 'deadline-passed', 'markup-moved'. */
  code: string;
  severity: WatcherFindingSeverity;
  /** Human-readable, surfaced in the review rail. */
  message: string;
  /**
   * true when this finding's proposed remediation is STRUCTURAL — it adds or
   * removes plan nodes (PlanEdit op 'add'/'remove'). false/absent = retime-only
   * (date shifts) or purely informational.
   */
  structural?: boolean;
  /** Node ids implicated (absent for plan-/firm-level findings). */
  nodeIds?: string[];
}

/** Alias so F1 can import the shared name `Finding` from this module. */
export type Finding = WatcherFinding;

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ClassifyRiskInput {
  findings: WatcherFinding[];
  /**
   * A firm-scoped proposal (calendar mission, strategyId null) whose edits
   * affect multiple strategies at once.
   */
  firmLevel: boolean;
  /** Number of ops in the proposed edit-set (PlanEdit[] length). */
  opCount: number;
}

export interface RiskClassification {
  risk: RiskLevel;
  /** True ONLY when risk === 'low' (and never firm-level, and opCount > 0). */
  autoApplyEligible: boolean;
  /** Firm-level proposals must carry a cross-strategy impact summary. */
  requiresImpactSummary: boolean;
}

export function classifyRisk(input: ClassifyRiskInput): RiskClassification {
  const { findings, firmLevel, opCount } = input;

  // HARD RULE: firm-level is always critical, always needs an impact summary,
  // and NEVER auto-applies. Return early so no later ladder rung can soften it.
  if (firmLevel) {
    return { risk: 'critical', autoApplyEligible: false, requiresImpactSummary: true };
  }

  let risk: RiskLevel;
  if (findings.some((f) => f.severity === 'critical')) {
    risk = 'critical';
  } else if (findings.some((f) => f.severity === 'warning' && f.structural === true)) {
    // A warning whose remediation adds/removes nodes reshapes the plan.
    risk = 'high';
  } else if (findings.some((f) => f.severity === 'warning')) {
    // Retime-only warnings: the remediation shifts dates but keeps the shape.
    risk = 'medium';
  } else {
    // Info-only (or no findings at all).
    risk = 'low';
  }

  return {
    risk,
    // Low risk ONLY — and only when there is actually something to apply.
    autoApplyEligible: risk === 'low' && opCount > 0,
    requiresImpactSummary: false,
  };
}
