import { describe, expect, it } from '@jest/globals';
import { buildClaimSupportQuestion } from './claim-support-question';
import type { EvidenceEnvelope } from './decision-contract';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'claim-1', claimText: 'The amount is 42.', claimKind: 'fact', claimCategory: 'budget_amount',
  tenantId: 'tenant-1', clientId: null, scopeQualifiers: ['category:budget_amount'], asOf: null,
  sources: [{
    evidenceId: 'e1', sourceType: 'record', sourceId: 'r1', documentId: null, version: null,
    locator: null, passage: 'The amount is 42.', sourceDate: null, publishedAt: null,
    effectiveAt: null, retrievedAt: null,
  }],
};

describe('buildClaimSupportQuestion', () => {
  it('keeps claim_support.v1 state byte-identical when provenance is present', () => {
    const withProvenance: EvidenceEnvelope = {
      ...envelope,
      sources: envelope.sources.map((source) => ({
        ...source,
        provenance: { evidenceClass: 'official_government_data', primary: true, authoritative: true },
      })),
    };

    expect(buildClaimSupportQuestion(withProvenance).state).toEqual(buildClaimSupportQuestion(envelope).state);
    expect(JSON.stringify(buildClaimSupportQuestion(withProvenance).state))
      .toBe(JSON.stringify(buildClaimSupportQuestion(envelope).state));
  });
});