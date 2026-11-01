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
 * The selected tracker backend owns configuration: Core uses client_watchlist;
 * Intelligence uses intel_watchlist topics and terms. Core tags and unmapped
 * Intelligence criteria are reported explicitly as unsupported configuration.
 * The existing cross-schema Intelligence read requires both catalogs on the
 * selected database; deployment must verify target alignment and role access.
 * Every configuration query has tenant/client predicates. Current membership
 * and the canonical client wall are checked before and after reading coverage.
 */
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readTrackerClientScope, trackerMetricsClientId, TrackerMetricsError, type TenantContext, type TrackerMetricsBackend } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { LiveHearingsService } from './live-hearings.service.js';

/**
 * The Feed's own source-family vocabulary (bill | hearing | regulation |
 * program_element | state_bill — the web client's `FeedSourceType` minus its
 * `combined` aggregate). This was previously imported from the W2-4 backtest
 * matcher; that feature (watch presets + backtest) was removed, and the union
 * is declared here directly as a TYPE only — the coverage service never needs
 * a runtime array of the families.
 */
export type SignalFamily = 'bill' | 'hearing' | 'regulation' | 'program_element' | 'state_bill';

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
  backend: TrackerMetricsBackend;
  configuration: CoverageConfiguration;
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

interface CoverageConfiguration {
  model: 'client_watchlist' | 'intel_watchlist'; configured: boolean; complete: boolean;
  topicCount: number; tagCount: number; flatTermCount: number; issueAreaCount: number;
  reason: 'CORE_WATCHLIST_MODEL_UNSUPPORTED' | 'UNMAPPED_WATCHLIST_CONFIGURATION' | null;
}
type ConfiguredTopics = { topics: Array<{ id: string; label: string; families: SignalFamily[] }>; configuration: CoverageConfiguration };

@Injectable()
export class LegiWatchWave2CoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly liveHearings: LiveHearingsService,
  ) {}

  async watchlistCoverage(ctx: TenantContext, rawClientId: string, backend: TrackerMetricsBackend = 'intelligence'): Promise<WatchlistCoverageResponse> {
    try {
      const actor = { ...ctx }, clientId = trackerMetricsClientId(rawClientId);
      if (!['core', 'intelligence'].includes(backend)) throw new TrackerMetricsError('invalid_request');
      const before = await this.prisma.withTenant(actor.tenantId, tx => readTrackerClientScope(tx, actor, clientId));
      const configured = await this.loadConfiguredTopics(actor.tenantId, clientId, backend);
      const result = await this.calculateCoverage(clientId, backend, configured);
      const latest = await this.loadConfiguredTopics(actor.tenantId, clientId, backend);
      const after = await this.prisma.withTenant(actor.tenantId, tx => readTrackerClientScope(tx, actor, clientId));
      if (before !== after || JSON.stringify(configured) !== JSON.stringify(latest)) throw new TrackerMetricsError('scope_changed');
      return result;
    } catch (error) {
      if (error instanceof TrackerMetricsError && error.reason === 'invalid_request') throw new BadRequestException('Invalid coverage scope');
      if (error instanceof TrackerMetricsError && error.reason === 'client_not_readable') throw new NotFoundException('Client not found');
      throw new ServiceUnavailableException({ code: 'WATCHLIST_COVERAGE_UNAVAILABLE',
        reason: error instanceof TrackerMetricsError ? error.reason : 'source_unavailable', message: 'Watchlist coverage is unavailable. Please retry.' });
    }
  }

  private async calculateCoverage(clientId: string, backend: TrackerMetricsBackend, configured: ConfiguredTopics): Promise<WatchlistCoverageResponse> {
    const asOf = new Date();
    const { topics, configuration } = configured;
    if (!topics.length) {
      return {
        clientId, backend, configuration,
        asOf: asOf.toISOString(),
        overall: { coveredConcepts: 0, totalConcepts: 0, percentage: null, status: configuration.configured ? 'UNSUPPORTED' : 'NOT_CONFIGURED' },
        concepts: [],
        signalFamilies: [],
        sourceHealth: { healthy: 0, degraded: 0, failing: 0, stale: 0, acceptedExceptions: 0 },
        recommendations: [
          configuration.configured ? 'The saved watchlist is configured, but its criteria cannot be measured by the monitoring-topic coverage model.' :
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

    const overallStatus: OverallStatus = !configuration.complete ? 'PARTIAL' :
      coveredConcepts === totalConcepts ? 'COVERED' : coveredConcepts > 0 ? 'PARTIAL' :
        concepts.reduce<ConceptStatus>((status, concept) => worse(status, concept.status), 'COVERED');

    return {
      clientId, backend, configuration,
      asOf: asOf.toISOString(),
      overall: {
        coveredConcepts,
        totalConcepts,
        percentage: configuration.complete && totalConcepts > 0 ? Math.round((coveredConcepts / totalConcepts) * 100) : null,
        status: overallStatus,
      },
      concepts,
      signalFamilies,
      sourceHealth,
      recommendations: [...buildRecommendations(concepts), ...(!configuration.complete ?
        ['Saved flat terms or issue-area settings are not represented by the topic coverage denominator; a complete percentage is unavailable.'] : [])],
    };
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
    backend: TrackerMetricsBackend,
  ): Promise<ConfiguredTopics> {
    if (backend === 'core') {
      const saved = await this.prisma.withTenant(tenantId, tx => tx.clientWatchlist.findFirst({
        where: { tenantId, clientId }, select: { tags: true, issueAreas: true },
      }));
      if (saved && !Array.isArray(saved.tags)) throw new TrackerMetricsError('source_unavailable');
      const tagCount = saved ? (saved.tags as unknown[]).length : 0, issueAreaCount = saved?.issueAreas.length ?? 0;
      const configured = tagCount + issueAreaCount > 0;
      return { topics: [], configuration: { model: 'client_watchlist', configured, complete: !configured,
        topicCount: 0, tagCount, flatTermCount: 0, issueAreaCount,
        reason: configured ? 'CORE_WATCHLIST_MODEL_UNSUPPORTED' : null } };
    }
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; label: string; termTypes: string[]; jurisdictions: string[] }>>(
        `SELECT t.id, t.label, w.jurisdictions,
                COALESCE(array_agg(DISTINCT term.term_type ORDER BY term.term_type) FILTER (WHERE term.term_type IS NOT NULL), ARRAY[]::text[]) AS "termTypes"
         FROM intel_watchlist_topic t
         JOIN intel_watchlist w ON w.id = t.watchlist_id AND w.tenant_id=t.tenant_id
         LEFT JOIN intel_watchlist_term term ON term.topic_id = t.id AND term.tenant_id=w.tenant_id AND term.watchlist_id=w.id
         WHERE w.tenant_id = $1 AND w.client_id = $2 AND w.active = true
         GROUP BY t.id, t.label, w.jurisdictions
         ORDER BY t.label ASC, t.id ASC`,
        tenantId,
        clientId,
      ),
    );
    const settings = await this.prisma.withSystem(tx => tx.$queryRawUnsafe<Array<{ issueAreas: string[]; flatTermCount: string }>>(
      `SELECT w.issue_areas AS "issueAreas", count(term.id)::text AS "flatTermCount"
       FROM intel_watchlist w LEFT JOIN intel_watchlist_term term ON term.watchlist_id=w.id
         AND term.tenant_id=w.tenant_id AND term.topic_id IS NULL
       WHERE w.tenant_id=$1 AND w.client_id=$2 AND w.active=true
       GROUP BY w.id, w.issue_areas ORDER BY w.id`, tenantId, clientId,
    ));
    const flatTermCount = settings.reduce((sum, row) => sum + Number(row.flatTermCount), 0);
    if (!Number.isSafeInteger(flatTermCount) || flatTermCount < 0) throw new TrackerMetricsError('source_unavailable');
    const issueAreaCount = settings.reduce((sum, row) => sum + row.issueAreas.length, 0);
    const complete = flatTermCount === 0 && issueAreaCount === 0;
    const topics = rows.map((r) => ({
      id: r.id,
      label: r.label,
      families: [
        ...new Set(r.termTypes.flatMap((type): SignalFamily[] => type === 'bill' && r.jurisdictions.length ?
          [...(r.jurisdictions.includes('US') ? ['bill' as const] : []), ...(r.jurisdictions.some(j => j !== 'US') ? ['state_bill' as const] : [])] :
          TERM_TYPE_TO_FAMILIES[type] ?? [])),
      ],
    }));
    return { topics, configuration: { model: 'intel_watchlist', configured: topics.length + flatTermCount + issueAreaCount > 0,
      complete, topicCount: topics.length, tagCount: 0, flatTermCount, issueAreaCount,
      reason: complete ? null : 'UNMAPPED_WATCHLIST_CONFIGURATION' } };
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
