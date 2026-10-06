import { inventoryObservedAt, qualifyLegislativeCorpus } from './legislative-corpus.js';
const inventory = {
  billId: 'FL-2026-SB7',
  providerChangeHash: 'provider-revision',
  sourceCheckedAt: '2026-09-13T00:00:00Z',
  sourceListComplete: true,
  expected: [{ kind: 'amendment', providerId: 7, providerHash: 'bytes-hash' }],
};
const document = {
  documentId: 'doc-7',
  billId: inventory.billId,
  kind: 'amendment',
  providerId: '7',
  providerHash: 'bytes-hash',
  revision: 'extraction-revision',
  parserVersion: 'extractor-v1',
  complete: true,
  isCurrent: true,
};

test('a validated current inventory check can qualify a legacy bill without a whole-bill check', () => {
  const sourceCheckedAt = inventoryObservedAt(
    { ...inventory, observedAt: '2026-10-06T16:00:00Z' },
    inventory.providerChangeHash,
    null,
  );
  expect(sourceCheckedAt).toBe('2026-10-06T16:00:00Z');
  expect(
    qualifyLegislativeCorpus([inventory.billId], [{ ...inventory, sourceCheckedAt }], [document])
      .complete,
  ).toBe(true);
});

test('stale, partial or invalid inventory timestamps cannot manufacture source qualification', () => {
  for (const patch of [
    { providerChangeHash: 'different' },
    { sourceListComplete: false },
    { observedAt: 'invalid' },
    { observedAt: null },
  ]) {
    const current = { ...inventory, observedAt: '2026-10-06T16:00:00Z', ...patch };
    expect(inventoryObservedAt(current, inventory.providerChangeHash, null)).toBeNull();
    expect(
      inventoryObservedAt(current, inventory.providerChangeHash, inventory.sourceCheckedAt),
    ).toBe(inventory.sourceCheckedAt);
  }
});
test('qualified selected corpus reconciles exact expected ID and source hash', () => {
  expect(qualifyLegislativeCorpus([inventory.billId], [inventory], [document])).toMatchObject({
    complete: true,
    sessionWideComplete: false,
  });
});
test('missing or truncated source list cannot pass by fetching everything currently visible', () => {
  expect(
    qualifyLegislativeCorpus(
      [inventory.billId],
      [{ ...inventory, sourceListComplete: false }],
      [document],
    ).complete,
  ).toBe(false);
  expect(qualifyLegislativeCorpus([inventory.billId], [], [document]).complete).toBe(false);
});
test.each([
  { ...document, providerHash: 'stale' },
  { ...document, complete: false },
  { ...document, isCurrent: false },
])('stale hash, incomplete extraction and superseded extraction hold negatives', (d) => {
  expect(qualifyLegislativeCorpus([inventory.billId], [inventory], [d]).complete).toBe(false);
});
