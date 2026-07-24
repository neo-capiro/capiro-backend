/*
 * @capiro/strategy-verifier — the shared deterministic "does this plan actually
 * make sense" primitive (Phase 2 A4). Pure, DB-free, dependency-free so it runs
 * identically in three places: the orchestrator's back-prompt repair loop (LLM
 * proposes → verifier disposes), api-strategy's write-time gate, and (later) the
 * Strategy Watcher. "LLM proposes, symbolic layer disposes."
 *
 * It checks REALISM (ordering, dependencies, calendar fit), NOT schema shape —
 * enum/date-format validation stays in the DTOs + MeriService.
 */

export type Severity = 'error' | 'warning';

/**
 * A single realism problem. `error` = a hard-constraint violation (impossible
 * ordering, cycle, calendar-invalid) that the write-gate blocks or repairs;
 * `warning` = a soft-quality shortfall that is annotated, never blocked.
 */
export interface Violation {
  /** Stable machine code, e.g. 'dep-cycle', 'submission-before-markup'. */
  code: string;
  severity: Severity;
  /** The node id(s) this violation implicates (empty for plan-level findings). */
  nodeIds: string[];
  /** Human-readable, surfaced in the rail/banner. */
  message: string;
  /** Optional actionable fix hint. */
  suggestion?: string;
}

/** A plan step, normalized. Drafts (no ids yet) pass synthetic index-ids and
 *  index-based dependsOnIds; persisted plans pass real uuids. verifyPlan is
 *  agnostic to which. */
export interface VerifierNode {
  id: string;
  kind: string; // action | decision | gate | milestone | risk
  subject: string; // deliverable | submission | member | committee | ask | agency | outcome | optics
  title: string;
  startsOn: string; // YYYY-MM-DD
  endsOn: string | null; // YYYY-MM-DD | null (point event)
  dependsOnIds: string[];
}

/** A reference-calendar row (congressional milestone / PPBE phase). */
export interface VerifierRefRow {
  label: string;
  fy: number | null;
  startsOn: string | null; // YYYY-MM-DD | null
  endsOn: string | null;
}

/** The live fiscal window (matches MeriService.fiscalWindow()). */
export interface VerifierFiscal {
  today: string | null;
  fys: number[]; // e.g. [2027, 2028, 2029]
  fyLabels: string[]; // e.g. ['FY27','FY28','FY29']
  focalFy: string; // e.g. 'FY28'
}

export interface VerifyPlanInput {
  strategyType: string; // appropriations | authorization | ...
  nodes: VerifierNode[];
  fiscal: VerifierFiscal;
  /** Congressional milestones (markups, recesses, CR risks). Optional; checks
   *  that need it no-op when it's empty (data-gap-guarded). */
  congress?: VerifierRefRow[];
  ppbeCurrentPhases?: VerifierRefRow[];
}

export interface VerifyPlanResult {
  /** Errors first, then warnings (stable within a severity). */
  violations: Violation[];
  errorCount: number;
  warningCount: number;
}
