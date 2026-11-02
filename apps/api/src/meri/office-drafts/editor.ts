import { object, key, uuid, sequence, invalid, EDITOR_TTL_MS, DRAFT_TTL_MS } from './input.js';
import { conflict, draftTransaction, type DraftPorts, type DraftRow } from './store.js';

/** One current editor, owned by the same row/transaction as private Save. An
 * epoch never goes backwards and release never reopens an old acquire request. */
export async function admitOfficeEditor(ports: DraftPorts, raw: unknown) {
  if (!raw || typeof raw !== 'object') return invalid();
  const operation = (raw as Record<string, unknown>).operation;
  if (!['inspect', 'acquire', 'refresh', 'release', 'takeover'].includes(operation as string)) return invalid();
  const b = object(raw, ['conversationId', 'draftId', 'operation', ...(operation === 'inspect' ? [] : ['editorId', 'expectedEpoch'])]);
  const input = key(b), editorId = operation === 'inspect' ? null : uuid(b.editorId);
  const expected = operation === 'inspect' ? null : sequence(b.expectedEpoch);
  return draftTransaction(ports, input, async (tx, row, now) => {
    const r = row!, active = r.editor_id !== null && r.editor_expires_at !== null && r.editor_expires_at > now;
    const receipt = (value: DraftRow, live = true) => ({ editorId: live ? value.editor_id : null,
      epoch: value.editor_epoch, expiresAt: live ? value.editor_expires_at!.toISOString() : null });
    if (operation === 'inspect') return receipt(r, active);
    if (operation === 'release') {
      if (r.editor_epoch !== expected || r.editor_id !== null && r.editor_id !== editorId) conflict('OFFICE_EDITOR_STALE');
      if (r.editor_id !== null) await tx.$executeRaw`UPDATE meri_office_drafts SET editor_id=NULL,
        editor_expires_at=NULL,lock_token=NULL,lock_expires_at=NULL
        WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid AND draft_id=${input.draftId}::uuid`;
      return { editorId: null, epoch: r.editor_epoch, expiresAt: null };
    }
    if (!['draft', 'publish-refused'].includes(r.state)) conflict('OFFICE_DRAFT_PUBLISH_BARRIER');
    // Re-read the exact admitted instance after an acquire/takeover ACK was lost.
    // Its expiry is unchanged; replay is not an implicit refresh.
    if (['acquire', 'takeover'].includes(operation as string) && active && r.editor_id === editorId && r.editor_epoch === expected! + 1)
      return receipt(r);
    if (r.editor_epoch !== expected) conflict('OFFICE_EDITOR_STALE');
    if (operation === 'refresh') {
      if (!active || r.editor_id !== editorId) conflict('OFFICE_EDITOR_STALE');
    } else {
      if (operation === 'acquire' && active) conflict('OFFICE_EDITOR_BUSY');
      if (operation === 'takeover' && (!active || r.editor_id === editorId)) conflict('OFFICE_EDITOR_STALE');
      if (r.editor_epoch === 2147483647) conflict('OFFICE_EDITOR_EPOCH_LIMIT');
    }
    const epoch = operation === 'refresh' ? r.editor_epoch : r.editor_epoch + 1;
    const expires = new Date(now.getTime() + EDITOR_TTL_MS), draftExpires = new Date(now.getTime() + DRAFT_TTL_MS);
    const rows = await tx.$queryRaw<DraftRow[]>`UPDATE meri_office_drafts
      SET editor_id=${editorId}::uuid,editor_epoch=${epoch},editor_expires_at=${expires},expires_at=${draftExpires},
        lock_token=CASE WHEN ${operation === 'refresh'} THEN lock_token ELSE NULL END,
        lock_expires_at=CASE WHEN ${operation === 'refresh'} THEN lock_expires_at ELSE NULL END
      WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid AND draft_id=${input.draftId}::uuid
      RETURNING *`;
    return receipt(rows[0]!);
  });
}
