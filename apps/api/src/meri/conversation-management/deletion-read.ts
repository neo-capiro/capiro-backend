import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { requireOwnerActor } from '../../clients/client-ordered-owner.access.js';
import { MANAGEMENT_VERSION } from './contract.js';
import { deletionReference } from './deletion-receipt.js';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function request(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid deletion read');
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== keys.sort().join() || r.version !== MANAGEMENT_VERSION)
    throw new BadRequestException('Invalid deletion read');
  return r;
}
const unavailable = () => new ServiceUnavailableException('Deletion receipt unavailable');
const select = { requestId: true, conversationId: true, requestSha256: true, receipt: true, createdAt: true } as const;
type DeletionRow = Prisma.ClioConversationManagementReceiptGetPayload<{ select: typeof select }>;

/** Actor-owned, content-free receipt history remains readable after client access
 * withdrawal. It grants neither conversation access nor a new deletion effect. */
export async function listConversationDeletions(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  const r = request(raw, ['version', 'before']);
  let before: { createdAt: Date; requestId: string } | null = null;
  if (r.before !== null) {
    const b = r.before as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join() !== 'createdAt,requestId' ||
      typeof b.requestId !== 'string' || !uuid.test(b.requestId) || typeof b.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(b.createdAt)) || new Date(b.createdAt).toISOString() !== b.createdAt)
      throw new BadRequestException('Invalid deletion cursor');
    before = { requestId: b.requestId, createdAt: new Date(b.createdAt) };
  }
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    await requireOwnerActor(tx, ctx, false, true);
    // JS Date retains milliseconds, while the receipt clock stores microseconds.
    // Order and seek at the same precision as the cursor so a page cannot skip
    // other receipts written within its last millisecond.
    const cursor = before ? Prisma.sql`AND
      (date_trunc('milliseconds',created_at AT TIME ZONE 'UTC'),request_id) <
      (${before.createdAt}::timestamptz AT TIME ZONE 'UTC',${before.requestId}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<DeletionRow[]>(Prisma.sql`
      SELECT request_id AS "requestId",conversation_id AS "conversationId",
        request_sha256 AS "requestSha256",receipt,created_at AS "createdAt"
      FROM clio_conversation_management_receipts
      WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
        AND (receipt#>>'{receipt,conversation,status}'='trashed'
          OR (receipt ? 'deletion' AND receipt->'deletion'<>'null'::jsonb)) ${cursor}
      ORDER BY date_trunc('milliseconds',created_at AT TIME ZONE 'UTC') DESC,request_id DESC LIMIT 21`);
    const requests = rows.slice(0, 20).map(row => {
      const reference = deletionReference(row); if (!reference) throw unavailable();
      return { requestId: row.requestId, createdAt: row.createdAt.toISOString(), ...reference };
    });
    const last = requests.at(-1);
    const legacy = await tx.$queryRaw<Array<{ unavailable: boolean }>>`SELECT EXISTS(
      SELECT 1 FROM clio_conversation_management_receipts
      WHERE tenant_id=${ctx.tenantId}::uuid AND actor_user_id=${ctx.userId}::uuid
        AND receipt='{"tombstone":true}'::jsonb) AS unavailable`;
    if (legacy.length !== 1 || typeof legacy[0]?.unavailable !== 'boolean') throw unavailable();
    return { version: MANAGEMENT_VERSION, requests,
      olderRequestsUnavailable: legacy[0].unavailable,
      nextBefore: rows.length > 20 && last ? { createdAt: last.createdAt, requestId: last.requestId } : null };
  });
}

/** Core reports only its exact receipt and current metadata disposition. Meri
 * must independently verify all of its purge owners before saying completed. */
export async function readConversationDeletion(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  const r = request(raw, ['version', 'requestId']);
  if (typeof r.requestId !== 'string' || !uuid.test(r.requestId)) throw new BadRequestException('Invalid deletion read');
  const requestId = r.requestId;
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async tx => {
    await requireOwnerActor(tx, ctx, false, true);
    const row = await tx.clioConversationManagementReceipt.findUnique({ where: {
      tenantId_actorUserId_requestId: { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId } }, select });
    if (!row) throw new NotFoundException('Deletion request not found');
    const reference = deletionReference(row); if (!reference) throw unavailable();
    const conversation = await tx.clioConversation.findFirst({ where: { tenantId: ctx.tenantId,
      userId: ctx.userId, id: reference.conversationId }, select: { status: true, metadataRevision: true, restoreUntil: true } });
    const metadataState = conversation === null ? 'absent' : conversation.status === 'trashed' &&
      conversation.metadataRevision.toString() === reference.revision &&
      conversation.restoreUntil?.toISOString() === reference.restoreUntil ? 'present' : 'superseded';
    if (row.conversationId !== null && conversation === null) throw unavailable();
    const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (clocks.length !== 1 || !(clocks[0]?.now instanceof Date)) throw unavailable();
    return { version: MANAGEMENT_VERSION, requestId, createdAt: row.createdAt.toISOString(), ...reference,
      metadataState, checkedAtMs: clocks[0]!.now.getTime() };
  });
}
