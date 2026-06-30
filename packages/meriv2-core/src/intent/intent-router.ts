/**
 * Plan-modes (architecture-plan §2.1): five orchestrator plan-modes, not five
 * services. `research` is the default fallback and is evaluated LAST so a more
 * specific mode wins a keyword tie.
 */
export const PLAN_MODES = ['writing', 'monitoring', 'analytics', 'compliance', 'research'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export interface IntentClassification {
  mode: PlanMode;
  /** 0..1 — 0 when nothing matched (pure fallback to `research`). */
  confidence: number;
  /** The keyword signals that drove the classification. */
  signals: string[];
}

export interface IntentRouter {
  classify(message: string): IntentClassification;
}

const KEYWORDS: Record<PlanMode, readonly string[]> = {
  writing: [
    'draft',
    'write',
    'memo',
    'letter',
    'one-pager',
    'comment',
    'rewrite',
    'edit',
    'tighten',
    'packet',
  ],
  monitoring: [
    'monitor',
    'alert',
    'watch',
    'track',
    'notify',
    'deadline',
    'changed',
    'changes',
    'inbox',
  ],
  analytics: [
    'analyze',
    'model',
    'forecast',
    'trend',
    'score',
    'cluster',
    'compare',
    'estimate',
    'rank',
  ],
  compliance: [
    'compliance',
    'lda',
    'ld-2',
    'ld-203',
    'fara',
    'ethics',
    'gift',
    'conflict',
    'precheck',
    'disclos',
  ],
  research: [
    'find',
    'search',
    'who',
    'what',
    'when',
    'lookup',
    'bill',
    'hearing',
    'vote',
    'background',
    'summary',
  ],
};

/**
 * Phase-0 STUB intent router: a deterministic keyword scorer. Returns the
 * plan-mode with the most keyword hits; ties resolve to the earlier mode in
 * `PLAN_MODES` (so `research`, evaluated last, only wins on a strict majority
 * or as the zero-hit fallback). Deterministic by design so the parity harness
 * can assert on it; replaced by a model-backed classifier in a later phase.
 */
export class KeywordIntentRouter implements IntentRouter {
  classify(message: string): IntentClassification {
    const text = (message ?? '').toLowerCase();
    let bestMode: PlanMode = 'research';
    let bestSignals: string[] = [];
    for (const mode of PLAN_MODES) {
      const hits = KEYWORDS[mode].filter((kw) => text.includes(kw));
      if (hits.length > bestSignals.length) {
        bestMode = mode;
        bestSignals = hits;
      }
    }
    const confidence = bestSignals.length === 0 ? 0 : Math.min(1, 0.5 + 0.15 * bestSignals.length);
    return { mode: bestMode, confidence, signals: bestSignals };
  }
}
