import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { storedCommitteeIdentity } from '../hearing-discovery/hearing-committee-identity.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsService, type CalendarEvent } from './live-hearings.service.js';

export interface CommitteeEventSummary {
  id: string;
  title: string;
  date: string;
  startsAt: string | null;
  eventStatus: string;
  eventType: string | null;
}

export interface CommitteeDirectoryRow {
  systemCode: string;
  thomasId: string;
  name: string;
  chamber: string;
  parentSystemCode: string | null;
  parentName: string | null;
  officialUrl: string | null;
  jurisdiction: string | null;
  isSubcommittee: boolean;
  lastSyncedAt: string;
  upcomingEventCount: number;
  recentEventCount: number;
  sourceHealth: string;
  lastSourceSuccessAt: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceHealthInheritedFrom: string | null;
  captureSupportObservation?: string;
  streamResolutionObservation?: string;
  nextEvent: CommitteeEventSummary | null;
  /** Directory-card fields (LEGIWATCH-V2-HANDOFF §5.6) — undefined when no
   *  TenantContext was supplied (the tenant-agnostic public directory read).
   *  Leadership is read from `LiveHearingsService`'s roster, batched across
   *  every committee in one query — never a per-card N+1. */
  chair?: CommitteeMemberRow | null;
  rankingMember?: CommitteeMemberRow | null;
  following?: boolean;
  /** Distinct clients this tenant's users have connected to the committee via
   *  Follow (`LegiWatchCommitteeFollow.clientIds`). Not a claim about which
   *  clients are actually AFFECTED by the committee's activity — see the
   *  method doc. */
  clientExposureCount?: number;
}

export interface CommitteeMemberRow {
  id: string;
  bioguideId: string;
  name: string;
  party: string | null;
  side: string;
  rank: number | null;
  role: string | null;
}

interface DirectorySnapshot {
  rows: CommitteeDirectoryRow[];
  byCode: Map<string, CommitteeDirectoryRow>;
  asOf: string;
}

interface SourceRow {
  id: string;
  committeeSystemCode: string | null;
  sourceUrl: string;
  sourceHealth: string;
  lastSuccessAt: Date | null;
  priority: number;
}

interface CandidateObservation {
  sourceId: string | null;
  capturePolicy: string;
  resolutionState: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_EVENT_WINDOW_DAYS = 365;

/**
 * Persistent committee/subcommittee directory and Committee Room reads.
 *
 * Committee identity is sourced exclusively from CongressCommittee. It is
 * deliberately independent of the current calendar window: a current body with
 * zero hearings remains visible and selectable. CommitteeSource is a source
 * owner registry, so a subcommittee may truthfully inherit its parent's source
 * health without creating a fabricated subcommittee source row.
 */
@Injectable()
export class CommitteeDirectoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hearings: LiveHearingsService,
  ) {}

  async committees(ctx?: TenantContext): Promise<{
    rows: CommitteeDirectoryRow[];
    total: number;
    parentCount: number;
    subcommitteeCount: number;
    asOf: string;
  }> {
    const snapshot = await this.loadDirectory();
    const parentCount = snapshot.rows.filter((row) => !row.isSubcommittee).length;
    const rows = ctx ? await this.withDirectoryCardFields(snapshot.rows, ctx) : snapshot.rows;
    return {
      rows,
      total: rows.length,
      parentCount,
      subcommitteeCount: rows.length - parentCount,
      asOf: snapshot.asOf,
    };
  }

  /**
   * Batches the directory-card fields (chair, ranking member, following,
   * client exposure) across every committee in a small, fixed number of
   * queries — never one query per card (§41's N+1 rule).
   */
  private async withDirectoryCardFields(
    rows: CommitteeDirectoryRow[],
    ctx: TenantContext,
  ): Promise<CommitteeDirectoryRow[]> {
    const systemCodes = rows.map((r) => r.systemCode);

    const [memberships, follows] = await Promise.all([
      this.prisma.congressCommitteeMembership.findMany({
        where: { systemCode: { in: systemCodes } },
        orderBy: [{ rank: 'asc' }, { title: 'asc' }, { bioguideId: 'asc' }],
      }),
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.legiWatchCommitteeFollow.findMany({
          where: { tenantId: ctx.tenantId, userId: ctx.userId, committeeSystemCode: { in: systemCodes } },
          select: { committeeSystemCode: true, clientIds: true },
        }),
      ),
    ]);

    const personIds = [...new Set(memberships.map((m) => m.bioguideId))];
    const people = personIds.length
      ? await this.prisma.congressMember.findMany({ where: { bioguideId: { in: personIds } } })
      : [];
    const peopleById = new Map(people.map((p) => [p.bioguideId, p]));

    const membershipsByCode = new Map<string, typeof memberships>();
    for (const m of memberships) {
      const list = membershipsByCode.get(m.systemCode) ?? [];
      list.push(m);
      membershipsByCode.set(m.systemCode, list);
    }

    const followByCode = new Map<string, { following: boolean; clientExposureCount: number }>();
    for (const f of follows) {
      followByCode.set(f.committeeSystemCode, {
        following: true,
        clientExposureCount: new Set(f.clientIds).size,
      });
    }

    return rows.map((row) => {
      const codeMemberships = membershipsByCode.get(row.systemCode) ?? [];
      const memberRows = codeMemberships.map((m): CommitteeMemberRow => {
        const person = peopleById.get(m.bioguideId);
        return {
          id: m.id,
          bioguideId: m.bioguideId,
          name: person?.fullName ?? m.bioguideId,
          party: person?.party ?? null,
          side: m.side,
          rank: m.rank ?? null,
          role: m.title ?? null,
        };
      });
      const chair =
        memberRows.find((m) => {
          const role = normalizeRole(m.role);
          return role.includes('chair') && !role.includes('vice');
        }) ?? null;
      const rankingMember = memberRows.find((m) => normalizeRole(m.role).includes('ranking')) ?? null;
      const follow = followByCode.get(row.systemCode);
      return {
        ...row,
        chair,
        rankingMember,
        following: Boolean(follow),
        clientExposureCount: follow?.clientExposureCount ?? 0,
      };
    });
  }

  async committee(id: string, ctx: TenantContext): Promise<Record<string, unknown> | null> {
    const snapshot = await this.loadDirectory();
    const committee = snapshot.byCode.get(normalizeCode(id));
    if (!committee) return null;

    const filter = committee.isSubcommittee
      ? { subcommittee: committee.systemCode }
      : { committee: committee.systemCode };
    const today = startOfUtcDay(new Date());
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const future = new Date(today.getTime() + DIRECTORY_EVENT_WINDOW_DAYS * DAY_MS);
    const past = new Date(today.getTime() - DIRECTORY_EVENT_WINDOW_DAYS * DAY_MS);

    const [memberResult, updateResult, live, upcoming, recent] = await Promise.all([
      this.members(committee.systemCode),
      this.updates(committee.systemCode, 100),
      this.hearings.live(ctx),
      this.hearings.calendar(ctx, {
        ...filter,
        from: dateOnly(today),
        to: dateOnly(future),
        page: 1,
        pageSize: 100,
      }),
      this.hearings.calendar(ctx, {
        ...filter,
        from: dateOnly(past),
        to: dateOnly(new Date(today.getTime() - DAY_MS)),
        page: 1,
        pageSize: 100,
      }),
    ]);

    const matchesBody = (event: CalendarEvent): boolean => {
      if (committee.isSubcommittee) {
        return normalizeCode(event.subcommitteeSystemCode) === normalizeCode(committee.systemCode);
      }
      return normalizeCode(event.committeeSystemCode) === normalizeCode(committee.systemCode);
    };

    const subcommittees = snapshot.rows.filter(
      (row) => normalizeCode(row.parentSystemCode) === normalizeCode(committee.systemCode),
    );
    const parent = committee.parentSystemCode
      ? snapshot.byCode.get(normalizeCode(committee.parentSystemCode)) ?? null
      : null;

    return {
      ...committee,
      parent,
      subcommittees,
      chair: memberResult.chair,
      rankingMember: memberResult.rankingMember,
      members: memberResult.rows,
      liveEvent: live.rows.find(matchesBody) ?? null,
      upcomingEvents: upcoming.rows,
      recentEvents: recent.rows.slice().reverse(),
      updates: updateResult.rows,
      asOf: snapshot.asOf,
      nextRefreshNotBefore: tomorrow.toISOString(),
    };
  }

  async members(id: string): Promise<{
    rows: CommitteeMemberRow[];
    total: number;
    chair: CommitteeMemberRow | null;
    rankingMember: CommitteeMemberRow | null;
    asOf: string;
  }> {
    const committee = await this.prisma.congressCommittee.findFirst({
      where: { systemCode: id, isCurrent: true },
    });
    if (!committee) {
      return { rows: [], total: 0, chair: null, rankingMember: null, asOf: new Date().toISOString() };
    }

    const memberships = await this.prisma.congressCommitteeMembership.findMany({
      where: { systemCode: committee.systemCode },
      orderBy: [{ rank: 'asc' }, { title: 'asc' }, { bioguideId: 'asc' }],
    });
    const ids = [...new Set(memberships.map((row) => row.bioguideId))];
    const people = ids.length
      ? await this.prisma.congressMember.findMany({ where: { bioguideId: { in: ids } } })
      : [];
    const peopleById = new Map(people.map((person) => [person.bioguideId, person]));

    const rows = memberships.map((membership): CommitteeMemberRow => {
      const person = peopleById.get(membership.bioguideId);
      return {
        id: membership.id,
        bioguideId: membership.bioguideId,
        name: person?.fullName ?? membership.bioguideId,
        party: person?.party ?? null,
        side: membership.side,
        rank: membership.rank ?? null,
        role: membership.title ?? null,
      };
    });

    // Leadership is read from the roster's stated title. Party/side is never
    // used as a proxy for chair or ranking member.
    const chair =
      rows.find((row) => {
        const role = normalizeRole(row.role);
        return role.includes('chair') && !role.includes('vice');
      }) ?? null;
    const rankingMember =
      rows.find((row) => normalizeRole(row.role).includes('ranking')) ?? null;

    return {
      rows,
      total: rows.length,
      chair,
      rankingMember,
      asOf: committee.lastSyncedAt.toISOString(),
    };
  }

  async updates(id: string, limit = 100): Promise<{
    rows: Array<Record<string, unknown>>;
    total: number;
    asOf: string;
  }> {
    const committee = await this.prisma.congressCommittee.findFirst({
      where: { systemCode: id, isCurrent: true },
    });
    if (!committee) return { rows: [], total: 0, asOf: new Date().toISOString() };

    const sourceCodes = [committee.systemCode];
    if (committee.parentSystemCode) sourceCodes.push(committee.parentSystemCode);

    const rows = await this.prisma.committeeSiteUpdate.findMany({
      where: { committeeSystemCode: { in: sourceCodes } },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });

    return {
      rows: rows.map((row) => ({
        id: row.id,
        committeeSystemCode: row.committeeSystemCode,
        inheritedFromParent:
          row.committeeSystemCode !== committee.systemCode &&
          row.committeeSystemCode === committee.parentSystemCode,
        hearingId: row.hearingId,
        updateType: row.updateType,
        title: row.normalizedTitle,
        summary: row.normalizedSummary,
        sourceUrl: row.sourceUrl,
        publishedAt: row.officialPublishedAt?.toISOString() ?? null,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        contentHash: row.contentHash,
        previousValue: row.previousValue,
        newValue: row.newValue,
      })),
      total: rows.length,
      asOf: new Date().toISOString(),
    };
  }

  private async loadDirectory(): Promise<DirectorySnapshot> {
    const now = new Date();
    const recentCutoff = new Date(now.getTime() - DIRECTORY_EVENT_WINDOW_DAYS * DAY_MS);
    const futureCutoff = new Date(now.getTime() + DIRECTORY_EVENT_WINDOW_DAYS * DAY_MS);

    const committees = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true },
      orderBy: [{ chamber: 'asc' }, { parentSystemCode: 'asc' }, { name: 'asc' }],
    });
    const codes = committees.map((row) => row.systemCode);

    const [events, sources] = await Promise.all([
      codes.length
        ? this.prisma.committeeHearing.findMany({
            where: {
              date: { gte: startOfUtcDay(recentCutoff), lte: startOfUtcDay(futureCutoff) },
              OR: [
                { committeeSystemCode: { in: codes } },
                { committeeCode: { in: codes } },
                { subcommitteeSystemCode: { in: codes } },
              ],
            },
            orderBy: [{ date: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
      codes.length
        ? this.prisma.committeeSource.findMany({
            where: { enabled: true, committeeSystemCode: { in: codes } },
            orderBy: [{ priority: 'asc' }, { lastSuccessAt: 'desc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    const sourceRows = sources as SourceRow[];
    const sourceIds = sourceRows.map((row) => row.id);
    const candidates = sourceIds.length
      ? ((await this.prisma.hearingStreamCandidate.findMany({
          where: { sourceId: { in: sourceIds } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        })) as CandidateObservation[])
      : [];

    const parentNameByCode = new Map(
      committees.map((row) => [normalizeCode(row.systemCode), row.name]),
    );
    const sourceByCode = new Map<string, SourceRow>();
    for (const source of sourceRows) {
      const code = normalizeCode(source.committeeSystemCode);
      if (code && !sourceByCode.has(code)) sourceByCode.set(code, source);
    }
    const candidateBySource = new Map<string, CandidateObservation>();
    for (const candidate of candidates) {
      if (candidate.sourceId && !candidateBySource.has(candidate.sourceId)) {
        candidateBySource.set(candidate.sourceId, candidate);
      }
    }

    const counts = new Map<string, { upcoming: number; recent: number; next: CommitteeEventSummary | null }>();
    const addEvent = (codeValue: string | null, event: (typeof events)[number]) => {
      const code = normalizeCode(codeValue);
      if (!code) return;
      const current = counts.get(code) ?? { upcoming: 0, recent: 0, next: null };
      const instant = event.startsAt ?? startOfUtcDay(event.date);
      const summary: CommitteeEventSummary = {
        id: event.id,
        title: event.title,
        date: dateOnly(event.date),
        startsAt: event.startsAt?.toISOString() ?? null,
        eventStatus: event.eventStatus,
        eventType: event.type,
      };
      if (instant.getTime() >= now.getTime()) {
        current.upcoming += 1;
        if (!current.next || eventSortInstant(summary) < eventSortInstant(current.next)) {
          current.next = summary;
        }
      } else {
        current.recent += 1;
      }
      counts.set(code, current);
    };
    for (const event of events) {
      // Parent rooms include their subcommittee proceedings; subcommittee rooms
      // additionally receive their own count.
      const identity = storedCommitteeIdentity(event);
      const eventCodes = new Set([
        normalizeCode(identity.committeeSystemCode),
        normalizeCode(identity.subcommitteeSystemCode),
      ]);
      for (const code of eventCodes) addEvent(code, event);
    }

    const rows = committees.map((committee): CommitteeDirectoryRow => {
      const code = normalizeCode(committee.systemCode);
      const directSource = sourceByCode.get(code);
      const inheritedSource = committee.parentSystemCode
        ? sourceByCode.get(normalizeCode(committee.parentSystemCode))
        : undefined;
      const source = directSource ?? inheritedSource;
      const candidate = source ? candidateBySource.get(source.id) : undefined;
      const eventCounts = counts.get(code) ?? { upcoming: 0, recent: 0, next: null };

      return {
        systemCode: committee.systemCode,
        thomasId: committee.thomasId,
        name: committee.name,
        chamber: committee.chamber,
        parentSystemCode: committee.parentSystemCode,
        parentName: committee.parentSystemCode
          ? parentNameByCode.get(normalizeCode(committee.parentSystemCode)) ?? null
          : null,
        officialUrl: committee.url,
        jurisdiction: committee.jurisdiction,
        isSubcommittee: Boolean(committee.parentSystemCode),
        lastSyncedAt: committee.lastSyncedAt.toISOString(),
        upcomingEventCount: eventCounts.upcoming,
        recentEventCount: eventCounts.recent,
        sourceHealth: source?.sourceHealth ?? 'unknown',
        lastSourceSuccessAt: source?.lastSuccessAt?.toISOString() ?? null,
        sourceId: source?.id ?? null,
        sourceUrl: source?.sourceUrl ?? null,
        sourceHealthInheritedFrom:
          !directSource && inheritedSource ? committee.parentSystemCode : null,
        ...(candidate
          ? {
              captureSupportObservation: candidate.capturePolicy,
              streamResolutionObservation: candidate.resolutionState,
            }
          : {}),
        nextEvent: eventCounts.next,
      };
    });

    return {
      rows,
      byCode: new Map(rows.map((row) => [normalizeCode(row.systemCode), row])),
      asOf: now.toISOString(),
    };
  }
}

function normalizeCode(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeRole(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function eventSortInstant(event: CommitteeEventSummary): number {
  const value = event.startsAt ?? `${event.date}T23:59:59.999Z`;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
