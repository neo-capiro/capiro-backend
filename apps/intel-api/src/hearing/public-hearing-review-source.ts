import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import type { HearingEvidence } from './publication-domain.js';
import { evidenceHash } from './publication-domain.js';
import { globalPublicAudioSource } from './capture/global-public-audio-policy.js';

export type PublicReviewCapture = {
  id: string;
  hearingId: string;
  sourceUrl: string;
  title: string;
  status: string;
  gaps: unknown;
};
/** Scope and permission checks precede every read of global public evidence. */
export async function publicReviewCapture(
  tx: Prisma.TransactionClient,
  ctx: WorkspaceTenantContext,
  hearingId: string,
  captureId?: string,
) {
  const captures = await tx.$queryRaw<
    PublicReviewCapture[]
  >`SELECT c.id::text,h.id AS "hearingId",h.url AS "sourceUrl",h.title,
    COALESCE(c.domain_status,c.status::text) AS status,c.gaps FROM public_hearing_capture c
    JOIN committee_hearing h ON h.id=c.hearing_id WHERE h.id=${hearingId} AND h.visibility='public'
      AND (${captureId ?? null}::text IS NULL OR c.id=${captureId ?? null}) FOR SHARE OF h`;
  const capture = captures[0];
  if (!capture) throw new NotFoundException('CANONICAL_PUBLIC_CAPTURE_REQUIRED');
  const global = await globalPublicAudioSource(tx, hearingId, {
    sourceUrl: capture.sourceUrl,
    tenantId: ctx.tenantId,
    clerkUserId: ctx.clerkUserId,
  });
  if (global) return capture;
  const grants = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT p.id FROM intel_hearing_media_permission p
    JOIN tenant_memberships tm ON tm.tenant_id::text=p.tenant_id AND tm.status::text='active'
    JOIN users u ON u.id=tm.user_id AND u.clerk_user_id=${ctx.clerkUserId}
    JOIN intel_feature_flag f ON f.tenant_id=p.tenant_id AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE p.tenant_id=${ctx.tenantId} AND p.hearing_id=${hearingId} AND p.source_url=${capture.sourceUrl}
      AND p.mode='server' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
      AND p.operations @> ARRAY['transcription','analysis']::text[] FOR SHARE OF p,tm,f`;
  if (!grants.length) throw new ForbiddenException('CANONICAL_REVIEW_SOURCE_PERMISSION_REQUIRED');
  return capture;
}
export async function publicReviewEvidence(
  tx: Prisma.TransactionClient,
  captureId: string,
  segmentIds?: string[],
) {
  const rows = await tx.$queryRaw<
    Array<Omit<HearingEvidence, 'hash'>>
  >`SELECT id::text AS "segmentId",text,start_ms AS "startMs",end_ms AS "endMs",speaker_label AS "speakerLabel"
    FROM public_hearing_transcript_segment WHERE capture_id=${captureId} AND is_final
      AND (${segmentIds ?? null}::text[] IS NULL OR id::text=ANY(${segmentIds ?? null}::text[]))
    ORDER BY start_ms DESC,id DESC LIMIT 500 FOR SHARE`;
  if (segmentIds && rows.length !== segmentIds.length)
    throw new ForbiddenException('FINAL_TRANSCRIPT_EVIDENCE_REQUIRED');
  return rows
    .sort((a, b) => a.startMs - b.startMs)
    .map((row) => ({ ...row, hash: evidenceHash(row) }));
}
