/**
 * LegiWatch V2 Wave 2 (W2-5) — watchlist coverage score.
 *
 * Closes GAPS LW-G3 (no server coverage score) and LW-G5 (no per-source
 * telemetry) together — they were two faces of one missing capability, not
 * two separate builds. LW-G7 tags four distinct analytics aggregates in
 * AnalyticsTab; this endpoint closes only its coverage-tile/coverage-panel
 * share of that tag. Signal-volume time series, the client exposure matrix,
 * and issue momentum have no server aggregate and remain open.
 *
 * Honest by construction: the response always states an explicit numerator
 * (`coveredConcepts`) and denominator (`totalConcepts`); a client with no
 * configured monitoring returns `NOT_CONFIGURED`, never `0%`.
 *
 * ── reuses two existing systems, builds neither twice ──
 *
 * "Configured monitoring concept" = `WatchlistTopic` (intel-api). Per the
 * audit, `label` is already that model's real identity key everywhere
 * downstream (the compiler groups by it, the mapper dedupes by it), so it is
 * the natural `conceptId`.
 *
 * "Source health" = the EXISTING `CommitteeSource`/`CommitteeSourceException`
 * system (`LiveHearingsService.coverage()`), reused directly for the
 * `hearing` family rather than a second telemetry model.
 *
 * ── the one cross-service read, and why it is safe ──
 *
 * `WatchlistTopic`/`WatchlistTerm` live in intel-api's own Prisma schema, not
 * apps/api's — but both services run against the SAME physical Postgres
 * database (the established disposable-DB testing convention documents this
 * directly), and this codebase already has a precedent for exactly this kind
 * of read: `TrackerWatchlistService.assertClientInTenant` (intel-api) reads
 * apps/api-owned `clients`/`tenant_memberships`/`users` via `withSystem` +
 * raw SQL for the identical reason. This service does the mirror-image read
 * — apps/api reading intel-api-owned `intel_watchlist`/`intel_watchlist_topic`
 * — the same way: `withSystem` (RLS bypass, since intel-api's RLS policies are
 * not guaranteed to exist under apps/api's role) with an explicit
 * `tenant_id = $1` predicate in every query, never omitted.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import type { SignalFamily } from './legiwatch-wave2-watch-backtest-matcher.js';

export type ConceptStatus = 'COVERED' | 'PARTIAL' | 'UNSUPPORTED' | 'STALE' | 'UNAVAILABLE';
export type OverallStatus = ConceptStatus | 'NOT_CONFIGURED';

/** A concept (WatchlistTopic) is stale once its family's data is older than this. */
const FRESHNESS_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `termType` (intel_watchlist_term, a MATCH-TARGET taxonomy) → `SignalFamily`
 * (a SOURCE taxonomy, the Feed's own `FeedSourceType`). These are genuinely
 * different vocabularies for different purposes, so the map is intentionally
 * partial: a termType with no confident family mapping contributes nothing,
 * rather than a guessed one this service cannot back with real source data.
 */
const TERM_TYPE_TO_FAMILIES: Record<string, SignalFamily[]> = {
  bill: ['bill'],
  committee: ['hearing'],
  agency: ['hearing', 'regulation'],
};

interface FamilyFreshness {
  family: SignalFamily;
  lastObservedAt: Date | null;
  /** Only meaningful for `hearing`, which reuses CommitteeSource's own enum. */
  sourceHealthSummary?: { healthy: number; degraded: number; failing: number; unknown: number };
  acceptedExceptions?: number;
}

export interface ConceptCoverage {
  conceptId: string;
  label: string;
  signalFamilies: SignalFamily[];
  status: ConceptStatus;
  supportingSources: string[];
  gaps: string[];
  lastObservedAt: string | null;
}

export interface SignalFamilyCoverage {
  family: SignalFamily;
  configuredConcepts: number;
  coveredConcepts: number;
  status: ConceptStatus;
}

export interface WatchlistCoverageResponse {
  clientId: string;
  asOf: string;
  overall: {
    coveredConcepts: number;
    totalConcepts: number;
    percentage: number | null;
    status: OverallStatus;
  };
  concepts: ConceptCoverage[];
  signalFamilies: SignalFamilyCoverage[];
  sourceHealth: {
    healthy: number;
    degraded: number;
    failing: number;
    stale: number;
    acceptedExceptions: number;
  };
  recommendations: string[];
}

@Injectable()
export class LegiWatchWave2CoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveHearings: LiveHearingsService,
  ) {}

  async watchlistCoverage(tenantId: string, clientId: string): Promise<WatchlistCoverageResponse> {
    await this.assertClientInTenant(tenantId, clientId);
    const asOf = new Date();

    const topics = await this.loadConfiguredTopics(tenantId, clientId);
    if (!topics.length) {
      return {
        clientId,
        asOf: asOf.toISOString(),
        overall: { coveredConcepts: 0, totalConcepts: 0, percentage: null, status: 'NOT_CONFIGURED' },
        concepts: [],
        signalFamilies: [],
        sourceHealth: { healthy: 0, degraded: 0, failing: 0, stale: 0, acceptedExceptions: 0 },
        recommendations: [
          'No monitoring concepts are configured for this client yet. Configure the watchlist to see coverage.',
        ],
      };
    }

    const families = [...new Set(topics.flatMap((t) => t.families))];
    const freshnessByFamily = new Map<SignalFamily, FamilyFreshness>();
    for (const family of families) {
      freshnessByFamily.set(family, await this.loadFreshness(family));
    }

    const concepts: ConceptCoverage[] = topics.map((topic) => {
      if (!topic.families.length) {
        return {
          conceptId: topic.id,
          label: topic.label,
          signalFamilies: [],
          status: 'UNSUPPORTED',
          supportingSources: [],
          gaps: [
            `"${topic.label}" is configured with term types this coverage model does not map to a known signal family yet.`,
          ],
          lastObservedAt: null,
        };
      }

      const perFamily = topic.families.map((f) => freshnessByFamily.get(f)!);
      const gaps: string[] = [];
      const supportingSources: string[] = [];
      let worst: ConceptStatus = 'COVERED';

      for (const fam of perFamily) {
        if (fam.family === 'hearing' && fam.sourceHealthSummary) {
          const h = fam.sourceHealthSummary;
          supportingSources.push(`${h.healthy} healthy committee source(s)`);
          if (h.healthy === 0 && h.degraded === 0) {
            worst = worse(worst, 'UNAVAILABLE');
            gaps.push('No healthy or degraded committee sources are currently available.');
          } else if (h.failing > 0 || h.degraded > 0) {
            worst = worse(worst, 'PARTIAL');
            gaps.push(`${h.failing} committee source(s) are failing, ${h.degraded} degraded.`);
          }
        } else if (fam.lastObservedAt) {
          const age = asOf.getTime() - fam.lastObservedAt.getTime();
          if (age > FRESHNESS_THRESHOLD_MS) {
            worst = worse(worst, 'STALE');
            gaps.push(
              `${fam.family} data was last refreshed ${Math.round(age / 86_400_000)} day(s) ago.`,
            );
          } else {
            supportingSources.push(`${fam.family} sync`);
          }
        } else {
          worst = worse(worst, 'UNAVAILABLE');
          gaps.push(`No sync history is available for ${fam.family}.`);
        }
      }

      return {
        conceptId: topic.id,
        label: topic.label,
        signalFamilies: topic.families,
        status: worst,
        supportingSources,
        gaps,
        lastObservedAt: perFamily
          .map((f) => f.lastObservedAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0]
          ?.toISOString() ?? null,
      };
    });

    const coveredConcepts = concepts.filter((c) => c.status === 'COVERED').length;
    const totalConcepts = concepts.length;

    const signalFamilies: SignalFamilyCoverage[] = families.map((family) => {
      const relevant = concepts.filter((c) => c.signalFamilies.includes(family));
      const covered = relevant.filter((c) => c.status === 'COVERED').length;
      return {
        family,
        configuredConcepts: relevant.length,
        coveredConcepts: covered,
        status: covered === relevant.length ? 'COVERED' : covered > 0 ? 'PARTIAL' : 'UNAVAILABLE',
      };
    });

    const hearingFreshness = freshnessByFamily.get('hearing');
    const sourceHealth = {
      healthy: hearingFreshness?.sourceHealthSummary?.healthy ?? 0,
      degraded: hearingFreshness?.sourceHealthSummary?.degraded ?? 0,
      failing: hearingFreshness?.sourceHealthSummary?.failing ?? 0,
      stale: concepts.filter((c) => c.status === 'STALE').length,
      acceptedExceptions: hearingFreshness?.acceptedExceptions ?? 0,
    };

    const overallStatus: OverallStatus =
      coveredConcepts === totalConcepts
        ? 'COVERED'
        : concepts.some((c) => c.status === 'UNAVAILABLE')
          ? 'PARTIAL'
          : coveredConcepts > 0
            ? 'PARTIAL'
            : 'UNSUPPORTED';

    return {
      clientId,
      asOf: asOf.toISOString(),
      overall: {
        coveredConcepts,
        totalConcepts,
        percentage: totalConcepts > 0 ? Math.round((coveredConcepts / totalConcepts) * 100) : null,
        status: overallStatus,
      },
      concepts,
      signalFamilies,
      sourceHealth,
      recommendations: buildRecommendations(concepts),
    };
  }

  private async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!found) throw new NotFoundException('Client not found');
  }

  /**
   * Cross-service read of this client's configured watchlist topics, with the
   * signal families each topic's OWN terms map to. See the file header for
   * why `withSystem` + an explicit tenant_id predicate is the correct,
   * precedented way to do this.
   */
  private async loadConfiguredTopics(
    tenantId: string,
    clientId: string,
  ): Promise<Array<{ id: string; label: string; families: SignalFamily[] }>> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; label: string; termTypes: string[] }>>(
        `SELECT t.id, t.label,
                COALESCE(array_agg(DISTINCT term.term_type) FILTER (WHERE term.term_type IS NOT NULL), ARRAY[]::text[]) AS "termTypes"
         FROM intel_watchlist_topic t
         JOIN intel_watchlist w ON w.id = t.watchlist_id
         LEFT JOIN intel_watchlist_term term ON term.topic_id = t.id
         WHERE w.tenant_id = $1 AND w.client_id = $2 AND w.active = true
         GROUP BY t.id, t.label
         ORDER BY t.label ASC`,
        tenantId,
        clientId,
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      families: [
        ...new Set(r.termTypes.flatMap((type) => TERM_TYPE_TO_FAMILIES[type] ?? [])),
      ],
    }));
  }

  private async loadFreshness(family: SignalFamily): Promise<FamilyFreshness> {
    if (family === 'hearing') {
      const coverage = await this.liveHearings.coverage();
      const summary = coverage.summary;
      // Accepted-exception count reuses the SAME pattern Phase 9 readiness
      // already established (LEFT JOIN ... WHERE expires_at IS NULL) rather
      // than inventing a second exception-consuming query.
      const [exceptions] = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count
         FROM committee_source_exception
         WHERE expires_at IS NULL`,
      );
      const [lastSuccess] = await this.prisma.$queryRawUnsafe<Array<{ lastSuccessAt: Date | null }>>(
        `SELECT max(last_success_at) AS "lastSuccessAt" FROM committee_source`,
      );
      return {
        family,
        lastObservedAt: lastSuccess?.lastSuccessAt ?? null,
        sourceHealthSummary: {
          healthy: summary.healthy,
          degraded: summary.degraded,
          failing: summary.failing,
          unknown: summary.unknown,
        },
        acceptedExceptions: exceptions?.count ?? 0,
      };
    }

    const syncSourceByFamily: Partial<Record<SignalFamily, string>> = {
      bill: 'sync-congress',
      regulation: 'sync-federal-register',
      state_bill: 'sync-openstates',
    };

    if (family === 'program_element') {
      // No single SyncRun source name covers the fragmented PE ingestion
      // pipeline; the real "when did this data last move" signal is the
      // computed delta itself, not a sync timestamp.
      const [row] = await this.prisma.$queryRawUnsafe<Array<{ lastObservedAt: Date | null }>>(
        `SELECT max(computed_at) AS "lastObservedAt" FROM program_element_delta WHERE superseded_at IS NULL`,
      );
      return { family, lastObservedAt: row?.lastObservedAt ?? null };
    }

    const source = syncSourceByFamily[family];
    if (!source) return { family, lastObservedAt: null };
    const [row] = await this.prisma.$queryRawUnsafe<Array<{ lastObservedAt: Date | null }>>(
      `SELECT max(finished_at) AS "lastObservedAt" FROM sync_run WHERE source = $1 AND status = 'success'`,
      source,
    );
    return { family, lastObservedAt: row?.lastObservedAt ?? null };
  }
}

function worse(a: ConceptStatus, b: ConceptStatus): ConceptStatus {
  const rank: Record<ConceptStatus, number> = {
    COVERED: 0,
    PARTIAL: 1,
    STALE: 2,
    UNSUPPORTED: 3,
    UNAVAILABLE: 4,
  };
  return rank[b] > rank[a] ? b : a;
}

function buildRecommendations(concepts: ConceptCoverage[]): string[] {
  const recommendations: string[] = [];
  const unsupported = concepts.filter((c) => c.status === 'UNSUPPORTED');
  if (unsupported.length) {
    recommendations.push(
      `${unsupported.length} concept(s) use term types this coverage model cannot map to a signal family: ${unsupported.map((c) => c.label).join(', ')}.`,
    );
  }
  const unavailable = concepts.filter((c) => c.status === 'UNAVAILABLE');
  if (unavailable.length) {
    recommendations.push(
      `${unavailable.length} concept(s) have no available source data right now: ${unavailable.map((c) => c.label).join(', ')}.`,
    );
  }
  const stale = concepts.filter((c) => c.status === 'STALE');
  if (stale.length) {
    recommendations.push(
      `${stale.length} concept(s) are backed by stale data: ${stale.map((c) => c.label).join(', ')}.`,
    );
  }
  return recommendations;
}
