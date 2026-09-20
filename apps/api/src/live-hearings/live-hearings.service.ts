import {
  resolveCanonicalHearingId,
  resolveCanonicalHearingIds,
} from '../hearing-discovery/hearing-alias.js';
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
import {
  committeeParentCode,
  storedCommitteeIdentity,
} from '../hearing-discovery/hearing-committee-identity.js';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  floridaCommitteeDirectoryProfile,
  floridaLegislatorDirectoryProfile,
  preferNonBlank,
} from '../hearing-discovery/florida-directory-profile.js';
import { requireStateCalendar } from './legiwatch-calendar-access.js';

/** One canonical hearing as the master calendar renders it. */
export interface CalendarEvent {
  id: string;
  geographicJurisdiction?: string | null;
  legislativeSession?: string | null;
  stateCommitteeId?: string | null;
  calendarRevision?: number;
  calendarCheckedAt?: string | null;
  calendarCheckState?: string;
  timePrecision?: string | null;
  following?: boolean;
  agenda?: unknown;
  documents?: unknown;
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
  jurisdiction?: 'US' | 'FL' | 'ALL';
  session?: string;
  stateCommitteeId?: string;
  /** Internal-only alias expansion used by the state committee room. The
   * public DTO deliberately does not expose this field; callers may request
   * one canonical committee id, while the service can read every verified
   * source record that belongs to it without widening the HTTP contract. */
  stateCommitteeIds?: string[];
  billIds?: string[];
  hearingIds?: string[];
  following?: boolean;
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
  /**
   * Whitelisted sort direction on the canonical date/startsAt key. Default
   * `asc`; `desc` is for explicit "latest first" lookups and is bounded by the
   * same pageSize cap — it never widens the selection.
   */
  sort?: 'asc' | 'desc';
  q?: string;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 200;

type DirectoryEvidence = { aliasIds?: unknown; active?: unknown };

function isRetiredDirectoryRow(row: { sourceEvidence: unknown }): boolean {
  if (
    !row.sourceEvidence ||
    typeof row.sourceEvidence !== 'object' ||
    Array.isArray(row.sourceEvidence)
  ) {
    return false;
  }
  const directory = (row.sourceEvidence as { directory?: DirectoryEvidence }).directory;
  return directory?.active === false;
}

function verifiedDirectoryAliasIds(
  rows: Array<{ id: string; officialSourceKey: string | null; sourceEvidence: unknown }>,
): Set<string> {
  const aliases = new Set<string>();
  for (const row of rows) {
    // A retired official row no longer represents the directory. Its former
    // aliases must remain visible instead of being hidden by stale metadata.
    if (isRetiredDirectoryRow(row)) continue;
    if (
      !row.officialSourceKey ||
      !row.sourceEvidence ||
      typeof row.sourceEvidence !== 'object' ||
      Array.isArray(row.sourceEvidence)
    )
      continue;
    const directory = (row.sourceEvidence as { directory?: DirectoryEvidence }).directory;
    if (!directory || !Array.isArray(directory.aliasIds)) continue;
    for (const aliasId of directory.aliasIds) {
      if (typeof aliasId === 'string' && aliasId !== row.id) aliases.add(aliasId);
    }
  }
  return aliases;
}

export function filterVerifiedDirectoryAliases<
  T extends { id: string; officialSourceKey: string | null; sourceEvidence: unknown },
>(rows: T[]): T[] {
  const aliases = verifiedDirectoryAliasIds(rows);
  return rows.filter((row) => !aliases.has(row.id) && !isRetiredDirectoryRow(row));
}

export function officialDirectoryBodyForAlias<
  T extends { id: string; officialSourceKey: string | null; sourceEvidence: unknown },
>(aliasId: string, rows: T[]): T | null {
  return (
    rows.find((row) => {
      if (!row.officialSourceKey || isRetiredDirectoryRow(row)) return false;
      const evidence = row.sourceEvidence;
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
      const aliases = (evidence as { directory?: DirectoryEvidence }).directory?.aliasIds;
      return Array.isArray(aliases) && aliases.includes(aliasId);
    }) ?? null
  );
}

type LegacyCommitteeLink = { id: string; name: string; chamber: string | null };

type StateCommitteeRosterRow = {
  id: string;
  memberships: Array<{
    role: string | null;
    lastSyncedAt: Date;
    legislator: {
      id: string;
      name: string;
      chamber: string | null;
      district: string | null;
      party: string | null;
      email: string | null;
      image: string | null;
      url: string | null;
      sourceEvidence: unknown;
      active: boolean;
      legiscanPeopleId: number | null;
      syncedAt: Date;
    };
  }>;
};

export interface StateCommitteeRoomMember {
  id: string;
  name: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  email: string | null;
  image: string | null;
  url: string | null;
  active: boolean;
  legiscanPeopleId: number | null;
  role: string | null;
  roles: string[];
  sourceCommitteeIds: string[];
  lastSyncedAt: string;
}

function rosterRoleRank(roles: string[]): number {
  const value = roles.join(' ').toLowerCase();
  if (/\b(chair|chairman|chairwoman|chairperson)\b/.test(value) && !/vice|deputy/.test(value))
    return 0;
  if (/vice\s+chair|deputy\s+chair/.test(value)) return 1;
  if (/ranking|minority\s+(?:chair|leader)/.test(value)) return 2;
  return 3;
}

/**
 * Build one roster from the official Florida directory identity and every
 * explicitly verified OpenStates/legacy alias. A person is keyed only by the
 * provider's stable legislator id; display-name matching is never used. When
 * two source rows carry different role labels, both are retained verbatim.
 */
export function mergeStateCommitteeMembers(
  rows: StateCommitteeRosterRow[],
): StateCommitteeRoomMember[] {
  const byPerson = new Map<
    string,
    StateCommitteeRoomMember & { roleSet: Set<string>; sourceSet: Set<string>; syncedAtMs: number }
  >();
  for (const committee of rows) {
    for (const membership of committee.memberships) {
      const legislator = membership.legislator;
      const directory = floridaLegislatorDirectoryProfile(legislator.sourceEvidence);
      const existing = byPerson.get(legislator.id);
      const role = membership.role?.trim() || null;
      const syncedAtMs = Math.max(membership.lastSyncedAt.getTime(), legislator.syncedAt.getTime());
      if (existing) {
        if (role) existing.roleSet.add(role);
        existing.sourceSet.add(committee.id);
        existing.syncedAtMs = Math.max(existing.syncedAtMs, syncedAtMs);
        continue;
      }
      const roleSet = new Set<string>();
      if (role) roleSet.add(role);
      byPerson.set(legislator.id, {
        id: legislator.id,
        name: legislator.name,
        chamber: legislator.chamber,
        district: legislator.district,
        party: legislator.party,
        email: preferNonBlank(legislator.email, directory?.email ?? null),
        image: preferNonBlank(legislator.image, directory?.portraitUrl ?? null),
        url: legislator.url,
        active: legislator.active,
        legiscanPeopleId: legislator.legiscanPeopleId,
        role: null,
        roles: [],
        sourceCommitteeIds: [],
        lastSyncedAt: '',
        roleSet,
        sourceSet: new Set([committee.id]),
        syncedAtMs,
      });
    }
  }
  return [...byPerson.values()]
    .map(({ roleSet, sourceSet, syncedAtMs, ...member }) => {
      const roles = [...roleSet];
      return {
        ...member,
        role: roles.length ? roles.join(' · ') : null,
        roles,
        sourceCommitteeIds: [...sourceSet],
        lastSyncedAt: new Date(syncedAtMs).toISOString(),
      };
    })
    .sort(
      (a, b) => rosterRoleRank(a.roles) - rosterRoleRank(b.roles) || a.name.localeCompare(b.name),
    );
}

export function relatedLegacyBodiesForOfficial(
  body: { chamber: string | null; officialSourceKey: string | null; sourceEvidence: unknown },
  rows: LegacyCommitteeLink[],
): LegacyCommitteeLink[] {
  if (
    !body.officialSourceKey ||
    !body.sourceEvidence ||
    typeof body.sourceEvidence !== 'object' ||
    Array.isArray(body.sourceEvidence)
  )
    return [];
  const directory = (body.sourceEvidence as { directory?: DirectoryEvidence }).directory;
  if (!directory || !Array.isArray(directory.aliasIds)) return [];
  const ids = new Set(directory.aliasIds.filter((id): id is string => typeof id === 'string'));
  return rows.filter((row) => ids.has(row.id));
}

/**
 * A hearing counts as LIVE from its start until this long after, when nothing
 * has told us it ended. Congressional hearings routinely run 3-4 hours; a
 * shorter window would drop a still-running hearing off the Live view, and an
 * unbounded one would leave yesterday's on it forever.
 */
export const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** One official committee source, as the coverage/source-health surface renders it. */
export interface CommitteeSourceCoverage {
  id: string;
  committeeSystemCode: string | null;
  /** Resolved from `congress_committee` by system code; null when unresolved or chamber-wide. */
  committeeName: string | null;
  chamber: string;
  sourceType: string;
  sourceUrl: string;
  adapterKey: string;
  enabled: boolean;
  priority: number;
  /** 'healthy' | 'degraded' | 'failing' | 'unknown' — read verbatim, never coerced. */
  sourceHealth: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /**
   * Most recently observed `capturePolicy` / `resolutionState` among this
   * source's stream candidates, or null when no candidate has ever cited this
   * source. This is a real, derived read (never a fabricated default) — a
   * source-level "server capture support" column does not exist in the
   * schema, because capture eligibility is resolved per hearing, not per
   * source. A null here must render as truthfully unavailable, not as a
   * status.
   */
  recentCapturePolicy: string | null;
  recentResolutionState: string | null;
}

export interface CommitteeSourceCoverageSummary {
  total: number;
  healthy: number;
  degraded: number;
  failing: number;
  unknown: number;
}

@Injectable()
export class LiveHearingsService {
  constructor(private readonly prisma: PrismaService) {}
  async calendarCoverage(ctx: TenantContext, query: CalendarQuery) {
    await requireStateCalendar(this.prisma, ctx.tenantId);
    buildWhere({ ...query, jurisdiction: 'FL' });
    const rows = await this.prisma.legislativeCalendarCoverage.findMany({
      where: {
        jurisdiction: 'FL',
        ...(query.session ? { session: query.session } : {}),
        ...(query.from ? { fromDate: { lte: new Date(`${query.from}T00:00:00Z`) } } : {}),
        ...(query.to ? { toDate: { gte: new Date(`${query.to}T00:00:00Z`) } } : {}),
      },
      orderBy: [{ chamber: 'asc' }, { attemptedAt: 'desc' }],
      distinct: ['chamber'],
      take: 2,
    });
    return {
      rows: rows.map((row) => ({
        chamber: row.chamber,
        status: row.status,
        from: row.fromDate.toISOString().slice(0, 10),
        to: row.toDate.toISOString().slice(0, 10),
        checkedAt: row.attemptedAt.toISOString(),
        items: row.items,
        details: row.details,
      })),
      asOf: new Date().toISOString(),
    };
  }
  async stateBodies(ctx: TenantContext, session?: string) {
    await requireStateCalendar(this.prisma, ctx.tenantId);
    const rows = await this.prisma.stateCommittee.findMany({
      where: {
        state: 'FL',
        ...(session
          ? {
              OR: [
                { legislativeSession: session },
                { chamber: 'joint', legislativeSession: null, officialSourceKey: { not: null } },
              ],
            }
          : {}),
      },
      orderBy: [{ chamber: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 1000,
      select: {
        id: true,
        name: true,
        state: true,
        chamber: true,
        legislativeSession: true,
        officialSourceKey: true,
        sourceUrl: true,
        sourceEvidence: true,
        lastSyncedAt: true,
      },
    });
    return filterVerifiedDirectoryAliases(rows).map(
      ({ sourceEvidence: _sourceEvidence, ...row }) => row,
    );
  }
  async stateBody(ctx: TenantContext, id: string) {
    await requireStateCalendar(this.prisma, ctx.tenantId);
    const requestedBody = await this.prisma.stateCommittee.findUnique({
      where: { id },
      include: { memberships: { include: { legislator: true } } },
    });
    if (!requestedBody || requestedBody.state !== 'FL')
      throw new NotFoundException('State committee not found');
    // Calendar events and LegiScan referrals often retain the normalized
    // OpenStates/LegiScan alias. Resolve that exact, verified alias back to the
    // official Florida directory identity so every entry point opens the same
    // rich profile. Never match on committee name.
    const officialCandidates = requestedBody.officialSourceKey
      ? []
      : await this.prisma.stateCommittee.findMany({
          where: { state: 'FL', officialSourceKey: { not: null } },
          include: { memberships: { include: { legislator: true } } },
          take: 1000,
        });
    const body = requestedBody.officialSourceKey
      ? requestedBody
      : (officialDirectoryBodyForAlias(requestedBody.id, officialCandidates) ?? requestedBody);
    const directoryAliases =
      body.officialSourceKey &&
      body.sourceEvidence &&
      typeof body.sourceEvidence === 'object' &&
      !Array.isArray(body.sourceEvidence)
        ? (body.sourceEvidence as { directory?: DirectoryEvidence }).directory?.aliasIds
        : null;
    const aliasIds = Array.isArray(directoryAliases)
      ? directoryAliases.filter((aliasId): aliasId is string => typeof aliasId === 'string')
      : [];
    const legacyRows = aliasIds.length
      ? await this.prisma.stateCommittee.findMany({
          where: { id: { in: aliasIds }, state: 'FL' },
          include: { memberships: { include: { legislator: true } } },
        })
      : [];
    const relatedLegacyBodies = relatedLegacyBodiesForOfficial(body, legacyRows);
    const sourceRecords = [body, ...legacyRows];
    const sourceCommitteeIds = [...new Set(sourceRecords.map((row) => row.id))];
    const members = mergeStateCommitteeMembers(sourceRecords);
    const directoryProfile = floridaCommitteeDirectoryProfile(sourceRecords);

    // Match the federal room's explicit ±365-day proceedings windows. The
    // old state endpoint returned the first 200 rows across all time, sorted
    // oldest-first, which could hide every current hearing on a long-lived
    // committee. Verified aliases are expanded inside the service so an
    // official directory identity cannot strand proceedings on an older row.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const future = new Date(today.getTime() + 365 * 86_400_000);
    const past = new Date(today.getTime() - 365 * 86_400_000);
    const yesterday = new Date(today.getTime() - 86_400_000);
    const day = (value: Date) => value.toISOString().slice(0, 10);
    const committeeChamber = body.chamber?.toLowerCase() ?? null;
    const coverageChambers =
      committeeChamber === 'lower' || committeeChamber === 'house'
        ? ['house']
        : committeeChamber === 'upper' || committeeChamber === 'senate'
          ? ['senate']
          : ['house', 'senate'];

    const [upcomingEvents, recentEvents, coverageRows, referredBills, referredBillCount] =
      await Promise.all([
        this.calendar(ctx, {
          jurisdiction: 'FL',
          stateCommitteeIds: sourceCommitteeIds,
          from: day(today),
          to: day(future),
          sort: 'asc',
          pageSize: 200,
        }),
        this.calendar(ctx, {
          jurisdiction: 'FL',
          stateCommitteeIds: sourceCommitteeIds,
          from: day(past),
          to: day(yesterday),
          sort: 'desc',
          pageSize: 200,
        }),
        this.prisma.legislativeCalendarCoverage.findMany({
          where: {
            jurisdiction: 'FL',
            chamber: { in: coverageChambers },
            ...(body.legislativeSession
              ? { OR: [{ session: body.legislativeSession }, { session: null }] }
              : {}),
          },
          orderBy: [{ attemptedAt: 'desc' }],
          // Keep the latest receipt for EACH provider/chamber pair. A
          // first-party Florida calendar and the corroborating OpenStates
          // event feed must both remain visible; distinct(chamber) hid one.
          distinct: ['chamber', 'sourceId'],
          take: coverageChambers.length * 8,
        }),
        this.prisma.stateBill.findMany({
          where: { state: 'FL', currentCommitteeId: { in: sourceCommitteeIds } },
          orderBy: [{ latestActionDate: 'desc' }, { identifier: 'asc' }],
          take: 25,
          select: {
            id: true,
            identifier: true,
            title: true,
            status: true,
            latestActionDate: true,
            latestActionText: true,
            stateUrl: true,
            url: true,
            syncedAt: true,
            currentCommitteeId: true,
            calendarEvents: {
              where: { present: true },
              orderBy: [{ date: 'asc' }, { eventType: 'asc' }],
              take: 5,
              select: {
                id: true,
                eventType: true,
                date: true,
                time: true,
                location: true,
                description: true,
                firstSeenAt: true,
                lastSyncedAt: true,
              },
            },
          },
        }),
        this.prisma.stateBill.count({
          where: { state: 'FL', currentCommitteeId: { in: sourceCommitteeIds } },
        }),
      ]);

    const sourceIds = [...new Set(coverageRows.map((row) => row.sourceId))];
    const committeeSources = sourceIds.length
      ? await this.prisma.committeeSource.findMany({ where: { id: { in: sourceIds } } })
      : [];
    const sourceById = new Map(committeeSources.map((source) => [source.id, source]));
    const sourceCoverage = coverageRows.map((coverage) => {
      const source = sourceById.get(coverage.sourceId);
      return {
        chamber: coverage.chamber,
        status: coverage.status,
        from: coverage.fromDate.toISOString().slice(0, 10),
        to: coverage.toDate.toISOString().slice(0, 10),
        attemptedAt: coverage.attemptedAt.toISOString(),
        items: coverage.items,
        sourceHealth: source?.sourceHealth ?? 'unknown',
        lastCheckedAt: source?.lastCheckedAt?.toISOString() ?? null,
        lastSuccessAt: source?.lastSuccessAt?.toISOString() ?? null,
        lastErrorAt: source?.lastErrorAt?.toISOString() ?? null,
        lastError: source?.lastError ?? null,
        sourceUrl: source?.sourceUrl ?? null,
        adapterKey: source?.adapterKey ?? null,
      };
    });
    const { memberships: _memberships, ...bodyRecord } = body;
    return {
      body: bodyRecord,
      relatedLegacyBodies,
      sourceRecords: sourceRecords.map(({ memberships: _sourceMemberships, ...row }) => row),
      sourceCommitteeIds,
      members,
      directoryProfile,
      rosterStatus:
        body.officialSourceKey && !members.length ? 'unqualified' : 'source_memberships',
      upcomingEvents,
      recentEvents,
      // Compatibility envelope for the first state profile client. New rooms
      // read the explicit windows above; keeping this avoids a flag-skew crash
      // during a rolling web/API deployment.
      events: {
        rows: [...upcomingEvents.rows, ...recentEvents.rows],
        total: upcomingEvents.total + recentEvents.total,
        page: 1,
        pageSize: 400,
      },
      sourceCoverage,
      referredBills: {
        rows: referredBills.map((bill) => ({
          ...bill,
          latestActionDate: bill.latestActionDate?.toISOString().slice(0, 10) ?? null,
          syncedAt: bill.syncedAt.toISOString(),
          calendarEvents: bill.calendarEvents.map((event) => ({
            ...event,
            date: event.date.toISOString().slice(0, 10),
            firstSeenAt: event.firstSeenAt.toISOString(),
            lastSyncedAt: event.lastSyncedAt.toISOString(),
          })),
        })),
        total: referredBillCount,
      },
    };
  }

  /**
   * Source coverage / health — the operator-tooling surface the prototype
   * calls "Source coverage". Every field below is read straight off
   * `committee_source` (plus a best-effort committee-name join and a
   * derived "most recent candidate" read for capture/resolution support);
   * nothing is fabricated to fill in a prototype field the schema does not
   * back. GLOBAL data — no tenant_id on `committee_source`, so no tenant
   * filter applies.
   */
  async coverage(): Promise<{
    summary: CommitteeSourceCoverageSummary;
    sources: CommitteeSourceCoverage[];
  }> {
    const sources = await this.prisma.committeeSource.findMany({
      orderBy: [{ chamber: 'asc' }, { sourceUrl: 'asc' }],
      take: 1000,
    });

    const systemCodes = [
      ...new Set(sources.map((s) => s.committeeSystemCode).filter((c): c is string => Boolean(c))),
    ];
    const committees = systemCodes.length
      ? await this.prisma.congressCommittee.findMany({
          where: { systemCode: { in: systemCodes } },
          select: { systemCode: true, name: true },
        })
      : [];
    const nameBySystemCode = new Map(committees.map((c) => [c.systemCode, c.name]));

    const sourceIds = sources.map((s) => s.id);
    const candidates = sourceIds.length
      ? await this.prisma.hearingStreamCandidate.findMany({
          where: { sourceId: { in: sourceIds } },
          orderBy: [{ updatedAt: 'desc' }],
          select: {
            sourceId: true,
            capturePolicy: true,
            resolutionState: true,
            updatedAt: true,
          },
          take: 5000,
        })
      : [];
    // Most recently updated candidate per source, computed in memory rather
    // than via a Prisma `distinct` so the same reduction is trivially
    // testable against the plain in-memory Prisma double this module already
    // uses (see live-hearings.service.spec.ts).
    const latestCandidateBySource = new Map<
      string,
      { capturePolicy: string; resolutionState: string }
    >();
    for (const candidate of candidates) {
      if (!candidate.sourceId || latestCandidateBySource.has(candidate.sourceId)) continue;
      latestCandidateBySource.set(candidate.sourceId, {
        capturePolicy: candidate.capturePolicy,
        resolutionState: candidate.resolutionState,
      });
    }

    const summary: CommitteeSourceCoverageSummary = {
      total: sources.length,
      healthy: 0,
      degraded: 0,
      failing: 0,
      unknown: 0,
    };
    for (const s of sources) {
      const key = s.sourceHealth as keyof CommitteeSourceCoverageSummary;
      if (key === 'healthy' || key === 'degraded' || key === 'failing' || key === 'unknown') {
        summary[key] += 1;
      } else {
        summary.unknown += 1;
      }
    }

    return {
      summary,
      sources: sources.map((s) => {
        const latest = latestCandidateBySource.get(s.id) ?? null;
        return {
          id: s.id,
          committeeSystemCode: s.committeeSystemCode,
          committeeName: s.committeeSystemCode
            ? (nameBySystemCode.get(s.committeeSystemCode) ?? null)
            : null,
          chamber: s.chamber,
          sourceType: s.sourceType,
          sourceUrl: s.sourceUrl,
          adapterKey: s.adapterKey,
          enabled: s.enabled,
          priority: s.priority,
          sourceHealth: s.sourceHealth,
          lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          lastErrorAt: s.lastErrorAt?.toISOString() ?? null,
          lastError: s.lastError,
          recentCapturePolicy: latest?.capturePolicy ?? null,
          recentResolutionState: latest?.resolutionState ?? null,
        };
      }),
    };
  }

  /** Master calendar: a filtered page of canonical events with the tenant overlay. */
  async calendar(
    ctx: TenantContext,
    query: CalendarQuery,
  ): Promise<{ rows: CalendarEvent[]; total: number; page: number; pageSize: number }> {
    const pageSize = clampPageSize(query.pageSize);
    const page = Math.max(1, query.page ?? 1);
    const where = buildWhere(query);
    if (query.jurisdiction && query.jurisdiction !== 'US')
      await requireStateCalendar(this.prisma, ctx.tenantId);
    const selection: Prisma.CommitteeHearingWhereInput[] = [];
    if (query.hearingIds)
      selection.push({
        id: { in: await resolveCanonicalHearingIds(this.prisma, query.hearingIds) },
      });
    if (query.billIds) {
      const agenda = await this.prisma.legislativeAgendaItem.findMany({
        where: {
          active: true,
          OR: [{ stateBillKey: { in: query.billIds } }, { federalBillId: { in: query.billIds } }],
        },
        select: { hearingId: true },
        distinct: ['hearingId'],
      });
      const federal = await this.prisma.committeeHearingBill.findMany({
        where: { billId: { in: query.billIds } },
        select: { hearingId: true },
      });
      selection.push({
        id: {
          in: await resolveCanonicalHearingIds(
            this.prisma,
            [...agenda, ...federal].map((a) => a.hearingId),
          ),
        },
      });
    }
    if (query.following !== undefined) {
      const follows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.hearingFollow.findMany({
          where: { userId: ctx.userId },
          select: { hearingId: true },
        }),
      );
      const followedIds = await resolveCanonicalHearingIds(
        this.prisma,
        follows.map((f) => f.hearingId),
      );
      selection.push({
        id: query.following ? { in: followedIds } : { notIn: followedIds },
      });
    }
    if (selection.length)
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        ...selection,
      ];

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
        // Deterministic tie order: date → startsAt → id, flipped as a unit for
        // an explicit "latest first" lookup. Default asc is the calendar's
        // long-standing contract (and the export's chronological semantics).
        orderBy:
          query.sort === 'desc'
            ? [{ date: 'desc' }, { startsAt: 'desc' }, { id: 'desc' }]
            : [{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
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
        geographicJurisdiction: 'US',
        canonicalHearingId: null,
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
    id = await resolveCanonicalHearingId(this.prisma, id);
    const row = await this.prisma.committeeHearing.findUnique({ where: { id } });
    if (!row) return null;
    if (row.geographicJurisdiction && row.geographicJurisdiction !== 'US')
      await requireStateCalendar(this.prisma, ctx.tenantId);
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
    return resolveCanonicalHearingIds(
      this.prisma,
      rows.map((r) => r.hearingId),
    );
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

    const [captures, candidates, subscriptions, follows] = await Promise.all([
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
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.hearingFollow.findMany({
          where: { userId: ctx.userId, hearingId: { in: ids } },
          select: { hearingId: true },
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
        geographicJurisdiction: string | null;
        legislativeSession: string | null;
        stateCommitteeId: string | null;
        calendarRevision: number;
        calendarCheckedAt: Date | null;
        calendarCheckState: string;
        timePrecision: string | null;
        calendarSnapshot: unknown;
        congress: number | null;
        chamber: string;
        committeeName: string;
        committeeCode: string | null;
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
        following: follows.some((f) => f.hearingId === row.id),
        geographicJurisdiction: row.geographicJurisdiction,
        legislativeSession: row.legislativeSession,
        stateCommitteeId: row.stateCommitteeId,
        calendarRevision: row.calendarRevision,
        calendarCheckedAt: row.calendarCheckedAt?.toISOString() ?? null,
        calendarCheckState: row.calendarCheckState,
        timePrecision: row.timePrecision,
        agenda: (row.calendarSnapshot as { agenda?: unknown } | null)?.agenda ?? [],
        documents: (
          (row.calendarSnapshot as { documents?: Array<Record<string, unknown>> } | null)
            ?.documents ?? []
        ).map((d) => ({
          id: d.key,
          title: d.title,
          documentType: d.kind,
          sourceUrl: d.url,
          publishedAt: d.publishedAt,
          contentHash: d.contentHash,
          deadlines: d.deadlines,
        })),
        congress: row.congress,
        chamber: row.chamber,
        committeeName: row.committeeName,
        ...storedCommitteeIdentity(row),
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
  const where: Prisma.CommitteeHearingWhereInput = { canonicalHearingId: null };
  where.AND =
    query.jurisdiction === 'ALL'
      ? [
          {
            OR: [
              { geographicJurisdiction: null },
              { geographicJurisdiction: { in: ['US', 'FL'] } },
            ],
          },
        ]
      : query.jurisdiction === 'FL'
        ? [{ geographicJurisdiction: 'FL' }]
        : [{ OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] }];
  if (query.session) where.legislativeSession = query.session;
  if (query.stateCommitteeIds?.length)
    where.stateCommitteeId = { in: [...new Set(query.stateCommitteeIds)] };
  else if (query.stateCommitteeId) where.stateCommitteeId = query.stateCommitteeId;
  const date: Prisma.DateTimeFilter = {};
  if (query.from) {
    const from = parseDay(query.from);
    if (from) date.gte = from;
  }
  if (query.to) {
    const to = parseDay(query.to);
    if (to) date.lte = to;
  }
  if (date.gte instanceof Date && date.lte instanceof Date && date.gte > date.lte) {
    throw new BadRequestException('Calendar start date must not follow its end date');
  }
  if (date.gte || date.lte) where.date = date;

  if (query.chamber) where.chamber = displayChamberFilter(query.chamber);
  if (query.committee) {
    // Accept a system code or a display name; the corpus has rows keyed either
    // way (the legacy sync writes committee_code, Phase 3 writes both).
    const code = query.committee.trim().toLowerCase();
    const parent = committeeParentCode(code);
    // A full committee includes children identified by Congress.gov's exact
    // four-letter family + two-digit body code, including legacy imports.
    const family =
      parent === code
        ? Array.from({ length: 100 }, (_, n) => `${code.slice(0, 4)}${String(n).padStart(2, '0')}`)
        : null;
    where.OR = family
      ? [
          { committeeSystemCode: { in: family } },
          { subcommitteeSystemCode: { in: family } },
          { committeeSystemCode: null, committeeCode: { in: family } },
          { committeeName: { contains: query.committee, mode: 'insensitive' } },
        ]
      : [
          { committeeSystemCode: query.committee },
          { committeeCode: query.committee },
          { committeeName: { contains: query.committee, mode: 'insensitive' } },
        ];
  }
  if (query.subcommittee) {
    const code = query.subcommittee.trim().toLowerCase();
    const parent = committeeParentCode(code);
    // Canonical identity takes precedence. Older Congress.gov imports put an
    // explicitly published child code in committeeCode / committeeSystemCode.
    // Recover those exact codes, never every proceeding under the parent.
    const child: Prisma.CommitteeHearingWhereInput = {
      OR: [
        { subcommitteeSystemCode: code },
        {
          subcommitteeSystemCode: null,
          OR: [
            { committeeSystemCode: code },
            {
              committeeCode: code,
              OR: [
                { committeeSystemCode: null },
                ...(parent ? [{ committeeSystemCode: parent }] : []),
              ],
            },
          ],
        },
      ],
    };
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), child];
  }
  if (query.eventType) where.type = { equals: query.eventType, mode: 'insensitive' };
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
  if (!m || !m[1] || !m[2] || !m[3])
    throw new BadRequestException('Calendar dates must be valid YYYY-MM-DD values');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw.trim()) {
    throw new BadRequestException('Calendar dates must be valid YYYY-MM-DD values');
  }
  return d;
}
