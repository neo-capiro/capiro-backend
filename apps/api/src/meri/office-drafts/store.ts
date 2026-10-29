import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { authorizeDraft, type OfficeAuthority } from './authority.js';
import { digest, DRAFT_TTL_MS, LOCK_TTL_MS, parseKey, parseEditorRead, parseLock, parseOpen, parseSave,
  type DraftKey, type DraftSource, type EditorProof } from './input.js';

export type DraftRow = { tenant_id: string; actor_user_id: string; conversation_id: string;
  draft_id: string; artifact_id: string; base_version_id: string; base_sha256: string;
  format: DraftSource['format']; filename: string; sequence: number; bytes: Buffer | null; sha256: string | null;
  state: 'draft' | 'publish-pending' | 'publish-unknown' | 'publish-refused' | 'conflict' | 'published' | 'discarded';
  publish_intent: string | null; published_version_id: string | null;
  lock_token: string | null; lock_expires_at: Date | null; expires_at: Date; updated_at: Date;
  editor_id: string | null; editor_epoch: number; editor_expires_at: Date | null };
export type DraftPorts = { prisma: PrismaService; ctx: TenantContext; authority: OfficeAuthority };
export const draftReceipt = (r: DraftRow) => ({ draftId: r.draft_id, conversationId: r.conversation_id,
  artifactId: r.artifact_id, baseVersionId: r.base_version_id, baseSha256: r.base_sha256,
  format: r.format, filename: r.filename, sequence: r.sequence, sha256: r.sha256,
  byteLength: r.bytes?.length ?? 0, state: r.state, publishIntent: r.publish_intent,
  publishedVersionId: r.published_version_id, savedAt: r.updated_at.toISOString(), expiresAt: r.expires_at.toISOString() });
export const currentLock = (r: DraftRow, now: Date) =>
  r.lock_expires_at && r.lock_expires_at > now ? r.lock_token! : '';
export const conflict = (code: string): never => { throw new ConflictException(code); };

export async function draftTransaction<T>(ports: DraftPorts, key: DraftKey,
  fn: (tx: Prisma.TransactionClient, row: DraftRow | null, now: Date) => Promise<T>, allowMissing = false, allowDiscarded = false, editor: EditorProof | null = null) {
  const { prisma, ctx, authority } = ports;
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    await authorizeDraft(tx, ctx, key.conversationId, authority);
    // Serialize missing-row creation as well as existing-row changes. Actor is part of private identity.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(
      ${ctx.tenantId + ':office:' + ctx.userId + ':' + key.draftId},0))`;
    const rows = await tx.$queryRaw<DraftRow[]>`SELECT * FROM meri_office_drafts
      WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
        AND draft_id=${key.draftId}::uuid FOR UPDATE`;
    // Recheck native session expiry after waiting for the draft lock.
    const now = await authorizeDraft(tx, ctx, key.conversationId, authority), row = rows[0] ?? null;
    if (row && row.conversation_id !== key.conversationId) throw new NotFoundException('OFFICE_DRAFT_UNAVAILABLE');
    if (!row && !allowMissing) throw new NotFoundException('OFFICE_DRAFT_UNAVAILABLE');
    if (row && row.expires_at <= now) throw new GoneException('OFFICE_DRAFT_EXPIRED');
    if (row?.state === 'discarded' && !allowDiscarded) throw new GoneException('OFFICE_DRAFT_CLOSED');
    if (editor && (!row || row.editor_id !== editor.editorId || row.editor_epoch !== editor.editorEpoch ||
        !row.editor_expires_at || row.editor_expires_at <= now)) conflict('OFFICE_EDITOR_STALE');
    if (row?.bytes && (row.bytes.length === 0 || digest(Buffer.from(row.bytes)) !== row.sha256))
      throw new ConflictException('OFFICE_DRAFT_INTEGRITY');
    return fn(tx, row, now);
  });
}

export async function openDraft(ports: DraftPorts, raw: unknown) {
  const input = parseOpen(raw), { ctx } = ports;
  return draftTransaction(ports, input, async (tx, prior, now) => {
    if (prior) {
      if (prior.artifact_id !== input.artifactId || prior.base_version_id !== input.baseVersionId ||
          prior.base_sha256 !== input.baseSha256 || prior.format !== input.format || prior.filename !== input.filename)
        conflict('OFFICE_DRAFT_ID_CONFLICT');
      return draftReceipt(prior);
    }
    const expires = new Date(now.getTime() + DRAFT_TTL_MS);
    const rows = await tx.$queryRaw<DraftRow[]>`INSERT INTO meri_office_drafts
      (tenant_id,actor_user_id,conversation_id,draft_id,artifact_id,base_version_id,base_sha256,format,filename,expires_at,updated_at)
      VALUES (${ctx.tenantId}::uuid,${ctx.userId}::uuid,${input.conversationId}::uuid,${input.draftId}::uuid,
        ${input.artifactId}::uuid,${input.baseVersionId}::uuid,${input.baseSha256},${input.format},${input.filename},${expires},${now})
      RETURNING *`;
    return draftReceipt(rows[0]!);
  }, true);
}
export async function readDraft(ports: DraftPorts, raw: unknown) {
  return draftTransaction(ports, parseKey(raw), async (_tx, row) => ({ ...draftReceipt(row!),
    bytesBase64: row!.bytes === null ? null : Buffer.from(row!.bytes).toString('base64') }));
}
export async function readEditorDraft(ports: DraftPorts, raw: unknown) {
  const input = parseEditorRead(raw);
  return draftTransaction(ports, input, async (_tx, row) => ({ ...draftReceipt(row!),
    bytesBase64: row!.bytes === null ? null : Buffer.from(row!.bytes).toString('base64') }), false, false, input);
}
export async function lockDraft(ports: DraftPorts, raw: unknown) {
  const input = parseLock(raw);
  return draftTransaction(ports, input, async (tx, row, now) => {
    const r = row!, current = currentLock(r, now), mismatch = () => ({ status: 409, lock: current });
    if (input.operation === 'get') return { status: 200, lock: current };
    if (!['draft', 'publish-refused'].includes(r.state)) return mismatch();
    if (input.operation === 'lock' ? current !== '' && current !== input.lock :
      current === '' || current !== (input.operation === 'relock' ? input.oldLock : input.lock)) return mismatch();
    const token = input.operation === 'unlock' ? null : input.lock!;
    const lockExpiry = token === null ? null : new Date(now.getTime() + LOCK_TTL_MS);
    await tx.$executeRaw`UPDATE meri_office_drafts SET lock_token=${token},lock_expires_at=${lockExpiry},
      expires_at=${new Date(now.getTime() + DRAFT_TTL_MS)}
      WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid AND draft_id=${input.draftId}::uuid`;
    return { status: 200 };
  }, false, false, input);
}
export async function saveDraft(ports: DraftPorts, raw: unknown) {
  const input = parseSave(raw);
  return draftTransaction(ports, input, async (tx, row, now) => {
    const r = row!, lock = currentLock(r, now);
    if (!lock || lock !== input.lock) return { status: 409, lock };
    if (!['draft', 'publish-refused'].includes(r.state)) conflict('OFFICE_DRAFT_PUBLISH_BARRIER');
    const same = r.sha256 === input.sha256;
    if (r.sequence !== input.expectedSequence && !(same && r.sequence === input.expectedSequence + 1))
      conflict('OFFICE_DRAFT_STALE_SEQUENCE');
    if (!same && r.sequence === 2147483647) conflict('OFFICE_DRAFT_SEQUENCE_LIMIT');
    // Identical bytes are a readback of the same durable save, never another revision or publish.
    if (same) return { status: 200, receipt: draftReceipt(r) };
    const rows = await tx.$queryRaw<DraftRow[]>`UPDATE meri_office_drafts
      SET bytes=${input.bytes},sha256=${input.sha256},sequence=sequence+1,state='draft',publish_intent=NULL,
        updated_at=${now},expires_at=${new Date(now.getTime() + DRAFT_TTL_MS)}
      WHERE tenant_id=${ports.ctx.tenantId}::uuid AND actor_user_id=${ports.ctx.userId}::uuid
        AND draft_id=${input.draftId}::uuid RETURNING *`;
    return { status: 200, receipt: draftReceipt(rows[0]!) };
  }, false, false, input);
}
export async function discardDraft(ports: DraftPorts, raw: unknown) {
  return draftTransaction(ports, parseKey(raw), async (tx, row, now) => {
    if (['publish-pending', 'publish-unknown'].includes(row!.state)) conflict('OFFICE_DRAFT_PUBLISH_BARRIER');
    // Keep the closed identity without draft bytes so an unexpired WOPI token
    // cannot regain access by reopening the same draft ID. Bytes are removed now.
    await tx.$executeRaw`UPDATE meri_office_drafts SET state='discarded',bytes=NULL,sha256=NULL,
      lock_token=NULL,lock_expires_at=NULL,editor_id=NULL,editor_expires_at=NULL,publish_intent=NULL,published_version_id=NULL,
      expires_at=GREATEST(expires_at,${new Date(now.getTime() + LOCK_TTL_MS)})
      WHERE tenant_id=${ports.ctx.tenantId}::uuid
      AND actor_user_id=${ports.ctx.userId}::uuid AND draft_id=${row!.draft_id}::uuid`;
    return { discarded: true };
  }, false, true);
}
