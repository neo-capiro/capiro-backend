import { describe, expect, it } from '@jest/globals';
import type { EvidenceDecision, EvidenceOutcome } from './decision-contract';
import {
  decisionFromSkepticVerdict,
  LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
  skepticVerdictFromDecision,
} from './skeptic-adapter';

const meta = {
  provider: { name: 'legacy-skeptic', model: 'legacy', questionVersion: 'skeptic.v1' },
  latencyMs: 3,
};

describe('skeptic compatibility adapter', () => {
  it.each([
    ['high', 0.9],
    ['medium', 0.7],
    ['low', 0.55],
  ] satisfies Array<['high' | 'medium' | 'low', number]>)('maps refuted %s to contradicted', (confidence, probability) => {
    const decision = decisionFromSkepticVerdict({ refuted: true, confidence, reason: 'ignored' }, meta);
    expect(decision).toMatchObject({ kind: 'outcome', outcome: 'contradicted' });
    expect(decision.kind === 'outcome' && decision.probabilities.contradicted).toBe(probability);
  });

  it('never maps legacy not-refuted to supported', () => {
    expect(
      decisionFromSkepticVerdict({ refuted: false, confidence: 'high', reason: 'ignored' }, meta),
    ).toMatchObject({
      kind: 'outcome',
      outcome: 'insufficient_evidence',
      reasonCodes: ['legacy_not_refuted'],
    });
  });

  it('maps a v2 refutation without bound evidence to could-not-confirm', () => {
    expect(decisionFromSkepticVerdict(
      { refuted: true, confidence: 'low', reason: 'No evidence supplied.' },
      { ...meta, hasBoundEvidence: false, adapterVersion: LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION },
    )).toMatchObject({
      kind: 'outcome', outcome: 'insufficient_evidence', confidence: 0.55,
      reasonCodes: ['legacy_could_not_confirm'],
    });
  });

  it('keeps v1 and v2 evidence-bound refutations contradicted', () => {
    const verdict = { refuted: true, confidence: 'medium' as const, reason: 'The passage contradicts it.' };
    expect(decisionFromSkepticVerdict(verdict, { ...meta, hasBoundEvidence: false })).toMatchObject({
      outcome: 'contradicted', reasonCodes: ['legacy_refuted'],
    });
    expect(decisionFromSkepticVerdict(verdict, {
      ...meta, hasBoundEvidence: true, adapterVersion: LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
    })).toMatchObject({ outcome: 'contradicted', reasonCodes: ['legacy_refuted'] });
  });

  it('carries judge usage into the decision', () => {
    expect(decisionFromSkepticVerdict(
      { refuted: false, confidence: 'high', reason: 'stated', usage: { inputTokens: 37, outputTokens: 5 } },
      meta,
    )).toMatchObject({ usage: { inputTokens: 37, outputTokens: 5 } });
  });

  it.each([
    ['contradicted', true],
    ['supported', false],
    ['insufficient_evidence', false],
    ['conflicting_evidence', false],
  ] satisfies Array<[EvidenceOutcome, boolean]>)('maps %s to refuted=%s', (outcome, refuted) => {
    const decision: EvidenceDecision = {
      kind: 'outcome',
      outcome,
      probabilities: {
        supported: outcome === 'supported' ? 0.9 : 0.02,
        contradicted: outcome === 'contradicted' ? 0.9 : 0.02,
        insufficient_evidence: outcome === 'insufficient_evidence' ? 0.9 : 0.04,
        conflicting_evidence: outcome === 'conflicting_evidence' ? 0.9 : 0.04,
      },
      confidence: 0.9,
      reasonCodes: ['code'],
      evidenceIds: [],
      provider: meta.provider,
      latencyMs: 1,
    };
    expect(skepticVerdictFromDecision(decision)).toEqual({ refuted, confidence: 'high', reason: 'code' });
  });
});
