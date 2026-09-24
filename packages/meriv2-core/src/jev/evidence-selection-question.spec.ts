import { describe, expect, it } from '@jest/globals';
import type { EvidenceEnvelope } from './decision-contract';
import { buildEvidenceSelectionQuestion, selectedEvidenceCandidate } from './evidence-selection-question';

const source = (id: string, passage: string): EvidenceEnvelope['sources'][number] => ({ evidenceId: id,
  sourceType: 'budget', sourceId: `source-${id}`, documentId: 'doc', version: 'v1', locator: 'p. 2', passage,
  sourceDate: null, publishedAt: null, effectiveAt: null, retrievedAt: null,
  authority: { sourceAuthority: 'DoD Comptroller', publisher: 'DoD', jurisdiction: 'US' },
  documentCompleteness: 'complete', relationScope: 'pe_specific', financialStage: 'request',
  provenance: { evidenceClass: 'official_budget_exhibit_mark_law', primary: true, authoritative: true } });
const envelope: EvidenceEnvelope = { envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c',
  claimText: 'Which supports the amount?', claimKind: 'fact', claimCategory: 'evidence_selection',
  tenantId: 'tenant', clientId: null, scopeQualifiers: [], asOf: null,
  sources: [source('e1', 'Budget statement'), source('e2', 'Secondary statement')] };

describe('evidence selection question', () => {
  const candidates = [{ id: 'ev:1', evidenceId: 'e1' }, { id: 'ev:2', evidenceId: 'e2' }];
  it('offers envelope-bound pointers plus none and ambiguous without text output', () => {
    const q = buildEvidenceSelectionQuestion({ question: 'Which supports the amount?', envelope, candidates });
    const choice = q.questions.evidence_selection!;
    if (choice.type !== 'choice') throw new Error('expected Choice');
    expect(Object.keys(choice.criteria)).toEqual(['ev:1', 'ev:2', 'none', 'ambiguous']);
    expect(choice.instructions).toContain('Never quote, summarize, transform, or generate evidence text');
    expect(q.state).toMatchObject({ candidates: [
      { id: 'ev:1', evidence: expect.objectContaining({ evidenceId: 'e1', passage: 'Budget statement' }) },
      { id: 'ev:2', evidence: expect.objectContaining({ evidenceId: 'e2', passage: 'Secondary statement' }) },
    ] });
  });
  it('returns only the original caller-supplied candidate by pointer', () => {
    expect(selectedEvidenceCandidate(candidates, 'ev:1')).toBe(candidates[0]);
    expect(selectedEvidenceCandidate(candidates, 'none')).toBeNull();
    expect(selectedEvidenceCandidate(candidates, 'model-invented')).toBeNull();
  });
  it('rejects duplicate, reserved, malformed, missing-envelope and excessive candidates', () => {
    expect(() => buildEvidenceSelectionQuestion({ question: 'q', envelope,
      candidates: [candidates[0]!, candidates[0]!] })).toThrow(/unique/);
    expect(() => buildEvidenceSelectionQuestion({ question: 'q', envelope,
      candidates: [{ id: 'none', evidenceId: 'e1' }] })).toThrow(/reserved/);
    expect(() => buildEvidenceSelectionQuestion({ question: 'q', envelope,
      candidates: [{ id: 'x y', evidenceId: 'e1' }] })).toThrow(/valid/);
    expect(() => buildEvidenceSelectionQuestion({ question: 'q', envelope,
      candidates: [{ id: 'outside', evidenceId: 'outside' }] })).toThrow(/not in the envelope/);
    expect(() => buildEvidenceSelectionQuestion({ question: 'q', envelope: { ...envelope,
      sources: Array.from({ length: 33 }, (_, index) => source(`e${index}`, String(index))) },
      candidates: Array.from({ length: 33 }, (_, index) => ({ id: `c${index}`, evidenceId: `e${index}` })) })).toThrow(/32/);
  });
});
