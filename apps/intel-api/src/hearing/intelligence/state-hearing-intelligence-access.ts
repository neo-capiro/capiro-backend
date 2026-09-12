import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { stateCaptureEnabled } from '../capture/public-capture-permission.js';

/** Analysis permission is independent of completed/active capture demand. */
export async function stateAnalysisTenants(
  prisma: PrismaService,
  hearingId: string,
  transaction?: Prisma.TransactionClient,
) {
  if (!stateCaptureEnabled()) return [];
  const read = (tx: Prisma.TransactionClient) => tx.$queryRaw<Array<{ tenantId: string }>>`
    SELECT p.tenant_id AS "tenantId" FROM intel_hearing_media_permission p
    JOIN committee_hearing h ON h.id=p.hearing_id AND h.url=p.source_url AND h.visibility='public'
    JOIN intel_feature_flag f ON f.tenant_id=p.tenant_id AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE h.id=${hearingId} AND p.mode='server' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
      AND p.operations @> ARRAY['transcription','analysis']::text[] FOR SHARE OF p,f`;
  const rows = transaction ? await read(transaction) : await prisma.withSystem(read);
  return [...new Set(rows.map((row) => row.tenantId))];
}
