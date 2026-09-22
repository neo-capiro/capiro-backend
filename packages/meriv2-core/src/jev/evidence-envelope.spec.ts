import { describe, expect, it } from '@jest/globals';
import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import { buildEvidenceEnvelope } from './evidence-envelope';

const claim: AssuredClaim = { id: 'claim-1', text: 'The amount is 42.', type: 'fact', category: 'budget_amount', sourceIds: ['e1'], primarySourcePresent: true, confidence: 'high', asOf: '2026-01-01' };
const ledger: ClaimLedger = { version: 'ga-claim-ledger-v1', claims: [claim], evidence: [{ id: 'e1', sourceType: 'record', sourceId: 'r1', evidenceClass: 'official_government_data', primary: true, authoritative: true, requirementIds: [] }, { id: 'e2', sourceType: 'record', sourceId: 'r2', evidenceClass: 'official_government_data', primary: true, authoritative: true, requirementIds: [] }], unsupportedClaimIds: [], conflictedClaimIds: [], highRiskUnsupportedClaimIds: [], requiredEvidenceGaps: [], hash: 'ledger' };

describe('buildEvidenceEnvelope', () => {
  it('selects referenced evidence only and hashes content deterministically', () => {
    const input = { claim, ledger, citations: [], passages: { e1: { text: 'The amount is 42.' }, e2: { text: 'unreferenced' } }, tenantId: 'tenant-1', clientId: 'client-1' };
    const first = buildEvidenceEnvelope(input);
    expect(first.envelope.sources.map((source) => source.evidenceId)).toEqual(['e1']);
    expect(buildEvidenceEnvelope(input).hash).toBe(first.hash);
    expect(buildEvidenceEnvelope({ ...input, passages: { e1: { text: 'The amount is 43.' } } }).hash).not.toBe(first.hash);
  });

  it('caps a passage and records explicit truncation', () => {
    const result = buildEvidenceEnvelope({ claim, ledger, citations: [], passages: { e1: { text: `${'word '.repeat(500)}Finished.` } }, tenantId: 'tenant-1', clientId: null });
    expect(result.envelope.sources[0]?.passage.length).toBeLessThanOrEqual(2001);
    expect(result.envelope.truncation?.truncatedEvidenceIds).toEqual(['e1']);
    expect(result.envelope.truncation?.estimatedTokens).toBeGreaterThan(0);
  });

  it('carries publication, effective, and retrieval dates separately', () => {
    const datedLedger = { ...ledger, evidence: [{ ...ledger.evidence[0]!, publishedAt: '2026-01-01', effectiveAt: '2026-02-01', retrievedAt: '2026-02-02' }] };
    const result = buildEvidenceEnvelope({ claim, ledger: datedLedger, citations: [], passages: { e1: { text: 'The amount is 42.' } }, tenantId: 'tenant-1' });
    expect(result.envelope.sources[0]).toEqual(expect.objectContaining({
      publishedAt: '2026-01-01', effectiveAt: '2026-02-01', retrievedAt: '2026-02-02',
    }));
  });
});
