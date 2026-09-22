import { describe, expect, it } from '@jest/globals';
import { checkExactSourceEligibility, resolveDocumentReferences, type DocumentReference } from './exact-source';
import type { MaterialClaim } from './claim-inventory';

const claim: MaterialClaim = {
  id: 'claim-1', text: 'The Acme transcript says the launch is October 2.', sentenceIndex: 0,
  clauseIndex: 0, kind: 'fact', category: 'general_background', markers: [1],
  evidenceIds: ['doc-1'], uncited: false, compound: false, material: true,
};

const reference = (overrides: Partial<DocumentReference> = {}): DocumentReference => ({
  kind: 'client_document', id: 'doc-1', filename: 'Acme transcript.txt', version: '2',
  contentState: 'ready', readable: true, relevantPassageIds: ['passage-1'], resolution: 'explicit_id',
  clientId: 'client-1', requestedClientId: 'client-1', ...overrides,
});

describe('exact-source reference resolution', () => {
  const candidate = { id: 'att-1', filename: 'Board memo.pdf', version: '3', contentState: 'partial' as const,
    readable: true, relevantPassageIds: ['p-1'] };

  it('prefers selected attachment ids and preserves partial readability', () => {
    expect(resolveDocumentReferences({ userText: 'review it', selectedAttachmentIds: ['att-1'],
      priorTurnManifest: [candidate], clientDocuments: [] })).toEqual([
      expect.objectContaining({ id: 'att-1', resolution: 'explicit_id', readable: true }),
    ]);
  });

  it('labels filename and pronoun matches as heuristics', () => {
    expect(resolveDocumentReferences({ userText: 'Use Board memo.pdf', selectedAttachmentIds: [],
      priorTurnManifest: [candidate], clientDocuments: [] })[0]?.resolution).toBe('filename');
    expect(resolveDocumentReferences({ userText: 'Use this attachment', selectedAttachmentIds: [],
      priorTurnManifest: [candidate], clientDocuments: [] })[0]?.resolution).toBe('pronoun_heuristic');
  });

  it('never makes metadata-only or failed candidates readable', () => {
    for (const contentState of ['metadata_only', 'failed'] as const) {
      expect(resolveDocumentReferences({ userText: 'Use this document', selectedAttachmentIds: [],
        priorTurnManifest: [{ ...candidate, contentState, readable: true }], clientDocuments: [] })[0]?.readable).toBe(false);
    }
  });
});

describe('exact-source eligibility', () => {
  it.each([
    ['readable exact passage', reference(), { eligible: true, reason: 'ok' }],
    ['partial exact passage', reference({ contentState: 'partial' }), { eligible: true, reason: 'ok' }],
    ['metadata only', reference({ contentState: 'metadata_only', readable: false }), { eligible: false, reason: 'metadata_only' }],
    ['failed read', reference({ contentState: 'failed', readable: false }), { eligible: false, reason: 'unreadable' }],
    ['empty extraction', reference({ readable: false }), { eligible: false, reason: 'unreadable' }],
    ['no passage', reference({ relevantPassageIds: [] }), { eligible: false, reason: 'no_relevant_passage' }],
    ['version mismatch', reference({ requestedVersion: '9' }), { eligible: false, reason: 'version_mismatch' }],
    ['wrong client', reference({ requestedClientId: 'client-2' }), { eligible: false, reason: 'wrong_client' }],
  ])('%s', (_label, input, expected) => {
    expect(checkExactSourceEligibility(claim, [input])).toEqual(expected);
  });

  it('requires an exact document for document claims', () => {
    expect(checkExactSourceEligibility(claim, [])).toEqual({ eligible: false, reason: 'no_document' });
  });

  it('does not impose document eligibility on an ordinary bill claim', () => {
    expect(checkExactSourceEligibility({ ...claim, text: 'H.R. 1 passed.', category: 'bill_status' }, [])).toEqual({ eligible: true, reason: 'ok' });
  });
});
