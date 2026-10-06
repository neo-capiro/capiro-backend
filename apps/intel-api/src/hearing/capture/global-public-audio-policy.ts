import { Prisma } from '../../../generated/prisma-client/index.js';
import { capturableHearingView } from '../state-capture-policy.js';

/** Operator opt-in for retaining the same approved public streams capture-all
 * already transcribes. It never grants browser, private or licensed media rights. */
export const globalPublicAudioEnabled = () =>
  process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED === 'true' &&
  process.env.HEARING_PUBLIC_AUDIO_CAPTURE_ALL_ENABLED === 'true';

export async function globalPublicAudioSource(
  tx: Prisma.TransactionClient,
  hearingId: string,
  input: { capturing?: boolean; sourceUrl?: string; tenantId?: string; clerkUserId?: string } = {},
) {
  if (!globalPublicAudioEnabled()) return null;
  if (Boolean(input.tenantId) !== Boolean(input.clerkUserId)) return null;
  const rows = await tx.$queryRaw<Array<{ sourceUrl: string }>>`
    SELECT h.url AS "sourceUrl" FROM ${Prisma.raw(capturableHearingView())} h
    JOIN public_hearing_capture c ON c.hearing_id=h.id
    JOIN legiwatch_cutover_state policy ON policy.id='global' AND policy.capture_all_public_events
    WHERE h.id=${hearingId} AND h.visibility='public' AND h.canonical_hearing_id IS NULL
      AND h.url IS NOT NULL AND c.resolution_capture_policy='SERVER_CAPTURE_ALLOWED'
      AND c.domain_status NOT IN ('BLOCKED','CANCELED')
      AND (${input.sourceUrl ?? null}::text IS NULL OR h.url=${input.sourceUrl ?? null})
      AND (NOT ${input.capturing ?? false}::boolean OR (
        h.event_status IN ('scheduled','postponed','in_progress')
        AND c.resolution_state='READY_FOR_SERVER_CAPTURE'
        AND EXISTS(SELECT 1 FROM legiwatch_runtime_heartbeat
          WHERE job_key='capture-worker' AND enabled AND schedule_enabled)))
      AND (${input.tenantId ?? null}::text IS NULL OR EXISTS(
        SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
        JOIN intel_feature_flag f ON f.tenant_id=tm.tenant_id::text
          AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
        WHERE tm.tenant_id::text=${input.tenantId ?? null} AND tm.status::text='active'
          AND u.clerk_user_id=${input.clerkUserId ?? null}))
    LIMIT 1`;
  return rows[0] ?? null;
}

export function globalPublicAudioRetentionDays(): number {
  const days = Number(process.env.HEARING_PUBLIC_AUDIO_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90)
    throw new Error('Public hearing retention must be between 1 and 90 days');
  return days;
}
