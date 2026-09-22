import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';

/** State capture is not released: official state video remains external link-only. */
export const stateCaptureEnabled = () => false;
export const publicAudioEnabled = () => process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED === 'true';

/** An explicit source grant plus current tenant demand; never capture-all. */
export async function approvedPublicCapture(
  prisma: PrismaService,
  hearingId: string,
  transaction?: Prisma.TransactionClient,
) {
  const read = async (tx: Prisma.TransactionClient) => {
    const federal = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM federal_committee_hearing
      WHERE id=${hearingId}
      LIMIT 1`;
    if (!federal.length) return [];
    return tx.$queryRaw<
      Array<{
        id: string;
        tenantId: string;
        sourceUrl: string;
        expiresAt: Date;
        retentionDays: number;
      }>
    >`
    SELECT DISTINCT p.id,p.tenant_id AS "tenantId",p.source_url AS "sourceUrl",p.expires_at AS "expiresAt",p.retention_days AS "retentionDays"
    FROM committee_hearing h JOIN intel_hearing_media_permission p ON p.hearing_id=h.id AND p.source_url=h.url
    JOIN hearing_subscription s ON s.hearing_id=h.id AND s.tenant_id::text=p.tenant_id AND s.attendance_mode='automatic'
      AND (s.scheduled_by_user OR s.scheduled_by_rule_id IS NOT NULL)
    JOIN users u ON (u.id::text=s.user_id OR u.clerk_user_id=s.user_id)
    JOIN tenant_memberships tm ON tm.tenant_id=s.tenant_id AND tm.user_id=u.id AND tm.status::text='active'
    JOIN intel_feature_flag f ON f.tenant_id=p.tenant_id AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE h.id=${hearingId} AND h.visibility='public' AND h.event_status NOT IN ('canceled','cancelled','completed')
      AND p.mode='server' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
      AND p.operations @> ARRAY['capture','transcription','retention']::text[]`;
  };
  return transaction ? read(transaction) : prisma.withSystem(read);
}
