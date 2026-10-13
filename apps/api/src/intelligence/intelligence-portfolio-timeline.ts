import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { dayBoundsInZone, dateBoundsInZone } from './time-bounds.js';

type TimelineEvent = {
  id: string;
  kind: 'hearing' | 'deadline' | 'change' | 'brief';
  label: string;
  title: string;
  detail: string | null;
  severity: 'info' | 'notable' | 'critical';
  time: string | null;
  timestamp: string;
  href: string | null;
};
type Hearing = Prisma.CommitteeHearingGetPayload<{}>;
type Deadline = Prisma.FederalRegisterDocumentGetPayload<{}>;
type Change = Prisma.IntelligenceChangeGetPayload<{}>;

export class IntelligencePortfolioTimeline {
  constructor(private readonly prisma: PrismaService) {}

  async getTodayTimeline(tenantId: string) {
    const now = new Date();

    // ET day bounds for timestamp columns; UTC-midnight bounds for @db.Date columns.
    const { start: startOfDay, end: endOfDay } = dayBoundsInZone(now, 'America/New_York');

    const dateBounds = dateBoundsInZone(now, 'America/New_York');

    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [hearings, deadlines, changes, clientIds] = await this.readTodaySnapshot(
      tenantId,
      dateBounds,
      last24h,
    );

    const tenantClientIds = new Set(clientIds.map((c) => c.id));

    const events: TimelineEvent[] = [];

    this.appendTimelineEvents(events, hearings, deadlines, changes, tenantClientIds, endOfDay);

    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const counts = { critical: 0, notable: 0, info: 0 };

    for (const e of events) counts[e.severity]++;

    return { events, counts, today: startOfDay.toISOString() };
  }

  async getLiveTicker(tenantId: string, limit: number) {
    const clientIds = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
    );
    const tenantClientIds = clientIds.map((c) => c.id);

    const tenantChanges = tenantClientIds.length
      ? await this.prisma.intelligenceChange.findMany({
          where: { relatedClientIds: { hasSome: tenantClientIds } },
          orderBy: { detectedAt: 'desc' },
          take: limit,
        })
      : [];

    let items = tenantChanges;
    if (items.length < limit) {
      const fill = await this.prisma.intelligenceChange.findMany({
        where: {
          id: { notIn: items.map((i) => i.id) },
          relatedClientIds: { isEmpty: true },
        },
        orderBy: { detectedAt: 'desc' },
        take: limit - items.length,
      });
      items = [...items, ...fill];
    }

    return items.map((c) => ({
      id: c.id,
      source: c.source,
      title: c.title,
      severity: c.severity,
      detectedAt: c.detectedAt.toISOString(),
    }));
  }

  private readTodaySnapshot(
    tenantId: string,
    dateBounds: ReturnType<typeof dateBoundsInZone>,
    last24h: Date,
  ) {
    return Promise.all([
      this.prisma.committeeHearing.findMany({
        where: federalHearingWhere({ date: { gte: dateBounds.start, lte: dateBounds.end } }),
        orderBy: { time: 'asc' },
        take: 30,
      }),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gte: dateBounds.start, lte: dateBounds.end },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 20,
      }),
      this.prisma.intelligenceChange.findMany({
        where: {
          detectedAt: { gte: last24h },
          severity: { in: ['critical', 'notable', 'info'] },
        },
        orderBy: { detectedAt: 'desc' },
        take: 30,
      }),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
      ),
    ]);
  }

  private appendTimelineEvents(
    events: TimelineEvent[],
    hearings: Hearing[],
    deadlines: Deadline[],
    changes: Change[],
    tenantClientIds: Set<string>,
    endOfDay: Date,
  ) {
    for (const h of hearings) {
      const isMarkup = h.type === 'markup';
      events.push({
        id: `hearing-${h.id}`,
        kind: 'hearing',
        label: isMarkup ? 'MARKUP' : 'HEARING',
        title: `${h.committeeName}, ${h.title}`,
        detail: h.location ?? h.witnesses.slice(0, 3).join(', ') ?? null,
        severity: isMarkup ? 'notable' : 'info',
        time: h.time ?? null,
        timestamp: h.date.toISOString(),
        href: h.url ?? null,
      });
    }

    for (const d of deadlines) {
      events.push({
        id: `deadline-${d.id}`,
        kind: 'deadline',
        label: 'COMMENT DEADLINE',
        title: d.title,
        detail: d.agencyNames.slice(0, 2).join(' / '),
        severity: 'critical',
        time: 'before EOD',
        timestamp: (d.commentEndDate ?? endOfDay).toISOString(),
        href: d.htmlUrl ?? null,
      });
    }

    for (const c of changes) {
      // Three states:
      //   neutral     = relatedClientIds empty → general market signal, include
      //   tenantTouch = at least one related client belongs to this tenant → include
      //   foreign     = relatedClientIds only references other tenants → EXCLUDE
      //                 (descriptions can include the matched client's name)
      const isNeutral = c.relatedClientIds.length === 0;
      const touchesTenant = !isNeutral && c.relatedClientIds.some((id) => tenantClientIds.has(id));
      if (!isNeutral && !touchesTenant) continue;
      events.push({
        id: `change-${c.id}`,
        kind: 'change',
        label: c.source.toUpperCase().slice(0, 16),
        title: c.title,
        detail: c.description ? c.description.slice(0, 160) : null,
        severity: (c.severity as TimelineEvent['severity']) ?? 'info',
        time: null,
        timestamp: c.detectedAt.toISOString(),
        href: null,
      });
    }
  }
}
