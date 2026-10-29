import { object, key, sequence, sha, uuid, invalid } from './input.js';
import { conflict, draftReceipt, draftTransaction, type DraftPorts, type DraftRow } from './store.js';

/** Records only the editor state. The runtime's existing immutable artifact owner and
 * intent journal still perform and reconcile publication. No new artifact ledger. */
export async function beginDraftPublish(ports: DraftPorts, raw: unknown) {
  const b = object(raw, ['conversationId', 'draftId', 'sequence', 'sha256']);
  const input = { ...key(b), sequence: sequence(b.sequence), sha256: sha(b.sha256) };
  return draftTransaction(ports, input, async (tx, row) => {
    const r = row!;
    if (!r.bytes || r.sequence !== input.sequence || r.sha256 !== input.sha256) conflict('OFFICE_DRAFT_STALE_SEQUENCE');
    const intent = `office:${r.draft_id}:${r.sequence}`;
    if (r.publish_intent === intent && ['publish-pending', 'publish-unknown', 'published'].includes(r.state))
      return { receipt: draftReceipt(r), dispatch: false };
    if (!['draft', 'publish-refused'].includes(r.state)) conflict('OFFICE_DRAFT_PUBLISH_BARRIER');
    const rows = await tx.$queryRaw<DraftRow[]>`UPDATE meri_office_drafts SET state='publish-pending',publish_intent=${intent}
      WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid
        AND draft_id=${r.draft_id}::uuid RETURNING *`;
    return { receipt: draftReceipt(rows[0]!), dispatch: true };
  });
}
export async function settleDraftPublish(ports: DraftPorts, raw: unknown) {
  const b = object(raw, ['conversationId', 'draftId', 'sequence', 'sha256', 'intent', 'outcome', 'versionId']);
  const input = { ...key(b), sequence: sequence(b.sequence), sha256: sha(b.sha256) };
  const states = { published: 'published', refused: 'publish-refused', conflict: 'conflict', unknown: 'publish-unknown' } as const;
  if (typeof b.outcome !== 'string' || !Object.hasOwn(states, b.outcome) ||
      b.intent !== `office:${input.draftId}:${input.sequence}`) return invalid();
  const state = states[b.outcome as keyof typeof states];
  const versionId = state === 'published' ? uuid(b.versionId) : b.versionId === null ? null : invalid();
  return draftTransaction(ports, input, async (tx, row) => {
    const r = row!;
    if (r.sequence !== input.sequence || r.sha256 !== input.sha256 || r.publish_intent !== b.intent)
      conflict('OFFICE_DRAFT_PUBLISH_IDENTITY');
    if (r.state === state && r.published_version_id === versionId) return draftReceipt(r);
    if (!['publish-pending', 'publish-unknown'].includes(r.state)) conflict('OFFICE_DRAFT_PUBLISH_BARRIER');
    // A transient failure remains unknown. Only the canonical publisher's definite receipt/refusal may settle it.
    const rows = await tx.$queryRaw<DraftRow[]>`UPDATE meri_office_drafts
      SET state=${state},published_version_id=${versionId}::uuid
      WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid
        AND draft_id=${r.draft_id}::uuid RETURNING *`;
    return draftReceipt(rows[0]!);
  });
}
