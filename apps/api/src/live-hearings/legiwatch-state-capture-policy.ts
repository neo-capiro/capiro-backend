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

export const STATE_CAPTURE_LINK_ONLY = 'STATE_CAPTURE_LINK_ONLY';

/** Same switch the intel capture worker reads; both sides must agree. */
export function stateCaptureEnabled(
  value = process.env.LEGIWATCH_STATE_SERVER_CAPTURE_ENABLED,
): boolean {
  return ['1', 'true', 'on', 'enabled', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Capture-eligible canonical hearings: federal only until state server capture
 * is enabled. Mirrors apps/intel-api's capturableHearingView() — every
 * capture-eligibility read on either side must select through this, not the
 * raw view name, so the two sides can never disagree about jurisdiction.
 */
export function capturableHearingView(): 'capturable_committee_hearing' | 'federal_committee_hearing' {
  return stateCaptureEnabled() ? 'capturable_committee_hearing' : 'federal_committee_hearing';
}

/**
 * State calendars and official Watch/Replay links are always readable. Capture
 * for non-federal events is a system-wide release switch: off, every state
 * proceeding is link-only; on, state hearings go through the normal capture
 * assessment like federal ones.
 */
export async function stateCapturePolicy(
  prisma: PrismaService,
  ctx: TenantContext,
  hearing: StateCaptureHearing,
): Promise<{ policy: StrictScheduleAssessment; browserAllowed: boolean } | undefined> {
  if (
    !hearing.geographicJurisdiction ||
    hearing.geographicJurisdiction.trim().toUpperCase() === 'US'
  )
    return undefined;
  if (stateCaptureEnabled()) return undefined;
  await requireStateCalendar(prisma, ctx.tenantId);
  return {
    browserAllowed: false,
    policy: {
      allowed: false,
      state: 'BLOCKED',
      reasonCode: STATE_CAPTURE_LINK_ONLY,
      message:
        'State proceedings are available as official external Watch/Replay links only. Capiro capture is not enabled for this source.',
    },
  };
}
