import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { addDateInZone } from './time-bounds.js';
import { ownMeetingWhere } from '../engagement/engagement-access.helpers.js';

type ComingUpItem = {
  id: string;
  kind: 'hearing' | 'markup' | 'deadline' | 'meeting';
  label: string;
  title: string;
  detail: string | null;
  severity: 'info' | 'notable' | 'critical';
  date: string;
  time: string | null;
  href: string | null;
};
type Hearing = Prisma.CommitteeHearingGetPayload<{}>;
type Deadline = Prisma.FederalRegisterDocumentGetPayload<{}>;
type CalendarMeeting = Prisma.MeetingGetPayload<{
  select: {
    id: true;
    subject: true;
    startsAt: true;
    location: true;
    organizerName: true;
    organizerEmail: true;
  };
}>;

export class IntelligencePortfolioComingUp {
  constructor(private readonly prisma: PrismaService) {}

  async getComingUp(tenantId: string, userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Current user is required');
    }

    const now = new Date();

    // Both `hearing.date` and `comment_end_date` come back at UTC midnight;
    // bounds must also be UTC midnight to include rows on the boundary day.
    const tomorrowStart = addDateInZone(now, 1, 'America/New_York');

    const sevenDaysOut = new Date(tomorrowStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [hearings, deadlines, meetings, clientIds] = await this.readComingUpSnapshot(
      tenantId,
      userId,
      tomorrowStart,
      sevenDaysOut,
    );

    // tenantClientIds reserved for future relevance ranking
    void clientIds;

    const items: ComingUpItem[] = [];

    this.appendCalendarItems(items, hearings, deadlines, sevenDaysOut);

    this.appendMeetingItems(items, meetings);

    items.sort((a, b) => a.date.localeCompare(b.date));

    // Meetings are always the user's own calendar, they should be visible
    // on the home dashboard even if there are higher-severity hearings or
    // deadlines competing for slots. Strategy:
    //   1. Include up to 4 meetings, soonest first.
    //   2. Fill remaining slots (up to 6 total) with the highest-severity
    //      non-meeting items, soonest first within the same severity.
    //   3. Sort the final list by date so the dashboard reads chronologically.
    const meetingItems = items
      .filter((i) => i.kind === 'meeting')
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 4);

    const SEVERITY_RANK: Record<ComingUpItem['severity'], number> = {
      critical: 3,
      notable: 2,
      info: 1,
    };

    const nonMeetingPicks = items
      .filter((i) => i.kind !== 'meeting')
      .sort((a, b) => {
        const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (sev !== 0) return sev;
        return a.date.localeCompare(b.date);
      })
      .slice(0, Math.max(0, 6 - meetingItems.length));

    const top = [...meetingItems, ...nonMeetingPicks].sort((a, b) => a.date.localeCompare(b.date));

    return { items: top, totalThisWeek: items.length };
  }

  private readComingUpSnapshot(
    tenantId: string,
    userId: string,
    tomorrowStart: Date,
    sevenDaysOut: Date,
  ) {
    return Promise.all([
      this.prisma.committeeHearing.findMany({
        where: federalHearingWhere({ date: { gte: tomorrowStart, lte: sevenDaysOut } }),
        orderBy: { date: 'asc' },
        take: 30,
      }),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gte: tomorrowStart, lte: sevenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 20,
      }),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.findMany({
          where: {
            ...ownMeetingWhere(userId),
            startsAt: { gte: tomorrowStart, lte: sevenDaysOut },
            status: { notIn: ['cancelled', 'canceled', 'deleted'] },
          },
          orderBy: { startsAt: 'asc' },
          take: 30,
          select: {
            id: true,
            subject: true,
            startsAt: true,
            location: true,
            organizerName: true,
            organizerEmail: true,
          },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
      ),
    ]);
  }

  private appendCalendarItems(
    items: ComingUpItem[],
    hearings: Hearing[],
    deadlines: Deadline[],
    sevenDaysOut: Date,
  ) {
    for (const h of hearings) {
      const isMarkup = h.type === 'markup';
      items.push({
        id: `hearing-${h.id}`,
        kind: isMarkup ? 'markup' : 'hearing',
        label: isMarkup ? 'MARKUP' : 'HEARING',
        title: `${h.committeeName}, ${h.title}`,
        detail: h.location ?? null,
        severity: isMarkup ? 'critical' : 'notable',
        date: h.date.toISOString(),
        time: h.time ?? null,
        href: h.url ?? null,
      });
    }

    for (const d of deadlines) {
      items.push({
        id: `deadline-${d.id}`,
        kind: 'deadline',
        label: 'DEADLINE',
        title: d.title,
        detail: d.agencyNames.slice(0, 2).join(' / '),
        severity: 'notable',
        date: (d.commentEndDate ?? sevenDaysOut).toISOString(),
        time: 'before EOD',
        href: d.htmlUrl ?? null,
      });
    }
  }

  private appendMeetingItems(items: ComingUpItem[], meetings: CalendarMeeting[]) {
    for (const m of meetings) {
      const startsAt = m.startsAt;
      // ET time string for the card. Falls back to null if formatting fails
      // (e.g. exotic timezone string the DB returned unexpectedly).
      let timeLabel: string | null = null;
      try {
        timeLabel = startsAt.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/New_York',
        });
      } catch {
        timeLabel = null;
      }
      const organizer = m.organizerName ?? m.organizerEmail ?? null;
      items.push({
        id: `meeting-${m.id}`,
        kind: 'meeting',
        label: 'MEETING',
        title: m.subject,
        detail:
          [m.location, organizer ? `Organizer: ${organizer}` : null]
            .filter((v): v is string => Boolean(v))
            .join(' · ') || null,
        severity: 'info',
        date: startsAt.toISOString(),
        time: timeLabel,
        href: `/engagement/meetings/${m.id}`,
      });
    }
  }
}
