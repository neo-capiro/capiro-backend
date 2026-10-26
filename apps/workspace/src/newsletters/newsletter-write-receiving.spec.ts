import {
  parseNewsletterCampaign,
  parseNewsletterWriteReceipt,
  type NewsletterWriteReceipt,
} from '@capiro/shared/newsletter';

const requestId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const create = { operation: 'create' as const, requestId };
const save = { operation: 'save' as const, requestId, documentId, previousRevision: 3 };
const receipt: NewsletterWriteReceipt = {
  requestId,
  documentId,
  operation: 'save',
  previousRevision: 3,
  revision: 4,
  inputHash: 'a'.repeat(64),
  contentHash: 'b'.repeat(64),
  hashFormat: 'newsletter-write-jcs-v1',
  createdAt: '2026-10-26T00:00:00.000Z',
};
it('receives only exact create/save bindings and clones the content-free receipt', () => {
  const got = parseNewsletterWriteReceipt(receipt, save);
  expect(got).toEqual({ ok: true, value: receipt });
  if (got.ok) expect(got.value).not.toBe(receipt);
  expect(
    parseNewsletterWriteReceipt(
      { ...receipt, operation: 'create', previousRevision: null, revision: 1 },
      create,
    ).ok,
  ).toBe(true);
  expect(
    parseNewsletterWriteReceipt(receipt, { ...save, requestId: requestId.toUpperCase() }).ok,
  ).toBe(true);
  expect(parseNewsletterCampaign(receipt).ok).toBe(false);
});
it('refuses absent, unbound, partial, old campaign and inconsistent revision receipts', () => {
  for (const value of [
    null,
    {},
    { ...receipt, revision: 5 },
    { ...receipt, previousRevision: null },
    { ...receipt, operation: 'create' },
    { ...receipt, design: {} },
    { ...receipt, toString: 'extra' },
  ])
    expect(parseNewsletterWriteReceipt(value, save).ok).toBe(false);
  // @ts-expect-error No unbound overload can establish an exact saved write.
  expect(parseNewsletterWriteReceipt(receipt).ok).toBe(false);
  // @ts-expect-error Save binding includes its original document and revision.
  expect(parseNewsletterWriteReceipt(receipt, { requestId, operation: 'save' }).ok).toBe(false);
});
it('rejects a different retained request, operation, document, revision or digest', () => {
  for (const binding of [
    { ...save, requestId: documentId },
    { ...save, documentId: requestId },
    { ...save, previousRevision: 2 },
    { ...save, inputHash: 'c'.repeat(64) },
    { ...save, contentHash: 'c'.repeat(64) },
    create,
  ])
    expect(parseNewsletterWriteReceipt(receipt, binding)).toMatchObject({
      ok: false,
      error: { code: 'identity_mismatch' },
    });
});
it('requires every receipt field and strict hash/time/identity shapes', () => {
  for (const key of Object.keys(receipt)) {
    const missing = { ...receipt };
    delete missing[key as keyof NewsletterWriteReceipt];
    expect(parseNewsletterWriteReceipt(missing, save).ok).toBe(false);
  }
  for (const invalid of [
    { requestId: 'bad' },
    { documentId: 'bad' },
    { inputHash: 'A'.repeat(64) },
    { contentHash: 'g'.repeat(64) },
    { createdAt: '2026-10-26' },
    { hashFormat: 'unknown' },
    { previousRevision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(parseNewsletterWriteReceipt({ ...receipt, ...invalid }, save).ok).toBe(false);
});
it('refuses extra or malformed consumer expectations without executing accessors', () => {
  const getter = jest.fn();
  const hostile = Object.defineProperty({}, 'requestId', { get: getter, enumerable: true });
  expect(parseNewsletterWriteReceipt(receipt, hostile as never).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  for (const binding of [
    { ...save, extra: true },
    { ...save, inputHash: '' },
    { ...save, previousRevision: 0 },
    { ...create, documentId },
  ])
    expect(parseNewsletterWriteReceipt(receipt, binding as never).ok).toBe(false);
});
