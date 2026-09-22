export type CanaryMode = 'off' | 'shadow' | 'enforce' | string;

export interface CanaryTurnEvent {
  event: 'meri.canary.turn';
  conversationId: string | null;
  tenantId: string;
  surface: 'chat';
  modes: {
    evidenceAccuracy: CanaryMode;
    claimAssessment: CanaryMode;
    coverageRetrieval: CanaryMode;
    passageSelection: CanaryMode;
    autoCorrection: CanaryMode;
    jevProvider: CanaryMode;
    routing: CanaryMode;
  };
  outcome: 'released' | 'held' | 'error' | 'aborted';
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
  };
  repair: {
    attempted: number;
    corrected: number;
    qualified: number;
    omitted: number;
    documentRequested: number;
    budgetExhausted: number;
  };
  latencyMs: {
    timeToText: number;
    assessment: number;
    passageSelection: number;
    coverageFollowUp: number;
    repair: number;
    total: number;
  };
  tokens: { synthesis: number; jev: number; legacy: number; repair: number };
  estimatedCostUsd: number;
  sampled: boolean;
}

type MutableMetrics = Pick<CanaryTurnEvent,
  'coverage' | 'passageSelection' | 'repair' | 'latencyMs' | 'tokens'> & {
  estimatedCostUsd: number;
  sampled: boolean;
};

export class CanaryTurnCollector {
  private readonly startedAt: number;
  private readonly metrics: MutableMetrics = {
    coverage: { gaps: 0, followUps: 0, residual: 0 },
    passageSelection: {
      candidates: 0, kept: 0, dropped: 0, requiredCandidates: 0, requiredRetained: 0,
      contradictoryRetained: 0, fallback: false,
    },
    repair: {
      attempted: 0, corrected: 0, qualified: 0, omitted: 0,
      documentRequested: 0, budgetExhausted: 0,
    },
    latencyMs: {
      timeToText: 0, assessment: 0, passageSelection: 0,
      coverageFollowUp: 0, repair: 0, total: 0,
    },
    tokens: { synthesis: 0, jev: 0, legacy: 0, repair: 0 },
    estimatedCostUsd: 0,
    sampled: false,
  };

  constructor(
    private readonly identity: Pick<CanaryTurnEvent, 'conversationId' | 'tenantId' | 'surface' | 'modes'>,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  noteCoverage(value: CanaryTurnEvent['coverage'] & { latencyMs: number }): void {
    this.metrics.coverage = { gaps: value.gaps, followUps: value.followUps, residual: value.residual };
    this.metrics.latencyMs.coverageFollowUp = value.latencyMs;
  }

  notePassageSelection(value: CanaryTurnEvent['passageSelection'] & {
    latencyMs: number; tokens: number; costUsd: number;
  }): void {
    const { latencyMs, tokens, costUsd, ...selection } = value;
    this.metrics.passageSelection = selection;
    this.metrics.latencyMs.passageSelection = latencyMs;
    this.metrics.tokens.jev += tokens;
    this.metrics.estimatedCostUsd += costUsd;
  }

  noteRepair(value: CanaryTurnEvent['repair'] & {
    assessmentMs: number; repairMs: number; tokens: number; costUsd: number; sampled?: boolean;
  }): void {
    const { assessmentMs, repairMs, tokens, costUsd, sampled, ...repair } = value;
    this.metrics.repair = repair;
    this.metrics.latencyMs.assessment = assessmentMs;
    this.metrics.latencyMs.repair = repairMs;
    this.metrics.tokens.repair += tokens;
    this.metrics.estimatedCostUsd += costUsd;
    this.metrics.sampled = this.metrics.sampled || Boolean(sampled);
  }

  noteSynthesis(tokens: number, costUsd: number): void {
    this.metrics.tokens.synthesis += tokens;
    this.metrics.estimatedCostUsd += costUsd;
  }

  noteLegacy(tokens: number): void {
    this.metrics.tokens.legacy += tokens;
  }

  build(input: {
    outcome: CanaryTurnEvent['outcome'];
    clarificationRequested: boolean;
    heldReason?: string | null;
  }): CanaryTurnEvent {
    const total = Math.max(0, this.now() - this.startedAt);
    return {
      event: 'meri.canary.turn',
      ...this.identity,
      outcome: input.outcome,
      clarificationRequested: input.clarificationRequested,
      heldReason: input.heldReason ?? null,
      ...this.metrics,
      latencyMs: { ...this.metrics.latencyMs, timeToText: total, total },
      estimatedCostUsd: Number(this.metrics.estimatedCostUsd.toFixed(9)),
    };
  }
}

export function replyRequestsClarification(reply: string, documentRequested: number): boolean {
  if (documentRequested > 0) return true;
  const normalized = reply.trim();
  if (!normalized.endsWith('?')) return false;
  return /(?:^|\b)(?:which|what|who|where|when|could you|can you|would you|please clarify|do you mean)\b[^?]*\?$/i.test(normalized);
}
