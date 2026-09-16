import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireStateCalendar } from './legiwatch-calendar-access.js';
import type { StrictScheduleAssessment } from './live-hearings-phase7-schedule.guard.js';

export interface StateCaptureHearing {
  id: string;
  geographicJurisdiction?: string | null;
  eventStatus: string;
  visibility: string;
  url?: string | null;
}

/**
 * First-party Florida chamber hosts. A public Florida proceeding is
 * browser-attendable when its official page is on one of these — the user opens
 * the official chamber/committee player themselves. This is the public
 * browser-safe policy, deliberately distinct from backend (server) ingestion
 * eligibility, which stays fail-closed behind a reviewed media permission.
 */
const FLORIDA_FIRST_PARTY_HOSTS = /(^|\.)(flsenate\.gov|flhouse\.gov)$/i;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Only a real http(s) page is a usable browser source; never an api:// or
    // other scheme.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * Explicit state adapter. Legacy federal scheduling keeps its existing policy.
 *
 * Two INDEPENDENT decisions are made here, per the user-authorized rule change:
 *
 *  - BROWSER availability for a PUBLIC Florida event no longer requires the
 *    legacy per-tenant `intel_hearing_media_permission` browser grant. A public
 *    state proceeding on an official chamber page is browser-attendable by any
 *    tenant; the user records with their own browser on a public page. Closed
 *    or private proceedings and canceled events are refused before this is
 *    considered. A COMPLETED public event keeps browser access when it has an
 *    official page — its published replay is watchable even though new
 *    automatic demand is closed.
 *
 *  - SERVER (unattended) capture is UNCHANGED and fail-closed: it still needs
 *    the runtime gates plus a reviewed `intel_hearing_media_permission` row
 *    (mode `server`, unexpired, unrevoked, operations ⊇ capture/transcription/
 *    retention) for this exact hearing + source and an active member of a
 *    tenant with `legiwatch_hearing_recording_v1` enabled. We never fabricate a
 *    server path or bypass a source's own security.
 */
export async function stateCapturePolicy(
  prisma: PrismaService,
  ctx: TenantContext,
  hearing: StateCaptureHearing,
): Promise<{ policy: StrictScheduleAssessment; browserAllowed: boolean } | undefined> {
  if (!hearing.geographicJurisdiction || hearing.geographicJurisdiction === 'US') return undefined;
  await requireStateCalendar(prisma, ctx.tenantId);

  // Public browser-safe policy, decided independently of automatic temporal
  // eligibility: closed/private and canceled events are never browser-offered;
  // a public event (including a completed one with a published replay) on an
  // official first-party Florida page is browser-attendable.
  const status = (hearing.eventStatus ?? '').toLowerCase();
  const host = hostOf(hearing.url);
  const publicBrowser =
    hearing.visibility === 'public' &&
    status !== 'canceled' &&
    status !== 'cancelled' &&
    host !== null &&
    FLORIDA_FIRST_PARTY_HOSTS.test(host);

  // Closed/private proceedings are terminal for every mode.
  if (hearing.visibility !== 'public') {
    return {
      browserAllowed: false,
      policy: {
        allowed: false,
        state: 'BLOCKED',
        reasonCode: 'NON_PUBLIC_PROCEEDING',
        message: 'This proceeding is not public and cannot be scheduled for public server capture.',
      },
    };
  }
  // Canceled events are terminal for every mode.
  if (status === 'canceled' || status === 'cancelled') {
    return {
      browserAllowed: false,
      policy: {
        allowed: false,
        state: 'BLOCKED',
        reasonCode: 'EVENT_CANCELED',
        message: 'This proceeding has been canceled.',
      },
    };
  }

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
  const browserAllowed = publicBrowser || grants.some((grant) => grant.mode === 'browser');

  // A completed event takes no new automatic demand, but its official replay
  // stays browser-watchable.
  if (status === 'completed') {
    return {
      browserAllowed,
      policy: {
        allowed: false,
        state: 'BLOCKED',
        reasonCode: 'EVENT_COMPLETED',
        message: 'This proceeding is already complete.',
      },
    };
  }

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
          reasonCode: publicBrowser
            ? 'STATE_PUBLIC_BROWSER_AVAILABLE'
            : 'STATE_BROWSER_PERMISSION_REVIEWED',
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
