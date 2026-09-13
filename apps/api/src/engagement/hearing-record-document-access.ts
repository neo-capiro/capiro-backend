import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Saved bytes retain the brief's owner, folder and observation access boundary.
 * Ordinary attachments continue through their existing parent and viewer ACLs. */
export async function assertHearingRecordDocumentAccess(
  prisma: PrismaService,
  ctx: TenantContext,
  attachment: {
    id: string;
    sourceEntityType: string | null;
    sourceEntityId: string | null;
    clientId: string | null;
  },
  purpose: 'read' | 'distribute' = 'read',
) {
  if (attachment.sourceEntityType !== 'hearing_record_brief') return;
  const deny = () => new ForbiddenException('RECORD_BRIEF_DOCUMENT_ACCESS_OR_VERSION_CHANGED');
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!ctx.clerkUserId || !secret) throw deny();
  const row = await prisma.withTenant(ctx.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.folder_actor',${ctx.clerkUserId},true)`;
    const rows = await tx.$queryRaw<
      Array<{
        eventId: string;
        briefId: string;
        clientId: string;
        contentHash: string;
        sourceHash: string;
      }>
    >`
      SELECT d.event_id AS "eventId",d.brief_id AS "briefId",d.client_id::text AS "clientId",d.content_hash AS "contentHash",d.source_hash AS "sourceHash"
      FROM legiwatch_record_document d JOIN users u ON u.id=${ctx.userId}::uuid AND u.clerk_user_id=d.owner_clerk_id
      JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=d.tenant_id AND m.status::text='active'
      WHERE d.attachment_id=${attachment.id}::uuid AND d.tenant_id=${ctx.tenantId}::uuid AND d.owner_clerk_id=${ctx.clerkUserId}`;
    return rows[0];
  });
  if (!row || row.clientId !== attachment.clientId || row.briefId !== attachment.sourceEntityId)
    throw deny();
  let result: Record<string, unknown>;
  try {
    const response = await fetch(
      (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '') +
        '/intel-api/internal/hearing-record-retrieval',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({
          tenantId: ctx.tenantId,
          actor: ctx.clerkUserId,
          eventId: row.eventId,
          view: 'document-access',
          id: row.briefId,
          clientId: row.clientId,
          contentHash: row.contentHash,
          purpose,
        }),
      },
    );
    if (!response.ok) throw deny();
    result = (await response.json()) as Record<string, unknown>;
  } catch {
    throw deny();
  }
  if (
    result.kind !== 'capiro_record_document_access' ||
    result.id !== row.briefId ||
    result.tenantId !== ctx.tenantId ||
    result.clientId !== row.clientId ||
    result.eventId !== row.eventId ||
    result.contentHash !== row.contentHash ||
    result.sourceHash !== row.sourceHash
  )
    throw deny();
}
