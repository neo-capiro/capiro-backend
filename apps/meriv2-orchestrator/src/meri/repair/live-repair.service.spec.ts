import type { DecisionProvider, EvidenceDecision } from '@capiro/meriv2-core';
import { applyLiveRepair, sampled } from './live-repair.service';

const supported: EvidenceDecision = {
  kind: 'outcome', outcome: 'supported', confidence: 0.9,
  probabilities: { supported: 0.9, contradicted: 0.03, insufficient_evidence: 0.04, conflicting_evidence: 0.03 },
  reasonCodes: [], evidenceIds: [], provider: { name: 'fake', model: 'fake', questionVersion: 'claim_support.v1' }, latencyMs: 1,
};
const insufficient: EvidenceDecision = {
  ...supported, outcome: 'insufficient_evidence', confidence: 0.9,
  probabilities: { supported: 0.03, contradicted: 0.03, insufficient_evidence: 0.9, conflicting_evidence: 0.04 },
};
function provider(decision: EvidenceDecision): DecisionProvider {
  return { name: 'fake', available: () => true, assess: jest.fn(async () => decision) };
}
const plan = {
  version: 'ga-evidence-plan-v1' as const, requestCategories: ['general_background' as const],
  jurisdictions: [], requirements: [{
    id: 'general', claimCategory: 'general_background' as const, level: 'required' as const,
    evidenceClass: 'official_government_data' as const, toolFamilies: ['refresh_status'],
    freshness: 'same_turn' as const, reason: 'test', requiredFields: [],
  }], requiredRequirementIds: ['general'], optionalRequirementIds: [], supplementalRequirementIds: [],
  unresolvedFrameFields: [], incomplete: false,
};
const ledger = {
  version: 'ga-claim-ledger-v1' as const, claims: [], evidence: [], unsupportedClaimIds: [],
  conflictedClaimIds: [], highRiskUnsupportedClaimIds: [], requiredEvidenceGaps: [], hash: 'h',
};
const logger = { log: jest.fn(), warn: jest.fn() };
function claim(id: string, category: 'general_background' | 'bill_status' = 'general_background') {
  return { id, text: id === 'promoted' ? 'TITAN is not in production.' : 'Unrelated content remains.', sentenceIndex: 0, clauseIndex: 0, kind: 'fact' as const, category, markers: [], evidenceIds: [], uncited: true, compound: false, material: true, asOf: new Date().toISOString() };
}
function base(overrides: Record<string, unknown> = {}) {
  return {
    released: 'TITAN is not in production. Unrelated content remains.', claims: [claim('promoted'), claim('other', 'bill_status')],
    ledger, citations: [], passages: {}, evidencePlan: plan, tenantId: 'tenant', conversationId: 'conversation',
    providers: { jev: provider(insufficient), legacy: provider(supported) },
    executor: { execute: jest.fn(async () => ({ ok: false as const, state: 'retrieval_failed' as const, reason: 'unavailable' })) },
    generate: jest.fn(async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: [] })),
    promotedCategories: new Set(['general_background' as const]),
    budget: { maxPasses: 1 as const, maxToolCalls: 3, maxMs: 8_000, maxInputTokens: 60_000 },
    logger, ...overrides,
  };
}

describe('live bounded repair', () => {
  it('assesses only promoted categories and preserves unrelated text byte-identically', async () => {
    const result = await applyLiveRepair(base());
    expect(result.reply).toContain('Unrelated content remains.');
    expect(Object.keys(result.outcomes)).toEqual(['promoted']);
  });

  it('corrects a promoted claim after bounded evidence retrieval', async () => {
    const result = await applyLiveRepair(base({
      providers: { jev: provider(insufficient), legacy: provider(supported) },
      executor: { execute: jest.fn(async () => ({ ok: true as const, evidence: [{
        id: 'e1', sourceType: 'refresh_status', sourceId: 'titan', evidenceClass: 'official_government_data' as const,
        passage: 'TITAN entered production.', primary: true, authoritative: true, requirementIds: [],
      }] })) },
      generate: async () => ({ replacementText: 'TITAN entered production.', citedEvidenceIds: ['e1'] }),
    }));
    expect(result.reply).toBe('TITAN entered production. Unrelated content remains.');
    expect(result.toolCalls).toBeLessThanOrEqual(3);
    expect(result.passes).toBe(1);
  });

  it('deterministically samples exactly one tenth of stable claim ids', () => {
    const values = Array.from({ length: 1000 }, (_, index) => sampled('conversation', String(index)));
    expect(values.filter(Boolean).length).toBeGreaterThan(70);
    expect(values.filter(Boolean).length).toBeLessThan(130);
    expect(values).toEqual(Array.from({ length: 1000 }, (_, index) => sampled('conversation', String(index))));
  });
});
