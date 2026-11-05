import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { requireProfileSubject } from '../profile-subject.js';
import { attachmentViewerWhere } from '../../engagement/attachments/attachment-viewer-access.js';

/** Derived excerpts stay subject to the existing attachment's current access and lifecycle. */
export async function portfolioEvidenceVisible(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  value: Prisma.JsonValue | unknown,
): Promise<boolean> {
  if (!Array.isArray(value)) return false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : {};
    const id = record.attachmentId ?? metadata.attachmentId;
    if (id !== undefined && (typeof id !== 'string' || !id.trim())) return false;
    if (typeof id === 'string') {
      const direct = await tx.engagementAttachment.findFirst({
        where: {
          id,
          tenantId: ctx.tenantId,
          clientId,
          prospectId: null,
          supersededByAttachmentId: null,
          viewerMode: 'all',
          lifecycleStatus: { in: ['ready', 'legacy_ready'] },
          OR: attachmentViewerWhere(ctx.userId),
        },
        select: { id: true },
      });
      if (direct) continue;
      // Conversion retains original ownership; authorize the explicitly linked source prospect, never invent a copied client attachment.
      const links = await tx.$queryRawUnsafe<Array<{ prospectId: string }>>(
        `SELECT l.prospect_id::text AS "prospectId"
        FROM profile_attachment_link l JOIN engagement_attachments a ON a.id=l.attachment_id AND a.tenant_id=l.tenant_id AND a.prospect_id=l.prospect_id
        WHERE l.tenant_id=$1::uuid AND l.client_id=$2::uuid AND l.attachment_id=$3::uuid
          AND a.client_id IS NULL AND a.viewer_mode='all' AND a.lifecycle_status IN ('ready','legacy_ready') AND a.superseded_by_attachment_id IS NULL
        FOR SHARE OF a,l`,
        ctx.tenantId,
        clientId,
        id,
      );
      if (links.length !== 1 || typeof links[0]?.prospectId !== 'string') return false;
      try {
        await requireProfileSubject(tx, ctx, { kind: 'prospect', id: links[0].prospectId });
      } catch {
        return false;
      }
    }
  }
  return true;
}

export async function visiblePortfolioHistory(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  value: Prisma.JsonValue,
): Promise<Prisma.JsonValue> {
  if (!Array.isArray(value)) return [];
  const result: Prisma.JsonValue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const sources = [entry.evidence, entry.previousEvidence, entry.termEvidence].filter(
      (v) => v !== undefined,
    );
    const visible = (
      await Promise.all(
        sources.map((evidence) => portfolioEvidenceVisible(tx, ctx, clientId, evidence)),
      )
    ).every(Boolean);
    if (visible) result.push(entry);
    else
      result.push({
        action: entry.action ?? null,
        actorUserId: entry.actorUserId ?? null,
        at: entry.at ?? null,
        stance: entry.stance ?? null,
        previousStance: entry.previousStance ?? null,
        sourceUnavailable: true,
      });
  }
  return result;
}

export async function visibleCapabilityProvenance(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
  value: Prisma.JsonValue,
): Promise<Prisma.JsonValue> {
  if (!Array.isArray(value)) return [];
  const result: Prisma.JsonValue[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    result.push(
      (await portfolioEvidenceVisible(tx, ctx, clientId, [entry]))
        ? entry
        : { origin: entry.origin ?? 'unknown', sourceUnavailable: true },
    );
  }
  return result;
}
