import type { AssuranceEvalResult, EvalDomain, EvalSeverity, EvalTier } from '../../src/assurance';

export type EvalCategory =
  | 'leakage'
  | 'grounding'
  | 'compliance'
  | 'entity'
  | 'legislation'
  | 'assurance';

export interface EvalOutcome {
  pass: boolean;
  detail: string;
  /**
   * OPTIONAL per-case breakdown. A case that exercises several distinct mechanisms
   * can emit one AssuranceEvalResult each, so the per-DOMAIN release gate sees them
   * separately instead of collapsing them into a single pass/fail. A case that omits
   * this gets exactly one synthesized result from its declared tier/domain/severity
   * — which is why widening this required no change to any existing case.
   */
  results?: readonly AssuranceEvalResult[];
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  description: string;
  /**
   * Release-gate classification. Declared per case so `evaluateReleaseGate` can
   * make a CATEGORY-SPECIFIC decision — a global pass count can hide one critical
   * legislative, tenancy, approval, or compliance regression, which is the whole
   * reason eval-gate.ts exists.
   *
   * Optional so a new case cannot fail to compile; run-evals.ts defaults an
   * undeclared case to the most conservative classification (L1 / general /
   * critical) rather than the most permissive.
   */
  tier?: EvalTier;
  domain?: EvalDomain;
  severity?: EvalSeverity;
  /**
   * `tenant_isolation` and `approval_invariant` are special-cased by
   * `evaluateReleaseGate`: a failure of either blocks release on its own, at ANY
   * severity. Declaring them is therefore not decoration.
   */
  metric?: AssuranceEvalResult['metric'];
  run(): Promise<EvalOutcome>;
}
