/**
 * Master Calendar reads for LegiWatch Live Hearings (Phase 3, plan §4 + §12).
 *
 * Every response is GLOBAL canonical hearing data plus a TENANT overlay:
 *
 *     committee_hearing (+ stream candidates, + capture, + change feed)   GLOBAL
 *   + hearing_subscription for THIS tenant's THIS user                   TENANT
 *
 * The two are read separately and joined in memory, deliberately. `committee_hearing`
 * and friends are tenant-free public-record tables, so they are read bare (which
 * the tenant-scope guard permits for GLOBAL tables). `hearing_subscription` is
 * tenant-scoped, and the runtime DB role BYPASSES Postgres RLS — so isolation
 * there comes from routing through `PrismaService.withTenant`, which injects
 * `where.tenantId` in-query. A bare `prisma.hearingSubscription` read here would
 * return every tenant's subscriptions; that is the 2026-07-16 leak class, and
 * `tenant-scope-guard.spec.ts` fails the build on it.
 *
 * The overlay is additionally scoped to the CALLING USER, because
 * hearing_subscription is `@@unique([tenantId, userId, hearingId])` — one user's
 * "I scheduled this" must not appear as another colleague's.
 */
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/** One canonical hearing as the master calendar renders it. */
export interface CalendarEvent {
  id: string;
  congress: number | null;
  chamber: string;
  committeeName: string;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  title: string;
  eventType: string | null;
  eventStatus: string;
  visibility: string;
  /** Eastern calendar day (display). */
  date: string;
  /** The authoritative instant; null for a date-only record. */
  startsAt: string | null;
  time: string | null;
  timezone: string;
  location: string | null;
  officialPageUrl: string | null;
  witnesses: string[];
  streamAvailability: string;
  coverageStatus: string;
  sourceRevision: number;
  lastOfficialUpdateAt: string | null;
  /** Global capture state, when a capture record exists. */
  capture: {
    status: string;
    scheduledStart: string | null;
    actualStart: string | null;
    actualEnd: string | null;
    capturedSeconds: number;
    transcriptGapSeconds: number;
    reconnectCount: number;
    failureCode: string | null;
  } | null;
  /** Advertised stream candidates, best priority first. */
  streamCandidates: Array<{
    provider: string;
    officialPageUrl: string;
    hasMediaUrl: boolean;
    mediaType: string | null;
    resolutionState: string;
    capturePolicy: string;
    priority: number;
    failureReason: string | null;
  }>;
  /** THIS user's subscription, or null. Never another tenant's. */
  subscription: {
    notifyOnStart: boolean;
    notifyOnMention: boolean;
    scheduledByUser: boolean;
    scheduledByRuleId: string | null;
    clientIds: string[];
    watchlistId: string | null;
  } | null;
}

export interface CalendarQuery {
  from?: string;
  to?: string;
  chamber?: string;
  committee?: string;
  subcommittee?: string;
  eventType?: string;
  eventStatus?: string;
  streamState?: string;
  captureState?: string;
  /** 'scheduled' = only this user's subscriptions; 'unscheduled' = only others. */
  followState?: 'scheduled' | 'unscheduled';
  q?: string;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 200;

/**
 * A hearing counts as LIVE from its start until this long after, when nothing
 * has told us it ended. Congressional hearings routinely run 3-4 hours; a
 * shorter window would drop a still-running hearing off the Live view, and an
 * unbounded one would leave yesterday's on it forever.
 */
export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class LiveHearingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Master calendar: a filtered page of canonical events with the tenant overlay. */
  async calendar(
    ctx: TenantContext,
    query: CalendarQuery,
  ): Promise<{ rows: CalendarEvent[]; total: number; page: number; pageSize: number }> {
    const pageSize = clampPageSize(query.pageSize);
    const page = Math.max(1, query.page ?? 1);
    const where = buildWhere(query);

    // The follow-state filter has to be applied against THIS user's
    // subscriptions, so the id set is resolved first and used as a predicate
    // rather than filtered after paging (which would return short pages).
    if (query.followState) {
      const subscribedIds = await this.subscribedHearingIds(ctx);
      if (query.followState === 'scheduled') {
        if (subscribedIds.length === 0) {
          return { rows: [], total: 0, page, pageSize };
        }
        where.id = { in: subscribedIds };
      } else if (subscribedIds.length > 0) {
        where.id = { notIn: subscribedIds };
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.committeeHearing.findMany({
        where,
        orderBy: [{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      this.prisma.committeeHearing.count({ where }),
    ]);

    const hydrated = await this.hydrate(ctx, rows);
    return { rows: hydrated, total, page, pageSize };
  }

  /**
   * The Live view: hearings currently in progress, or whose start is inside the
   * live window with no end recorded. Ordered by start so the most recently
   * gavelled-in hearing leads.
   */
  async live(ctx: TenantContext): Promise<{ rows: CalendarEvent[]; asOf: string }> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - LIVE_WINDOW_MS);
    const rows = await this.prisma.committeeHearing.findMany({
      where: {
        OR: [
          { eventStatus: 'in_progress' },
          {
            eventStatus: { in: ['scheduled', 'in_progress'] },
            startsAt: { gte: windowStart, lte: now },
            actualEnd: null,
          },
        ],
        // A closed session is never surfaced as a live public hearing.
        visibility: 'public',
      },
      orderBy: [{ startsAt: 'desc' }],
      take: 100,
    });
    return { rows: await this.hydrate(ctx, rows), asOf: now.toISOString() };
  }

  /** One canonical event with the tenant overlay, or null when unknown. */
  async event(ctx: TenantContext, id: string): Promise<CalendarEvent | null> {
    const row = await this.prisma.committeeHearing.findUnique({ where: { id } });
    if (!row) return null;
    const [hydrated] = await this.hydrate(ctx, [row]);
    return hydrated ?? null;
  }

  /**
   * The change feed for one event — what the Committee Room shows. GLOBAL data
   * (a committee's published change is public record), so no tenant filter
   * applies; the tenant boundary in this module is the subscription overlay.
   */
  async updates(
    _ctx: TenantContext,
    id: string,
    limit = 100,
  ): Promise<
    Array<{
      id: string;
      updateType: string;
      title: string;
      summary: string | null;
      sourceUrl: string;
      previousValue: string | null;
      newValue: string | null;
      officialPublishedAt: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
    }>
  > {
    const rows = await this.prisma.committeeSiteUpdate.findMany({
      where: { hearingId: id },
      orderBy: [{ officialPublishedAt: 'desc' }, { firstSeenAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((u) => ({
      id: u.id,
      updateType: u.updateType,
      title: u.normalizedTitle,
      summary: u.normalizedSummary,
      sourceUrl: u.sourceUrl,
      previousValue: u.previousValue,
      newValue: u.newValue,
      officialPublishedAt: u.officialPublishedAt?.toISOString() ?? null,
      firstSeenAt: u.firstSeenAt.toISOString(),
      lastSeenAt: u.lastSeenAt.toISOString(),
    }));
  }

  /** This user's subscribed hearing ids, tenant- and user-scoped. */
  private async subscribedHearingIds(ctx: TenantContext): Promise<string[]> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.hearingSubscription.findMany({
        where: { userId: ctx.userId },
        select: { hearingId: true },
      }),
    );
    return rows.map((r) => r.hearingId);
  }

  /**
   * Attach the global capture/candidate data and the per-user subscription to a
   * page of canonical rows. Three bounded queries for the whole page rather than
   * per-row lookups.
   */
  private async hydrate(
    ctx: TenantContext,
    rows: Array<Record<string, unknown>>,
  ): Promise<CalendarEvent[]> {
    const ids = rows.map((r) => String(r.id));
    if (ids.length === 0) return [];

    const [captures, candidates, subscriptions] = await Promise.all([
      this.prisma.publicHearingCapture.findMany({ where: { hearingId: { in: ids } } }),
      this.prisma.hearingStreamCandidate.findMany({
        where: { hearingId: { in: ids } },
        orderBy: [{ priority: 'asc' }],
      }),
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.hearingSubscription.findMany({
          where: { userId: ctx.userId, hearingId: { in: ids } },
        }),
      ),
    ]);

    const captureByHearing = new Map(captures.map((c) => [c.hearingId, c]));
    const candidatesByHearing = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const list = candidatesByHearing.get(c.hearingId) ?? [];
      list.push(c);
      candidatesByHearing.set(c.hearingId, list);
    }
    const subByHearing = new Map(subscriptions.map((s) => [s.hearingId, s]));

    return rows.map((raw) => {
      const row = raw as {
        id: string;
        congress: number | null;
        chamber: string;
        committeeName: string;
        committeeSystemCode: string | null;
        subcommitteeSystemCode: string | null;
        title: string;
        type: string | null;
        eventStatus: string;
        visibility: string;
        date: Date;
        startsAt: Date | null;
        time: string | null;
        timezone: string;
        location: string | null;
        url: string | null;
        witnesses: string[] | null;
        streamAvailability: string;
        coverageStatus: string;
        sourceRevision: number;
        lastOfficialUpdateAt: Date | null;
      };
      const capture = captureByHearing.get(row.id) ?? null;
      const sub = subByHearing.get(row.id) ?? null;
      return {
        id: row.id,
        congress: row.congress,
        chamber: row.chamber,
        committeeName: row.committeeName,
        committeeSystemCode: row.committeeSystemCode,
        subcommitteeSystemCode: row.subcommitteeSystemCode,
        title: row.title,
        eventType: row.type,
        eventStatus: row.eventStatus,
        visibility: row.visibility,
        date: row.date.toISOString().slice(0, 10),
        startsAt: row.startsAt?.toISOString() ?? null,
        time: row.time,
        timezone: row.timezone,
        location: row.location,
        officialPageUrl: row.url,
        witnesses: row.witnesses ?? [],
        streamAvailability: row.streamAvailability,
        coverageStatus: row.coverageStatus,
        sourceRevision: row.sourceRevision,
        lastOfficialUpdateAt: row.lastOfficialUpdateAt?.toISOString() ?? null,
        capture: capture
          ? {
              status: capture.status,
              scheduledStart: capture.scheduledStart?.toISOString() ?? null,
              actualStart: capture.actualStart?.toISOString() ?? null,
              actualEnd: capture.actualEnd?.toISOString() ?? null,
              capturedSeconds: capture.capturedSeconds,
              transcriptGapSeconds: capture.transcriptGapSeconds,
              reconnectCount: capture.reconnectCount,
              failureCode: capture.failureCode,
            }
          : null,
        streamCandidates: (candidatesByHearing.get(row.id) ?? []).map((c) => ({
          provider: c.provider,
          officialPageUrl: c.officialPageUrl,
          // The raw media URL is deliberately NOT exposed: it can be expiring,
          // IP-bound or licence-restricted, and a normal user has no reason to
          // hold one. The UI needs to know a stream EXISTS, not where it is.
          hasMediaUrl: c.mediaUrl != null,
          mediaType: c.mediaType,
          resolutionState: c.resolutionState,
          capturePolicy: c.capturePolicy,
          priority: c.priority,
          failureReason: c.failureReason,
        })),
        subscription: sub
          ? {
              notifyOnStart: sub.notifyOnStart,
              notifyOnMention: sub.notifyOnMention,
              scheduledByUser: sub.scheduledByUser,
              scheduledByRuleId: sub.scheduledByRuleId,
              clientIds: sub.clientIds ?? [],
              watchlistId: sub.watchlistId,
            }
          : null,
      };
    });
  }
}

function clampPageSize(raw: number | undefined): number {
  if (!raw || !Number.isFinite(raw) || raw < 1) return 50;
  return Math.min(Math.floor(raw), MAX_PAGE_SIZE);
}

/** Translate the calendar filters into a Prisma predicate. */
export function buildWhere(query: CalendarQuery): Prisma.CommitteeHearingWhereInput {
  const where: Prisma.CommitteeHearingWhereInput = {};
  const date: Prisma.DateTimeFilter = {};
  if (query.from) {
    const from = parseDay(query.from);
    if (from) date.gte = from;
  }
  if (query.to) {
    const to = parseDay(query.to);
    if (to) date.lte = to;
  }
  if (date.gte || date.lte) where.date = date;

  if (query.chamber) where.chamber = displayChamberFilter(query.chamber);
  if (query.committee) {
    // Accept a system code or a display name; the corpus has rows keyed either
    // way (the legacy sync writes committee_code, Phase 3 writes both).
    where.OR = [
      { committeeSystemCode: query.committee },
      { committeeCode: query.committee },
      { committeeName: { contains: query.committee, mode: 'insensitive' } },
    ];
  }
  if (query.subcommittee) where.subcommitteeSystemCode = query.subcommittee;
  if (query.eventType) where.type = query.eventType;
  if (query.eventStatus) where.eventStatus = query.eventStatus;
  if (query.streamState) where.streamAvailability = query.streamState;
  if (query.captureState) where.coverageStatus = query.captureState;
  if (query.q) {
    const q = query.q;
    const text: Prisma.CommitteeHearingWhereInput[] = [
      { title: { contains: q, mode: 'insensitive' } },
      { committeeName: { contains: q, mode: 'insensitive' } },
      { location: { contains: q, mode: 'insensitive' } },
    ];
    // AND the text search with any committee predicate rather than replacing it
    // — an OR at the top level would silently widen a filtered query.
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: text },
    ];
  }
  return where;
}

/** `committee_hearing.chamber` is stored in Display Case. */
function displayChamberFilter(chamber: string): string {
  const c = chamber.trim().toLowerCase();
  if (c === 'house') return 'House';
  if (c === 'senate') return 'Senate';
  if (c === 'joint') return 'Joint';
  return chamber;
}

/** `YYYY-MM-DD` → UTC-midnight, matching the `@db.Date` column. */
function parseDay(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
