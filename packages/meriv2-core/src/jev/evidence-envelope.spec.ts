import { describe, expect, it } from '@jest/globals';
import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import {
  evidenceEnvelopeSchema,
  hashEvidenceEnvelope,
  hashJevBoundaryValue,
} from './decision-contract';
import { buildEvidenceEnvelope, envelopeSourcesForJev } from './evidence-envelope';

const claim: AssuredClaim = {
  id: 'claim-1',
  text: 'The amount is 42.',
  type: 'fact',
  category: 'budget_amount',
  sourceIds: ['e1'],
  primarySourcePresent: true,
  confidence: 'high',
  asOf: '2026-01-01',
};
const ledger: ClaimLedger = {
  version: 'ga-claim-ledger-v1',
  claims: [claim],
  evidence: [
    {
      id: 'e1',
      sourceType: 'record',
      sourceId: 'r1',
      evidenceClass: 'official_government_data',
      primary: true,
      authoritative: true,
      requirementIds: [],
    },
    {
      id: 'e2',
      sourceType: 'record',
      sourceId: 'r2',
      evidenceClass: 'official_government_data',
      primary: true,
      authoritative: true,
      requirementIds: [],
    },
  ],
  unsupportedClaimIds: [],
  conflictedClaimIds: [],
  highRiskUnsupportedClaimIds: [],
  requiredEvidenceGaps: [],
  hash: 'ledger',
};

describe('buildEvidenceEnvelope', () => {
  it('selects referenced evidence only and hashes content deterministically', () => {
    const input = {
      claim,
      ledger,
      citations: [],
      passages: { e1: { text: 'The amount is 42.' }, e2: { text: 'unreferenced' } },
      tenantId: 'tenant-1',
      clientId: 'client-1',
    };
    const first = buildEvidenceEnvelope(input);
    expect(first.envelope.sources.map((source) => source.evidenceId)).toEqual(['e1']);
    expect(buildEvidenceEnvelope(input).hash).toBe(first.hash);
    expect(
      buildEvidenceEnvelope({ ...input, passages: { e1: { text: 'The amount is 43.' } } }).hash,
    ).not.toBe(first.hash);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashJevBoundaryValue({ b: 1, a: 2 })).toBe(hashJevBoundaryValue({ a: 2, b: 1 }));
  });

  it('accepts legacy and provenance-bearing envelopes and identities provenance changes', () => {
    const input = {
      claim,
      ledger,
      citations: [],
      passages: { e1: { text: 'The amount is 42.' } },
      tenantId: 'tenant-1',
    };
    const legacy = buildEvidenceEnvelope(input).envelope;
    const withProvenance = buildEvidenceEnvelope({ ...input, includeProvenance: true }).envelope;

    expect(evidenceEnvelopeSchema.parse(legacy)).toEqual(legacy);
    expect(evidenceEnvelopeSchema.parse(withProvenance)).toEqual(withProvenance);
    expect(withProvenance.sources[0]?.provenance).toEqual({
      evidenceClass: 'official_government_data',
      primary: true,
      authoritative: true,
    });
    expect(hashEvidenceEnvelope(withProvenance)).not.toBe(hashEvidenceEnvelope(legacy));
    expect(
      hashEvidenceEnvelope({
        ...withProvenance,
        sources: withProvenance.sources.map((source) => ({
          ...source,
          passage: 'The amount is 43.',
        })),
      }),
    ).not.toBe(hashEvidenceEnvelope(legacy));
  });

  it('exposes provenance to Jev only when requested', () => {
    const envelope = buildEvidenceEnvelope({
      claim,
      ledger,
      citations: [],
      passages: { e1: { text: 'The amount is 42.' } },
      tenantId: 'tenant-1',
      includeProvenance: true,
    }).envelope;

    expect(envelopeSourcesForJev(envelope, { includeProvenance: false })[0]).toEqual({
      evidenceId: 'e1',
      sourceType: 'record',
      sourceId: 'r1',
      documentId: null,
      version: null,
      locator: null,
      passage: 'The amount is 42.',
      sourceDate: null,
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: null,
    });
    expect(envelopeSourcesForJev(envelope, { includeProvenance: true })[0]?.provenance).toEqual({
      evidenceClass: 'official_government_data',
      primary: true,
      authoritative: true,
    });
  });

  it('caps a passage and records explicit truncation', () => {
    const result = buildEvidenceEnvelope({
      claim,
      ledger,
      citations: [],
      passages: { e1: { text: `${'word '.repeat(500)}Finished.` } },
      tenantId: 'tenant-1',
      clientId: null,
    });
    expect(result.envelope.sources[0]?.passage.length).toBeLessThanOrEqual(2001);
    expect(result.envelope.truncation?.truncatedEvidenceIds).toEqual(['e1']);
    expect(result.envelope.truncation?.estimatedTokens).toBeGreaterThan(0);
  });

  it('carries publication, effective, and retrieval dates separately', () => {
    const datedLedger = {
      ...ledger,
      evidence: [
        {
          ...ledger.evidence[0]!,
          publishedAt: '2026-01-01',
          effectiveAt: '2026-02-01',
          retrievedAt: '2026-02-02',
        },
      ],
    };
    const result = buildEvidenceEnvelope({
      claim,
      ledger: datedLedger,
      citations: [],
      passages: { e1: { text: 'The amount is 42.' } },
      tenantId: 'tenant-1',
    });
    expect(result.envelope.sources[0]).toEqual(
      expect.objectContaining({
        publishedAt: '2026-01-01',
        effectiveAt: '2026-02-01',
        retrievedAt: '2026-02-02',
      }),
    );
  });

  it('preserves authority, completeness, relation scope and financial stage through the Jev projection', () => {
    const result = buildEvidenceEnvelope({
      claim,
      ledger,
      citations: [],
      tenantId: 'tenant-1',
      includeProvenance: true,
      passages: {
        e1: {
          text: 'The amount is 42.',
          locator: 'p. 9',
          authority: {
            sourceAuthority: 'DoD Comptroller',
            publisher: 'Department of Defense',
            jurisdiction: 'US',
          },
          documentCompleteness: 'complete',
          relationScope: 'pe_specific',
          financialStage: 'request',
        },
      },
    });
    expect(envelopeSourcesForJev(result.envelope, { includeProvenance: true })[0]).toEqual(
      expect.objectContaining({
        authority: {
          sourceAuthority: 'DoD Comptroller',
          publisher: 'Department of Defense',
          jurisdiction: 'US',
        },
        documentCompleteness: 'complete',
        relationScope: 'pe_specific',
        financialStage: 'request',
        provenance: {
          evidenceClass: 'official_government_data',
          primary: true,
          authoritative: true,
        },
      }),
    );
    expect(evidenceEnvelopeSchema.parse(result.envelope)).toEqual(result.envelope);
  });
});
