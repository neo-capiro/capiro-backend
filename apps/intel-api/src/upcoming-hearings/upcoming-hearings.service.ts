import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { LiveHearingSourceType, Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SourceDataRepository,
  type UpcomingCommitteeHearing,
} from '../sourcedata/source-data.repository.js';

export interface UpcomingHearing {
  id: string;
  title: string;
  committee: string;
  chamber: string;
  scheduledAt: string;
  time?: string | null;
  type?: string | null;
  location?: string | null;
  url?: string | null;
  sessionId?: string | null;
  sessionStatus?: string | null;
  watchlistMatchCount: number;
  recapSaved: boolean;
}

type BaseHearing = Omit<
  UpcomingHearing,
  'sessionId' | 'sessionStatus' | 'watchlistMatchCount' | 'recapSaved'
>;

const PUBLIC_SOURCE_TYPES = [LiveHearingSourceType.hearing, LiveHearingSourceType.markup] as const;

@Injectable()
export class UpcomingHearingsService {
  private readonly logger = new Logger(UpcomingHearingsService.name);
  private cache: { at: number; data: BaseHearing[] } | null = null;
  private readonly ttlMs = 15 * 60 * 1000;
  private readonly limit = 50;

  constructor(
    private readonly source: SourceDataRepository,
    private readonly prisma: PrismaService,
  ) {}

  async list(tenantId: string, userId: string): Promise<UpcomingHearing[]> {
    let data: BaseHearing[];
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) {
      data = this.cache.data;
    } else {
      try {
        data = (await this.source.getUpcomingCommitteeHearings(this.limit)).map(toUpcoming);
        this.cache = { at: Date.now(), data };
      } catch (err) {
        this.logger.error(`upcoming hearings read failed: ${(err as Error).message}`);
        if (!this.cache)
          throw new ServiceUnavailableException('Hearing schedule is temporarily unavailable');
        data = this.cache.data;
      }
    }
    return this.decorate(tenantId, userId, data);
  }

  async browse(
    tenantId: string,
    userId: string,
    opts: {
      search?: string | null;
      chamber?: string | null;
      scope?: string | null;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: UpcomingHearing[]; total: number }> {
    const scope = opts.scope === 'past' || opts.scope === 'all' ? opts.scope : 'upcoming';
    const limit = clamp(opts.limit ?? 25, 1, 100);
    const offset = Math.max(0, opts.offset ?? 0);
    try {
      const { rows, total } = await this.source.searchCommitteeHearings({
        search: opts.search ?? null,
        chamber: opts.chamber ?? null,
        scope,
        limit,
        offset,
      });
      return { items: await this.decorate(tenantId, userId, rows.map(toUpcoming)), total };
    } catch (err) {
      this.logger.error(`hearings browse failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Hearing archive is temporarily unavailable');
    }
  }

  private async decorate(
    tenantId: string,
    userId: string,
    hearings: BaseHearing[],
  ): Promise<UpcomingHearing[]> {
    const hearingIds = hearings.map((row) => row.id);
    if (!hearingIds.length) return [];
    const sessions = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findMany({
        where: {
          tenantId,
          hearingId: { in: hearingIds },
          OR: [{ sourceType: { in: [...PUBLIC_SOURCE_TYPES] } }, { createdBy: userId }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, hearingId: true, status: true, createdAt: true },
      }),
    );
    const latestByHearing = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      if (session.hearingId && !latestByHearing.has(session.hearingId)) {
        latestByHearing.set(session.hearingId, session);
      }
    }
    const sessionIds = [...latestByHearing.values()].map((row) => row.id);
    const [matchCounts, recapRows] = sessionIds.length
      ? await this.prisma.withTenant(tenantId, (tx) =>
          Promise.all([
            tx.watchlistMatch.groupBy({
              by: ['sessionId'],
              where: { tenantId, sessionId: { in: sessionIds } },
              _count: { _all: true },
            }),
            tx.$queryRaw<Array<{ sessionId: string }>>(Prisma.sql`
              SELECT DISTINCT source_entity_id AS "sessionId"
              FROM engagement_attachments
              WHERE tenant_id::text = ${tenantId}
                AND source = 'hearing_recap'
                AND source_entity_type = 'hearing_session'
                AND source_entity_id IN (${Prisma.join(sessionIds)})
                AND superseded_by_attachment_id IS NULL
                AND lifecycle_status NOT IN ('delete_pending', 'delete_failed', 'blocked')
            `),
          ]),
        )
      : [[], []];
    const countBySession = new Map(matchCounts.map((row) => [row.sessionId, row._count._all]));
    const recapSessions = new Set(recapRows.map((row) => row.sessionId));
    return hearings.map((row) => {
      const session = latestByHearing.get(row.id);
      return {
        ...row,
        sessionId: session?.id ?? null,
        sessionStatus: session?.status ?? null,
        watchlistMatchCount: session ? (countBySession.get(session.id) ?? 0) : 0,
        recapSaved: session ? recapSessions.has(session.id) : false,
      };
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n) || lo));
}

function toUpcoming(r: UpcomingCommitteeHearing): BaseHearing {
  return {
    id: r.id,
    title: robustTitle(r),
    committee: r.committeeName?.trim() || 'Committee',
    chamber: r.chamber?.trim() || '',
    scheduledAt: dateOnly(r.date),
    time: r.time ?? null,
    type: r.type ?? null,
    location: r.location ?? null,
    url: r.url ?? null,
  };
}

function dateOnly(d: Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

const GENERIC_TITLES = new Set([
  '(untitled)',
  'hearing',
  'hearings',
  'markup',
  'markup session',
  'meeting',
  'business meeting',
  'open hearing',
  'closed hearing',
  'open business meeting',
  'closed business meeting',
  'field hearing',
  'committee meeting',
  'organizational meeting',
]);

function robustTitle(r: UpcomingCommitteeHearing): string {
  const raw = (r.title ?? '').trim();
  const statusMatch = raw.match(/^(\[[^\]]+\]\s*)/);
  const statusPrefix = statusMatch?.[1] ?? '';
  const body = raw.slice(statusPrefix.length).trim();
  const normalized = body.toLowerCase().replace(/[.\s]+$/, '');
  if (body && !GENERIC_TITLES.has(normalized)) return raw;
  const committee = r.committeeName?.trim() || 'Committee';
  return `${statusPrefix}${prettyType(r.type)}: ${committee}`.trim();
}

function prettyType(type: string | null): string {
  const t = (type ?? '').trim().toLowerCase();
  if (t.includes('markup')) return 'Markup';
  if (t.includes('hearing')) return 'Hearing';
  if (t.includes('meeting')) return 'Meeting';
  return 'Meeting';
}
