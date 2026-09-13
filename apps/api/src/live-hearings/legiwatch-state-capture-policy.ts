import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireStateCalendar } from './legiwatch-calendar-access.js';
import {
  assessStrictSchedulePolicy,
  type StrictScheduleAssessment,
} from './live-hearings-phase7-schedule.guard.js';

export interface StateCaptureHearing {
  id: string;
  geographicJurisdiction?: string | null;
  eventStatus: string;
  visibility: string;
  url?: string | null;
}

/** Explicit state adapter. Legacy federal scheduling keeps its existing policy. */
export async function stateCapturePolicy(
  prisma: PrismaService,
  ctx: TenantContext,
  hearing: StateCaptureHearing,
): Promise<{ policy: StrictScheduleAssessment; browserAllowed: boolean } | undefined> {
  if (!hearing.geographicJurisdiction || hearing.geographicJurisdiction === 'US') return undefined;
  await requireStateCalendar(prisma, ctx.tenantId);
  const terminal = assessStrictSchedulePolicy(hearing, []);
  if (!terminal.allowed) return { policy: terminal, browserAllowed: false };
  const grants = await prisma.withSystem(
    (tx) => tx.$queryRaw<Array<{ mode: string }>>`
    SELECT DISTINCT p.mode FROM intel_hearing_media_permission p
    JOIN intel_feature_flag f ON f.tenant_id=p.tenant_id
      AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    JOIN tenant_memberships tm ON tm.tenant_id::text=p.tenant_id AND tm.status::text='active'
    JOIN users u ON u.id=tm.user_id AND u.id::text=${ctx.userId}
    WHERE p.tenant_id=${ctx.tenantId} AND p.hearing_id=${hearing.id}
      AND p.source_url=${hearing.url ?? ''} AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
      AND p.operations @> ARRAY['capture','transcription']::text[]
      AND (p.mode='browser' OR p.operations @> ARRAY['retention']::text[])
  `,
  );
  const browserAllowed = grants.some((grant) => grant.mode === 'browser');
  const serverAllowed =
    process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED === 'true' &&
    process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED === 'true' &&
    grants.some((grant) => grant.mode === 'server');
  if (serverAllowed)
    return {
      browserAllowed,
      policy: {
        allowed: true,
        state: 'PREFLIGHT_REQUIRED',
        reasonCode: 'STATE_SOURCE_PERMISSION_REVIEWED',
        message:
          'This event has reviewed capture permission. Its stream will be checked before unattended recording starts.',
      },
    };
  return {
    browserAllowed,
    policy: browserAllowed
      ? {
          allowed: false,
          state: 'BROWSER_ONLY',
          reasonCode: 'STATE_BROWSER_PERMISSION_REVIEWED',
          message:
            'Browser capture is permitted for this event. Keep the selected tab and device active.',
        }
      : {
          allowed: false,
          state: 'BLOCKED',
          reasonCode: 'STATE_CAPTURE_NOT_QUALIFIED',
          message:
            'Recording is unavailable for this event. Use Watch original while source permission and capture readiness are being qualified.',
        },
  };
}
