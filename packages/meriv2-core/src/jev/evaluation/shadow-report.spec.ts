import { describe, expect, it } from '@jest/globals';
import { buildShadowReport } from './shadow-report';
import type { EvidenceShadowEvent, HumanLabels } from './shadow-events';

const probabilities = {
  supported: 0.8,
  contradicted: 0.1,
  insufficient_evidence: 0.05,
  conflicting_evidence: 0.05,
};
function row(
  id: string,
  jev: 'supported' | 'contradicted',
  legacy: 'supported' | 'contradicted',
  model = 'jev-v1',
): EvidenceShadowEvent {
  const decision = (outcome: 'supported' | 'contradicted', providerModel: string) => ({
    kind: 'outcome' as const,
    outcome,
    confidence: 0.8,
    probabilities,
    reasonCodes: [],
    model: providerModel,
    questionVersion: 'claim_support.v1',
    latencyMs: 2,
    inputTokens: 10,
  });
  return {
    event: 'meri.evidence_shadow',
    conversationId: 'c',
    turnId: id,
    claimId: id,
    claimKind: 'fact',
    claimCategory: 'award',
    envelopeHash: `hash-${id}`,
    eligibility: { eligible: true, reason: 'ok' },
    jev: decision(jev, model),
    legacy: decision(legacy, 'legacy-v1'),
    agreement: jev === legacy,
    legacyAdapterVersion: 'legacy-skeptic-adapter.v1',
    proposedAction: { jev: 'none', legacy: 'none' },
    claimText: `${id} claim`,
    split: 'tuning',
    source: 'live',
  };
}
const labels: HumanLabels = {
  version: 'jev_human_labels_v1',
  labels: [
    {
      claimId: 'a',
      label: 'supported',
      status: 'approved',
      reviewer: 'R',
      reviewedAt: '2026-09-22T00:00:00.000Z',
      note: '',
    },
    {
      claimId: 'b',
      label: 'contradicted',
      status: 'approved',
      reviewer: 'R',
      reviewedAt: '2026-09-22T00:00:00.000Z',
      note: '',
    },
    {
      claimId: 'c',
      label: 'supported',
      status: 'approved',
      reviewer: 'R',
      reviewedAt: '2026-09-22T00:00:00.000Z',
      note: '',
    },
  ],
};

describe('shadow report', () => {
  it('computes known agreement, accuracy, precision, recall, totals, and digest', () => {
    const report = buildShadowReport({
      events: [
        row('a', 'supported', 'supported'),
        row('b', 'supported', 'contradicted'),
        row('c', 'contradicted', 'contradicted'),
      ],
      labels,
      split: 'all',
    });
    expect(report.providers.jev.agreementRate).toBeCloseTo(2 / 3);
    expect(report.providers.jev.metrics.accuracy).toBeCloseTo(1 / 3);
    expect(report.providers.jev.metrics.perOutcome.supported?.precision).toBeCloseTo(1 / 2);
    expect(report.providers.jev.metrics.perOutcome.supported?.recall).toBeCloseTo(1 / 2);
    expect(report.providers.legacy.metrics.accuracy).toBeCloseTo(2 / 3);
    expect(report.providers.jev.inputTokens).toBe(30);
    expect(report.disagreements).toHaveLength(1);
    expect(report.hash).toMatch(/^[0-9a-f]+$/);
    expect(report.markdown).toContain('Jev paired-shadow evaluation');
  });

  it('refuses mixed models and lists them', () => {
    expect(() =>
      buildShadowReport({
        events: [row('a', 'supported', 'supported'), row('b', 'supported', 'supported', 'jev-v2')],
        labels,
        split: 'all',
      }),
    ).toThrow('jev-v1, jev-v2');
  });

  it('refuses mixed legacy adapter versions', () => {
    const changed = row('b', 'supported', 'supported');
    changed.legacyAdapterVersion = 'legacy-skeptic-adapter.v2';
    expect(() =>
      buildShadowReport({
        events: [row('a', 'supported', 'supported'), changed],
        labels,
        split: 'all',
      }),
    ).toThrow('legacy-skeptic-adapter.v1, legacy-skeptic-adapter.v2');
  });

  it('refuses question versions that differ across providers', () => {
    const changed = row('a', 'supported', 'supported');
    changed.legacy.questionVersion = 'claim_support.v2';
    expect(() => buildShadowReport({ events: [changed], labels, split: 'all' })).toThrow(
      'claim_support.v1, claim_support.v2',
    );
  });

  it('accepts an empty fixture list for live-only reports', () => {
    const report = buildShadowReport({
      events: [row('a', 'supported', 'supported')],
      fixtures: [],
      split: 'all',
    });
    expect(report.counts).toMatchObject({ liveClaimEvents: 1, replayClaimEvents: 0 });
  });
});
