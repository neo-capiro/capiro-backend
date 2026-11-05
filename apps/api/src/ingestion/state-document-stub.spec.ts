import { mergeDocumentStubs, stateDocumentStubs } from './state-document-stub.js';
test('retains primary byte metadata for text and all amendment/supplement versions', () => {
  const stubs = stateDocumentStubs({
    texts: [
      {
        doc_id: 1,
        type: 'Introduced',
        text_hash: 'primary',
        text_size: 10,
        mime: 'text/html',
        state_link: 'https://example.gov/1',
        alt_text_hash: 'alternate',
      },
    ],
    amendments: [
      {
        amendment_id: 2,
        amendment_hash: 'amendment',
        amendment_size: 20,
        mime: 'application/pdf',
        state_link: 'https://example.gov/2',
      },
    ],
    supplements: [
      { supplement_id: 3, supplement_hash: 'supplement', supplement_size: 30, mime: 'text/plain' },
    ],
  } as any);
  expect(stubs.map((s) => [s.kind, s.providerId, s.providerHash, s.size, s.mime])).toEqual([
    ['text', 1, 'primary', 10, 'text/html'],
    ['amendment', 2, 'amendment', 20, 'application/pdf'],
    ['supplement', 3, 'supplement', 30, 'text/plain'],
  ]);
});
test('withdrawn versions and changed bytes at the same URL remain separately addressable', () => {
  const first = {
    kind: 'text' as const,
    providerId: 1,
    providerHash: 'first',
    stateUrl: 'https://example.gov/latest',
  };
  const second = { ...first, providerHash: 'second' };
  expect(mergeDocumentStubs([first], [second])).toEqual([first, second]);
  expect(mergeDocumentStubs([first, second], [second])).toEqual([first, second]);
  expect(mergeDocumentStubs([first, second], [])).toEqual([first, second]);
});
