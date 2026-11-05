import { ownMeetingWhere, ownMailThreadWhere } from '../engagement/engagement-access.helpers.js';
import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { requireProfileSubject, type ProfileSubject } from './profile-subject.js';

/** Shared profile facts cannot publish content from a restricted document. */
export async function assertSharedProfileEvidence(
  tx: Prisma.TransactionClient,
  tenantId: string,
  subject: ProfileSubject,
  evidence: unknown[],
  ctx?: import('@capiro/shared').TenantContext,
) {
  if (ctx)
    for (const entry of evidence) {
      const metadata = asRecord(asRecord(entry).metadata);
      const id = asString(metadata.entityId);
      if (!id) continue;
      if (metadata.entityType === 'meeting') {
        if (
          !(await tx.meeting.findFirst({
            where: { id, tenantId, ...ownMeetingWhere(ctx.userId) },
            select: { id: true },
          }))
        )
          throw new NotFoundException('Relationship source is no longer available');
      } else if (metadata.entityType === 'mail_thread') {
        if (
          !(await tx.mailThread.findFirst({
            where: { id, tenantId, ...ownMailThreadWhere(ctx.userId) },
            select: { id: true },
          }))
        )
          throw new NotFoundException('Relationship source is no longer available');
      }
    }
  const ids = [
    ...new Set(
      evidence.flatMap((value) => {
        const row = asRecord(value);
        const id = asString(row.attachmentId) ?? asString(asRecord(row.metadata).attachmentId);
        return id ? [id] : [];
      }),
    ),
  ];
  for (const id of ids) {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; prospectId: string | null }>>(
      `SELECT a.id,a.prospect_id AS "prospectId" FROM engagement_attachments a WHERE a.id=$1::uuid AND a.tenant_id=$2::uuid AND a.viewer_mode='all' AND a.superseded_by_attachment_id IS NULL AND a.lifecycle_status IN ('ready','legacy_ready') AND ${subject.kind === 'prospect' ? 'a.prospect_id=$3::uuid' : '((a.client_id=$3::uuid AND a.prospect_id IS NULL) OR EXISTS(SELECT 1 FROM profile_attachment_link l WHERE l.tenant_id=a.tenant_id AND l.attachment_id=a.id AND l.client_id=$3::uuid))'} FOR SHARE OF a`,
      id,
      tenantId,
      subject.id,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Shared profile source document is no longer available');
    if (ctx && row.prospectId && subject.kind === 'client')
      await requireProfileSubject(tx, ctx, { kind: 'prospect', id: row.prospectId });
  }
}

/** Current source visibility also applies to saved pending proposals and excerpts. */
export async function visibleProfileFindings<T extends { evidence: unknown }>(
  tx: Prisma.TransactionClient,
  ctx: import('@capiro/shared').TenantContext,
  subject: ProfileSubject,
  rows: T[],
): Promise<T[]> {
  const visible: T[] = [];
  for (const row of rows) {
    try {
      await assertSharedProfileEvidence(
        tx,
        ctx.tenantId,
        subject,
        Array.isArray(row.evidence) ? row.evidence : [],
        ctx,
      );
      visible.push(row);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
  }
  return visible;
}
