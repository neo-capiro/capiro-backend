import { describe, expect, it, jest } from '@jest/globals';
import type { ClaimCategory } from '../assurance/evidence-plan';
import type { DecisionProvider, EvidenceDecision, EvidenceEnvelope, EvidenceQuestion } from './decision-contract';
import { runCalibratedCascade, sampledCascadeKey } from './calibrated-cascade';
import { JEV_TASK_REGISTRY, type JevTaskRegistration } from './task-registry';

const probabilities = {
  supported: 0.9,
  contradicted: 0.03,
  insufficient_evidence: 0.04,
  conflicting_evidence: 0.03,
};
const outcome = (
  value: 'supported' | 'contradicted' | 'insufficient_evidence' | 'conflicting_evidence' = 'supported',
  confidence = 0.9,
): EvidenceDecision => ({
  kind: 'outcome', outcome: value, confidence, probabilities, reasonCodes: [], evidenceIds: [],
  provider: { name: 'provider', model: 'model', questionVersion: 'claim_support.v1' }, latencyMs: 1,
});
const failure: EvidenceDecision = {
  kind: 'failure', state: 'judge_unavailable', reasonCodes: ['failed'],
  provider: { name: 'provider', model: 'model', questionVersion: 'claim_support.v1' }, latencyMs: 1,
};
const provider = (decision: EvidenceDecision, available = true): DecisionProvider => ({
  name: 'provider', available: () => available, assess: jest.fn(async () => decision),
});
const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'claim', claimText: 'Claim', claimKind: 'fact',
  claimCategory: 'general_background', tenantId: 'tenant', clientId: null, scopeQualifiers: [], asOf: null, sources: [],
};
const question: EvidenceQuestion = { state: {}, questions: {} };
const registration = (overrides: Partial<NonNullable<JevTaskRegistration['cascade']>> = {}, evaluatedCategories?: readonly ClaimCategory[]): JevTaskRegistration => ({
  ...JEV_TASK_REGISTRY.claim_support,
  calibration: { ...JEV_TASK_REGISTRY.claim_support.calibration, evaluatedCategories },
  cascade: { ...JEV_TASK_REGISTRY.claim_support.cascade!, auditSampleRate: 0, ...overrides },
});
const run = (overrides: Partial<Parameters<typeof runCalibratedCascade>[0]> = {}) => runCalibratedCascade({
  claim: { id: 'claim', category: 'general_background', compound: false },
  jev: provider(outcome()), legacy: provider(outcome('contradicted')), envelope, question,
  registration: registration(), sampleKey: 'not-sampled', ...overrides,
});

describe('runCalibratedCascade', () => {
  it('does not escalate a confident supported non-sampled claim', async () => {
    const legacy = provider(outcome('contradicted'));
    const result = await run({ legacy });
    expect(result).toMatchObject({ escalated: false, escalationReasons: [], audited: false, legacy: null });
    expect(result.decision).toEqual(result.jev);
    expect(legacy.assess).not.toHaveBeenCalled();
  });

  it.each([
    ['jev_unavailable', null, outcome(), { registration: registration() }],
    ['jev_failure', provider(failure), outcome(), { registration: registration() }],
    ['low_confidence', provider(outcome('supported', 0.49)), outcome(), { registration: registration({ escalateBelowConfidence: 0.5 }) }],
    ['compound_claim', provider(outcome()), outcome(), { claim: { id: 'claim', category: 'general_background' as const, compound: true } }],
    ['conflict', provider(outcome('conflicting_evidence')), outcome(), {}],
    ['high_impact_category', provider(outcome()), outcome(), { claim: { id: 'claim', category: 'bill_status' as const, compound: false }, registration: registration({ highImpactCategories: ['bill_status'] }) }],
    ['out_of_distribution', provider(outcome()), outcome(), { registration: registration({}, ['bill_status']) }],
    ['audit_sample', provider(outcome()), outcome(), { registration: registration({ auditSampleRate: 1 }) }],
  ])('emits the minimal %s escalation', async (reason, jev, legacyDecision, overrides) => {
    const result = await run({ jev, legacy: provider(legacyDecision), ...overrides });
    expect(result.escalationReasons).toEqual([reason]);
    expect(result.escalated).toBe(true);
    expect(result.legacy).not.toBeNull();
  });

  it('flags contradicted high-impact claims as both conflict and high impact', async () => {
    const result = await run({
      claim: { id: 'claim', category: 'bill_status', compound: false },
      jev: provider(outcome('contradicted')),
      registration: registration({ highImpactCategories: ['bill_status'] }),
    });
    expect(result.escalationReasons).toEqual(['conflict', 'high_impact_category']);
  });

  it('follows registry thresholds and preserves the legacy-first decision rule', async () => {
    const legacyDecision = outcome('contradicted');
    const result = await run({
      jev: provider(outcome('supported', 0.8)), legacy: provider(legacyDecision),
      registration: registration({ escalateBelowConfidence: 0.81 }),
    });
    expect(result.escalationReasons).toEqual(['low_confidence']);
    expect(result.decision).toBe(legacyDecision);
  });

  it('audits deterministically and reports disagreement', async () => {
    const first = await run({ registration: registration({ auditSampleRate: 1 }) });
    const second = await run({ registration: registration({ auditSampleRate: 1 }) });
    expect(first).toMatchObject({ audited: true, auditDisagreement: true });
    expect(second.escalationReasons).toEqual(first.escalationReasons);
    expect(sampledCascadeKey('stable', 0.1)).toBe(sampledCascadeKey('stable', 0.1));
  });

  it('does not call legacy after abort or an expired deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortedLegacy = provider(outcome());
    await run({ jev: null, legacy: abortedLegacy, signal: controller.signal });
    expect(abortedLegacy.assess).not.toHaveBeenCalled();

    const expiredLegacy = provider(outcome());
    await run({ jev: null, legacy: expiredLegacy, deadlineAt: Date.now() - 1 });
    expect(expiredLegacy.assess).not.toHaveBeenCalled();
  });

  it('degrades a provider availability failure to legacy', async () => {
    const broken: DecisionProvider = {
      name: 'broken',
      available: () => { throw new Error('availability failed'); },
      assess: jest.fn(async () => outcome()),
    };
    const legacyDecision = outcome('contradicted');
    const result = await run({ jev: broken, legacy: provider(legacyDecision) });
    expect(result.escalationReasons).toEqual(['jev_unavailable']);
    expect(result.decision).toBe(legacyDecision);
    expect(broken.assess).not.toHaveBeenCalled();
  });
});
