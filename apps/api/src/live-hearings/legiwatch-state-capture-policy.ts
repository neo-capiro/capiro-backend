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

/**
 * State calendars and official Watch/Replay links are readable, but this API
 * does not advertise or create browser/server capture for non-federal events.
 * Media rights must be enabled through a separately reviewed source-specific
 * release; a legacy grant or runtime flag cannot widen this boundary.
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
