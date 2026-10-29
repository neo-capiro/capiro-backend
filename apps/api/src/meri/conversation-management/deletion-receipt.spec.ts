import { MANAGEMENT_VERSION, managementDigest } from './contract.js';
import { consumedDeletionMatches, deletionReference } from './deletion-receipt.js';
const requestId = '00000000-0000-4000-8000-000000000001';
const reference = { conversationId: '00000000-0000-4000-8000-000000000002', revision: '3', restoreUntil: '2026-11-29T00:00:00.000Z' };
const row = { requestId, conversationId: null, requestSha256: managementDigest({ version: MANAGEMENT_VERSION,
  requestId, conversationId: reference.conversationId, operation: 'trash', expectedRevision: '2' }),
  receipt: { tombstone: true, deletion: reference } };
test('only an exact command-bound content-free identity supports deletion readback', () => {
  expect(deletionReference(row)).toEqual(reference);
  expect(consumedDeletionMatches(row, reference)).toBe(true);
  for (const changed of [{ ...row, requestId: reference.conversationId }, { ...row, requestSha256: '0'.repeat(64) },
    { ...row, receipt: { ...row.receipt, title: 'Private metadata' } },
    { ...row, receipt: { tombstone: true, deletion: { ...reference, title: 'Private metadata' } } }]) {
    expect(deletionReference(changed)).toBeNull();
    expect(consumedDeletionMatches(changed, reference)).toBe(false);
  }
  expect(consumedDeletionMatches(row, { ...reference, revision: '4' })).toBe(false);
});
test('legacy content-free tombstones support trusted reconciliation but never invent request history', () => {
  const legacy = { ...row, receipt: { tombstone: true } };
  expect(deletionReference(legacy)).toBeNull();
  expect(consumedDeletionMatches(legacy, reference)).toBe(true);
  expect(consumedDeletionMatches({ ...legacy, receipt: { tombstone: true, payload: 'private' } }, reference)).toBe(false);
});
