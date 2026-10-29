import { createHash } from 'node:crypto';
import {
  parseRelevancePreview,
  parseRelevanceSave,
  receiveRelevancePreview,
  relevanceReceipt,
  relevanceSemanticInput,
} from './legiwatch-relevance.contract.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const selection = {
  clientId: null,
  folderId: '20000000-0000-4000-8000-000000000001',
  jurisdiction: 'US',
  sessionKey: '119',
  fields: ['title'] as ['title'],
  billId: 'hr1-119',
};
const request = {
  ...selection,
  explanation: 'The source addresses this client issue.',
  documentId: 'hr1-119:title',
  start: 2,
  end: 6,
  quote: '😀界文',
};
const coverage = {
  complete: false,
  inspectedDocuments: 1,
  missing: ['FULL_DOCUMENT_CORPUS_NOT_QUALIFIED'],
};
function ready() {
  const input = relevanceSemanticInput(request),
    binding = { input, sourceFingerprint: 'a'.repeat(64), folderVersion: 7 };
  return {
    input,
    binding,
    previewHash: hash(binding),
    coverage,
    effects: [{ kind: 'pending_semantic_suggestion', automaticAssignment: false }],
  };
}
function discovery() {
  return {
    bill: {
      id: selection.billId,
      number: 'H.R.1',
      title: '😀界文',
      sponsor: null,
      jurisdiction: 'US',
      sessionKey: '119',
      status: null,
      latestAction: null,
      latestActionAt: null,
      sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/1',
    },
    documents: [
      {
        id: request.documentId,
        billId: selection.billId,
        kind: 'title',
        revision: 'a'.repeat(64),
        observationId: 'a'.repeat(64),
        sourceUrl: null,
        extractorVersion: 'canonical-title-v1',
        text: '😀界文',
        complete: true,
        reason: null,
        excerptOnly: false,
      },
    ],
    coverage,
    previewHash: null,
    effects: [],
  };
}
describe('LegiWatch relevance exact source and pending receipt', () => {
  it('preserves discovery evidence and incomplete coverage without an approvable preview', () => {
    const page = receiveRelevancePreview(parseRelevancePreview(selection), discovery());
    expect(page.data).toEqual(discovery());
    expect(page.effects).toEqual([]);
    expect(page.coverage.sourceUniverseComplete).toBe(false);
  });
  it('binds exact UTF16 quote, folder version and source fingerprint in the canonical preview hash', () => {
    const page = receiveRelevancePreview(parseRelevancePreview(request), ready());
    expect(page.data).toEqual(ready());
    expect(request.quote.length).toBe(4);
  });
  it.each(['scope', 'input', 'hash', 'assignment'])('rejects changed preview %s', (kind) => {
    const page = ready();
    if (kind === 'scope') page.binding.input.scope.sessionKey = '118';
    if (kind === 'input') page.input.folderId = 'other';
    if (kind === 'hash') page.previewHash = 'b'.repeat(64);
    if (kind === 'assignment') page.effects[0]!.automaticAssignment = true;
    expect(() => receiveRelevancePreview(request, page)).toThrow();
  });
  it('rejects wrong canonical bill and document scope, but preserves an honest 12000-unit excerpt', () => {
    const p = discovery();
    p.documents[0]!.billId = 'foreign';
    expect(() => receiveRelevancePreview(selection, p)).toThrow();
    p.documents[0]!.billId = selection.billId;
    p.documents[0]!.text = '界'.repeat(12000);
    p.documents[0]!.excerptOnly = true;
    expect((receiveRelevancePreview(selection, p).data as typeof p).documents[0]!.excerptOnly).toBe(
      true,
    );
  });
  it('refuses partial evidence, codepoint offsets, duplicate fields and injected authority', () => {
    for (const raw of [
      { ...selection, explanation: 'why' },
      { ...request, end: 5 },
      { ...request, fields: ['title', 'title'] },
      { ...request, tenantId: 'model' },
    ])
      expect(() => parseRelevancePreview(raw)).toThrow();
  });
  it('only exact request-key and preview-hash receipt proves a pending suggestion, never bill assignment', () => {
    const r = parseRelevanceSave({
      ...request,
      previewHash: ready().previewHash,
      requestKey: 'stable-native-operation',
    });
    const result = {
      tool: 'save_legiwatch_relevance',
      result: {
        binding: hash([r.previewHash, r.requestKey]),
        suggestionId: selection.folderId,
        version: 1,
        origin: 'semantic',
        state: 'pending',
      },
    };
    expect(relevanceReceipt(result, r).outcome).toBe('suggested');
    expect(() =>
      relevanceReceipt(result, { ...r, requestKey: 'another-native-operation' }),
    ).toThrow();
    expect(() =>
      relevanceReceipt({ ...result, result: { ...result.result, state: 'assigned' } }, r),
    ).toThrow();
  });
});
