import { MANAGEMENT_VERSION, managementDigest } from './contract.js';

export type DeletionReference = { conversationId: string; revision: string; restoreUntil: string };
type Receipt = { requestId: string; conversationId: string | null; requestSha256: string; receipt: unknown };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The original command digest binds this content-free identity. A historical
 * tombstone without an identity cannot be guessed back into a deletion request. */
export function deletionReference(row: Receipt): DeletionReference | null {
  const saved = record(row.receipt);
  if (!saved) return null;
  let value: Record<string, unknown> | null;
  if (saved.tombstone === true) {
    if (Object.keys(saved).sort().join() !== 'deletion,tombstone' || row.conversationId !== null) return null;
    value = record(saved.deletion);
    if (!value || Object.keys(value).sort().join() !== 'conversationId,restoreUntil,revision') return null;
  } else {
    const receipt = record(saved.receipt), conversation = record(receipt?.conversation);
    if (receipt?.version !== MANAGEMENT_VERSION || receipt.requestId !== row.requestId ||
      conversation?.status !== 'trashed' || saved.releaseRetention !== false ||
      conversation.conversationId !== row.conversationId) return null;
    value = conversation;
  }
  const { conversationId, revision, restoreUntil } = value;
  if (typeof conversationId !== 'string' || !uuid.test(conversationId) ||
    typeof revision !== 'string' || !/^[1-9][0-9]{0,17}$/.test(revision) ||
    typeof restoreUntil !== 'string' || !Number.isFinite(Date.parse(restoreUntil)) ||
    new Date(restoreUntil).toISOString() !== restoreUntil) return null;
  if (row.requestSha256 !== managementDigest({ version: MANAGEMENT_VERSION, operation: 'trash',
    requestId: row.requestId, conversationId, expectedRevision: (BigInt(revision) - 1n).toString() })) return null;
  return { conversationId, revision, restoreUntil };
}

/** Legacy content-free receipts still support exact trusted purge reconciliation;
 * they do not supply enough information for the new user-facing request list. */
export function consumedDeletionMatches(row: Receipt, expected: DeletionReference) {
  const saved = record(row.receipt);
  if (row.conversationId !== null || !saved || saved.tombstone !== true) return false;
  if (Object.keys(saved).join() === 'tombstone') return true;
  const reference = deletionReference(row);
  return reference !== null && reference.conversationId === expected.conversationId &&
    reference.revision === expected.revision && reference.restoreUntil === expected.restoreUntil;
}
