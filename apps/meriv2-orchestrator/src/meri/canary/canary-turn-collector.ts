import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from '@capiro/meriv2-core';

export type CanaryMode = 'off' | 'shadow' | 'enforce' | string;
/** The surface the turn was enrolled under; Deep Research runs are `research`, never `chat`. */
export type CanaryTurnSurface = 'chat' | 'research';

export interface CanaryTurnEvent {
  event: 'meri.canary.turn';
  conversationId: string | null;
  tenantId: string;
  surface: CanaryTurnSurface;
  modes: {
    evidenceAccuracy: CanaryMode;
    claimAssessment: CanaryMode;
    coverageRetrieval: CanaryMode;
    passageSelection: CanaryMode;
    autoCorrection: CanaryMode;
    jevProvider: CanaryMode;
    routing: CanaryMode;
  };
  registryVersion: typeof JEV_TASK_REGISTRY_VERSION;
  jevTasks: Record<string, { questionVersion: string; modelVersion: string }>;
  outcome: 'released' | 'held' | 'error' | 'aborted' | 'incomplete';
  clarificationRequested: boolean;
  heldReason: string | null;
  coverage: { gaps: number; followUps: number; residual: number };
  passageSelection: {
    candidates: number;
    kept: number;
    dropped: number;
    requiredCandidates: number;
    requiredRetained: number;
    contradictoryRetained: number;
    fallback: boolean;
    safetyIntervention?: { evaluated: boolean; intervened: boolean; reasons: string[] };
  };
  repair: {
    attempted: number;
    corrected: number;
    qualified: number;
    omitted: number;
    documentRequested: number;
    budgetExhausted: number;
    timedOut?: boolean;
    /** False when the stage did not settle and claim-level outcomes are unavailable. */
    outcomesComplete?: boolean;
  };
  repairUsage?: 'not_attempted' | 'measured' | 'unknown';
  latencyMs: {
    timeToText: number;
    assessment: number;
    passageSelection: number;
    coverageFollowUp: number;
    repair: number;
    total: number;
  };
  tokens: { synthesis: number; jev: number; legacy: number | null; repair: number | null };
  cost: {
    retrievalToolCalls: number; retrievalLatencyMs: number; coverageFollowUpTokens: number;
    jevCalls: number | null; legacyCalls: number | null; repairLoops: number | null;
  };
  cache?: { mode: 'shadow' | 'enforce'; lookups: number; hits: number; agreements: number };
  estimatedCostUsd: number | null;
  sampled: boolean;
}

type MutableMetrics = Pick<CanaryTurnEvent,
  'coverage' | 'passageSelection' | 'repair' | 'latencyMs' | 'tokens' | 'cost' | 'cache'> & {
  estimatedCostUsd: number | null;
  repairUsage: 'not_attempted' | 'measured' | 'unknown';
  sampled: boolean;
};

export class CanaryTurnCollector {
  private readonly startedAt: number;
  /** When the turn's text frame was emitted; `null` until (or unless) it is. */
  private textEmittedAt: number | null = null;
  private readonly metrics: MutableMetrics = {
    coverage: { gaps: 0, followUps: 0, residual: 0 },
    passageSelection: {
      candidates: 0, kept: 0, dropped: 0, requiredCandidates: 0, requiredRetained: 0,
      contradictoryRetained: 0, fallback: false,
      safetyIntervention: { evaluated: false, intervened: false, reasons: [] },
    },
    repair: {
      attempted: 0, corrected: 0, qualified: 0, omitted: 0,
      documentRequested: 0, budgetExhausted: 0, timedOut: false,
    },
    latencyMs: {
      timeToText: 0, assessment: 0, passageSelection: 0,
      coverageFollowUp: 0, repair: 0, total: 0,
    },
    tokens: { synthesis: 0, jev: 0, legacy: 0, repair: 0 },
    cost: { retrievalToolCalls: 0, retrievalLatencyMs: 0, coverageFollowUpTokens: 0,
      jevCalls: 0, legacyCalls: 0, repairLoops: 0 },
    estimatedCostUsd: 0,
    repairUsage: 'not_attempted',
    sampled: false,
  };

  constructor(
    private readonly identity: Pick<CanaryTurnEvent, 'conversationId' | 'tenantId' | 'surface' | 'modes'>,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  noteCoverage(value: CanaryTurnEvent['coverage'] & {
    latencyMs: number; retrievalToolCalls?: number; coverageFollowUpTokens?: number;
  }): void {
    this.metrics.coverage = { gaps: value.gaps, followUps: value.followUps, residual: value.residual };
    this.metrics.latencyMs.coverageFollowUp = value.latencyMs;
    this.metrics.cost.retrievalToolCalls += value.retrievalToolCalls ?? value.followUps;
    this.metrics.cost.retrievalLatencyMs += value.latencyMs;
    this.metrics.cost.coverageFollowUpTokens += value.coverageFollowUpTokens ?? 0;
  }

  notePassageSelection(value: CanaryTurnEvent['passageSelection'] & {
    latencyMs: number; tokens: number; costUsd: number; calls?: number;
  }): void {
    const { latencyMs, tokens, costUsd, calls, ...selection } = value;
    this.metrics.passageSelection = selection;
    this.metrics.latencyMs.passageSelection = latencyMs;
    this.metrics.tokens.jev += tokens;
    if (this.metrics.estimatedCostUsd !== null) this.metrics.estimatedCostUsd += costUsd;
    if (this.metrics.cost.jevCalls !== null) this.metrics.cost.jevCalls += calls ?? (tokens > 0 ? 1 : 0);
  }

  noteRepair(value: CanaryTurnEvent['repair'] & {
    assessmentMs: number; repairMs: number; tokens: number | null; costUsd: number | null; sampled?: boolean;
    jevCalls?: number; legacyCalls?: number; repairLoops?: number;
    cache?: CanaryTurnEvent['cache'];
  }): void {
    const { assessmentMs, repairMs, tokens, costUsd, sampled, jevCalls, legacyCalls, repairLoops, cache, ...repair } = value;
    const usageUnknown = tokens === null || costUsd === null;
    this.metrics.repair = { ...repair, outcomesComplete: !usageUnknown && repair.outcomesComplete !== false };
    this.metrics.repairUsage = usageUnknown ? 'unknown' : 'measured';
    this.metrics.latencyMs.assessment = assessmentMs;
    this.metrics.latencyMs.repair = repairMs;
    if (tokens === null || costUsd === null) {
      this.metrics.tokens.repair = null;
      this.metrics.tokens.legacy = null;
      this.metrics.estimatedCostUsd = null;
      this.metrics.cost.jevCalls = null;
      this.metrics.cost.legacyCalls = null;
      this.metrics.cost.repairLoops = null;
    } else {
      if (this.metrics.tokens.repair !== null) this.metrics.tokens.repair += tokens;
      if (this.metrics.estimatedCostUsd !== null) this.metrics.estimatedCostUsd += costUsd;
    }
    this.metrics.sampled = this.metrics.sampled || Boolean(sampled);
    if (!usageUnknown) {
      if (this.metrics.cost.jevCalls !== null) this.metrics.cost.jevCalls += jevCalls ?? 0;
      if (this.metrics.cost.legacyCalls !== null) this.metrics.cost.legacyCalls += legacyCalls ?? 0;
      if (this.metrics.cost.repairLoops !== null) this.metrics.cost.repairLoops += repairLoops ?? repair.attempted;
    }
    if (cache) this.metrics.cache = cache;
  }

  noteSynthesis(tokens: number, costUsd: number): void {
    this.metrics.tokens.synthesis += tokens;
    if (this.metrics.estimatedCostUsd !== null) this.metrics.estimatedCostUsd += costUsd;
  }

  noteLegacy(tokens: number): void {
    if (this.metrics.tokens.legacy !== null) this.metrics.tokens.legacy += tokens;
  }

  /** Call exactly when the text frame is emitted; the first call is the measurement. */
  noteTextEmitted(): void {
    if (this.textEmittedAt === null) this.textEmittedAt = this.now();
  }

  build(input: {
    outcome: CanaryTurnEvent['outcome'];
    clarificationRequested: boolean;
    heldReason?: string | null;
  }): CanaryTurnEvent {
    const total = Math.max(0, this.now() - this.startedAt);
    // Time-to-text is measured at the text frame. A turn that emitted no text
    // (cancelled, empty) reports the whole duration rather than a fictitious 0.
    const timeToText =
      this.textEmittedAt === null ? total : Math.max(0, this.textEmittedAt - this.startedAt);
    const usedTasks = [
      ...(this.identity.modes.passageSelection !== 'off' ? ['passage_relevance' as const] : []),
      ...(this.identity.modes.claimAssessment !== 'off' || this.identity.modes.autoCorrection !== 'off'
        ? ['claim_support' as const] : []),
    ];
    return {
      event: 'meri.canary.turn',
      ...this.identity,
      registryVersion: JEV_TASK_REGISTRY_VERSION,
      jevTasks: Object.fromEntries(usedTasks.map((task) => {
        const registration = JEV_TASK_REGISTRY[task];
        return [task, { questionVersion: registration.questionVersion,
          modelVersion: registration.modelVersion }];
      })),
      outcome: input.outcome,
      clarificationRequested: input.clarificationRequested,
      heldReason: input.heldReason ?? null,
      ...this.metrics,
      latencyMs: { ...this.metrics.latencyMs, timeToText, total },
      estimatedCostUsd: this.metrics.estimatedCostUsd === null
        ? null : Number(this.metrics.estimatedCostUsd.toFixed(9)),
    };
  }
}

export function replyRequestsClarification(reply: string, documentRequested: number): boolean {
  if (documentRequested > 0) return true;
  const normalized = reply.trim();
  if (!normalized.endsWith('?')) return false;
  return /(?:^|\b)(?:which|what|who|where|when|could you|can you|would you|please clarify|do you mean)\b[^?]*\?$/i.test(normalized);
}
