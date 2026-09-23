import type { ClaimCategory } from '../assurance/evidence-plan';
import type {
  DecisionProvider,
  EvidenceDecision,
  EvidenceEnvelope,
  EvidenceQuestion,
} from './decision-contract';
import type { JevTaskRegistration } from './task-registry';

export const CASCADE_ESCALATION_REASONS = [
  'jev_unavailable',
  'jev_failure',
  'low_confidence',
  'compound_claim',
  'conflict',
  'high_impact_category',
  'out_of_distribution',
  'audit_sample',
] as const;
export type CascadeEscalationReason = (typeof CASCADE_ESCALATION_REASONS)[number];

export interface CalibratedCascadeInput {
  claim: {
    id: string;
    category: ClaimCategory | 'unclassified';
    compound: boolean;
    materialHighImpact?: boolean;
  };
  jev: DecisionProvider | null;
  legacy: DecisionProvider;
  envelope: EvidenceEnvelope;
  question: EvidenceQuestion;
  registration: JevTaskRegistration;
  sampleKey: string;
  /** Restrict escalation to the historical live-repair rules during its behavior-preserving refactor. */
  legacyLiveRepairCompatibility?: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface CalibratedCascadeResult {
  decision: EvidenceDecision;
  jev: EvidenceDecision | null;
  legacy: EvidenceDecision | null;
  escalated: boolean;
  escalationReasons: CascadeEscalationReason[];
  audited: boolean;
  auditDisagreement: boolean;
}

export async function runCalibratedCascade(input: CalibratedCascadeInput): Promise<CalibratedCascadeResult> {
  const cascade = input.registration.cascade;
  if (!cascade) throw new Error(`Jev task ${input.registration.task} has no cascade registration`);

  let jev: EvidenceDecision | null = null;
  const reasons: CascadeEscalationReason[] = [];
  if (abortedOrExpired(input.signal, input.deadlineAt)) {
    reasons.push('jev_unavailable');
  } else if (!input.jev || !providerAvailable(input.jev)) {
    reasons.push('jev_unavailable');
  } else {
    jev = await safeAssess(input.jev, input);
    if (jev.kind === 'failure') reasons.push('jev_failure');
  }

  if (jev?.kind === 'outcome') {
    if (jev.confidence < cascade.escalateBelowConfidence) reasons.push('low_confidence');
    if (cascade.escalateCompound && input.claim.compound) reasons.push('compound_claim');
    if (!input.legacyLiveRepairCompatibility) {
      const highImpactCategory = input.claim.category !== 'unclassified'
        && cascade.highImpactCategories.includes(input.claim.category);
      if (jev.outcome === 'conflicting_evidence' || (jev.outcome === 'contradicted' && highImpactCategory)) {
        reasons.push('conflict');
      }
      if (input.claim.materialHighImpact || highImpactCategory) reasons.push('high_impact_category');
      const evaluated = input.registration.calibration.evaluatedCategories;
      if (evaluated?.length
        && (input.claim.category === 'unclassified' || !evaluated.includes(input.claim.category))) {
        reasons.push('out_of_distribution');
      }
    }
    if (jev.outcome === 'supported' && sampledCascadeKey(input.sampleKey, cascade.auditSampleRate)) {
      reasons.push('audit_sample');
    }
  } else if (cascade.escalateCompound && input.claim.compound) {
    reasons.push('compound_claim');
  }

  let legacy: EvidenceDecision | null = null;
  if (reasons.length > 0 && !abortedOrExpired(input.signal, input.deadlineAt)) {
    legacy = await safeAssess(input.legacy, input);
  }
  const audited = reasons.includes('audit_sample');
  return {
    decision: selectCascadeDecision(jev, legacy),
    jev,
    legacy,
    escalated: reasons.length > 0,
    escalationReasons: reasons,
    audited,
    auditDisagreement: Boolean(
      audited && jev?.kind === 'outcome' && legacy?.kind === 'outcome' && jev.outcome !== legacy.outcome,
    ),
  };
}

export function sampledCascadeKey(sampleKey: string, rate: number): boolean {
  let hash = 2166136261;
  for (const char of sampleKey) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return (hash >>> 0) % Math.round(1 / rate) === 0;
}

export function selectCascadeDecision(
  jev: EvidenceDecision | null,
  legacy: EvidenceDecision | null,
): EvidenceDecision {
  if (legacy?.kind === 'outcome') return legacy;
  if (jev?.kind === 'outcome') return jev;
  return legacy ?? jev ?? failure('no-provider', 'judge_unavailable');
}

async function safeAssess(
  provider: DecisionProvider,
  input: Pick<CalibratedCascadeInput, 'envelope' | 'question' | 'signal' | 'deadlineAt'>,
): Promise<EvidenceDecision> {
  try {
    const call = provider.assess(input.envelope, input.question, {
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
    return await settleBeforeAbort(call, input.signal, input.deadlineAt);
  } catch {
    return failure(provider.name, 'provider_failure');
  }
}

async function settleBeforeAbort(
  call: Promise<EvidenceDecision>,
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
): Promise<EvidenceDecision> {
  const remaining = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
  if (!signal && remaining === undefined) return call;
  if (signal?.aborted || remaining === 0) throw new DOMException('Aborted', 'AbortError');
  return new Promise<EvidenceDecision>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = remaining === undefined ? undefined : setTimeout(abort, remaining);
    void call.then(resolve, reject).finally(() => {
      signal?.removeEventListener('abort', abort);
      if (timer !== undefined) clearTimeout(timer);
    });
  });
}

function abortedOrExpired(signal: AbortSignal | undefined, deadlineAt: number | undefined): boolean {
  return Boolean(signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt));
}

function providerAvailable(provider: DecisionProvider): boolean {
  try {
    return provider.available();
  } catch {
    return false;
  }
}

function failure(name: string, reason: string): EvidenceDecision {
  return {
    kind: 'failure',
    state: 'judge_unavailable',
    reasonCodes: [reason],
    provider: { name, model: 'unknown', questionVersion: 'claim_support.v1' },
    latencyMs: 0,
  };
}
