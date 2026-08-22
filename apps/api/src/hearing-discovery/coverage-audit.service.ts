/**
 * Coverage audit — the honest answer to "which congressional bodies can we
 * actually cover?"
 *
 * The trap this exists to avoid: the central Congress.gov calendar working is
 * NOT the same as covering 46 committees. A body is only covered to the extent
 * that (a) a registered source for it is healthy, (b) events for it are actually
 * being discovered, and (c) a stream for those events can be found. Each of
 * those is measured separately here, and the per-body status is derived from the
 * measurements — never asserted.
 *
 * Statuses:
 *   HEALTHY                  events discovered AND every registered source healthy
 *   DEGRADED                 events discovered, but a source is failing/stale
 *   CUSTOM_ADAPTER_REQUIRED  sources fetch fine but yield nothing parseable
 *   REVIEW_REQUIRED          no source registered, or no official URL to register
 *   UNAVAILABLE              every registered source is failing
 *
 * `serverCaptureAllowed` is reported as false for every body in Phase 3, and
 * that is correct rather than pessimistic: discovery never grants a capture
 * policy (see `stream-candidate.repository.ts`), so until Phase 4's resolver
 * runs, nothing is server-capturable. Reporting it as true here would be the
 * exact kind of unearned claim this audit is meant to catch.
 */
import type { PrismaClient } from '@prisma/client';
import { CommitteeSourceRepository, DEGRADED_GRACE_MS } from './committee-source.repository.js';
import { SourceRegistryService, type CommitteeBody } from './source-registry.service.js';
import type { Chamber } from './hearing-discovery.types.js';

export type CoverageStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'CUSTOM_ADAPTER_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'UNAVAILABLE';

export interface BodyCoverage {
  systemCode: string;
  committee: string;
  chamber: Chamber;
  /** The best-priority source registered for this body. */
  selectedSource: string | null;
  adapterKey: string | null;
  schedulePage: string | null;
  lastSuccessAt: Date | null;
  sourcesRegistered: number;
  sourcesHealthy: number;
  sourcesFailing: number;
  /** Canonical hearings on file for this body in the audit window. */
  hearingsDiscovered: number;
  /** Upcoming canonical hearings — the number the product actually shows. */
  upcomingHearings: number;
  /** Observations recorded for this body's hearings (provenance depth). */
  observations: number;
  canDiscoverEvents: boolean;
  canResolveStreams: boolean;
  /** Always false in Phase 3 — no capture policy is granted by discovery. */
  serverCaptureAllowed: boolean;
  status: CoverageStatus;
  reason: string;
}

export interface CoverageReport {
  generatedAt: Date;
  windowDays: number;
  bodies: BodyCoverage[];
  totals: Record<CoverageStatus, number> & { bodies: number };
  /** Bodies needing a specific adapter task, with the reason. */
  unsupported: Array<{
    systemCode: string;
    committee: string;
    status: CoverageStatus;
    reason: string;
  }>;
}

export class CoverageAuditService {
  private readonly sources: CommitteeSourceRepository;
  private readonly registry: SourceRegistryService;

  constructor(
    private readonly prisma: PrismaClient,
    deps?: { sources?: CommitteeSourceRepository; registry?: SourceRegistryService },
  ) {
    this.sources = deps?.sources ?? new CommitteeSourceRepository(prisma);
    this.registry = deps?.registry ?? new SourceRegistryService(prisma);
  }

  async run(opts: { now?: Date; windowDays?: number } = {}): Promise<CoverageReport> {
    const now = opts.now ?? new Date();
    const windowDays = opts.windowDays ?? 60;
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

    const [bodies, allSources] = await Promise.all([
      this.registry.listBodies(),
      this.sources.listAll(),
    ]);

    // Central sources cover every body in their chamber, so they count toward a
    // body's health even though they carry no committee_system_code.
    const central = allSources.filter((s) => s.committeeSystemCode == null);

    const bodyReports: BodyCoverage[] = [];
    for (const body of bodies) {
      const own = allSources.filter((s) => s.committeeSystemCode === body.systemCode);
      const applicable = [
        ...own,
        ...central.filter((s) => s.chamber === body.chamber || s.chamber === 'joint'),
      ];
      const counts = await this.measureBody(body, windowStart, now);
      bodyReports.push(this.classify(body, own, applicable, counts, now));
    }

    const totals = bodyReports.reduce(
      (acc, b) => {
        acc[b.status] += 1;
        return acc;
      },
      {
        HEALTHY: 0,
        DEGRADED: 0,
        CUSTOM_ADAPTER_REQUIRED: 0,
        REVIEW_REQUIRED: 0,
        UNAVAILABLE: 0,
        bodies: bodyReports.length,
      } as CoverageReport['totals'],
    );

    return {
      generatedAt: now,
      windowDays,
      bodies: bodyReports,
      totals,
      unsupported: bodyReports
        .filter((b) => b.status !== 'HEALTHY')
        .map((b) => ({
          systemCode: b.systemCode,
          committee: b.committee,
          status: b.status,
          reason: b.reason,
        })),
    };
  }

  /**
   * Count what we can actually see for this body. Matches on either the new
   * canonical `committee_system_code` or the legacy `committee_code` — the
   * pre-existing sync populates the latter, and ignoring it would under-report
   * coverage that genuinely exists.
   */
  private async measureBody(
    body: CommitteeBody,
    windowStart: Date,
    now: Date,
  ): Promise<{
    hearingsDiscovered: number;
    upcomingHearings: number;
    observations: number;
    streamCandidates: number;
  }> {
    const codeMatch = {
      OR: [{ committeeSystemCode: body.systemCode }, { committeeCode: body.systemCode }],
    };
    const [hearingsDiscovered, upcomingHearings, hearingIds] = await Promise.all([
      this.prisma.committeeHearing.count({ where: { ...codeMatch, date: { gte: windowStart } } }),
      this.prisma.committeeHearing.count({
        where: { ...codeMatch, date: { gte: startOfDay(now) } },
      }),
      this.prisma.committeeHearing.findMany({
        where: { ...codeMatch, date: { gte: windowStart } },
        select: { id: true },
        take: 2000,
      }),
    ]);
    const ids = hearingIds.map((h) => h.id);
    const [observations, streamCandidates] = await Promise.all([
      ids.length
        ? this.prisma.hearingSourceObservation.count({ where: { hearingId: { in: ids } } })
        : Promise.resolve(0),
      ids.length
        ? this.prisma.hearingStreamCandidate.count({ where: { hearingId: { in: ids } } })
        : Promise.resolve(0),
    ]);
    return { hearingsDiscovered, upcomingHearings, observations, streamCandidates };
  }

  /** Derive the status from the measurements. Every branch names its reason. */
  private classify(
    body: CommitteeBody,
    ownSources: Awaited<ReturnType<CommitteeSourceRepository['listAll']>>,
    applicableSources: Awaited<ReturnType<CommitteeSourceRepository['listAll']>>,
    counts: {
      hearingsDiscovered: number;
      upcomingHearings: number;
      observations: number;
      streamCandidates: number;
    },
    now: Date,
  ): BodyCoverage {
    const best = applicableSources.slice().sort((a, b) => a.priority - b.priority)[0] ?? null;
    const healthy = applicableSources.filter((s) => s.sourceHealth === 'healthy').length;
    const failing = applicableSources.filter((s) => s.sourceHealth === 'failing').length;
    const staleOwn = ownSources.filter(
      (s) =>
        s.lastSuccessAt == null || now.getTime() - s.lastSuccessAt.getTime() > DEGRADED_GRACE_MS,
    ).length;

    const canDiscoverEvents = counts.hearingsDiscovered > 0;
    const canResolveStreams = counts.streamCandidates > 0;

    let status: CoverageStatus;
    let reason: string;

    if (applicableSources.length === 0) {
      status = 'REVIEW_REQUIRED';
      reason = 'no committee_source registered for this body or its chamber';
    } else if (ownSources.length === 0 && !body.url) {
      status = 'REVIEW_REQUIRED';
      reason =
        'congress_committee has no official URL, so no committee-site source can be registered; central feeds only';
    } else if (failing === applicableSources.length) {
      status = 'UNAVAILABLE';
      reason = `all ${applicableSources.length} applicable sources are failing (last error: ${
        best?.lastError ?? 'unknown'
      })`;
    } else if (!canDiscoverEvents && healthy > 0) {
      // Sources fetch cleanly yet nothing lands: either the body genuinely held
      // no events in the window, or its publishing format defeats the generic
      // parser. Distinguishing those needs a human/adapter, which is the point
      // of this status.
      status = 'CUSTOM_ADAPTER_REQUIRED';
      reason =
        'sources fetch successfully but no events were discovered for this body in the audit window';
    } else if (failing > 0 || staleOwn > 0) {
      status = 'DEGRADED';
      reason =
        failing > 0
          ? `${failing} of ${applicableSources.length} applicable sources failing`
          : `${staleOwn} committee-level source(s) have no recent success`;
    } else {
      status = 'HEALTHY';
      reason = `${counts.hearingsDiscovered} hearing(s) discovered in window, all sources healthy`;
    }

    return {
      systemCode: body.systemCode,
      committee: body.name,
      chamber: body.chamber,
      selectedSource: best?.sourceUrl ?? null,
      adapterKey: best?.adapterKey ?? null,
      schedulePage: body.url,
      lastSuccessAt: best?.lastSuccessAt ?? null,
      sourcesRegistered: applicableSources.length,
      sourcesHealthy: healthy,
      sourcesFailing: failing,
      hearingsDiscovered: counts.hearingsDiscovered,
      upcomingHearings: counts.upcomingHearings,
      observations: counts.observations,
      canDiscoverEvents,
      canResolveStreams,
      // Phase 3 grants no capture policy; see the module header.
      serverCaptureAllowed: false,
      status,
      reason,
    };
  }
}

/** UTC-midnight of `d` — the `@db.Date` comparison boundary. */
function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
