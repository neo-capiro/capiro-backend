import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { EngagementTaskStatus } from '@prisma/client';
import {
  AGENCY_SECTOR_MAP,
  ldaCodesForSectors,
  normalizeSector,
  type SectorTag,
  deriveRuleLifecycleStage,
  RULE_LIFECYCLE_STAGES,
  billStage,
  passageProbability,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMBEDDING_MODEL, embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import { toCanonicalAlert } from './canonical-alert.adapter.js';
import { classifyTrajectory } from './trajectory-classifier.model.js';
import { addDateInZone, dateBoundsInZone, dayBoundsInZone } from './time-bounds.js';
import { FEC_DISCLAIMER } from './fec-disclaimer.js';
import { expandTerms, isKnownAcronym, MIN_KEYWORD_TOKEN_LENGTH } from './term-expansion.js';
import { commentDeadlineDedupeKey } from './comment-deadline.util.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import type { OfficeRecommendation } from './office-recommender.service.js';

/**
 * Normalized internal shape every "Top alerts" source emits. `_urgencyScore` and
 * `_typeRank` are sort-only and stripped before the payload leaves the service.
 */
type AlertRow = {
  id: string;
  type: string;
  severity: string;
  title: string;
  subtitle: string;
  when: string;
  countdownDays: number | null;
  countdownLabel: string | null;
  href: string | null;
  _urgencyScore: number;
  _typeRank: number;
};

/**
 * Cosine-similarity floors for tracked-bill embedding matches.
 *
 * DEFAULT is used when the client supplies sharp signal (capability keywords).
 * THIN_SIGNAL is the tighter floor for clients with NO capabilities, whose
 * query is just broad LDA issue-code names: at 0.65 those broad queries let
 * semantically-adjacent but topically-wrong bills slip in (e.g. a baby-bottle
 * "Equipment Screening" bill matching a defense client's screening/sensor
 * semantics). Requiring a stronger match for thin-signal clients cuts those
 * false positives, while clients that supply capability keywords keep the
 * looser floor since their query is already specific.
 */
export const TRACKED_BILL_SIMILARITY_FLOOR = 0.65;
export const THIN_SIGNAL_SIMILARITY_FLOOR = 0.75;

/** Pick the embedding similarity floor based on whether the client has capability signal. */
export function embeddingSimilarityFloor(hasCapabilitySignal: boolean): number {
  return hasCapabilitySignal ? TRACKED_BILL_SIMILARITY_FLOOR : THIN_SIGNAL_SIMILARITY_FLOOR;
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  // Short-TTL in-memory cache for the cross-client portfolio alerts roll-up.
  // The roll-up runs the full per-client profile-v1 aggregate for every active
  // client, so it is expensive; the dashboard polls it on load. A 2-minute TTL
  // keyed by tenant+user (worklist state is per-user) keeps repeat loads cheap
  // without serving stale alerts for long. Process-local is fine: it is a
  // best-effort read cache, not a source of truth.
  private readonly portfolioAlertsCache = new Map<string, { expiresAt: number; value: unknown }>();
  private static readonly PORTFOLIO_ALERTS_TTL_MS = 2 * 60 * 1000;

  // In-flight dedupe: concurrent callers with the same cache key share ONE
  // computation instead of each launching their own N-client roll-up (which
  // multiplied connection-pool pressure and caused tenant-wide 500s).
  private readonly portfolioAlertsInflight = new Map<string, Promise<unknown>>();
  // Process-wide serialization: only ONE portfolio roll-up computes at a time,
  // regardless of tenant/user, so the heavy per-client aggregate fan-out can
  // never saturate the pool and starve unrelated requests.
  private portfolioAlertsGate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    // Optional only so the many hand-built `new IntelligenceService(prisma)` unit
    // tests keep compiling; NestJS always injects it in the app (it's a provider).
    private readonly prepopulation?: ClientPrepopulationService,
    // Office Recommender v2. Optional for the same unit-test reason; when absent
    // (bare-constructed in a test) the relationships panel simply yields no
    // office recommendations rather than throwing.
    private readonly officeRecommender?: OfficeRecommenderService,
  ) {}

  private asFinite(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private asFiniteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private asIsoOrNull(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (typeof value === 'string') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }

  private normalizeProfileV1Sections(sections: {
    snapshot: Record<string, any>;
    financialFootprint: Record<string, any>;
    legislativeRegulatory: Record<string, any>;
    relationships: Record<string, any>;
  }) {
    const snapshot = {
      ...sections.snapshot,
      changes7dCount: Math.max(0, Math.trunc(this.asFinite(sections.snapshot.changes7dCount, 0))),
      activity14d: Array.isArray(sections.snapshot.activity14d)
        ? [...sections.snapshot.activity14d].sort((a, b) =>
            String(a?.date ?? '').localeCompare(String(b?.date ?? '')),
          )
        : [],
      topAlerts: Array.isArray(sections.snapshot.topAlerts)
        ? sections.snapshot.topAlerts.map((a: Record<string, unknown>) => ({
            ...a,
            when: this.asIsoOrNull(a.when),
            countdownDays: this.asFiniteOrNull(a.countdownDays),
            state: a.state === 'acknowledged' ? 'acknowledged' : null,
          }))
        : [],
      alertsHiddenCount: Math.max(
        0,
        Math.trunc(this.asFinite(sections.snapshot.alertsHiddenCount, 0)),
      ),
    };

    const financialFootprint = {
      ...sections.financialFootprint,
      districtNexus: {
        ...(sections.financialFootprint.districtNexus ?? {}),
        topDistricts: Array.isArray(sections.financialFootprint?.districtNexus?.topDistricts)
          ? [...sections.financialFootprint.districtNexus.topDistricts]
              .sort((a, b) => this.asFinite(b?.jobs, 0) - this.asFinite(a?.jobs, 0))
              .slice(0, 5)
          : [],
      },
    };

    const stageOrder = ['introduced', 'committee', 'passed', 'enacted'];
    const legislativeRegulatory = {
      ...sections.legislativeRegulatory,
      kanban: {
        ...(sections.legislativeRegulatory.kanban ?? {}),
        columns: Array.isArray(sections.legislativeRegulatory?.kanban?.columns)
          ? [...sections.legislativeRegulatory.kanban.columns]
              .sort((a, b) => stageOrder.indexOf(String(a?.id)) - stageOrder.indexOf(String(b?.id)))
              .map((c) => ({
                ...c,
                count: Math.max(0, Math.trunc(this.asFinite(c?.count, 0))),
                bills: Array.isArray(c?.bills)
                  ? [...c.bills].sort(
                      (x, y) => this.asFinite(y?.probability, 0) - this.asFinite(x?.probability, 0),
                    )
                  : [],
              }))
          : [],
      },
      hearingsAndMarkups: Array.isArray(sections.legislativeRegulatory.hearingsAndMarkups)
        ? [...sections.legislativeRegulatory.hearingsAndMarkups]
            .map((h) => ({ ...h, date: this.asIsoOrNull(h?.date) }))
            .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
        : [],
    };

    const relationships = {
      ...sections.relationships,
      exStafferCount: Math.max(
        0,
        Math.trunc(this.asFinite(sections.relationships.exStafferCount, 0)),
      ),
      officeRecommender: Array.isArray(sections.relationships.officeRecommender)
        ? [...sections.relationships.officeRecommender]
            .sort((a, b) => this.asFinite(b?.score, 0) - this.asFinite(a?.score, 0))
            .slice(0, 12)
        : [],
    };

    return { snapshot, financialFootprint, legislativeRegulatory, relationships };
  }

  /**
   * Build a 360° intelligence profile for a CRM client.
   * Uses confirmed mappings from client_intel_mapping when available;
   * falls back to fuzzy matching for sources without confirmed mappings.
   */
  async getClientProfile(clientId: string, tenantId: string) {
    // 1. Fetch the CRM client (tenant-scoped via RLS)
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        include: { capabilities: true },
      }),
    );
    // Soft-archived ("deleted") clients are treated as not-found everywhere.
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');

    const clientName = client.name;
    const capabilityRefs = (client.capabilities ?? []).map((c) => ({
      name: c.name,
      sector: c.sector ?? null,
      tags: Array.isArray(c.tags)
        ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    }));

    // 2. Fetch existing confirmed mappings, then resolve each source.
    //    Confirmed mappings skip fuzzy re-match and query by externalId directly.
    const existingMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId },
        orderBy: { confidence: 'desc' },
      }),
    );

    const confirmedBySource = new Map<string, string>(); // source → externalId
    for (const m of existingMappings) {
      if (m.confirmed && !confirmedBySource.has(m.source)) {
        confirmedBySource.set(m.source, m.externalId);
      }
    }

    // 3. Resolve each source, use confirmed mapping if present, else fuzzy match.
    //    LDA resolves over the client's FULL id set (cache, else confirmed
    //    mappings) so a company lobbied by N firms aggregates all N relationships
    //    (e.g. Boeing's 27 ids). Name-fuzzy is the fallback ONLY when unresolved.
    const confirmedLdaExternalIds = existingMappings
      .filter((m) => m.source === 'lda' && m.confirmed)
      .map((m) => m.externalId);
    const ldaClientIds = this.pickLdaClientIds(client.ldaClientIds, confirmedLdaExternalIds);

    const [ldaMatch, contractorMatch, lobbyMatch] = await Promise.all([
      ldaClientIds.length ? this.fetchLdaByIds(ldaClientIds) : this.fuzzyMatchLda(clientName),
      confirmedBySource.has('contracting')
        ? this.fetchContractorById(confirmedBySource.get('contracting')!)
        : this.fuzzyMatchContractor(clientName),
      confirmedBySource.has('lobby_intel')
        ? this.fetchLobbyIntelById(confirmedBySource.get('lobby_intel')!)
        : this.fuzzyMatchLobbyIntel(clientName),
    ]);

    // 3. Get issue codes from LDA match
    const issueCodes: string[] = ldaMatch?.issueCodes ?? [];

    // 4. Find relevant bills and regulations in parallel
    // When LDA didn't match (no issue codes), fall back to the client's own
    // capability metadata so the Bills + Regulations tabs aren't empty for
    // unmapped clients. This mirrors getTrackedBills() and keeps the
    // standalone /tracked-bills endpoint and the profile's relevantBills in
    // agreement.
    const capabilityFallbackTerms = issueCodes.length
      ? []
      : await this.capabilityFallbackTerms(tenantId, clientId);

    const [relevantBills, activeRegulations, competitors] = await Promise.all([
      this.findRelevantBills(issueCodes, capabilityFallbackTerms),
      this.findActiveRegulations(issueCodes, capabilityFallbackTerms),
      this.findCompetitors(clientName, issueCodes, ldaClientIds),
    ]);

    return {
      client: {
        id: client.id,
        name: client.name,
        description: client.description,
        sectorTag: client.sectorTag,
        submissionTracks: client.submissionTracks ?? [],
        capabilities: capabilityRefs,
      },
      mappings: existingMappings,
      lda: ldaMatch ?? {
        matched: false,
        ldaClientId: null,
        ldaClientIds: [],
        confidence: 0,
        totalFilings: 0,
        totalSpending: null,
        issueCodes: [],
        recentFilings: [],
        yearlySpend: [],
      },
      contracting: contractorMatch ?? {
        matched: false,
        contractorName: null,
        totalContracts: null,
        rankByContracts: null,
        noBidTotal: null,
        topAgencies: [],
        yearlySpend: [],
      },
      lobbyIntel: lobbyMatch ?? {
        matched: false,
        trajectory: null,
        growthRate: null,
        totalSpending: null,
      },
      relevantBills,
      activeRegulations,
      competitors,
      aiSummary: null, // Populated by Phase 4
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Client Profile / Intel Tab, redesigned v1 aggregate payload.
   * Opinionated 4-section contract so the frontend can render a single
   * anchored surface without stitching 10+ calls client-side.
   */
  async getClientProfileV1(clientId: string, tenantId: string, userId?: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, name: true, status: true },
      }),
    );
    // Treat soft-archived ("deleted") clients as not-found so their alerts can
    // never surface here — including via a stale deep link to the Intel tab.
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');

    const now = new Date();
    const day14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const day21 = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
    const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    // Look-back windows for the new compute-on-read alert types.
    const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const mappingRowsPromise = this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId },
        select: { source: true, confirmed: true, externalId: true },
      }),
    );

    // getTrackedBills runs an expensive pgvector similarity search
    // (findTrackedBillsByEmbeddings, ~1.8s). It was previously called THREE times
    // per profile-v1 request — directly (index 4), inside getBillRegulationLinks
    // (index 5), and inside getHearingAlerts (index 23) — tripling that cost and
    // the connection-pool pressure under the parallel fan-out. Compute it ONCE
    // here and feed the same promise into all three consumers. The standalone
    // controller endpoints + their unit tests still call getTrackedBills() with no
    // precomputed value, so their behavior is unchanged.
    const trackedBillsPromise = this.getTrackedBills(clientId, tenantId);

    // Each source is resolved independently via allSettled so one failing
    // builder (a missing sync table, a tenant without a given mapping, a slow
    // query) degrades only its own section instead of rejecting the whole
    // aggregate and blanking every section at once. Failures are logged with
    // the source label so production issues are diagnosable.
    const settled = await Promise.allSettled([
      this.getClientProfile(clientId, tenantId),
      this.getLobbyingRoi(clientId, tenantId),
      this.getFecMoneyFlow(clientId, tenantId),
      this.getDistrictNexus(clientId, tenantId),
      trackedBillsPromise,
      this.getBillRegulationLinks(clientId, tenantId, trackedBillsPromise),
      // [6] Knowledge graph: REMOVED from the client Intelligence tab. The graph
      // is being relocated to the Intelligence Center (it still has its own
      // dedicated endpoint + getKnowledgeGraph() method, used by
      // KnowledgeGraphPage). It was the single slowest source here — kg_walk()
      // ran inside an interactive transaction and, under the 24-way fan-out,
      // produced "Unable to start a transaction" pool-starvation errors plus
      // 8–18s tail latency. We keep this positional slot (so every later index
      // is unchanged) but resolve a static empty graph instead of touching the
      // DB. scopedGraph is built from this empty shape; the Relationships
      // section no longer renders the graph, so nothing downstream regresses.
      Promise.resolve({
        nodes: [] as Array<{ id: string; type: string; label: string }>,
        edges: [] as Array<{ source: string; target: string; type: string }>,
        resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
      } as unknown as Awaited<ReturnType<typeof this.getKnowledgeGraph>>),
      this.computeEngagementHealth(clientId, tenantId),
      this.getExStaffers(clientId, tenantId),
      this.getCommentPeriodAlerts(tenantId),
      this.getChanges(tenantId, day7.toISOString(), clientId),
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: now, lte: day21 } },
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
        take: 40,
      }),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.findMany({
          where: { clientId, startsAt: { gte: day14 } },
          select: { startsAt: true },
          orderBy: { startsAt: 'asc' },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.mailThread.findMany({
          where: { clientId, lastMessageAt: { gte: day14 } },
          select: { lastMessageAt: true },
          orderBy: { lastMessageAt: 'asc' },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementTask.findMany({
          where: {
            clientId,
            status: EngagementTaskStatus.done,
            updatedAt: { gte: day14 },
          },
          select: { updatedAt: true },
          orderBy: { updatedAt: 'asc' },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meetingDebrief.findMany({
          where: { clientId, createdAt: { gte: day14 } },
          select: { createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
      ),
      // Outreach sent per day, feeds the 5th Activity row in the snapshot
      // panel (Meetings / Outreach sent / Tasks done / Bills tracked /
      // Critical alerts). Mockup spec requires this row; previously only
      // surfaced as an aggregate inside computeEngagementHealth.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.outreachRecord.findMany({
          where: { clientId, sentAt: { gte: day14 } },
          select: { sentAt: true },
          orderBy: { sentAt: 'asc' },
        }),
      ),
      mappingRowsPromise,
      // Real USAspending spend-by-district (the data-driven path). Appended at the
      // end of the array so the existing positional settle() indices are unchanged.
      // Drives the Financial Footprint district panel's job/spend bars; the
      // free-text getDistrictNexus (index 3) remains as a fallback / capability list.
      this.getDistrictNexusSpend(clientId, tenantId),
      // ── New alert-source feeders (compute-on-read), appended at the END so the
      // existing positional settle() indices (0–18) are unchanged. Each is wrapped
      // so a failure degrades only its own alert type, never the aggregate. ──
      // [19] Overdue comment deadlines: FedReg docs whose comment window JUST
      // closed (last 7d) and that match this client — "did we file?" nudge.
      this.getOverdueCommentAlerts(clientId, tenantId, now, day7),
      // [20] New competitor LDA activity on the client's issue codes (last 30d).
      this.getCompetitorLdaAlerts(clientId, tenantId, day30),
      // [21] New federal contract awards relevant to the client (last 30d).
      this.getContractAwardAlerts(clientId, tenantId, day30),
      // [22] Per-user worklist state (ack/dismiss/snooze) for this client's alerts.
      userId
        ? this.prisma.withTenant(tenantId, (tx) =>
            tx.alertState.findMany({
              where: { userId, clientId },
              select: { alertId: true, state: true, snoozedUntil: true },
            }),
          )
        : Promise.resolve(
            [] as Array<{ alertId: string; state: string; snoozedUntil: Date | null }>,
          ),
      // [23] Upcoming hearings & markups matched to this client (next 21d). The
      // legacy Hearings panel was removed from the UI; this surfaces the same
      // signal as time-sensitive alert rows on the Top alerts card.
      this.getHearingAlerts(clientId, tenantId, now, day21, trackedBillsPromise),
    ]);

    const settledSourceLabels = [
      'profile',
      'lobbyingRoi',
      'fecMoneyFlow',
      'districtNexus',
      'trackedBills',
      'billRegulationLinks',
      'knowledgeGraph',
      'engagementHealth',
      'exStaffers',
      'commentAlerts',
      'changes',
      'hearings',
      'meetings',
      'mailThreads',
      'doneTasks',
      'debriefs',
      'outreachRecords',
      'mappingRows',
      'districtNexusSpend',
      'overdueComments',
      'competitorLda',
      'contractAwards',
      'alertStates',
      'hearingAlerts',
    ] as const;

    const settle = <T>(index: number, fallback: T): T => {
      const result = settled[index];
      if (result && result.status === 'fulfilled') return result.value as T;
      const reason = result && result.status === 'rejected' ? result.reason : 'unknown';
      this.logger.warn(
        `profile-v1 source "${settledSourceLabels[index]}" failed for client ${clientId}: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      );
      return fallback;
    };

    // `profile` is the spine of the response (drives identity + trajectory).
    // If it failed we can't build a coherent aggregate, so surface the error.
    if (settled[0].status === 'rejected') throw settled[0].reason;
    const profile = settled[0].value as Awaited<ReturnType<typeof this.getClientProfile>>;

    const roi = settle(1, {
      clientId,
      clientName: client.name,
      mappedLdaClientId: null,
      mappedLdaClientIds: [],
      mappedContractorId: null,
      lobbySpend: 0,
      contractWins: 0,
      roi: null,
      gap: 0,
    } as Awaited<ReturnType<typeof this.getLobbyingRoi>>);
    const fec = settle(2, {
      clientId,
      clientName: client.name,
      mappedEmployer: null,
      contributionType: 'individual_employer_linked' as const,
      summary: {
        totalContributions: 0,
        totalAmount: 0,
        committeeCount: 0,
        candidateCount: 0,
        memberCount: 0,
        billCount: 0,
      },
      committees: [],
      pacGiving: {
        tracked: false,
        committees: [],
        summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
      },
      disclaimer: FEC_DISCLAIMER,
    } as unknown as Awaited<ReturnType<typeof this.getFecMoneyFlow>>);
    const district = settle(3, { capabilities: [] } as unknown as Awaited<
      ReturnType<typeof this.getDistrictNexus>
    >);
    const trackedBills = settle(4, { total: 0, issueCodes: [], bills: [] } as Awaited<
      ReturnType<typeof this.getTrackedBills>
    >);
    const regLinks = settle(5, {
      totalBills: 0,
      totalRegulations: 0,
      rails: [],
    } as unknown as Awaited<ReturnType<typeof this.getBillRegulationLinks>>);
    const graph = settle(6, {
      nodes: [],
      edges: [],
      resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
    } as unknown as Awaited<ReturnType<typeof this.getKnowledgeGraph>>);
    const health = settle(
      7,
      null as unknown as Awaited<ReturnType<typeof this.computeEngagementHealth>>,
    );
    const exStaffers = settle(8, { lobbyists: [] } as unknown as Awaited<
      ReturnType<typeof this.getExStaffers>
    >);
    const commentAlerts = settle(9, { alerts: [] } as Awaited<
      ReturnType<typeof this.getCommentPeriodAlerts>
    >);
    const changes = settle(10, [] as Awaited<ReturnType<typeof this.getChanges>>);
    const hearings = settle(
      11,
      [] as Awaited<ReturnType<typeof this.prisma.committeeHearing.findMany>>,
    );
    const meetings = settle(12, [] as Array<{ startsAt: Date }>);
    const threads = settle(13, [] as Array<{ lastMessageAt: Date | null }>);
    const doneTasks = settle(14, [] as Array<{ updatedAt: Date }>);
    const debriefs = settle(15, [] as Array<{ createdAt: Date }>);
    const outreachRows = settle(16, [] as Array<{ sentAt: Date }>);
    const mappingRows = settle(
      17,
      [] as Array<{ source: string; confirmed: boolean; externalId: string | null }>,
    );
    const districtSpend = settle(18, {
      linked: false as const,
      reason: 'no_confirmed_contracting_mapping',
      contractorNames: [] as string[],
      totalAwards: 0,
      totalAmount: 0,
      districts: [] as Array<{
        district: string;
        state: string;
        districtNumber: string;
        awardCount: number;
        totalAmount: number;
        demographics: unknown;
      }>,
      unmappedAmount: 0,
    } as unknown as Awaited<ReturnType<typeof this.getDistrictNexusSpend>>);

    // New alert-source reads (indices 19–22). Each defaults to empty so a failed
    // feeder simply omits its alert type rather than blanking the card.
    const overdueCommentAlerts = settle(
      19,
      [] as Awaited<ReturnType<typeof this.getOverdueCommentAlerts>>,
    );
    const competitorLdaAlerts = settle(
      20,
      [] as Awaited<ReturnType<typeof this.getCompetitorLdaAlerts>>,
    );
    const contractAwardAlerts = settle(
      21,
      [] as Awaited<ReturnType<typeof this.getContractAwardAlerts>>,
    );
    const alertStateRows = settle(
      22,
      [] as Array<{ alertId: string; state: string; snoozedUntil: Date | null }>,
    );
    const hearingAlerts = settle(23, [] as Awaited<ReturnType<typeof this.getHearingAlerts>>);

    // Freshness + unresolved metadata derived from the tenant-scoped mapping query.
    // mappingRows is fetched via withTenant, clientId is guaranteed to belong to tenantId.
    const confirmedSources = new Set(mappingRows.filter((m) => m.confirmed).map((m) => m.source));
    const sourceCount = confirmedSources.size;
    const unresolvedMappings = mappingRows.filter((m) => !m.confirmed).length;

    const byDay = new Map<
      string,
      {
        date: string;
        meetings: number;
        emails: number;
        tasks: number;
        debriefs: number;
        outreach: number;
      }
    >();
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, { date: key, meetings: 0, emails: 0, tasks: 0, debriefs: 0, outreach: 0 });
    }
    for (const row of meetings) {
      const key = row.startsAt.toISOString().slice(0, 10);
      const slot = byDay.get(key);
      if (slot) slot.meetings += 1;
    }
    for (const row of threads) {
      if (!row.lastMessageAt) continue;
      const key = row.lastMessageAt.toISOString().slice(0, 10);
      const slot = byDay.get(key);
      if (slot) slot.emails += 1;
    }
    for (const row of doneTasks) {
      const key = row.updatedAt.toISOString().slice(0, 10);
      const slot = byDay.get(key);
      if (slot) slot.tasks += 1;
    }
    for (const row of debriefs) {
      const key = row.createdAt.toISOString().slice(0, 10);
      const slot = byDay.get(key);
      if (slot) slot.debriefs += 1;
    }
    for (const row of outreachRows) {
      if (!row.sentAt) continue;
      const key = row.sentAt.toISOString().slice(0, 10);
      const slot = byDay.get(key);
      if (slot) slot.outreach += 1;
    }

    const severityRank = (severity: string): number => {
      if (severity === 'critical') return 3;
      if (severity === 'notable') return 2;
      return 1;
    };

    const countdownLabel = (days: number | null): string | null => {
      if (days == null) return null;
      if (days < 0) return `Overdue ${Math.abs(days)}d`;
      if (days === 0) return 'Due today';
      if (days === 1) return '1d left';
      return `${days}d left`;
    };

    const recencyLabel = (whenIso: string): string => {
      const when = new Date(whenIso);
      const diffMs = now.getTime() - when.getTime();
      const diffDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return '1d ago';
      return `${diffDays}d ago`;
    };

    const commentAlertsForClient = commentAlerts.alerts.filter((a) => a.clientId === clientId);

    // Bill-movement alerts: a tracked bill (auto-matched OR manually pinned) whose
    // latest recorded action landed within the last 14 days. "HR 1234 (you're
    // tracking) just moved" is higher-signal than a generic sector change because
    // the client/team already flagged the bill as relevant. Vote/floor/markup/
    // passed/enacted language escalates to critical.
    const billMovementAlerts = (trackedBills.bills ?? [])
      .filter((b) => {
        if (!b.latestActionDate) return false;
        const d = new Date(b.latestActionDate);
        return (
          !Number.isNaN(d.getTime()) &&
          d.getTime() >= day14.getTime() &&
          d.getTime() <= now.getTime()
        );
      })
      .map((b) => {
        const actionText = (b.latestActionText ?? '').toLowerCase();
        const isHot = /\b(vote|floor|passed|enacted|markup|reported|signed)\b/.test(actionText);
        const whenIso = new Date(b.latestActionDate as Date).toISOString();
        const daysAgo = Math.max(
          0,
          Math.floor((now.getTime() - new Date(whenIso).getTime()) / (1000 * 60 * 60 * 24)),
        );
        return {
          id: `bill:${b.identifier}`,
          type: 'bill_movement',
          severity: isHot ? 'critical' : 'notable',
          title: `${b.identifier.toUpperCase()} moved${b.isManual ? ' (tracked)' : ''}`,
          subtitle: b.latestActionText ?? b.title,
          when: whenIso,
          countdownDays: null as number | null,
          countdownLabel: recencyLabel(whenIso),
          href: `/intelligence/bills/${encodeURIComponent(b.identifier)}?clientId=${encodeURIComponent(clientId)}`,
          _urgencyScore: 45 - Math.min(daysAgo, 45),
          _typeRank: 1,
        };
      });

    // Merge ALL alert sources into one list, then filter by per-user worklist
    // state, then sort. Each source already returns the normalized internal
    // shape (with _urgencyScore/_typeRank that get stripped before returning).
    const mergedAlerts = [
      ...commentAlertsForClient.map((a) => {
        const days = a.daysToDeadline ?? null;
        return {
          id: `comment:${a.documentId}`,
          type: 'comment_deadline',
          severity: a.severity,
          title: a.title,
          subtitle: a.agencies.slice(0, 2).join(' / '),
          when: a.commentEndDate.toISOString(),
          countdownDays: days,
          countdownLabel: countdownLabel(days),
          href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=comment_deadline`,
          _urgencyScore: days == null ? 0 : 100 - Math.max(-30, Math.min(days, 100)),
          _typeRank: 2,
        };
      }),
      ...changes.map((c) => {
        const daysAgo = Math.max(
          0,
          Math.floor((now.getTime() - c.detectedAt.getTime()) / (1000 * 60 * 60 * 24)),
        );
        return {
          id: `change:${c.id}`,
          type: c.changeType,
          severity: c.severity,
          title: c.title,
          subtitle: c.source,
          when: c.detectedAt.toISOString(),
          countdownDays: null as number | null,
          countdownLabel: recencyLabel(c.detectedAt.toISOString()),
          href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&changeId=${encodeURIComponent(c.id)}`,
          _urgencyScore: 40 - Math.min(daysAgo, 40),
          _typeRank: 1,
        };
      }),
      ...hearingAlerts,
      ...billMovementAlerts,
      ...overdueCommentAlerts,
      ...competitorLdaAlerts,
      ...contractAwardAlerts,
    ];

    // Per-user worklist state. Dismissed alerts disappear; snoozed alerts hide
    // until their snoozedUntil passes; acknowledged alerts stay but are flagged
    // so the UI can de-emphasize them. State that no longer maps to a live alert
    // is simply ignored (the alert aged out on its own).
    const stateByAlertId = new Map<string, { state: string; snoozedUntil: Date | null }>();
    for (const row of alertStateRows) {
      stateByAlertId.set(row.alertId, { state: row.state, snoozedUntil: row.snoozedUntil });
    }
    const isHidden = (alertId: string): boolean => {
      const st = stateByAlertId.get(alertId);
      if (!st) return false;
      if (st.state === 'dismissed') return true;
      if (st.state === 'snoozed') {
        // Snoozed with no/expired deadline → treat as hidden until snoozedUntil.
        if (!st.snoozedUntil) return true;
        return new Date(st.snoozedUntil).getTime() > now.getTime();
      }
      return false;
    };

    const visibleAlerts = mergedAlerts
      .filter((a) => !isHidden(a.id))
      .map((a) => ({
        ...a,
        // 'acknowledged' surfaces as a flag the UI uses to de-emphasize the row;
        // it is NOT hidden. Any other state (or none) → null.
        state: stateByAlertId.get(a.id)?.state === 'acknowledged' ? 'acknowledged' : null,
      }))
      .sort((a, b) => {
        const sev = severityRank(b.severity) - severityRank(a.severity);
        if (sev !== 0) return sev;
        const type = b._typeRank - a._typeRank;
        if (type !== 0) return type;
        const urgency = b._urgencyScore - a._urgencyScore;
        if (urgency !== 0) return urgency;
        return b.when.localeCompare(a.when);
      });

    // The card shows the top 5 by default; surface how many MORE are hidden below
    // the fold so the lobbyist knows the list is truncated. The frontend owns the
    // deadline-first re-sort + final slice, so we return up to 20 visible rows
    // (top 5 shown + buffer for the toggle) and the hidden count off the full set.
    const alertsHiddenCount = Math.max(0, visibleAlerts.length - 5);
    const topAlerts = visibleAlerts
      .slice(0, 20)
      .map(({ _urgencyScore, _typeRank, ...alert }) => alert);

    const criticalDeadlines = commentAlertsForClient.filter(
      (a) => (a.daysToDeadline ?? 999) <= 7,
    ).length;
    const briefingHighlights: Array<{
      label: string;
      value: string | number | null;
      tone: 'critical' | 'notable' | 'info' | 'neutral';
    }> = [];

    if (criticalDeadlines > 0) {
      briefingHighlights.push({
        label: 'Deadlines',
        value: `${criticalDeadlines} due ≤7d`,
        tone: 'critical',
      });
    }
    if (trackedBills.total > 0) {
      briefingHighlights.push({
        label: 'Bills tracked',
        value: trackedBills.total,
        tone: 'notable',
      });
    }
    if ((roi.lobbySpend ?? 0) > 0) {
      briefingHighlights.push({
        label: 'Lobbying TTM',
        value: Math.round(roi.lobbySpend),
        tone: 'info',
      });
    }
    if (changes.length > 0) {
      briefingHighlights.push({
        label: 'New events (7d)',
        value: changes.length,
        tone: 'info',
      });
    }

    if (briefingHighlights.length === 0) {
      briefingHighlights.push({
        label: 'Status',
        value: 'Monitoring for new intelligence signals',
        tone: 'neutral',
      });
    }

    const fallbackSummaryParts: string[] = [];
    if (criticalDeadlines > 0) {
      fallbackSummaryParts.push(
        `${criticalDeadlines} comment deadline${criticalDeadlines === 1 ? '' : 's'} due within 7 days.`,
      );
    }
    if (trackedBills.total > 0) {
      fallbackSummaryParts.push(
        `${trackedBills.total} bill${trackedBills.total === 1 ? '' : 's'} currently tracked.`,
      );
    }
    fallbackSummaryParts.push(
      changes.length > 0
        ? `${changes.length} intelligence change${changes.length === 1 ? '' : 's'} detected this week.`
        : 'No new intelligence changes detected this week.',
    );

    const aiSummaryRaw = (profile as { aiSummary?: string | null }).aiSummary;
    const aiSummary = typeof aiSummaryRaw === 'string' ? aiSummaryRaw.trim() : '';

    const briefingSummary =
      aiSummary ||
      fallbackSummaryParts.join(' ') ||
      `No intelligence updates available for ${client.name}.`;

    const changesInboxHref = `/intelligence/changes?clientId=${encodeURIComponent(clientId)}`;
    const dailyBriefing = {
      summary: briefingSummary,
      highlights: briefingHighlights.slice(0, 4),
      generatedAt: now.toISOString(),
      eventCount: changes.length,
      ctaHref: changesInboxHref,
    };

    // GAI-07: use the CANONICAL classifiers from @capiro/shared — this method
    // previously carried verbatim inline clones that silently drifted from the
    // shared implementation (they kept the bare /passed|agreed to/ passage test
    // after the shared copy was chamber-qualified).

    const kanbanColumns: Array<{
      id: 'introduced' | 'committee' | 'passed' | 'enacted';
      label: string;
      count: number;
      bills: Array<{
        identifier: string;
        title: string;
        latestActionDate: Date | null;
        latestActionText: string | null;
        probability: number;
        isManual: boolean;
      }>;
    }> = [
      { id: 'introduced', label: 'Introduced', count: 0, bills: [] },
      { id: 'committee', label: 'In Committee', count: 0, bills: [] },
      { id: 'passed', label: 'Passed Chamber', count: 0, bills: [] },
      { id: 'enacted', label: 'Enacted', count: 0, bills: [] },
    ];
    const columnById = new Map(kanbanColumns.map((c) => [c.id, c]));
    for (const bill of trackedBills.bills) {
      const stage = billStage(bill.latestActionText);
      const col = columnById.get(stage);
      if (!col) continue;
      col.count += 1;
      col.bills.push({
        identifier: bill.identifier,
        title: bill.title,
        latestActionDate: bill.latestActionDate ? new Date(bill.latestActionDate) : null,
        latestActionText: bill.latestActionText,
        probability: passageProbability(bill),
        isManual: (bill as { isManual?: boolean }).isManual ?? false,
      });
    }
    for (const col of kanbanColumns) {
      // Manually pinned bills sort to the top of each column, then by passage
      // probability — a deliberate pin should never be buried below auto matches.
      col.bills.sort((a, b) => {
        if (a.isManual !== b.isManual) return a.isManual ? -1 : 1;
        return b.probability - a.probability;
      });
      col.bills = col.bills.slice(0, 12);
    }

    const regDocByNumber = new Map<
      string,
      {
        documentNumber: string;
        type: string;
        title: string;
        agencyNames: string[];
        publicationDate: Date;
        commentEndDate: Date | null;
        effectiveDate: Date | null;
        linkedBills: string[];
      }
    >();
    for (const link of regLinks.links) {
      for (const reg of link.regulations) {
        const existing = regDocByNumber.get(reg.documentNumber);
        if (existing) {
          if (!existing.linkedBills.includes(link.bill.identifier)) {
            existing.linkedBills.push(link.bill.identifier);
          }
          continue;
        }
        regDocByNumber.set(reg.documentNumber, {
          documentNumber: reg.documentNumber,
          type: (reg as { type?: string }).type ?? '',
          title: reg.title,
          agencyNames: reg.agencyNames,
          publicationDate: new Date(reg.publicationDate),
          commentEndDate: reg.commentEndDate ? new Date(reg.commentEndDate) : null,
          effectiveDate: (reg as { effectiveDate?: Date | string | null }).effectiveDate
            ? new Date((reg as { effectiveDate: Date | string }).effectiveDate)
            : null,
          linkedBills: [link.bill.identifier],
        });
      }
    }
    // The rulemaking lifecycle rail tracks ONE Federal Register document's
    // position through the standard FR pipeline. `federal_register_document.type`
    // is one of RULE / PROPOSED_RULE / NOTICE / PRESIDENTIAL_DOCUMENT (see the
    // sync normalizer + schema), which — together with the comment/effective
    // dates — tells us the real stage. Previously `currentStage` was hardcoded
    // to 'NPRM' for every regulation regardless of its actual type. Derivation
    // lives in `@capiro/shared`'s `deriveRuleLifecycleStage` (Phase 1 M4.2) so
    // this federal rail and the state-rule Meri tool (`get_state_rule_status`)
    // can never disagree about what stage a rule is at.
    const regulatoryRails = Array.from(regDocByNumber.values())
      .sort((a, b) => b.publicationDate.getTime() - a.publicationDate.getTime())
      .slice(0, 8)
      .map((reg) => {
        const currentStage = deriveRuleLifecycleStage({
          documentType: reg.type,
          commentEndDate: reg.commentEndDate,
          effectiveDate: reg.effectiveDate,
          today: now,
        });
        return {
          documentNumber: reg.documentNumber,
          title: reg.title,
          agencyNames: reg.agencyNames,
          linkedBills: reg.linkedBills,
          currentStage,
          // For an open NPRM the actionable deadline is the comment close date.
          // Once the rule is final/effective there is no open comment deadline.
          deadline: currentStage === 'nprm' ? reg.commentEndDate : null,
          stages: RULE_LIFECYCLE_STAGES.map((s) => ({ key: s.key, label: s.label })),
        };
      });

    // ── Hearings & markups: CLIENT-SCOPED (accuracy-critical) ──────────────
    // `hearings` (settled index 11) is the GLOBAL congressional calendar for the
    // next 21 days. Surfacing it raw shows every committee's schedule, not this
    // client's. A hearing is relevant to THIS client only when either:
    //   (a) it is held by a committee that has jurisdiction over one of the
    //       client's tracked bills (congress_bill_committee join), or
    //   (b) its title references a tracked-bill number (e.g. "H.R. 1234").
    // Everything else (the global calendar) is dropped.

    // Human-readable bill-number variants per tracked bill, derived from the
    // "119-hr-1234" slug → "hr 1234" / "h.r. 1234" / "hr1234". Hearing titles
    // cite bills in these human forms, never the internal slug, so matching the
    // raw slug (as the old code did) effectively never hit.
    const billTitleVariants = trackedBills.bills.map((b) => {
      const parts = b.identifier.split('-');
      const variants: string[] = [];
      if (parts.length === 3 && parts[1] && parts[2]) {
        const chamber = parts[1].toLowerCase(); // hr, s, hres, sres, hjres…
        const num = parts[2];
        variants.push(`${chamber} ${num}`);
        variants.push(`${chamber}${num}`);
        // Dotted long form for the common House/Senate prefixes.
        if (chamber === 'hr') variants.push(`h.r. ${num}`);
        if (chamber === 's') variants.push(`s. ${num}`);
      }
      return { identifier: b.identifier, variants };
    });

    // Committee names/codes with jurisdiction over the client's tracked bills.
    // Same join the office-recommender uses (cbc.bill_id == bill identifier).
    const jurisdictionCommitteeNames = new Set<string>();
    const jurisdictionCommitteeCodes = new Set<string>();
    const trackedBillIdList = trackedBills.bills
      .map((b) => b.identifier)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const normalizeCommittee = (value: string | null | undefined): string =>
      (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (trackedBillIdList.length > 0) {
      try {
        const committeeRows = await this.prisma.$queryRaw<
          Array<{ committee_name: string; committee_code: string | null }>
        >`
          SELECT DISTINCT cbc.committee_name, cbc.committee_code
          FROM congress_bill_committee cbc
          WHERE cbc.bill_id = ANY(${trackedBillIdList}::text[])
            AND cbc.committee_name IS NOT NULL
            AND cbc.committee_name <> ''
        `;
        for (const row of committeeRows) {
          const name = normalizeCommittee(row.committee_name);
          if (name) jurisdictionCommitteeNames.add(name);
          if (row.committee_code) jurisdictionCommitteeCodes.add(row.committee_code.toLowerCase());
        }
      } catch (err) {
        this.logger.warn(
          `hearings client-scoping committee join failed for client ${clientId}: ${(err as Error).message}`,
        );
      }
    }

    const jurisdictionNameList = Array.from(jurisdictionCommitteeNames);
    const hearingsList = hearings
      .map((h) => {
        const titleLower = h.title.toLowerCase();
        const linked = billTitleVariants
          .filter((b) => b.variants.some((v) => titleLower.includes(v)))
          .map((b) => b.identifier);
        const hearingCommittee = normalizeCommittee(h.committeeName);
        const hearingCode = (h.committeeCode ?? '').toLowerCase();
        // Committee-of-jurisdiction match: exact normalized name, OR committee
        // code, OR one name being a substring of the other (handles "Committee
        // on Armed Services" vs "Armed Services" / chamber-prefixed variants).
        const committeeMatch =
          (hearingCommittee.length > 0 &&
            (jurisdictionCommitteeNames.has(hearingCommittee) ||
              jurisdictionNameList.some(
                (j) => j.includes(hearingCommittee) || hearingCommittee.includes(j),
              ))) ||
          (hearingCode.length > 0 && jurisdictionCommitteeCodes.has(hearingCode));
        return {
          id: h.id,
          committeeName: h.committeeName,
          chamber: h.chamber,
          title: h.title,
          date: h.date,
          time: h.time,
          type: h.type,
          linkedBills: linked,
          isTracked: linked.length > 0 || committeeMatch,
        };
      })
      // Drop the global (non-client-relevant) calendar entries: a hearing is
      // kept only when it cites a tracked bill (linkedBills) or is held by a
      // committee with jurisdiction over a tracked bill (isTracked).
      .filter((h) => h.isTracked);

    // District rows for the aggregate. District Nexus is now a SINGLE
    // data-driven engine: real USAspending spend-by-district
    // (getDistrictNexusSpend, index 18). The old free-text capability parse was
    // retired — it had no input column in prod and never produced data. When the
    // client has a confirmed contracting mapping and enriched awards, these rows
    // carry actual contract dollars + award counts; otherwise the section is
    // empty (the dedicated DistrictNexusSection renders the honest unlinked /
    // not-yet-enriched state).
    const districtRows =
      districtSpend.linked && Array.isArray(districtSpend.districts)
        ? districtSpend.districts
            .filter((d) => d.totalAmount > 0)
            .sort((a, b) => b.totalAmount - a.totalAmount)
            .slice(0, 5)
            .map((d) => ({
              district: d.district,
              jobs: 0,
              spend: d.totalAmount,
              awardCount: d.awardCount,
              capability: 'Federal contract spend',
              dataYear:
                d.demographics &&
                typeof d.demographics === 'object' &&
                'dataYear' in (d.demographics as Record<string, unknown>)
                  ? Number((d.demographics as Record<string, unknown>).dataYear) || 0
                  : 0,
            }))
        : [];
    const exStafferNames = exStaffers.lobbyists.map((l) => l.name.toLowerCase());

    const committeeNames = Array.from(
      new Set(hearingsList.map((h) => h.committeeName).filter(Boolean)),
    ).slice(0, 12);

    // Office Recommender v2 (see OfficeRecommenderService). Ranks congressional
    // offices by committee jurisdiction over the client's tracked bills, issue
    // overlap, and constituent geography (facility ↔ member state/district). This
    // replaces the legacy sponsor/FEC/ex-staffer scorer wholesale: bill
    // sponsor_name is unpopulated for most synced bills, so that scorer returned
    // nothing for most clients. When the recommender is unavailable (bare-
    // constructed in a unit test), yields an empty list rather than throwing.
    const trackedBillIdsForRec = trackedBills.bills
      .map((b) => b.identifier)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const officeRecommendations = this.officeRecommender
      ? await this.officeRecommender.recommend({
          clientId,
          tenantId: tenantId ?? '',
          trackedBillIds: trackedBillIdsForRec,
          trackedBills: trackedBills.bills.map((b) => ({
            identifier: b.identifier,
            subjectNames: b.subjectNames ?? [],
          })),
          issueCodes: trackedBills.issueCodes ?? [],
        })
      : [];
    const recommendedMemberCount = officeRecommendations.length;

    const scopedGraph = {
      nodes: graph.nodes
        .filter(
          (n) =>
            ['lobbyist', 'agency', 'registrant'].includes(n.type) || n.id.startsWith('member:'),
        )
        .slice(0, 40),
      edges: graph.edges.slice(0, 80),
      resolutionQuality: graph.resolutionQuality,
      meta: {
        lobbyistCount: exStaffers.lobbyists.length,
        memberCount: recommendedMemberCount,
        committeeCount: committeeNames.length,
      },
      hints: {
        exStafferNames,
      },
    };

    const hasLobbyingTtm = (roi.lobbySpend ?? 0) > 0;
    const hasObligationsTtm = (roi.contractWins ?? 0) > 0;
    const heroTruthState: 'normal' | 'zero_obligation' | 'no_activity' =
      hasLobbyingTtm && !hasObligationsTtm
        ? 'zero_obligation'
        : hasLobbyingTtm || hasObligationsTtm
          ? 'normal'
          : 'no_activity';

    const quarterRoiSeries = await this.buildRoiQuarterSeries({
      mappedLdaClientIds: roi.mappedLdaClientIds,
      lobbyingYearly: profile.lda.yearlySpend,
      obligationsYearly: profile.contracting.yearlySpend,
      now,
    });

    const trajectoryModel = classifyTrajectory({
      yearlySpend: profile.lda.yearlySpend,
      growthRate: profile.lobbyIntel.growthRate,
      totalSpending: profile.lobbyIntel.totalSpending,
      sourceLabel: profile.lobbyIntel.trajectory,
    });

    const sections = this.normalizeProfileV1Sections({
      snapshot: {
        trajectory: {
          label: trajectoryModel.label,
          growthRate: profile.lobbyIntel.growthRate,
          totalSpending: profile.lobbyIntel.totalSpending,
          yearlySpend: profile.lda.yearlySpend,
          model: {
            label: trajectoryModel.label,
            confidence: trajectoryModel.confidence,
            score: trajectoryModel.score,
            source: trajectoryModel.source,
          },
          fallback: {
            label: profile.lobbyIntel.trajectory,
          },
        },
        health,
        dailyBriefing,
        topAlerts,
        alertsHiddenCount,
        activity14d: Array.from(byDay.values()),
        changes7dCount: changes.length,
      },
      financialFootprint: {
        hero: {
          lobbyingTtm: roi.lobbySpend,
          obligationsTtm: roi.contractWins,
          returnRatio: roi.roi,
          gap: roi.gap,
          truthState: heroTruthState,
        },
        series: {
          lobbying: profile.lda.yearlySpend,
          obligations: profile.contracting.yearlySpend,
          quarterSeries: quarterRoiSeries,
        },
        fecMoneyFlow: fec,
        districtNexus: {
          topDistricts: districtRows,
          // Retained for response-shape back-compat; the free-text capability
          // parse no longer drives topDistricts (now spend-only). Always [] in
          // practice since prod has no capability districtNexus input.
          capabilities: district.capabilities,
        },
      },
      legislativeRegulatory: {
        kanban: {
          total: trackedBills.total,
          issueCodes: trackedBills.issueCodes,
          columns: kanbanColumns,
        },
        regulatoryLifecycle: {
          totalLinkedBills: regLinks.totalBills,
          totalRegulations: regLinks.totalRegulations,
          rails: regulatoryRails,
        },
        hearingsAndMarkups: hearingsList,
      },
      relationships: {
        scopedGraph,
        officeRecommender: officeRecommendations,
        exStafferCount: exStaffers.lobbyists.length,
      },
    });

    const primaryIssueCode = trackedBills.issueCodes
      .find((code) => typeof code === 'string' && code.trim().length > 0)
      ?.trim();
    const competitorIssueHref = primaryIssueCode
      ? `/intelligence/issues/${encodeURIComponent(primaryIssueCode)}`
      : '';

    return {
      client: { id: client.id, name: client.name },
      generatedAt: now.toISOString(),
      meta: {
        schema: 'client-profile-v1',
        sectionOrder: ['snapshot', 'financialFootprint', 'legislativeRegulatory', 'relationships'],
        hasSnapshot: true,
        hasFinancialFootprint: true,
        hasLegislativeRegulatory: true,
        hasRelationships: true,
        generatedAt: now.toISOString(),
        sourceCount,
        unresolvedMappings,
      },
      links: {
        changesInbox: changesInboxHref,
        mappingsAdmin: '/settings/intelligence-mappings',
        competitorIssuePage: competitorIssueHref,
        billDetailBase: '/explorer',
        entityResolutionQueue: '/settings/intelligence-mappings',
      },
      actionTargets: {
        snapshot: {
          seeAllChanges: {
            route: '/intelligence/changes',
            params: { clientId },
            href: changesInboxHref,
          },
          viewAllAlerts: {
            route: '/intelligence/changes',
            params: { clientId },
            href: changesInboxHref,
          },
          mappingsHelp: {
            route: '/settings/intelligence-mappings',
            params: {},
            href: '/settings/intelligence-mappings',
          },
        },
        financial: {
          runFecEnrichment: {
            route: '/settings/intelligence-mappings',
            params: { clientId, source: 'fec_employer' },
            href: '/settings/intelligence-mappings',
          },
          districtSupport: {
            route: '/settings/intelligence-mappings',
            params: { clientId, focus: 'district_nexus' },
            href: '/settings/intelligence-mappings',
          },
        },
        legislative: {
          billDrill: {
            route: '/explorer',
            params: { billIdentifierParam: ':bill' },
            hrefTemplate: '/explorer?bill=:bill',
          },
          syncCalendar: {
            route: '/engagement',
            params: { clientId },
            href: '/engagement',
          },
          setAlerts: {
            route: '/intelligence/changes',
            params: { clientId },
            href: changesInboxHref,
          },
        },
        relationships: {
          officeAll: {
            route: '/intelligence/issues',
            params: { clientId },
            href: '/intelligence/issues',
          },
          officeDrill: {
            route: '/intelligence/issues',
            params: { officeParam: ':office' },
            hrefTemplate: '/intelligence/issues?office=:office',
          },
          graphNodeDrill: {
            route: '/intelligence/issues',
            params: { nodeParam: ':node' },
            hrefTemplate: '/intelligence/issues?node=:node',
          },
        },
      },
      sections,
      movedOut: {
        changesInbox: true,
        entityResolutionQueue: true,
        competitorLeaderboard: true,
        billEnrichment: true,
      },
    };
  }

  /**
   * Phase 4: a real company = a SET of LDA client_ids (one per lobbying-firm
   * relationship). Pure selection: prefer the denormalized clients.lda_client_ids
   * cache, else the confirmed source='lda' mapping externalIds. Returns [] for an
   * unresolved client — callers MUST treat [] as "fall back to name-fuzzy", never
   * as ANY('{}').
   */
  private pickLdaClientIds(
    cached: number[] | null | undefined,
    confirmedExternalIds: string[],
  ): number[] {
    const c = (cached ?? []).filter((n) => Number.isInteger(n));
    if (c.length) return Array.from(new Set(c));
    return Array.from(
      new Set(confirmedExternalIds.map((e) => Number(e)).filter((n) => Number.isInteger(n))),
    );
  }

  /**
   * Tenant-safe LDA id-set resolution for callers that don't already hold the
   * client + mappings. Prefers the clients.lda_client_ids cache, falling back to the
   * confirmed source='lda' mappings — BOTH read under the same tenant scope (clients
   * and client_intel_mapping are RLS-protected), so a foreign clientId yields [].
   */
  private async resolveLdaClientIds(clientId: string, tenantId: string): Promise<number[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId },
        select: { ldaClientIds: true },
      });
      if (!client) return [];
      if ((client.ldaClientIds ?? []).length) return this.pickLdaClientIds(client.ldaClientIds, []);
      const confirmed = await tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      });
      return this.pickLdaClientIds(
        [],
        confirmed.map((m) => m.externalId),
      );
    });
  }

  /**
   * The client's confirmed source='lda' externalIds as an int set, tenant-scoped
   * (client_intel_mapping now carries tenant_id + forced RLS, so a foreign clientId
   * yields []). Functionally the same set as the clients.lda_client_ids cache
   * (kept in sync by prepopulation).
   */
  private async confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]> {
    const mappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      }),
    );
    return this.pickLdaClientIds(
      [],
      mappings.map((m) => m.externalId),
    );
  }

  /**
   * Distinct issue codes unioned across a SET of LDA client ids (Phase 4c). One
   * real company is a SET of lda_client ids (one per firm that lobbies for it);
   * reading codes off a single id undercounts. Mirrors the union idiom already
   * used by getCompetitorBoard / fetchLdaByIds. Returns [] for an empty set.
   */
  private async issueCodesForLdaIds(ldaClientIds: number[]): Promise<string[]> {
    if (!ldaClientIds.length) return [];
    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    return codeRows.map((r) => r.code).filter(Boolean);
  }

  /**
   * Fetch a client's LDA profile aggregated across its FULL confirmed id set
   * (replaces the old single-id fetchLdaById, which undercounted to one of N firm
   * relationships — e.g. Boeing's 27 ids). Two-pass aggregate so id rows that have
   * no issue_codes still contribute to filings/spend.
   */
  private async fetchLdaByIds(ldaClientIds: number[]) {
    if (!ldaClientIds.length) return null;
    const agg = await this.prisma.$queryRaw<
      Array<{ total_filings: number; total_spending: number | null }>
    >`
      SELECT COALESCE(SUM(total_filings), 0)::int AS total_filings,
             SUM(total_spending)::float AS total_spending
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[])
    `;
    const filings = await this.prisma.ldaFiling.findMany({
      where: { clientId: { in: ldaClientIds } },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    });
    // Stale/unknown ids (no lda_client rows and no filings) → treat as unmatched.
    if ((agg[0]?.total_filings ?? 0) === 0 && filings.length === 0) return null;

    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    const yearlySpend = await this.prisma.$queryRaw<Array<{ year: number; amount: number }>>`
      SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount
      FROM lda_filing WHERE client_id = ANY(${ldaClientIds}::int[])
      GROUP BY filing_year ORDER BY filing_year
    `;

    return {
      matched: true,
      ldaClientId: ldaClientIds[0]!, // representative scalar (frontend back-compat)
      ldaClientIds, // the full set
      confidence: 1.0,
      totalFilings: agg[0]?.total_filings ?? 0,
      totalSpending: agg[0]?.total_spending ?? null,
      issueCodes: codeRows.map((r) => r.code).filter(Boolean),
      recentFilings: filings,
      yearlySpend,
    };
  }

  /**
   * Detailed LDA lobbying-disclosure filings for a client, for the Financial
   * Footprint section (which now lists the client's LDA filings rather than the
   * old ROI/FEC/district panels). Resolves the client's confirmed LDA id set
   * (tenant-scoped — a foreign clientId yields an empty, unmatched result), then
   * returns every filing across that set, newest first, with the
   * lobbyist/issue/government-entity detail parsed out of the filing JSON.
   *
   * `income` is the quarterly lobbying income a registrant reports for this
   * client (LD-2). `expenses` is the self-lobbying expense path used by a small
   * number of in-house filers; we surface whichever the filing carries.
   */
  async getClientLdaFilings(clientId: string, tenantId: string) {
    const ldaClientIds = await this.resolveLdaClientIds(clientId, tenantId);
    if (!ldaClientIds.length) {
      return {
        matched: false,
        ldaClientIds: [] as number[],
        totalFilings: 0,
        totalIncome: 0,
        totalExpenses: 0,
        firstFilingYear: null as number | null,
        latestFilingYear: null as number | null,
        registrants: [] as Array<{ name: string; filings: number; income: number }>,
        byYear: [] as Array<{ year: number; income: number; expenses: number; filings: number }>,
        filings: [] as unknown[],
      };
    }

    const rows = await this.prisma.ldaFiling.findMany({
      where: { clientId: { in: ldaClientIds } },
      orderBy: [{ filingYear: 'desc' }, { dtPosted: 'desc' }],
      take: 500,
      select: {
        filingUuid: true,
        filingType: true,
        filingYear: true,
        filingPeriod: true,
        income: true,
        expenses: true,
        dtPosted: true,
        registrantName: true,
        clientName: true,
        issueCodes: true,
        governmentEntities: true,
        lobbyists: true,
        lobbyingActivities: true,
        filingDocumentUrl: true,
      },
    });

    const num = (v: unknown): number => {
      const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const nameList = (json: unknown, key: string): string[] => {
      if (!Array.isArray(json)) return [];
      const out: string[] = [];
      for (const item of json) {
        if (item && typeof item === 'object') {
          const v = (item as Record<string, unknown>)[key];
          if (typeof v === 'string' && v.trim()) out.push(v.trim());
          else if (v && typeof v === 'object') {
            // government_entities arrive as { name } objects in some vintages
            const n = (v as Record<string, unknown>).name;
            if (typeof n === 'string' && n.trim()) out.push(n.trim());
          }
        } else if (typeof item === 'string' && item.trim()) {
          out.push(item.trim());
        }
      }
      return Array.from(new Set(out));
    };
    const lobbyistNames = (json: unknown): string[] => {
      if (!Array.isArray(json)) return [];
      const out: string[] = [];
      for (const item of json) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          // LDA lobbyist rows: { lobbyist: { first_name, last_name } } or flat.
          const inner = (o.lobbyist as Record<string, unknown>) ?? o;
          const first = typeof inner.first_name === 'string' ? inner.first_name : '';
          const last = typeof inner.last_name === 'string' ? inner.last_name : '';
          const full = `${first} ${last}`.trim();
          if (full) out.push(full);
        }
      }
      return Array.from(new Set(out));
    };

    let totalIncome = 0;
    let totalExpenses = 0;
    const byYear = new Map<
      number,
      { year: number; income: number; expenses: number; filings: number }
    >();
    const registrants = new Map<string, { name: string; filings: number; income: number }>();

    const filings = rows.map((r) => {
      const income = num(r.income);
      const expenses = num(r.expenses);
      totalIncome += income;
      totalExpenses += expenses;

      const y = byYear.get(r.filingYear) ?? {
        year: r.filingYear,
        income: 0,
        expenses: 0,
        filings: 0,
      };
      y.income += income;
      y.expenses += expenses;
      y.filings += 1;
      byYear.set(r.filingYear, y);

      const rn = (r.registrantName || '').trim() || 'Unknown registrant';
      const reg = registrants.get(rn) ?? { name: rn, filings: 0, income: 0 };
      reg.filings += 1;
      reg.income += income;
      registrants.set(rn, reg);

      return {
        filingUuid: r.filingUuid,
        filingType: r.filingType,
        filingYear: r.filingYear,
        filingPeriod: r.filingPeriod,
        income,
        expenses,
        amount: income || expenses, // the headline number to show per row
        postedAt: r.dtPosted ? r.dtPosted.toISOString() : null,
        registrantName: rn,
        clientName: r.clientName,
        issueCodes: Array.isArray(r.issueCodes) ? r.issueCodes : [],
        governmentEntities: nameList(r.governmentEntities, 'name'),
        lobbyists: lobbyistNames(r.lobbyists),
        documentUrl: r.filingDocumentUrl ?? null,
      };
    });

    const years = rows.map((r) => r.filingYear);
    return {
      matched: true,
      ldaClientIds,
      totalFilings: rows.length,
      totalIncome,
      totalExpenses,
      firstFilingYear: years.length ? Math.min(...years) : null,
      latestFilingYear: years.length ? Math.max(...years) : null,
      registrants: Array.from(registrants.values())
        .sort((a, b) => b.income - a.income)
        .slice(0, 10),
      byYear: Array.from(byYear.values()).sort((a, b) => b.year - a.year),
      filings,
    };
  }

  /** Fetch contractor data by confirmed ID (skips fuzzy match) */
  private async fetchContractorById(id: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        total_contracts: number | null;
        rank_by_contracts: number | null;
        no_bid_total: number | null;
        yearly_spend_jsonb: object[];
        top_agencies_jsonb: object[];
      }>
    >`
      SELECT id, name, total_contracts, rank_by_contracts, no_bid_total,
             COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb,
             COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb
      FROM federal_contractor WHERE id = ${id}::uuid
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      contractorName: match.name,
      totalContracts: match.total_contracts,
      rankByContracts: match.rank_by_contracts,
      noBidTotal: match.no_bid_total,
      topAgencies: match.top_agencies_jsonb as { name: string; amount: number }[],
      yearlySpend: match.yearly_spend_jsonb as { year: number; amount: number }[],
    };
  }

  /** Fetch lobby intel data by confirmed ID (skips fuzzy match) */
  private async fetchLobbyIntelById(id: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        trajectory: string | null;
        growth_rate: number | null;
        total_spending: number | null;
      }>
    >`
      SELECT id, name, trajectory, growth_rate, total_spending
      FROM lobby_intel_mv WHERE id = ${id}::uuid
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      trajectory: match.trajectory,
      growthRate: match.growth_rate,
      totalSpending: match.total_spending,
    };
  }

  /** Fuzzy match client name against LDA clients */
  private async fuzzyMatchLda(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        name: string;
        total_filings: number;
        total_spending: number | null;
        issue_codes: string[];
        similarity: number;
      }>
    >`
      SELECT c.id, c.name, c.total_filings, c.total_spending, 
             COALESCE(c.issue_codes, '{}') as issue_codes,
             similarity(c.name, ${clientName}) as similarity
      FROM lda_client c
      WHERE similarity(c.name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    // Get recent filings
    const filings = await this.prisma.ldaFiling.findMany({
      where: { clientId: match.id },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    });
    // Get yearly spend trend
    const yearlySpend = await this.prisma.$queryRaw<Array<{ year: number; amount: number }>>`
      SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount
      FROM lda_filing WHERE client_id = ${match.id}
      GROUP BY filing_year ORDER BY filing_year
    `;

    return {
      matched: true,
      ldaClientId: match.id,
      ldaClientIds: [match.id],
      confidence: match.similarity,
      totalFilings: match.total_filings,
      totalSpending: match.total_spending,
      issueCodes: match.issue_codes,
      recentFilings: filings,
      yearlySpend,
    };
  }

  /** Fuzzy match client name against federal contractors */
  private async fuzzyMatchContractor(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        total_contracts: number | null;
        rank_by_contracts: number | null;
        no_bid_total: number | null;
        yearly_spend_jsonb: object[];
        top_agencies_jsonb: object[];
        similarity: number;
      }>
    >`
      SELECT id, name, total_contracts, rank_by_contracts, no_bid_total,
             COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb,
             COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb,
             similarity(name, ${clientName}) as similarity
      FROM federal_contractor
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      contractorName: match.name,
      totalContracts: match.total_contracts,
      rankByContracts: match.rank_by_contracts,
      noBidTotal: match.no_bid_total,
      topAgencies: match.top_agencies_jsonb as { name: string; amount: number }[],
      yearlySpend: match.yearly_spend_jsonb as { year: number; amount: number }[],
    };
  }

  /** Fuzzy match client name against lobby intel */
  private async fuzzyMatchLobbyIntel(clientName: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        trajectory: string | null;
        growth_rate: number | null;
        total_spending: number | null;
        similarity: number;
      }>
    >`
      SELECT id, name, trajectory, growth_rate, total_spending,
             similarity(name, ${clientName}) as similarity
      FROM lobby_intel_mv
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 1
    `;
    if (!rows.length) return null;

    const match = rows[0]!;
    return {
      matched: true,
      trajectory: match.trajectory,
      growthRate: match.growth_rate,
      totalSpending: match.total_spending,
    };
  }

  /** Find Congress bills relevant to the client's issue areas */
  /**
   * Pull capability-derived match terms for a client. Mirrors the keyword
   * extraction inside getTrackedBills() so the profile's `relevantBills` /
   * `activeRegulations` and the standalone /tracked-bills endpoint produce
   * the same fallback set when LDA matching yields no issue codes.
   */
  private async capabilityFallbackTerms(tenantId: string, clientId: string): Promise<string[]> {
    const terms: string[] = [];
    const caps = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: { sector: true, name: true, tags: true },
      }),
    );
    for (const cap of caps) {
      if (cap.sector) terms.push(cap.sector);
      if (cap.name) {
        cap.name
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .forEach((w) => terms.push(w));
      }
      const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
      for (const t of tags) {
        if (typeof t === 'string' && t.length > 3) terms.push(t);
      }
    }
    return terms;
  }

  private async findRelevantBills(issueCodes: string[], fallbackTerms: string[] = []) {
    // Resolve LDA issue codes -> English issue names once, then run
    // embeddings-first bill retrieval with transparent keyword fallback.
    const issueNames: string[] = [];
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames.push(...nameRows.map((r) => r.name));
    }

    const allTerms = expandTerms([...issueNames, ...fallbackTerms])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (!allTerms.length) return { total: 0, bills: [] };

    const embedded = await this.findRelevantBillsByEmbeddings(allTerms);
    if (embedded) return embedded;

    return this.findRelevantBillsByKeyword(allTerms);
  }

  private async findRelevantBillsByEmbeddings(allTerms: string[]): Promise<{
    total: number;
    bills: Array<{
      id: string;
      congress: number;
      billType: string;
      billNumber: string;
      title: string;
      introducedDate: Date | null;
      sponsorName: string | null;
      sponsorParty: string | null;
      sponsorState: string | null;
      latestActionText: string | null;
      latestActionDate: Date | null;
      policyArea: string | null;
      subjects: string[];
    }>;
  } | null> {
    const query = normalize(allTerms.join('. '));
    if (query.length < 10) return null;

    try {
      const vector = await embedText(query);
      const vecLiteral = vectorLiteral(vector);
      // Relevance floor (cosine similarity): drop weakly-related bills so the
      // linker doesn't surface tangential matches. Mirrors the tracked-bills floor.
      const SIMILARITY_FLOOR = 0.65;
      const candidateRows = await this.prisma.$queryRawUnsafe<
        Array<{ source_id: string; score: number }>
      >(
        `SELECT ce.source_id,
                (1 - (ce.embedding <=> $1::vector))::float8 AS score
           FROM context_embeddings ce
          WHERE ce.source_type = 'bill'
            AND ce.model = $2
            AND ce.embedding IS NOT NULL
            AND (1 - (ce.embedding <=> $1::vector)) >= $3
          ORDER BY ce.embedding <=> $1::vector
          LIMIT 150`,
        vecLiteral,
        EMBEDDING_MODEL,
        SIMILARITY_FLOOR,
      );

      const candidateIds = Array.from(
        new Set(
          candidateRows
            .filter((r) => typeof r.source_id === 'string' && r.source_id.trim().length > 0)
            .map((r) => r.source_id.trim()),
        ),
      );
      if (!candidateIds.length) return null;

      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          congress: number;
          bill_type: string;
          bill_number: string;
          title: string;
          introduced_date: Date | null;
          sponsor_name: string | null;
          sponsor_party: string | null;
          sponsor_state: string | null;
          latest_action_text: string | null;
          latest_action_date: Date | null;
          policy_area: string | null;
          subjects: string[];
        }>
      >`
        SELECT cb.id, cb.congress, cb.bill_type, cb.bill_number, cb.title,
               cb.introduced_date, cb.sponsor_name, cb.sponsor_party, cb.sponsor_state,
               cb.latest_action_text, cb.latest_action_date, cb.policy_area, cb.subjects
        FROM congress_bill cb
        WHERE cb.id = ANY(${candidateIds}::text[])
        ORDER BY cb.latest_action_date DESC NULLS LAST
        LIMIT 25
      `;

      if (!rows.length) return null;

      const bills = rows.map((r) => ({
        id: r.id,
        congress: r.congress,
        billType: r.bill_type,
        billNumber: r.bill_number,
        title: r.title,
        introducedDate: r.introduced_date,
        sponsorName: r.sponsor_name,
        sponsorParty: r.sponsor_party,
        sponsorState: r.sponsor_state,
        latestActionText: r.latest_action_text,
        latestActionDate: r.latest_action_date,
        policyArea: r.policy_area,
        subjects: r.subjects ?? [],
      }));

      return { total: candidateIds.length, bills };
    } catch (error) {
      this.logger.warn(
        `Issue-bill embeddings lookup failed, falling back to keyword matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async findRelevantBillsByKeyword(allTerms: string[]) {
    // Whole-word keyword fallback (legacy source). Keeps behavior stable when
    // embeddings are unavailable or backfill has not populated bill vectors.
    const lowerTerms = allTerms.map((n) => n.toLowerCase());
    const wordPatterns = lowerTerms.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);

    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT cb.id)::bigint AS total
      FROM congress_bill cb
      LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
      WHERE LOWER(cbs.name) = ANY(${lowerTerms}::text[])
         OR LOWER(cbs.name) ~ ANY(${wordPatterns}::text[])
         OR LOWER(cb.policy_area) = ANY(${lowerTerms}::text[])
         OR LOWER(cb.policy_area) ~ ANY(${wordPatterns}::text[])
         OR LOWER(cb.title) ~ ANY(${wordPatterns}::text[])
    `;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        congress: number;
        bill_type: string;
        bill_number: string;
        title: string;
        introduced_date: Date | null;
        sponsor_name: string | null;
        sponsor_party: string | null;
        sponsor_state: string | null;
        latest_action_text: string | null;
        latest_action_date: Date | null;
        policy_area: string | null;
        subjects: string[];
      }>
    >`
      SELECT * FROM (
        SELECT DISTINCT ON (cb.id)
          cb.id, cb.congress, cb.bill_type, cb.bill_number, cb.title,
          cb.introduced_date, cb.sponsor_name, cb.sponsor_party, cb.sponsor_state,
          cb.latest_action_text, cb.latest_action_date, cb.policy_area, cb.subjects
        FROM congress_bill cb
        LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
        WHERE LOWER(cbs.name) = ANY(${lowerTerms}::text[])
           OR LOWER(cbs.name) ~ ANY(${wordPatterns}::text[])
           OR LOWER(cb.policy_area) = ANY(${lowerTerms}::text[])
           OR LOWER(cb.policy_area) ~ ANY(${wordPatterns}::text[])
           OR LOWER(cb.title) ~ ANY(${wordPatterns}::text[])
        ORDER BY cb.id
      ) q
      ORDER BY q.latest_action_date DESC NULLS LAST
      LIMIT 25
    `;

    const bills = rows.map((r) => ({
      id: r.id,
      congress: r.congress,
      billType: r.bill_type,
      billNumber: r.bill_number,
      title: r.title,
      introducedDate: r.introduced_date,
      sponsorName: r.sponsor_name,
      sponsorParty: r.sponsor_party,
      sponsorState: r.sponsor_state,
      latestActionText: r.latest_action_text,
      latestActionDate: r.latest_action_date,
      policyArea: r.policy_area,
      subjects: r.subjects ?? [],
    }));

    return { total: Number(countRows[0]?.total ?? 0), bills };
  }

  /**
   * Find active regulations with open comment periods that match this client's
   * LDA issue codes. Two-pass match: (1) topic array contains an LDA issue name
   * as a whole word, OR (2) the document title mentions one of the issue names.
   * The pure exact-equality variant we tried first was too strict, LDA issue
   * names like "Defense" rarely equal FR topic strings like "Defense department"
   * verbatim, so it returned zero rows even for clients with obvious matches.
   */
  private async findActiveRegulations(issueCodes: string[], fallbackTerms: string[] = []) {
    const issueNames: string[] = [];
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames.push(...nameRows.map((r) => r.name));
    }
    const allTerms = [...issueNames, ...fallbackTerms];
    if (!allTerms.length) return { total: 0, documents: [] };

    const lowerTerms = allTerms.map((n) => n.toLowerCase());
    const wordPatterns = lowerTerms.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);

    // Separate COUNT so total isn't truncated by the LIMIT 50 page.
    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM federal_register_document
      WHERE comment_end_date > NOW()
        AND (
          EXISTS (
            SELECT 1 FROM unnest(topics) t
            WHERE LOWER(t) ~ ANY(${wordPatterns}::text[])
          )
          OR LOWER(title) ~ ANY(${wordPatterns}::text[])
        )
    `;

    const docs = await this.prisma.$queryRaw<
      Array<{
        id: string;
        document_number: string;
        type: string;
        title: string;
        agency_names: string[];
        topics: string[];
        comment_end_date: Date | null;
        publication_date: Date;
        significant_rule: boolean;
        html_url: string | null;
      }>
    >`
      SELECT id, document_number, type, title, agency_names, topics,
             comment_end_date, publication_date, significant_rule, html_url
      FROM federal_register_document
      WHERE comment_end_date > NOW()
        AND (
          EXISTS (
            SELECT 1 FROM unnest(topics) t
            WHERE LOWER(t) ~ ANY(${wordPatterns}::text[])
          )
          OR LOWER(title) ~ ANY(${wordPatterns}::text[])
        )
      ORDER BY comment_end_date ASC
      LIMIT 50
    `;

    const documents = docs.map((d) => ({
      id: d.id,
      documentNumber: d.document_number,
      type: d.type,
      title: d.title,
      agencyNames: d.agency_names,
      topics: d.topics,
      commentEndDate: d.comment_end_date,
      publicationDate: d.publication_date,
      significantRule: d.significant_rule,
      htmlUrl: d.html_url,
    }));

    return { total: Number(countRows[0]?.total ?? 0), documents };
  }

  /** Find competitors: other entities lobbying on the same issue codes */
  private async findCompetitors(
    clientName: string,
    issueCodes: string[],
    ldaClientIds: number[] = [],
  ) {
    if (!issueCodes.length) return { topBySpend: [], newEntrants: [] };

    // Self-exclusion (AC-9.2): a RESOLVED client excludes its own LDA ids
    // (c.id <> ALL(ids)) so its other-registrant filings never surface as its
    // own competitor. An UNRESOLVED client (empty id set) has no ids to exclude,
    // so we fall back to a name-similarity guard (< 0.6) — otherwise the client
    // would appear as its own top competitor. Both branches are expressed in
    // parameterized SQL (no dynamic string building); cardinality(ids) picks
    // the active branch per-row.
    const ids = ldaClientIds;

    // Find top spenders on the same issues (excluding the client itself)
    const topBySpend = await this.prisma.$queryRaw<
      Array<{ name: string; total_spending: number; shared_issues: string[] }>
    >`
      SELECT c.name, c.total_spending::float as total_spending,
             c.issue_codes as shared_issues
      FROM lda_client c
      WHERE c.issue_codes && ${issueCodes}::text[]
        AND (
          (cardinality(${ids}::int[]) > 0 AND c.id <> ALL(${ids}::int[]))
          OR (cardinality(${ids}::int[]) = 0 AND similarity(c.name, ${clientName}) < 0.6)
        )
        AND c.total_spending IS NOT NULL
      ORDER BY c.total_spending DESC
      LIMIT 10
    `;

    // Find new entrants (first filing in last 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const newEntrants = await this.prisma.$queryRaw<
      Array<{ name: string; first_filing_date: string; issues: string[] }>
    >`
      SELECT c.name, MIN(f.dt_posted)::text as first_filing_date,
             c.issue_codes as issues
      FROM lda_client c
      JOIN lda_filing f ON f.client_id = c.id
      WHERE c.issue_codes && ${issueCodes}::text[]
        AND (
          (cardinality(${ids}::int[]) > 0 AND c.id <> ALL(${ids}::int[]))
          OR (cardinality(${ids}::int[]) = 0 AND similarity(c.name, ${clientName}) < 0.6)
        )
      GROUP BY c.id, c.name, c.issue_codes
      HAVING MIN(f.dt_posted) >= ${ninetyDaysAgo}
      ORDER BY MIN(f.dt_posted) DESC
      LIMIT 5
    `;

    return {
      topBySpend: topBySpend.map((r) => ({
        name: r.name,
        totalSpending: r.total_spending,
        sharedIssues: r.shared_issues,
      })),
      newEntrants: newEntrants.map((r) => ({
        name: r.name,
        firstFilingDate: r.first_filing_date,
        issues: r.issues,
      })),
    };
  }

  /**
   * Get recent intelligence changes, scoped to the requesting tenant.
   *
   * Cross-tenant safety: `intelligence_change` is a GLOBAL table (no tenant_id).
   * Comment-period emitters write per-(doc × client) rows with descriptions
   * referencing the matched client by name. Returning those globally would
   * leak client names across tenants. We filter to:
   *   - Rows that explicitly touch one of this tenant's clients, OR
   *   - Tenant-neutral rows (empty `relatedClientIds`) which are general
   *     market signals like "5 new GAO reports detected in last 24h".
   *
   * Pass `tenantClientIds` from the caller, typically resolved once with
   * `withTenant(...).client.findMany({ select: { id: true } })`.
   */
  async getChanges(
    tenantId: string,
    since?: string,
    clientId?: string,
    source?: string,
    consumed?: boolean,
    peCodes?: string[],
  ) {
    const tenantClientIds = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
    );
    const ids = tenantClientIds.map((c) => c.id);

    // Validate the optional clientId query param is one of this tenant's clients.
    if (clientId && !ids.includes(clientId)) {
      return [];
    }

    const where: Record<string, unknown> = {};
    if (since) where.detectedAt = { gte: new Date(since) };
    if (source) where.source = source;
    // Optional read/unread filter. The Changes Inbox passes consumed=false so a
    // change a user has cleared stays cleared across reloads (true inbox
    // semantics). Dashboard surfaces (Needs Attention, greeting count) omit the
    // param and still receive every change.
    if (typeof consumed === 'boolean') where.consumed = consumed;
    // PE Watchlist signal feed: scope to changes touching a set of Program
    // Element codes. related_pe_codes is populated by the PE delta/writer emitters
    // and the bill↔PE extractor, and is GIN-indexed, so hasSome is index-supported.
    if (peCodes && peCodes.length > 0) where.relatedPeCodes = { hasSome: peCodes };

    if (clientId) {
      where.relatedClientIds = { has: clientId };
    } else {
      // Either touches one of this tenant's clients, or is tenant-neutral
      // (no related clients at all = general market signal).
      where.OR = [{ relatedClientIds: { hasSome: ids } }, { relatedClientIds: { isEmpty: true } }];
    }

    return this.prisma.intelligenceChange.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Get client-to-intel source mappings. TENANT-SCOPED: the client must belong
   * to the caller's tenant, otherwise this would be a cross-tenant read (the
   * route is auth-guarded but not tenant-scoped, so we enforce ownership here).
   * `clients` is RLS-isolated; the mapping read is additionally backstopped by
   * RLS once client_intel_mapping carries tenant_id.
   */
  async getMappings(clientId: string, tenantId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientIntelMapping.findMany({
        where: { clientId },
        orderBy: { confidence: 'desc' },
      });
    });
  }

  /**
   * Search lda_client by name (trigram) OR by exact numeric LDA client id.
   *
   * Powers the "attach a registrant manually" panel. Fuzzy resolution keys off
   * the client's NAME, so a legacy/renamed variant (e.g. "RAYTHEON TECHNOLOGIES
   * CORPORATION" under a client named "RTX CORPORATION") never clears the
   * similarity floor and can't be confirmed through the auto-resolve flow. Here
   * a human searches freely and pins an EXACT lda_client.id — the reliable,
   * name-independent identifier. We return filing-history columns (state, total
   * filings, latest year, spend, issue codes) so the right record is recognised
   * by its footprint + stable id rather than by name alone.
   */
  async searchLdaClients(query: string) {
    const q = query.trim();
    if (!q) return [];
    const asId = Number(q);
    const idMatch = Number.isInteger(asId) && asId > 0 ? asId : -1;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        name: string;
        state: string | null;
        total_filings: number;
        latest_filing_year: number | null;
        total_spending: number | null;
        issue_codes: string[];
        similarity: number;
      }>
    >`
      SELECT id, name, state,
             total_filings,
             latest_filing_year,
             total_spending::float AS total_spending,
             COALESCE(issue_codes, '{}') AS issue_codes,
             GREATEST(
               similarity(name, ${q}),
               CASE WHEN id = ${idMatch} THEN 1 ELSE 0 END
             ) AS similarity
      FROM lda_client
      WHERE similarity(name, ${q}) > 0.2 OR id = ${idMatch}
      ORDER BY similarity DESC, total_filings DESC
      LIMIT 25
    `;
    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      state: r.state,
      totalFilings: Number(r.total_filings ?? 0),
      latestFilingYear: r.latest_filing_year,
      totalSpending: r.total_spending,
      issueCodes: r.issue_codes ?? [],
      similarity: Number(r.similarity ?? 0),
    }));
  }

  /**
   * Search distinct FEC contributor-employer strings for the manual-attach panel.
   * FEC employer is free-text (no id), so the "external id" IS the employer string.
   * A renamed org's contributions are split across spellings the fuzzy matcher
   * won't surface from the client name (e.g. "RAYTHEON …" under client "RTX"),
   * so the user searches freely and pins each. Returns contribution count, total
   * amount, and latest year so the right employer strings are recognisable.
   */
  async searchFecEmployers(query: string) {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{
        employer: string;
        contribution_count: number;
        total_amount: number | null;
        latest_year: number | null;
        similarity: number;
      }>
    >`
      SELECT contributor_employer AS employer,
             COUNT(*)::int AS contribution_count,
             COALESCE(SUM(amount), 0)::float AS total_amount,
             MAX(EXTRACT(YEAR FROM contribution_date))::int AS latest_year,
             similarity(contributor_employer, ${q}) AS similarity
      FROM fec_contribution
      WHERE contributor_employer IS NOT NULL
        AND similarity(contributor_employer, ${q}) > 0.2
      GROUP BY contributor_employer
      ORDER BY similarity DESC, total_amount DESC
      LIMIT 25
    `;
    return rows.map((r) => ({
      // For fec_employer the employer string is both the id and the name.
      id: r.employer,
      name: r.employer,
      contributionCount: Number(r.contribution_count ?? 0),
      totalAmount: r.total_amount,
      latestYear: r.latest_year,
      similarity: Number(r.similarity ?? 0),
    }));
  }

  /**
   * Search federal_contractor for the manual-attach panel. The contractor row's
   * uuid is the externalId pinned into a source='contracting' mapping (matching
   * fetchContractorById, which reads federal_contractor by id::uuid). Returns
   * identity + contract footprint so a user can recognise the right recipient by
   * its total obligations / category / rank rather than name similarity alone.
   * Accepts a name fuzzy-match or an exact uuid paste.
   */
  async searchContractors(query: string) {
    const q = query.trim();
    if (!q) return [];
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        uei: string | null;
        category: string | null;
        total_contracts: number | null;
        rank_by_contracts: number | null;
        similarity: number;
      }>
    >`
      SELECT id, name, uei, category,
             total_contracts::float AS total_contracts,
             rank_by_contracts,
             GREATEST(
               similarity(name, ${q}),
               CASE WHEN ${isUuid} AND id::text = ${q} THEN 1 ELSE 0 END
             ) AS similarity
      FROM federal_contractor
      WHERE similarity(name, ${q}) > 0.2 OR (${isUuid} AND id::text = ${q})
      ORDER BY similarity DESC, total_contracts DESC NULLS LAST
      LIMIT 25
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      uei: r.uei,
      category: r.category,
      totalContracts: r.total_contracts,
      rankByContracts: r.rank_by_contracts,
      similarity: Number(r.similarity ?? 0),
    }));
  }

  /**
   * Manually attach (and confirm) an external record to a client. For source
   * 'lda' this pins an exact lda_client.id — the reliable way to fold a
   * registrant variant the fuzzy matcher can't reach into a client's footprint.
   * confidence=1 marks it as a deliberate human pin; confirmed=true so the
   * union/match logic reads it immediately. Tenant-scoped: the client must
   * belong to the caller's tenant.
   */
  async createManualMapping(
    clientId: string,
    tenantId: string,
    input: { source: string; externalId: string; externalName: string },
  ) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const mapping = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.upsert({
        where: {
          clientId_source_externalId: {
            clientId,
            source: input.source,
            externalId: input.externalId,
          },
        },
        update: { externalName: input.externalName, confirmed: true },
        create: {
          tenantId,
          clientId,
          source: input.source,
          externalId: input.externalId,
          externalName: input.externalName,
          confidence: 1,
          confirmed: true,
        },
      }),
    );

    // Pinning an LDA entity changes the confirmed set → refresh the cascade
    // (sync lda_client_ids + merge issue codes / signals).
    if (input.source === 'lda') {
      await this.prepopulation?.prepopulate(tenantId, clientId);
    }
    return mapping;
  }

  /** Resolve mappings by fuzzy matching a CRM client against all sources */
  async resolveMapping(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId } }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const clientName = client.name;
    const results: Array<{
      source: string;
      externalId: string;
      externalName: string;
      confidence: number;
    }> = [];

    // Match against each source
    const ldaRows = await this.prisma.$queryRaw<
      Array<{ id: number; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM lda_client WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of ldaRows) {
      results.push({
        source: 'lda',
        externalId: String(r.id),
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    const contractorRows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM federal_contractor WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of contractorRows) {
      results.push({
        source: 'contracting',
        externalId: r.id,
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    const lobbyRows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM lobby_intel_mv WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of lobbyRows) {
      results.push({
        source: 'lobby_intel',
        externalId: r.id,
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    // Upsert mappings (one tenant-scoped transaction for the whole loop)
    const mappings = await this.prisma.withTenant(tenantId, async (tx) => {
      const out = [];
      for (const r of results) {
        const mapping = await tx.clientIntelMapping.upsert({
          where: {
            clientId_source_externalId: {
              clientId,
              source: r.source,
              externalId: r.externalId,
            },
          },
          update: {
            externalName: r.externalName,
            confidence: r.confidence,
          },
          create: {
            tenantId,
            clientId,
            source: r.source,
            externalId: r.externalId,
            externalName: r.externalName,
            confidence: r.confidence,
            confirmed: r.confidence >= 0.6,
          },
        });
        out.push(mapping);
      }
      return out;
    });

    return mappings;
  }

  /**
   * Confirm or reject a mapping. TENANT-SCOPED: the mapping's client must belong to
   * the caller's tenant (the route is auth-guarded but not tenant-scoped). With
   * client_intel_mapping now carrying tenant_id + forced RLS, the tx-scoped read of
   * a foreign id returns null. After the flip, re-run the prepopulation cascade so
   * lda_client_ids + issue codes reflect the new confirmed set (confirm + un-confirm).
   */
  async confirmMapping(mappingId: string, confirmed: boolean, tenantId: string) {
    const mapping = await this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.clientIntelMapping.findUnique({
        where: { id: mappingId },
        select: { id: true, clientId: true },
      });
      const owned = existing
        ? await tx.client.findFirst({ where: { id: existing.clientId }, select: { id: true } })
        : null;
      if (!existing || !owned) throw new NotFoundException('Mapping not found');
      return tx.clientIntelMapping.update({
        where: { id: mappingId },
        data: { confirmed },
      });
    });
    // Re-run the cascade so lda_client_ids + issue codes reflect the new confirmed
    // set (covers both confirm and un-confirm; idempotent).
    if (mapping.source === 'lda') {
      await this.prepopulation?.prepopulate(tenantId, mapping.clientId);
    }
    return mapping;
  }

  /** Mark an intelligence change as consumed/unconsumed */
  async markChangeConsumed(id: string, consumed: boolean) {
    return this.prisma.intelligenceChange.update({
      where: { id },
      data: { consumed },
    });
  }

  /** Count non-consumed changes detected in the last 7 days */
  async getUnreadChangesCount() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const count = await this.prisma.intelligenceChange.count({
      where: { consumed: false, detectedAt: { gte: sevenDaysAgo } },
    });
    return { count };
  }

  /** Lobbying $ vs Contract $ ROI for a client via confirmed mappings */
  async getLobbyingRoi(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, name: true, ldaClientIds: true },
      }),
    );
    if (!client) {
      return {
        clientId,
        clientName: null,
        mappedLdaClientId: null,
        mappedLdaClientIds: [] as number[],
        mappedContractorId: null,
        lobbySpend: 0,
        contractWins: 0,
        roi: null,
        gap: 0,
      };
    }

    const [ldaMappings, contractingMapping] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { clientId, source: 'lda', confirmed: true },
          select: { externalId: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findFirst({
          where: { clientId, source: 'contracting', confirmed: true },
        }),
      ),
    ]);
    // Lobbying spend across the client's FULL LDA id set (all firm relationships),
    // not a single confirmed mapping.
    const ldaClientIds = this.pickLdaClientIds(
      client.ldaClientIds,
      ldaMappings.map((m) => m.externalId),
    );

    let lobbySpend = 0;
    let contractWins = 0;

    if (ldaClientIds.length) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COALESCE(SUM(income), 0)::float AS total
        FROM lda_filing
        WHERE client_id = ANY(${ldaClientIds}::int[])
      `;
      lobbySpend = rows[0]?.total ?? 0;
    }

    if (contractingMapping) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COALESCE(total_contracts, 0)::float AS total
        FROM federal_contractor
        WHERE id = ${contractingMapping.externalId}::uuid
      `;
      contractWins = rows[0]?.total ?? 0;
    }

    const roi = lobbySpend > 0 ? contractWins / lobbySpend : null;
    return {
      clientId,
      clientName: client.name,
      mappedLdaClientId: ldaClientIds[0] ?? null, // representative scalar (back-compat)
      mappedLdaClientIds: ldaClientIds,
      mappedContractorId: contractingMapping?.externalId ?? null,
      lobbySpend,
      contractWins,
      roi,
      gap: contractWins - lobbySpend,
    };
  }

  /**
   * Client's OWN PAC giving (Schedule B): disbursements BY committees mapped to
   * this client (confirmed source='fec_committee') TO candidates. Returns
   * tracked:false when no committee is mapped yet, so the UI distinguishes
   * "no PAC mapped" from "PAC mapped, no giving". Read-only, tenant-scoped via mapping.
   */
  private async getPacGiving(
    clientId: string,
    tenantId: string,
  ): Promise<{
    tracked: boolean;
    committees: Array<{
      committeeId: string;
      committeeName: string | null;
      totalAmount: number;
      disbursementCount: number;
      recipients: Array<{
        recipientName: string;
        candidateName: string | null;
        totalAmount: number;
      }>;
    }>;
    summary: { totalAmount: number; disbursementCount: number; recipientCount: number };
  }> {
    const committeeMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'fec_committee', confirmed: true },
        select: { externalId: true },
      }),
    );
    const committeeIds = Array.from(
      new Set(committeeMappings.map((m) => m.externalId.trim()).filter(Boolean)),
    );
    if (committeeIds.length === 0) {
      return {
        tracked: false,
        committees: [],
        summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
      };
    }

    const rows = await this.prisma.$queryRaw<
      Array<{
        committee_id: string;
        committee_name: string | null;
        recipient_name: string | null;
        candidate_name: string | null;
        total_amount: number;
        disbursement_count: number;
      }>
    >`
      SELECT
        committee_id,
        MAX(committee_name) AS committee_name,
        recipient_name,
        MAX(candidate_name) AS candidate_name,
        COALESCE(SUM(amount), 0)::float AS total_amount,
        COUNT(*)::int AS disbursement_count
      FROM fec_pac_contribution
      WHERE committee_id = ANY(${committeeIds}::text[])
      GROUP BY committee_id, recipient_name
      ORDER BY total_amount DESC
      LIMIT 500
    `;

    const grouped = new Map<
      string,
      {
        committeeId: string;
        committeeName: string | null;
        totalAmount: number;
        disbursementCount: number;
        recipients: Array<{
          recipientName: string;
          candidateName: string | null;
          totalAmount: number;
        }>;
      }
    >();
    for (const r of rows) {
      const g = grouped.get(r.committee_id) ?? {
        committeeId: r.committee_id,
        committeeName: r.committee_name,
        totalAmount: 0,
        disbursementCount: 0,
        recipients: [],
      };
      g.totalAmount += r.total_amount;
      g.disbursementCount += r.disbursement_count;
      if (r.recipient_name) {
        g.recipients.push({
          recipientName: r.recipient_name,
          candidateName: r.candidate_name,
          totalAmount: r.total_amount,
        });
      }
      grouped.set(r.committee_id, g);
    }
    const committees = Array.from(grouped.values()).sort((a, b) => b.totalAmount - a.totalAmount);
    return {
      tracked: true,
      committees,
      summary: {
        totalAmount: committees.reduce((s, c) => s + c.totalAmount, 0),
        disbursementCount: committees.reduce((s, c) => s + c.disbursementCount, 0),
        recipientCount: committees.reduce((s, c) => s + c.recipients.length, 0),
      },
    };
  }

  /**
   * Phase 2.2, FEC money flow trace.
   * contributor_employer (mapped client) → committee → candidate → sponsoring member → committee → bill
   */
  async getFecMoneyFlow(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    if (!client) {
      return {
        clientId,
        clientName: null,
        mappedEmployer: null,
        summary: {
          totalContributions: 0,
          totalAmount: 0,
          committeeCount: 0,
          candidateCount: 0,
          memberCount: 0,
          billCount: 0,
        },
        contributionType: 'individual_employer_linked' as const,
        committees: [],
        pacGiving: { tracked: false as const, committees: [] as never[] },
        disclaimer: FEC_DISCLAIMER,
      };
    }

    // Client's own PAC giving (Schedule B) — computed once, used in all paths below.
    const pacGiving = await this.getPacGiving(clientId, tenantId);

    // Union ALL confirmed FEC-employer strings, not just one. A renamed/large org
    // files individual contributions under several employer spellings ("RAYTHEON",
    // "RTX", "RAYTHEON TECHNOLOGIES CORPORATION"); reading only the single top
    // mapping undercounted the footprint. Mirrors the LDA-registrant union.
    const fecMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'fec_employer', confirmed: true },
        orderBy: { confidence: 'desc' },
      }),
    );
    const employers = Array.from(
      new Set(
        fecMappings
          .map((m) => m.externalName?.trim())
          .filter((e): e is string => Boolean(e && e.length > 0)),
      ),
    );
    const employersLower = employers.map((e) => e.toLowerCase());
    if (!employers.length) {
      return {
        clientId,
        clientName: client.name,
        mappedEmployer: null,
        summary: {
          totalContributions: 0,
          totalAmount: 0,
          committeeCount: 0,
          candidateCount: 0,
          memberCount: 0,
          billCount: 0,
        },
        contributionType: 'individual_employer_linked' as const,
        committees: [],
        pacGiving,
        disclaimer: FEC_DISCLAIMER,
      };
    }

    // Rolling window: count recent giving only, so the headline figure is
    // well-defined and current. The panel labels this "last 24 months" (the
    // previous "TTM" label was inaccurate — the query had no date bound at all).
    // Undated rows fall outside the window and are excluded.
    const windowStart = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);

    const flowRows = await this.prisma.$queryRaw<
      Array<{
        committee_id: string;
        committee_name: string | null;
        candidate_id: string | null;
        candidate_name: string | null;
        contribution_count: number;
        total_amount: number;
        latest_contribution_date: Date | null;
      }>
    >`
      SELECT
        fc.committee_id,
        MAX(fc.committee_name) AS committee_name,
        fc.candidate_id,
        fc.candidate_name,
        COUNT(*)::int AS contribution_count,
        COALESCE(SUM(fc.amount), 0)::float AS total_amount,
        MAX(fc.contribution_date) AS latest_contribution_date
      FROM fec_contribution fc
      WHERE LOWER(fc.contributor_employer) = ANY(${employersLower}::text[])
        AND fc.contribution_date >= ${windowStart}
      GROUP BY fc.committee_id, fc.candidate_id, fc.candidate_name
      ORDER BY total_amount DESC
      LIMIT 250
    `;

    const candidateNames = Array.from(
      new Set(flowRows.map((r) => r.candidate_name).filter((v): v is string => Boolean(v))),
    );
    const candidateNamesLower = candidateNames.map((n) => n.toLowerCase());

    const memberRows = candidateNames.length
      ? await this.prisma.$queryRaw<
          Array<{ candidate_name: string; member_name: string; bill_count: number }>
        >`
          SELECT
            x.candidate_name,
            cb.sponsor_name AS member_name,
            COUNT(DISTINCT cb.id)::int AS bill_count
          FROM (
            SELECT UNNEST(${candidateNames}::text[]) AS candidate_name
          ) x
          JOIN congress_bill cb
            ON LOWER(cb.sponsor_name) = LOWER(x.candidate_name)
          GROUP BY x.candidate_name, cb.sponsor_name
        `
      : [];

    // Bills associated with the money flow, linked the ONLY way that is sound: a
    // recipient candidate who is themselves a bill sponsor. (The previous join
    // matched FEC committee IDs like "C00…" against congressional committee codes
    // like "hsas00" — disjoint ID spaces that never matched, so billCount was
    // always 0.) Keyed by sponsor name so bills attach to the committees that
    // funded that member.
    const sponsoredBillRows = candidateNamesLower.length
      ? await this.prisma.$queryRaw<
          Array<{ sponsor_name: string; bill_id: string; bill_title: string }>
        >`
          SELECT cb.sponsor_name, cb.id AS bill_id, cb.title AS bill_title
          FROM congress_bill cb
          WHERE LOWER(cb.sponsor_name) = ANY(${candidateNamesLower}::text[])
          ORDER BY cb.latest_action_date DESC NULLS LAST
          LIMIT 500
        `
      : [];

    const memberByCandidate = new Map<string, Array<{ memberName: string; billCount: number }>>();
    for (const r of memberRows) {
      const key = r.candidate_name.toLowerCase();
      const arr = memberByCandidate.get(key) ?? [];
      arr.push({ memberName: r.member_name, billCount: r.bill_count });
      memberByCandidate.set(key, arr);
    }

    const billsBySponsor = new Map<
      string,
      Array<{ billId: string; billTitle: string; sponsorName: string | null }>
    >();
    for (const r of sponsoredBillRows) {
      const key = (r.sponsor_name ?? '').toLowerCase();
      if (!key) continue;
      const arr = billsBySponsor.get(key) ?? [];
      arr.push({ billId: r.bill_id, billTitle: r.bill_title, sponsorName: r.sponsor_name });
      billsBySponsor.set(key, arr);
    }

    const grouped = new Map<
      string,
      {
        committeeId: string;
        committeeName: string;
        totalAmount: number;
        contributionCount: number;
        latestContributionDate: Date | null;
        candidates: Array<{
          candidateId: string | null;
          candidateName: string;
          totalAmount: number;
          contributionCount: number;
          linkedMembers: Array<{ memberName: string; billCount: number }>;
        }>;
      }
    >();

    for (const row of flowRows) {
      const committeeName = row.committee_name ?? row.committee_id;
      const candidateName = row.candidate_name ?? 'Unknown candidate';
      if (!grouped.has(row.committee_id)) {
        grouped.set(row.committee_id, {
          committeeId: row.committee_id,
          committeeName,
          totalAmount: 0,
          contributionCount: 0,
          latestContributionDate: row.latest_contribution_date,
          candidates: [],
        });
      }

      const g = grouped.get(row.committee_id)!;
      g.totalAmount += row.total_amount;
      g.contributionCount += row.contribution_count;
      if (
        row.latest_contribution_date &&
        (!g.latestContributionDate || row.latest_contribution_date > g.latestContributionDate)
      ) {
        g.latestContributionDate = row.latest_contribution_date;
      }

      g.candidates.push({
        candidateId: row.candidate_id,
        candidateName,
        totalAmount: row.total_amount,
        contributionCount: row.contribution_count,
        linkedMembers: memberByCandidate.get(candidateName.toLowerCase()) ?? [],
      });
    }

    const committees = Array.from(grouped.values())
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .map((g) => {
        // A committee's associated bills = the bills sponsored by the candidates
        // it funded (deduped across this committee's candidates).
        const billsForCommittee = new Map<
          string,
          { billId: string; billTitle: string; sponsorName: string | null }
        >();
        for (const cand of g.candidates) {
          for (const b of billsBySponsor.get(cand.candidateName.toLowerCase()) ?? []) {
            billsForCommittee.set(b.billId, b);
          }
        }
        return {
          ...g,
          candidates: g.candidates.sort((a, b) => b.totalAmount - a.totalAmount),
          bills: Array.from(billsForCommittee.values()).slice(0, 15),
        };
      });

    const uniqueCandidates = new Set<string>();
    const uniqueMembers = new Set<string>();
    const uniqueBills = new Set<string>();
    for (const c of committees) {
      for (const cand of c.candidates) {
        uniqueCandidates.add(cand.candidateName.toLowerCase());
        for (const m of cand.linkedMembers) uniqueMembers.add(m.memberName.toLowerCase());
      }
      for (const b of c.bills) uniqueBills.add(b.billId);
    }

    const totalAmount = committees.reduce((sum, c) => sum + c.totalAmount, 0);
    const totalContributions = committees.reduce((sum, c) => sum + c.contributionCount, 0);

    return {
      clientId,
      clientName: client.name,
      mappedEmployer: employers.join(', '),
      // Everything in `committees` is Schedule A (received-by-committee) data keyed by
      // contributor EMPLOYER — i.e. individual filers who list this employer. It is
      // legally distinct from the organization's / its PAC's own giving.
      contributionType: 'individual_employer_linked' as const,
      summary: {
        totalContributions,
        totalAmount,
        committeeCount: committees.length,
        candidateCount: uniqueCandidates.size,
        memberCount: uniqueMembers.size,
        billCount: uniqueBills.size,
      },
      committees,
      // The client's OWN PAC giving (Schedule B committee → candidate disbursements),
      // ingested for committees mapped via confirmed ClientIntelMapping(fec_committee).
      // Kept strictly separate from the individual employer-linked data above.
      pacGiving,
      disclaimer: FEC_DISCLAIMER,
    };
  }

  /** Competitor surge detector: other registrants lobbying on same issue codes in last 90 days */
  async getCompetitorBoard(clientId: string, tenantId: string) {
    // Resolve the client's FULL LDA id set (all firm relationships), tenant-scoped.
    const ldaClientIds = await this.confirmedLdaIds(clientId, tenantId);
    if (!ldaClientIds.length) return { competitors: [], leaderboards: [] };

    const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
      SELECT DISTINCT unnest(issue_codes) AS code
      FROM lda_client WHERE id = ANY(${ldaClientIds}::int[]) AND issue_codes IS NOT NULL
    `;
    const issueCodes = codeRows.map((r) => r.code).filter(Boolean);
    if (!issueCodes.length) return { competitors: [], leaderboards: [] };

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [rows, leaderboards] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          registrant_name: string;
          filing_count: number;
          all_time_first: Date | null;
          shared_issues: string[];
        }>
      >`
        SELECT
          f.registrant_name,
          COUNT(*)::int AS filing_count,
          (SELECT MIN(f2.dt_posted) FROM lda_filing f2 WHERE f2.registrant_name = f.registrant_name) AS all_time_first,
          array_agg(DISTINCT ic) FILTER (WHERE ic IS NOT NULL) AS shared_issues
        FROM lda_filing f,
             LATERAL unnest(f.issue_codes) ic
        WHERE f.dt_posted >= ${ninetyDaysAgo}
          AND f.client_id != ALL(${ldaClientIds}::int[])
          AND f.issue_codes && ${issueCodes}::text[]
          AND ic = ANY(${issueCodes}::text[])
        GROUP BY f.registrant_name
        ORDER BY filing_count DESC
        LIMIT 20
      `,
      Promise.all(issueCodes.slice(0, 5).map((code) => this.getIssueLeaderboard(code))),
    ]);

    return {
      competitors: rows.map((r) => ({
        registrantName: r.registrant_name,
        filingCount: r.filing_count,
        isNewEntrant: r.all_time_first !== null && r.all_time_first >= ninetyDaysAgo,
        issueOverlap: r.shared_issues ?? [],
      })),
      leaderboards,
    };
  }

  /** Ex-staffers: lobbyists on this client's filings who have covered government positions */
  async getExStaffers(clientId: string, tenantId: string) {
    // confirmedLdaIds is tenant-scoped (client_intel_mapping now has tenant_id + RLS),
    // so a foreign clientId yields an empty set — no separate belongs-check needed.
    const ldaClientIds = await this.confirmedLdaIds(clientId, tenantId);
    if (!ldaClientIds.length) return { lobbyists: [] };

    const regRows = await this.prisma.$queryRaw<Array<{ registrant_id: number }>>`
      SELECT DISTINCT registrant_id FROM lda_filing
      WHERE client_id = ANY(${ldaClientIds}::int[]) AND registrant_id IS NOT NULL
    `;
    const registrantIds = regRows.map((r) => r.registrant_id);
    if (!registrantIds.length) return { lobbyists: [] };

    const lobbyists = await this.prisma.$queryRaw<
      Array<{
        id: number;
        first_name: string;
        last_name: string;
        covered_positions: unknown;
      }>
    >`
      SELECT id, first_name, last_name, covered_positions
      FROM lda_lobbyist
      WHERE registrant_ids && ${registrantIds}::int[]
        AND covered_positions::text != '[]'
      ORDER BY last_name, first_name
      LIMIT 50
    `;

    return {
      lobbyists: lobbyists.map((l) => ({
        name: `${l.first_name} ${l.last_name}`.trim(),
        coveredPositions: Array.isArray(l.covered_positions) ? l.covered_positions : [],
      })),
    };
  }

  /** Relevant bills for a client, derived from their confirmed LDA issue codes */
  async getClientBills(clientId: string, tenantId: string) {
    // Phase 4c: read issue codes across the client's FULL confirmed LDA id set
    // (one real company = a SET of lda_client ids), not a single firm relationship.
    const ldaClientIds = await this.confirmedLdaIds(clientId, tenantId);
    const issueCodes = await this.issueCodesForLdaIds(ldaClientIds);
    return this.findRelevantBills(issueCodes);
  }

  /** Auto-matched bills per client based on LDA issue codes ↔ CongressBillSubject name overlap */
  /**
   * Intel "setup completeness" for a client: which high-impact inputs are filled
   * so the UI can nudge users toward the fields that most improve matching.
   * Read-only, tenant-scoped. Weighted score (0-100) leads with the LDA mapping —
   * the keystone that unlocks tracked bills + the office recommender. Internal
   * weights are not exposed in the payload.
   */
  async getSetupCompleteness(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, sectorTag: true, issueCodes: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const [confirmedMappings, caps] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { clientId, confirmed: true },
          select: { source: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientCapability.findMany({
          where: { clientId },
          select: { tags: true, description: true },
        }),
      ),
    ]);

    const sources = new Set(confirmedMappings.map((m) => m.source));
    const issueCodeCount = Array.isArray(client.issueCodes) ? client.issueCodes.length : 0;
    const capWithTags = caps.filter(
      (c) => Array.isArray(c.tags) && (c.tags as unknown[]).length > 0,
    ).length;
    const capWithDesc = caps.filter(
      (c) => typeof c.description === 'string' && c.description.trim().length > 0,
    ).length;

    const checks = [
      {
        key: 'lda',
        label: 'LDA mapping confirmed',
        done: sources.has('lda'),
        weight: 3,
        impact: 'Unlocks tracked bills, the office recommender, hearings, and regulations.',
        hint: 'Confirm it in Settings → Intelligence Mappings.',
      },
      {
        key: 'issue_codes',
        label: 'Issue codes set',
        done: issueCodeCount > 0 || sources.has('lda'),
        weight: 2,
        impact: 'Drives bill & regulation matching — even with no LDA mapping.',
        hint: 'Set LDA issue codes on the client form (Sector & Tracks); they auto-fill from the LDA match.',
      },
      {
        key: 'capabilities',
        label: 'Capabilities added',
        done: caps.length > 0,
        weight: 1,
        impact: 'Capabilities feed bill & regulation matching.',
        hint: "Add the client's products/services as capabilities.",
      },
      {
        key: 'capability_tags',
        label: 'Specific capability tags',
        done: capWithTags > 0,
        weight: 2,
        impact:
          'Specific tags (e.g. "hypersonics") sharpen which bills surface; vague tags add noise.',
        hint: 'Add specific tags to each capability; acronyms like EW/C2/ISR auto-expand.',
      },
      {
        key: 'capability_descriptions',
        label: 'Capability descriptions',
        done: capWithDesc > 0,
        weight: 1,
        impact: 'Descriptions power the semantic bill matcher.',
        hint: 'Write a sentence or two describing each capability.',
      },
      {
        key: 'sector',
        label: 'Sector set',
        done: Boolean(client.sectorTag),
        weight: 1,
        impact: 'Drives agency & regulation matching.',
        hint: 'Pick a sector on the client form.',
      },
      {
        key: 'contracting',
        label: 'Contracting mapping confirmed',
        done: sources.has('contracting'),
        weight: 1,
        impact: 'Federal obligations, return ratio, and real district-by-dollars nexus.',
        hint: 'Confirm in Settings → Intelligence Mappings (optional).',
      },
      {
        key: 'fec_employer',
        label: 'FEC employer mapping confirmed',
        done: sources.has('fec_employer'),
        weight: 1,
        impact: 'Employer-linked political-contribution panel.',
        hint: 'Confirm in Settings → Intelligence Mappings (optional).',
      },
    ];

    const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
    const doneWeight = checks.filter((c) => c.done).reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0 ? Math.round((doneWeight / totalWeight) * 100) : 0;

    return {
      clientId,
      score,
      complete: checks.every((c) => c.done),
      checks: checks.map(({ weight: _weight, ...rest }) => rest),
    };
  }

  /**
   * Read-only "what's driving this client's bill/regulation matching" summary for
   * the profile. Surfaces the issue codes the matcher actually uses — the union
   * across all confirmed LDA registrants plus any client-level override — with
   * their human names, the registrant count behind them, and how much richer
   * (capability) signal exists. Makes the otherwise-invisible matching inputs
   * legible so users can see and trust the intel.
   */
  async getIssueCodeSignal(clientId: string, tenantId: string) {
    const ldaMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true, externalName: true },
      }),
    );
    const ldaIds = ldaMappings.map((m) => Number(m.externalId)).filter((n) => Number.isFinite(n));

    const ldaCodes: string[] = [];
    if (ldaIds.length) {
      const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
        SELECT DISTINCT unnest(issue_codes) AS code
        FROM lda_client
        WHERE id = ANY(${ldaIds}::int[]) AND issue_codes IS NOT NULL
      `;
      ldaCodes.push(
        ...codeRows.map((r) => r.code).filter((c) => typeof c === 'string' && c.length > 0),
      );
    }

    let overrideCodes: string[] = [];
    let capabilityTagCount = 0;
    let capabilityDescCount = 0;
    try {
      const [client, caps] = await this.prisma.withTenant(tenantId, (tx) =>
        Promise.all([
          tx.client.findFirst({ where: { id: clientId }, select: { issueCodes: true } }),
          tx.clientCapability.findMany({
            where: { clientId },
            select: { tags: true, description: true },
          }),
        ]),
      );
      if (Array.isArray(client?.issueCodes)) {
        overrideCodes = client!.issueCodes.filter((c): c is string => typeof c === 'string');
      }
      capabilityTagCount = caps.reduce(
        (s, c) => s + (Array.isArray(c.tags) ? (c.tags as unknown[]).length : 0),
        0,
      );
      capabilityDescCount = caps.filter(
        (c) => typeof c.description === 'string' && c.description.trim().length > 0,
      ).length;
    } catch {
      // tenant reads unavailable (e.g. mocked tx) — fall back to LDA-only signal.
    }

    const ldaSet = new Set(ldaCodes.map((c) => c.trim()).filter(Boolean));
    const overrideSet = new Set(overrideCodes.map((c) => c.trim()).filter(Boolean));
    const allCodes = Array.from(new Set([...ldaSet, ...overrideSet])).sort();

    const names: Record<string, string> = {};
    if (allCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ code: string; name: string }>>`
        SELECT code, name FROM lda_issue_code WHERE code = ANY(${allCodes}::text[])
      `;
      for (const r of nameRows) names[r.code] = r.name;
    }

    return {
      clientId,
      ldaRegistrantCount: ldaIds.length,
      ldaRegistrants: ldaMappings.map((m) => m.externalName),
      codes: allCodes.map((code) => ({
        code,
        name: names[code] ?? null,
        source:
          ldaSet.has(code) && overrideSet.has(code) ? 'both' : ldaSet.has(code) ? 'lda' : 'manual',
      })),
      overrideCodeCount: overrideSet.size,
      capabilityTagCount,
      capabilityDescCount,
    };
  }

  /**
   * Office Recommender ("Suggested by Meri") for a client, computed standalone —
   * the same call the profile-v1 aggregate makes (tracked-bill resolution +
   * office scoring), but WITHOUT the rest of the ~25-query aggregate. Lets the
   * Targets tab get recommendations in seconds instead of waiting on the full
   * profile. Returns up to 12 member-identified rows; empty when the recommender
   * is unavailable (bare-constructed in a unit test) or the client has no signal.
   */
  async computeOfficeRecommendations(
    clientId: string,
    tenantId: string,
  ): Promise<OfficeRecommendation[]> {
    if (!this.officeRecommender) return [];
    const tracked = await this.getTrackedBills(clientId, tenantId);
    const trackedBillIds = tracked.bills
      .map((b) => b.identifier)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    return this.officeRecommender.recommend({
      clientId,
      tenantId,
      trackedBillIds,
      trackedBills: tracked.bills.map((b) => ({
        identifier: b.identifier,
        subjectNames: b.subjectNames ?? [],
      })),
      issueCodes: tracked.issueCodes ?? [],
    });
  }

  /**
   * Build the relevance term sets (issue codes + capability keywords/prose,
   * acronym-expanded) used to match bills to a client — the SAME inputs the
   * tracked-bill resolver feeds the embeddings/keyword matchers. Extracted from
   * getTrackedBills so the Tracker Recommendations matcher reuses identical
   * inputs without re-deriving them (and without drifting from this logic).
   */
  async getClientRelevanceTerms(
    clientId: string,
    tenantId: string,
  ): Promise<{
    issueCodes: string[];
    issueNames: string[];
    keywordTermsExpanded: string[];
    embeddingPartsClean: string[];
    hasCapabilitySignal: boolean;
  }> {
    // Union across ALL confirmed LDA registrants, not just one (a large client
    // files under several registrant-name variants, each a distinct lda_client).
    const ldaMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      }),
    );

    let issueCodes: string[] = [];
    let issueNames: string[] = [];

    const ldaCodes: string[] = [];
    if (ldaMappings.length) {
      const ldaIds = ldaMappings.map((m) => Number(m.externalId)).filter((n) => Number.isFinite(n));
      if (ldaIds.length) {
        // DISTINCT unnest = the union of issue codes across every confirmed
        // registrant variant for this client.
        const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
          SELECT DISTINCT unnest(issue_codes) AS code
          FROM lda_client
          WHERE id = ANY(${ldaIds}::int[]) AND issue_codes IS NOT NULL
        `;
        ldaCodes.push(
          ...codeRows.map((r) => r.code).filter((c) => typeof c === 'string' && c.length > 0),
        );
      }
    }

    // Client-level manual override (the "LDA Issue Codes" control). Unioned with
    // the auto codes, applied even with NO LDA mapping so a thin-LDA client can
    // still drive matching by hand. Defensive: a mocked tx may not stub client.
    const overrideCodes: string[] = [];
    try {
      const c = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId }, select: { issueCodes: true } }),
      );
      if (Array.isArray(c?.issueCodes)) overrideCodes.push(...c!.issueCodes);
    } catch {
      // tenant client read unavailable (e.g. mocked tx) — no override applied.
    }

    issueCodes = Array.from(
      new Set([...ldaCodes, ...overrideCodes].map((c) => c.trim()).filter(Boolean)),
    );
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames = nameRows.map((r) => r.name);
    }

    // Build two term sets from the client's capabilities (combined with LDA issue
    // names): keywordTerms (short precise tokens, acronym-expanded) for the
    // whole-word matcher, and embeddingParts (richer prose) for the semantic one.
    const keywordTerms: string[] = [...issueNames];
    const embeddingParts: string[] = [...issueNames];
    let hasCapabilitySignal = false;
    const caps = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: {
          sector: true,
          name: true,
          tags: true,
          description: true,
          justification: true,
          districtNexus: true,
        },
      }),
    );
    hasCapabilitySignal = caps.length > 0;
    for (const cap of caps) {
      if (cap.sector) {
        keywordTerms.push(cap.sector);
        embeddingParts.push(cap.sector);
      }
      if (cap.name) {
        embeddingParts.push(cap.name);
        cap.name
          .split(/\s+/)
          .filter((w) => w.length >= MIN_KEYWORD_TOKEN_LENGTH)
          .forEach((w) => keywordTerms.push(w));
      }
      const tags = Array.isArray(cap.tags)
        ? (cap.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      for (const t of tags) {
        embeddingParts.push(t); // any length — the embedding query is cosine-floored
        if (t.trim().length >= MIN_KEYWORD_TOKEN_LENGTH || isKnownAcronym(t)) {
          keywordTerms.push(t);
        }
      }
      for (const rich of [cap.description, cap.justification, cap.districtNexus]) {
        if (rich) embeddingParts.push(rich);
      }
    }

    // Acronym-expand the keyword tokens (EW → electronic warfare, etc.) so short
    // client tags reach the full-phrase vocabulary used by bill subjects.
    const keywordTermsExpanded = expandTerms(keywordTerms)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const embeddingPartsClean = embeddingParts
      .map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter((n) => n.length > 0);

    return {
      issueCodes,
      issueNames,
      keywordTermsExpanded,
      embeddingPartsClean,
      hasCapabilitySignal,
    };
  }

  async getTrackedBills(clientId: string, tenantId?: string) {
    // Union across ALL confirmed LDA registrants, not just one. A large client
    // (e.g. RTX) files its lobbying under several registrant-name variants —
    // "RTX CORPORATION", "RTX CORPORATION AND AFFILIATES", "RAYTHEON TECHNOLOGIES
    // CORPORATION", various FKA forms — and each is a distinct lda_client. Picking
    // a single one left big clients matching on a thin slice of their footprint.
    // Manually pinned bills (explicit human picks) — always included regardless
    // of embedding similarity, and flagged so the UI can mark them. Tenant-scoped.
    const manualBillIds = tenantId ? await this.getManualTrackedBillIds(clientId, tenantId) : [];
    const manualSet = new Set(manualBillIds);

    // Relevance term sets (issue codes + acronym-expanded capability keywords +
    // semantic prose), extracted into getClientRelevanceTerms so the Tracker
    // Recommendations matcher feeds the embeddings/keyword matchers IDENTICAL
    // inputs without re-deriving (or drifting from) this logic.
    const { issueCodes, keywordTermsExpanded, embeddingPartsClean, hasCapabilitySignal } = tenantId
      ? await this.getClientRelevanceTerms(clientId, tenantId)
      : {
          issueCodes: [] as string[],
          keywordTermsExpanded: [] as string[],
          embeddingPartsClean: [] as string[],
          hasCapabilitySignal: false,
        };

    // Merge auto-matched bills with manually pinned ones. Manual picks are
    // ALWAYS included (even with no terms / no embedding match) and flagged
    // isManual so the UI can mark + pin them. Auto matches that are also
    // manually tracked get isManual:true too.
    const mergeManual = async (auto: {
      total: number;
      bills: Array<{
        identifier: string;
        title: string;
        latestActionDate: Date | null;
        latestActionText: string | null;
        sponsorName: string | null;
        sponsorParty: string | null;
        subjectNames: string[];
        isManual?: boolean;
      }>;
    }) => {
      const flagged = auto.bills.map((b) => ({ ...b, isManual: manualSet.has(b.identifier) }));
      const presentIds = new Set(flagged.map((b) => b.identifier));
      const missingManual = manualBillIds.filter((id) => !presentIds.has(id));
      const manualBills = missingManual.length ? await this.fetchBillsByIds(missingManual) : [];
      const merged = [...manualBills.map((b) => ({ ...b, isManual: true })), ...flagged];
      // total counts the distinct universe of tracked bills (auto + manual).
      return { total: merged.length, issueCodes, bills: merged };
    };

    if (!keywordTermsExpanded.length && !embeddingPartsClean.length) {
      // No relevance signal, but manual picks may still exist — surface them.
      return mergeManual({ total: 0, bills: [] });
    }

    // Thin-signal guard: a client with no capabilities matches on broad LDA
    // issue-code names alone, which produces semantic false positives at the
    // default floor. Require a tighter similarity for those clients.
    const embedded = await this.findTrackedBillsByEmbeddings(
      embeddingPartsClean,
      embeddingSimilarityFloor(hasCapabilitySignal),
    );
    if (embedded) {
      return mergeManual(embedded);
    }

    const keyword = await this.findTrackedBillsByKeyword(keywordTermsExpanded);
    return mergeManual(keyword);
  }

  // ── Manual bill tracking (user-pinned) ────────────────────────────────────

  /** Confirmed-tracked bill ids for a client (tenant-scoped). */
  private async getManualTrackedBillIds(clientId: string, tenantId: string): Promise<string[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({ where: { clientId }, select: { billId: true } }),
    );
    return rows.map((r) => r.billId);
  }

  /** Fetch congress_bill rows by id, shaped like the tracked-bill list entries. */
  private async fetchBillsByIds(ids: string[]): Promise<
    Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>
  > {
    if (!ids.length) return [];
    const bills = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        latest_action_date: Date | null;
        latest_action_text: string | null;
        sponsor_name: string | null;
        sponsor_party: string | null;
        subjects: string[];
      }>
    >`
      SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text,
             cb.sponsor_name, cb.sponsor_party, cb.subjects
      FROM congress_bill cb
      WHERE cb.id = ANY(${ids}::text[])
      ORDER BY cb.latest_action_date DESC NULLS LAST
    `;
    return bills.map((b) => ({
      identifier: b.id,
      title: b.title,
      latestActionDate: b.latest_action_date,
      latestActionText: b.latest_action_text,
      sponsorName: b.sponsor_name,
      sponsorParty: b.sponsor_party,
      subjectNames: b.subjects ?? [],
    }));
  }

  /** List a client's manually tracked bills with full bill detail. */
  async listTrackedBills(clientId: string, tenantId: string) {
    const tracked = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    const billIds = tracked.map((t) => t.billId);
    const bills = await this.fetchBillsByIds(billIds);
    const billById = new Map(bills.map((b) => [b.identifier, b]));
    return tracked.map((t) => ({
      id: t.id,
      billId: t.billId,
      note: t.note,
      createdAt: t.createdAt,
      bill: billById.get(t.billId) ?? null,
    }));
  }

  /** Pin a bill for a client (idempotent on clientId+billId). */
  async addTrackedBill(
    clientId: string,
    tenantId: string,
    billId: string,
    note?: string,
    createdBy?: string,
  ) {
    const trimmedId = billId.trim();
    if (!trimmedId) {
      throw new BadRequestException('billId is required');
    }
    // Verify the bill exists (global table) and the client belongs to the tenant.
    const [billExists] = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM congress_bill WHERE id = ${trimmedId} LIMIT 1
    `;
    if (!billExists) {
      throw new NotFoundException(`Bill ${trimmedId} not found`);
    }
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) {
      throw new NotFoundException(`Client ${clientId} not found`);
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.upsert({
        where: { clientId_billId: { clientId, billId: trimmedId } },
        update: { note: note ?? undefined },
        create: {
          tenantId,
          clientId,
          billId: trimmedId,
          note: note ?? null,
          createdBy: createdBy ?? null,
        },
      }),
    );
  }

  /** Unpin a tracked bill. No-op if it wasn't tracked. */
  async removeTrackedBill(clientId: string, tenantId: string, billId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.deleteMany({ where: { clientId, billId: billId.trim() } }),
    );
    return { removed: true };
  }

  private async findTrackedBillsByEmbeddings(
    allTerms: string[],
    similarityFloor: number = TRACKED_BILL_SIMILARITY_FLOOR,
  ): Promise<{
    total: number;
    bills: Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>;
  } | null> {
    const query = normalize(allTerms.join('. '));
    if (query.length < 10) return null;

    try {
      const vector = await embedText(query);
      const vecLiteral = vectorLiteral(vector);
      // Relevance floor: cosine similarity (1 - distance) must clear this to count
      // as a tracked bill. Without it the vector search returns its top-N nearest
      // regardless of how weakly related, inflating the "tracked" count with noise.
      // The floor is supplied by the caller (see embeddingSimilarityFloor): the
      // default keeps genuinely on-topic bills while dropping tangential matches,
      // and a tighter floor is used for thin-signal (no-capability) clients.
      const SIMILARITY_FLOOR = similarityFloor;
      const candidateRows = await this.prisma.$queryRawUnsafe<
        Array<{ source_id: string; score: number }>
      >(
        `SELECT ce.source_id,
                (1 - (ce.embedding <=> $1::vector))::float8 AS score
           FROM context_embeddings ce
          WHERE ce.source_type = 'bill'
            AND ce.model = $2
            AND ce.embedding IS NOT NULL
            AND (1 - (ce.embedding <=> $1::vector)) >= $3
          ORDER BY ce.embedding <=> $1::vector
          LIMIT 200`,
        vecLiteral,
        EMBEDDING_MODEL,
        SIMILARITY_FLOOR,
      );

      const rankedIds = Array.from(
        new Set(
          candidateRows
            .filter((r) => typeof r.source_id === 'string' && r.source_id.trim().length > 0)
            .map((r) => r.source_id.trim()),
        ),
      );
      if (!rankedIds.length) return null;

      const bills = await this.prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          latest_action_date: Date | null;
          latest_action_text: string | null;
          sponsor_name: string | null;
          sponsor_party: string | null;
          subjects: string[];
        }>
      >`
        SELECT cb.id, cb.title, cb.latest_action_date, cb.latest_action_text,
               cb.sponsor_name, cb.sponsor_party, cb.subjects
        FROM congress_bill cb
        WHERE cb.id = ANY(${rankedIds}::text[])
        ORDER BY cb.latest_action_date DESC NULLS LAST
        LIMIT 50
      `;
      if (!bills.length) return null;

      return {
        total: rankedIds.length,
        bills: bills.map((b) => ({
          identifier: b.id,
          title: b.title,
          latestActionDate: b.latest_action_date,
          latestActionText: b.latest_action_text,
          sponsorName: b.sponsor_name,
          sponsorParty: b.sponsor_party,
          subjectNames: b.subjects ?? [],
        })),
      };
    } catch (error) {
      this.logger.warn(
        `Tracked-bills embeddings lookup failed, falling back to keyword matcher: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async findTrackedBillsByKeyword(allTerms: string[]): Promise<{
    total: number;
    bills: Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>;
  }> {
    const lowerTerms = allTerms.map((n) => n.toLowerCase());
    const wordPatterns = lowerTerms.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);

    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT cb.id)::bigint AS total
      FROM congress_bill cb
      LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
      WHERE LOWER(cbs.name) = ANY(${lowerTerms}::text[])
         OR LOWER(cbs.name) ~ ANY(${wordPatterns}::text[])
         OR LOWER(cb.policy_area) = ANY(${lowerTerms}::text[])
         OR LOWER(cb.policy_area) ~ ANY(${wordPatterns}::text[])
         OR LOWER(cb.title) ~ ANY(${wordPatterns}::text[])
    `;

    const bills = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        latest_action_date: Date | null;
        latest_action_text: string | null;
        sponsor_name: string | null;
        sponsor_party: string | null;
        subjects: string[];
      }>
    >`
      SELECT * FROM (
        SELECT DISTINCT ON (cb.id) cb.id, cb.title, cb.latest_action_date, cb.latest_action_text,
               cb.sponsor_name, cb.sponsor_party, cb.subjects
        FROM congress_bill cb
        LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
        WHERE LOWER(cbs.name) = ANY(${lowerTerms}::text[])
           OR LOWER(cbs.name) ~ ANY(${wordPatterns}::text[])
           OR LOWER(cb.policy_area) = ANY(${lowerTerms}::text[])
           OR LOWER(cb.policy_area) ~ ANY(${wordPatterns}::text[])
           OR LOWER(cb.title) ~ ANY(${wordPatterns}::text[])
        ORDER BY cb.id
      ) q
      ORDER BY q.latest_action_date DESC NULLS LAST
      LIMIT 50
    `;

    return {
      total: Number(countRows[0]?.total ?? 0),
      bills: bills.map((b) => ({
        identifier: b.id,
        title: b.title,
        latestActionDate: b.latest_action_date,
        latestActionText: b.latest_action_text,
        sponsorName: b.sponsor_name,
        sponsorParty: b.sponsor_party,
        subjectNames: b.subjects ?? [],
      })),
    };
  }

  /** Live competitor leaderboard per LDA issue code with new-entrant and shared-lobbyist signals */
  async getIssueLeaderboard(issueCode: string) {
    const issueRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM lda_issue_code WHERE code = ${issueCode}
    `;
    const issueName = issueRows[0]?.name ?? issueCode;

    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [totalRows, registrantRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: string }>>`
        SELECT COUNT(*)::text AS total FROM lda_filing
        WHERE dt_posted >= ${twoYearsAgo} AND ${issueCode} = ANY(issue_codes)
      `,
      this.prisma.$queryRaw<
        Array<{
          registrant_id: number | null;
          registrant_name: string;
          filing_count: number;
          total_income: number | null;
          first_filing_date: Date | null;
        }>
      >`
        SELECT
          registrant_id,
          registrant_name,
          COUNT(*)::int AS filing_count,
          COALESCE(SUM(income), 0)::float AS total_income,
          MIN(dt_posted) AS first_filing_date
        FROM lda_filing
        WHERE dt_posted >= ${twoYearsAgo}
          AND ${issueCode} = ANY(issue_codes)
          AND registrant_name != ''
        GROUP BY registrant_id, registrant_name
        ORDER BY filing_count DESC, total_income DESC
        LIMIT 20
      `,
    ]);

    const totalFilings = parseInt(totalRows[0]?.total ?? '0', 10);

    // Find lobbyists who work for multiple registrants on this issue (potential conflicts)
    const registrantIds = registrantRows
      .map((r) => r.registrant_id)
      .filter((id): id is number => id !== null);

    const sharedByRegistrantId = new Map<number, string[]>();

    if (registrantIds.length > 1) {
      const sharedRows = await this.prisma.$queryRaw<
        Array<{ lobbyist_name: string; shared_registrant_ids: number[] }>
      >`
        SELECT
          TRIM(CONCAT(first_name, ' ', last_name)) AS lobbyist_name,
          ARRAY(
            SELECT r FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
          ) AS shared_registrant_ids
        FROM lda_lobbyist
        WHERE registrant_ids && ${registrantIds}::int[]
          AND (
            SELECT COUNT(*) FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
          ) > 1
        ORDER BY (
          SELECT COUNT(*) FROM unnest(registrant_ids) r WHERE r = ANY(${registrantIds}::int[])
        ) DESC
        LIMIT 30
      `;

      for (const row of sharedRows) {
        for (const regId of row.shared_registrant_ids ?? []) {
          if (!sharedByRegistrantId.has(regId)) sharedByRegistrantId.set(regId, []);
          sharedByRegistrantId.get(regId)!.push(row.lobbyist_name);
        }
      }
    }

    return {
      issueCode,
      issueName,
      totalFilings,
      registrants: registrantRows.map((r) => ({
        name: r.registrant_name,
        filingCount: r.filing_count,
        totalIncome: r.total_income ?? 0,
        isNewEntrant: r.first_filing_date !== null && r.first_filing_date >= ninetyDaysAgo,
        firstFilingDate: r.first_filing_date?.toISOString() ?? null,
        sharedLobbyists:
          r.registrant_id != null ? (sharedByRegistrantId.get(r.registrant_id) ?? []) : [],
      })),
    };
  }

  /** Engagement health score (0-100) per client, per 7-day window */
  async computeEngagementHealth(clientId: string, tenantId: string) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const meetingWhere: Record<string, unknown> = { clientId, startsAt: { gte: sevenDaysAgo } };
    const mailWhere: Record<string, unknown> = { clientId, lastMessageAt: { gte: sevenDaysAgo } };
    const taskWhere: Record<string, unknown> = {
      clientId,
      status: EngagementTaskStatus.done,
      updatedAt: { gte: sevenDaysAgo },
    };
    const debriefWhere: Record<string, unknown> = { clientId, createdAt: { gte: sevenDaysAgo } };
    const outreachWhere: Record<string, unknown> = { clientId, sentAt: { gte: sevenDaysAgo } };

    const priorMeetingWhere: Record<string, unknown> = {
      clientId,
      startsAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };
    const priorMailWhere: Record<string, unknown> = {
      clientId,
      lastMessageAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };
    const priorTaskWhere: Record<string, unknown> = {
      clientId,
      status: EngagementTaskStatus.done,
      updatedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };
    const priorDebriefWhere: Record<string, unknown> = {
      clientId,
      createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };
    const priorOutreachWhere: Record<string, unknown> = {
      clientId,
      sentAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    const [
      meetings,
      emails,
      tasksCompleted,
      debriefs,
      outreachSent,
      priorMeetings,
      priorEmails,
      priorTasks,
      priorDebriefs,
      priorOutreach,
    ] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) => tx.meeting.count({ where: meetingWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.mailThread.count({ where: mailWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.engagementTask.count({ where: taskWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.meetingDebrief.count({ where: debriefWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.outreachRecord.count({ where: outreachWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.meeting.count({ where: priorMeetingWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.mailThread.count({ where: priorMailWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.engagementTask.count({ where: priorTaskWhere })),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meetingDebrief.count({ where: priorDebriefWhere }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.outreachRecord.count({ where: priorOutreachWhere }),
      ),
    ]);

    const expectedWeeklyPace = 100;
    const score = Math.min(
      100,
      Math.round(
        ((meetings * 15 + emails * 2 + tasksCompleted * 10 + debriefs * 20 + outreachSent * 5) /
          expectedWeeklyPace) *
          100,
      ),
    );
    const priorScore = Math.min(
      100,
      Math.round(
        ((priorMeetings * 15 +
          priorEmails * 2 +
          priorTasks * 10 +
          priorDebriefs * 20 +
          priorOutreach * 5) /
          expectedWeeklyPace) *
          100,
      ),
    );

    const trend: 'improving' | 'stable' | 'declining' =
      score > priorScore + 5 ? 'improving' : score < priorScore - 5 ? 'declining' : 'stable';

    return {
      score,
      breakdown: { meetings, emails, tasksCompleted, debriefs, outreachSent },
      trend,
      period: '7d',
    };
  }

  /** Comment-period urgency alerts: upcoming FederalRegisterDocument deadlines matched to tenant clients */
  async getCommentPeriodAlerts(tenantId: string) {
    const now = new Date();
    const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const [clientsWithCaps, docs, stateRules] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          // Exclude soft-archived ("deleted") clients: archiving sets
          // status='archived' but leaves profileStatus untouched, so filtering
          // on profileStatus alone would still surface a deleted client's alerts.
          where: { status: { not: 'archived' }, profileStatus: 'ACTIVE' },
          select: {
            id: true,
            name: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      ),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: fourteenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
      }),
      // W4.5 (M3-D): state_rule is a GLOBAL public table (R1) — read WITHOUT
      // withTenant, exactly like federalRegisterDocument above and
      // check-comment-periods.ts.
      this.prisma.stateRule.findMany({
        where: { commentEndDate: { gt: now, lte: fourteenDaysOut } },
        orderBy: { commentEndDate: 'asc' },
      }),
    ]);

    if ((!docs.length && !stateRules.length) || !clientsWithCaps.length) return { alerts: [] };

    const alerts: Array<{
      documentId: string;
      title: string;
      type: string;
      commentEndDate: Date;
      daysToDeadline: number;
      severity: string;
      agencies: string[];
      clientId: string;
      clientName: string;
      relevanceScore: number;
    }> = [];

    const changesToCreate: Array<{
      dedupeKey: string;
      source: string;
      changeType: string;
      severity: string;
      title: string;
      description: string;
      relatedClientIds: string[];
      relatedIssues: string[];
      data: object;
    }> = [];

    for (const doc of docs) {
      const daysToDeadline = Math.ceil(
        (doc.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';
      const agencies = doc.agencyNames as string[];

      // Determine which sectors this document touches via agency mapping
      const docSectors = new Set<SectorTag>();
      for (const agency of agencies) {
        for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) {
          docSectors.add(sector);
        }
      }
      // LDA codes derived from doc sectors, feeds IntelligenceChange.relatedIssues
      // so the hasSome branch in getCommentPeriodAlerts / generateClientBriefing
      // can surface this change for clients lobbying on the same codes.
      const docLdaCodes = ldaCodesForSectors([...docSectors]);

      for (const client of clientsWithCaps) {
        let baseRelevance = 0;
        const matchedSectors = new Set<SectorTag>();

        // Agency-sector match against client sectorTag (already controlled enum)
        if (client.sectorTag && docSectors.has(client.sectorTag as SectorTag)) {
          baseRelevance = Math.max(baseRelevance, 0.5);
          matchedSectors.add(client.sectorTag as SectorTag);
        }

        // Agency-sector match against capability sectors. cap.sector is free text
        // in legacy data; normalize through the shared taxonomy before comparing.
        for (const cap of client.capabilities) {
          const normalized = normalizeSector(cap.sector);
          if (normalized && docSectors.has(normalized)) {
            baseRelevance = Math.max(baseRelevance, 0.5);
            matchedSectors.add(normalized);
          }
        }

        // Topic match against capability keywords
        if (baseRelevance < 0.7) {
          const capKeywords = new Set<string>();
          for (const cap of client.capabilities) {
            if (cap.sector) capKeywords.add(cap.sector.toLowerCase());
            if (cap.name)
              cap.name
                .split(/\s+/)
                .filter((w) => w.length > 3)
                .forEach((w) => capKeywords.add(w.toLowerCase()));
            const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
            for (const t of tags) {
              if (typeof t === 'string' && t.length > 3) capKeywords.add(t.toLowerCase());
            }
          }

          for (const topic of doc.topics as string[]) {
            const topicLower = topic.toLowerCase();
            for (const kw of capKeywords) {
              if (topicLower.includes(kw) || kw.includes(topicLower)) {
                baseRelevance = Math.max(baseRelevance, 0.7);
                break;
              }
            }
          }
        }

        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;

        alerts.push({
          documentId: doc.id,
          title: doc.title,
          type: doc.type,
          commentEndDate: doc.commentEndDate!,
          daysToDeadline,
          severity,
          agencies,
          clientId: client.id,
          clientName: client.name,
          relevanceScore: Math.round(finalScore * 100) / 100,
        });

        const matchedLdaCodes = matchedSectors.size
          ? ldaCodesForSectors([...matchedSectors])
          : docLdaCodes;
        changesToCreate.push({
          dedupeKey: commentDeadlineDedupeKey('federal_register', doc.id, client.id),
          source: 'federal_register',
          changeType: 'comment_deadline_approaching',
          severity,
          title: `Comment period closing in ${daysToDeadline}d: ${doc.title.slice(0, 80)}`,
          description: `${doc.type} from ${agencies.slice(0, 2).join('/')} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name}.`,
          relatedClientIds: [client.id],
          relatedIssues: matchedLdaCodes,
          data: { documentId: doc.id, daysToDeadline, relevanceScore: finalScore },
        });
      }
    }

    // ── W4.5 (M3-D): STATE rules, matched EXACTLY as the scheduled
    // check-comment-periods.ts verb does — capability-keyword overlap against
    // the rule's title AND abstract (no AGENCY_SECTOR_MAP for state agencies
    // yet, so no sector match; abstract is included to match that verb's header
    // claim). Mirroring the scheduled verb is deliberate: both callers write the
    // SAME ('state_register', ruleId, clientId) dedupeKey, so their match logic
    // must agree or they'd upsert conflicting rows. Pushed into the SAME
    // alerts/changes arrays so `criticalDeadlines` + the Top-alerts card include
    // state rows too. ──
    for (const rule of stateRules) {
      const daysToDeadline = Math.ceil(
        (rule.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const urgencyMultiplier = daysToDeadline < 3 ? 2.0 : daysToDeadline <= 7 ? 1.5 : 1.0;
      const severity = daysToDeadline < 3 ? 'critical' : daysToDeadline <= 7 ? 'notable' : 'info';
      const haystack = `${rule.title} ${rule.abstract ?? ''}`.toLowerCase();

      for (const client of clientsWithCaps) {
        let baseRelevance = 0;
        const capKeywords = new Set<string>();
        for (const cap of client.capabilities) {
          if (cap.sector) capKeywords.add(cap.sector.toLowerCase());
          if (cap.name)
            cap.name
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .forEach((w) => capKeywords.add(w.toLowerCase()));
          const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
          for (const t of tags) {
            if (typeof t === 'string' && t.length > 3) capKeywords.add(t.toLowerCase());
          }
        }
        for (const kw of capKeywords) {
          if (haystack.includes(kw)) {
            baseRelevance = 0.7;
            break;
          }
        }

        const finalScore = baseRelevance * urgencyMultiplier;
        if (finalScore <= 0.3) continue;

        alerts.push({
          documentId: rule.id,
          title: rule.title,
          type: rule.ruleType,
          commentEndDate: rule.commentEndDate!,
          daysToDeadline,
          severity,
          agencies: [rule.agency],
          clientId: client.id,
          clientName: client.name,
          relevanceScore: Math.round(finalScore * 100) / 100,
        });
        changesToCreate.push({
          dedupeKey: commentDeadlineDedupeKey('state_register', rule.id, client.id),
          source: 'state_register',
          changeType: 'comment_deadline_approaching',
          severity,
          title: `Comment period closing in ${daysToDeadline}d: ${rule.title.slice(0, 80)}`,
          description: `${rule.ruleType} from ${rule.state} ${rule.agency} has a comment deadline in ${daysToDeadline} days. Relevant to ${client.name} (relevance: ${Math.round(finalScore * 100)}%).`,
          relatedClientIds: [client.id],
          // State agencies have no LDA-code mapping yet — empty, never a guess.
          relatedIssues: [],
          data: { documentId: rule.id, daysToDeadline, relevanceScore: finalScore },
        });
      }
    }

    // Emit changes (fire-and-forget errors). Idempotent: upsert on the SAME
    // dedupeKey `check-comment-periods.ts` uses for this (document, client)
    // pair, so a re-run of the scheduled verb OR simply reloading this
    // on-demand dashboard read never creates a second row (M3.4/M4.2 —
    // comment-deadline.util.ts's doc comment previously described this as
    // already done for both callers; this caller had not actually been
    // switched over to `upsert` yet).
    await Promise.all(
      changesToCreate.map((c) =>
        this.prisma.intelligenceChange
          .upsert({ where: { dedupeKey: c.dedupeKey }, create: c, update: c })
          .catch((err) => {
            this.logger.warn(`Failed to emit comment-period change: ${err.message}`);
          }),
      ),
    );

    alerts.sort((a, b) => a.daysToDeadline - b.daysToDeadline);
    return { alerts };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Compute-on-read alert sources for the client-profile "Top alerts" card.
  // Each returns the builder's normalized internal shape and NEVER throws —
  // a failure inside profile-v1's allSettled simply omits that alert type.
  // ──────────────────────────────────────────────────────────────────────────

  /** Internal alert row shape shared by every compute-on-read alert source. */
  private alertCountdownLabel(days: number | null): string | null {
    if (days == null) return null;
    if (days < 0) return `Overdue ${Math.abs(days)}d`;
    if (days === 0) return 'Due today';
    if (days === 1) return '1d left';
    return `${days}d left`;
  }

  /** Resolve a client's LDA issue codes (confirmed mapping) for competitor matching. */
  private async getClientIssueCodes(clientId: string, tenantId: string): Promise<string[]> {
    // Phase 4c: union issue codes across the FULL confirmed LDA id set.
    const ldaClientIds = await this.confirmedLdaIds(clientId, tenantId);
    return this.issueCodesForLdaIds(ldaClientIds);
  }

  /**
   * Upcoming hearings & markups matched to a client (next `until` days). Mirrors
   * the profile-v1 hearingsList committee/bill matching so the alert is genuinely
   * client-relevant, not the global calendar. Countdown is days-UNTIL the hearing.
   */
  async getHearingAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    until: Date,
    precomputedTracked?:
      | Promise<Awaited<ReturnType<typeof this.getTrackedBills>>>
      | Awaited<ReturnType<typeof this.getTrackedBills>>,
  ): Promise<AlertRow[]> {
    try {
      // Tracked bills give us the bill identifiers + the committees of jurisdiction
      // to match hearings against (same signal the removed Hearings panel used).
      const tracked = await (precomputedTracked ?? this.getTrackedBills(clientId, tenantId));
      const billVariants = (tracked.bills ?? []).map((b) => ({
        identifier: b.identifier,
        // "hr-1234" / "hr 1234" / "h.r. 1234" style variants for title matching.
        variants: [
          b.identifier.toLowerCase(),
          b.identifier.toLowerCase().replace(/-/g, ' '),
          b.identifier.toLowerCase().replace(/-/g, '.'),
        ],
      }));
      if (billVariants.length === 0) return [];

      const hearings = await this.prisma.committeeHearing.findMany({
        where: { date: { gte: now, lte: until } },
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
        take: 40,
      });

      const out: AlertRow[] = [];
      for (const h of hearings) {
        const titleLower = h.title.toLowerCase();
        const linked = billVariants
          .filter((b) => b.variants.some((v) => titleLower.includes(v)))
          .map((b) => b.identifier);
        if (linked.length === 0) continue; // keep only client-relevant hearings
        const d = new Date(h.date);
        const days = Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const severity = days < 3 ? 'critical' : days <= 7 ? 'notable' : 'info';
        out.push({
          id: `hearing:${h.id}`,
          type: 'hearing',
          severity,
          title: `${h.committeeName}: ${h.title}`.slice(0, 140),
          subtitle: `${h.chamber} ${h.type ?? 'hearing'} · ${linked.slice(0, 3).join(', ')}`,
          when: d.toISOString(),
          countdownDays: days,
          countdownLabel: this.alertCountdownLabel(days),
          href: `/intelligence/bills/${encodeURIComponent(linked[0] ?? '')}?clientId=${encodeURIComponent(clientId)}`,
          _urgencyScore: 100 - Math.max(-30, Math.min(days, 100)),
          _typeRank: 2,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `getHearingAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Comment deadlines that JUST closed (window [now-lookback, now)) and match the
   * client — the "deadline closed, did we file?" nudge. Reuses the same relevance
   * matching as getCommentPeriodAlerts but on the recently-expired window.
   */
  async getOverdueCommentAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    lookbackStart: Date,
  ): Promise<AlertRow[]> {
    try {
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: {
            id: true,
            name: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      );
      if (!client) return [];

      const docs = await this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gte: lookbackStart, lt: now },
        },
        orderBy: { commentEndDate: 'desc' },
        take: 40,
      });
      if (!docs.length) return [];

      const capKeywords = new Set<string>();
      if (client.sectorTag) capKeywords.add(String(client.sectorTag).toLowerCase());
      for (const cap of client.capabilities) {
        if (cap.sector) capKeywords.add(cap.sector.toLowerCase());
        if (cap.name)
          cap.name
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .forEach((w) => capKeywords.add(w.toLowerCase()));
        const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
        for (const t of tags) {
          if (typeof t === 'string' && t.length > 3) capKeywords.add(t.toLowerCase());
        }
      }
      const normalizedClientSector = normalizeSector(client.sectorTag);

      const out: AlertRow[] = [];
      for (const doc of docs) {
        const agencies = (doc.agencyNames as string[]) ?? [];
        const docSectors = new Set<SectorTag>();
        for (const agency of agencies) {
          for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) docSectors.add(sector);
        }
        let relevant = false;
        if (normalizedClientSector && docSectors.has(normalizedClientSector)) relevant = true;
        if (!relevant) {
          const topics = Array.isArray(doc.topics) ? (doc.topics as string[]) : [];
          for (const topic of topics) {
            const tl = topic.toLowerCase();
            for (const kw of capKeywords) {
              if (tl.includes(kw) || kw.includes(tl)) {
                relevant = true;
                break;
              }
            }
            if (relevant) break;
          }
        }
        if (!relevant) continue;

        const days = Math.ceil(
          (doc.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        ); // negative
        out.push({
          id: `comment_overdue:${doc.id}`,
          type: 'comment_overdue',
          severity: 'notable',
          title: `Deadline closed: ${doc.title}`.slice(0, 140),
          subtitle: agencies.slice(0, 2).join(' / ') || 'Federal Register',
          when: doc.commentEndDate!.toISOString(),
          countdownDays: days,
          countdownLabel: this.alertCountdownLabel(days),
          href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=comment_overdue`,
          _urgencyScore: 30, // recently lapsed: notable but below live deadlines
          _typeRank: 2,
        });
      }
      return out.slice(0, 5);
    } catch (err) {
      this.logger.warn(
        `getOverdueCommentAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * New competitor LDA activity on the client's issue codes (last `since` window).
   * A DIFFERENT registrant/client filing on the same issue codes the client
   * lobbies on — the intelligence-edge alert. NOTE: LDA filings are quarterly, so
   * this is necessarily a slower cadence than the deadline/hearing alerts.
   */
  async getCompetitorLdaAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> {
    try {
      const issueCodes = await this.getClientIssueCodes(clientId, tenantId);
      if (issueCodes.length === 0) return [];

      // The client's own LDA client name(s) so we exclude their own filings.
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId }, select: { name: true } }),
      );
      const ownName = (client?.name ?? '').trim().toLowerCase();

      const filings = await this.prisma.ldaFiling.findMany({
        where: {
          dtPosted: { gte: since },
          issueCodes: { hasSome: issueCodes },
        },
        orderBy: { dtPosted: 'desc' },
        take: 25,
      });

      const seenRegistrants = new Set<string>();
      const out: AlertRow[] = [];
      for (const f of filings) {
        const registrant = (f.registrantName ?? '').trim();
        const filingClient = (f.clientName ?? '').trim();
        // Skip the client's own filings (match on client name) and dedupe per registrant.
        if (ownName && filingClient.toLowerCase() === ownName) continue;
        const dedupeKey = `${registrant.toLowerCase()}|${filingClient.toLowerCase()}`;
        if (seenRegistrants.has(dedupeKey)) continue;
        seenRegistrants.add(dedupeKey);
        if (!f.dtPosted) continue;
        const overlap = (f.issueCodes ?? []).filter((c) => issueCodes.includes(c));
        out.push({
          id: `competitor:${f.id}`,
          type: 'competitor_filing',
          severity: 'info',
          title: `New lobbying filing: ${registrant || 'Unknown firm'}`,
          subtitle: `${filingClient || 'Undisclosed client'} · issues ${overlap.slice(0, 3).join(', ')}`,
          when: f.dtPosted.toISOString(),
          countdownDays: null,
          countdownLabel: null,
          href: `/intelligence/issues/${encodeURIComponent(overlap[0] ?? issueCodes[0] ?? '')}?clientId=${encodeURIComponent(clientId)}`,
          _urgencyScore: 10,
          _typeRank: 1,
        });
        if (out.length >= 5) break;
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `getCompetitorLdaAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * New federal contract awards relevant to the client (last `since` window).
   * Matched on the client's confirmed contracting mapping (contractor name) so
   * "a contract just landed" surfaces as an alert.
   */
  async getContractAwardAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> {
    try {
      const mapping = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findFirst({
          where: { clientId, source: 'contracting', confirmed: true },
          select: { externalId: true },
        }),
      );
      const contractorName = mapping?.externalId?.trim();
      if (!contractorName) return [];

      const awards = await this.prisma.federalAward.findMany({
        where: {
          contractorName: { equals: contractorName, mode: 'insensitive' },
          awardedAt: { gte: since },
        },
        orderBy: { awardedAt: 'desc' },
        take: 10,
      });

      const out: AlertRow[] = [];
      for (const a of awards) {
        if (!a.awardedAt) continue;
        const amount = a.amount ? Number(a.amount) : 0;
        out.push({
          id: `award:${a.id}`,
          type: 'contract_award',
          severity: 'notable',
          title: `New federal award${amount > 0 ? `: $${Math.round(amount).toLocaleString('en-US')}` : ''}`,
          subtitle: `${a.awardingAgency ?? 'Federal agency'}${a.description ? ` · ${a.description.slice(0, 60)}` : ''}`,
          when: a.awardedAt.toISOString(),
          countdownDays: null,
          countdownLabel: null,
          href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=contract_award`,
          _urgencyScore: 25,
          _typeRank: 1,
        });
        if (out.length >= 5) break;
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `getContractAwardAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-user alert worklist state (ack / dismiss / snooze) — tenant + user scoped.
  // ──────────────────────────────────────────────────────────────────────────

  /** Upsert per-user state for a specific alert. snoozedUntil only meaningful for 'snoozed'. */
  async setAlertState(
    tenantId: string,
    userId: string,
    clientId: string,
    alertId: string,
    state: 'acknowledged' | 'dismissed' | 'snoozed',
    snoozedUntil?: Date | null,
  ) {
    // Verify the client belongs to the tenant (RLS also enforces, but fail fast).
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const resolvedSnooze = state === 'snoozed' ? (snoozedUntil ?? null) : null;
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.alertState.upsert({
        where: { userId_clientId_alertId: { userId, clientId, alertId } },
        create: { tenantId, userId, clientId, alertId, state, snoozedUntil: resolvedSnooze },
        update: { state, snoozedUntil: resolvedSnooze },
        select: { id: true, alertId: true, state: true, snoozedUntil: true },
      }),
    );
  }

  /** Clear per-user state for an alert (undo ack/dismiss/snooze). Idempotent. */
  async clearAlertState(tenantId: string, userId: string, clientId: string, alertId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertState.deleteMany({ where: { userId, clientId, alertId } }),
    );
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Client briefs — saved notes promoted from alerts (or free-form). Surface in
  // the Outreach wizard context section. Tenant-scoped.
  // ──────────────────────────────────────────────────────────────────────────

  async listClientBriefs(tenantId: string, clientId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          body: true,
          sourceAlertId: true,
          sourceType: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  async addClientBrief(
    tenantId: string,
    clientId: string,
    userId: string,
    input: {
      title: string;
      body: string;
      sourceAlertId?: string | null;
      sourceType?: string | null;
    },
  ) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.create({
        data: {
          tenantId,
          clientId,
          createdBy: userId,
          title: input.title.trim().slice(0, 300),
          body: input.body.trim(),
          sourceAlertId: input.sourceAlertId ?? null,
          sourceType: input.sourceType ?? 'manual',
        },
        select: {
          id: true,
          title: true,
          body: true,
          sourceAlertId: true,
          sourceType: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  async deleteClientBrief(tenantId: string, clientId: string, briefId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.deleteMany({ where: { id: briefId, clientId } }),
    );
    return { ok: true };
  }

  /** Knowledge graph nodes + edges for hub-and-spoke visualization (powered by kg_walk view/function layer) */
  async getKnowledgeGraph(clientId: string, tenantId: string) {
    const [client, mappings, walkRows] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: { id: true, name: true, sectorTag: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { clientId },
          orderBy: { confidence: 'desc' },
        }),
      ),
      // kg_walk is a server-side graph-traversal function that fans out to
      // depth=2 with LIMIT 500. On warm Aurora it usually finishes in 1-2s
      // but cold-cache or large graphs push it to 5-8s, which used to blow
      // past the 5s default $transaction timeout and 500 the entire
      // /api/intelligence/client-profile-v1/:clientId endpoint. Give this
      // specific tenant transaction a 30s ceiling.
      this.prisma.withTenant(
        tenantId,
        (tx) =>
          tx.$queryRaw<
            Array<{
              depth: number;
              src_kind: string;
              src_id: string;
              dst_kind: string;
              dst_id: string;
              edge_type: string;
              confidence: number | null;
              source: string | null;
              observed_at: Date | null;
              tenant_id: string | null;
            }>
          >`
          SELECT depth, src_kind, src_id, dst_kind, dst_id, edge_type, confidence, source, observed_at, tenant_id
          FROM kg_walk('client', ${clientId}, 2, NULL)
          LIMIT 500
        `,
        { timeoutMs: 30_000 },
      ),
    ]);

    const clientLabel = client?.name ?? clientId;
    const centerNodeId = `client:${clientId}`;

    // Step 1, drop unconfirmed auto-match noise.
    //
    // The entity resolver writes a row to client_intel_mapping for EVERY
    // candidate LDA/FEC/contracting match it finds, then waits for a human
    // to confirm one. Until then those mappings have `confirmed = false`
    // and our view emits one client→lda_client edge per candidate, which
    // is what produced the 68-node "all AGENCY" mess in the screenshot.
    //
    // The graph should reflect the *resolved* state, not the candidate
    // pool. We drop edges where source='auto_matched' (the marker we set
    // in kg_tenant_edges for unconfirmed mappings) so only manually
    // confirmed bridges + canonical edges remain.
    const filteredWalkRows = walkRows.filter((r) => r.source !== 'auto_matched');

    // Step 2, batch-resolve human labels for ID-keyed kinds.
    //
    // Many node kinds use opaque numeric IDs (LDA client = int, LDA
    // registrant = int, LDA lobbyist = int, FEC committee = string code)
    // or UUIDs (federal_contractor, capability). Without a name lookup
    // the graph rendered "189497" / "67101" / raw UUIDs as labels.
    // Collect the ids per kind across the filtered walk, then do one
    // SELECT per kind to build a kind:id → name map.
    const idsByKind = new Map<string, Set<string>>();
    const collect = (kind: string, id: string) => {
      const set = idsByKind.get(kind) ?? new Set<string>();
      set.add(id);
      idsByKind.set(kind, set);
    };
    for (const row of filteredWalkRows) {
      collect(row.src_kind, row.src_id);
      collect(row.dst_kind, row.dst_id);
    }
    const labelByNodeKey = new Map<string, string>();
    const lookups: Array<Promise<void>> = [];

    const ldaClientIds = Array.from(idsByKind.get('lda_client') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (ldaClientIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
            SELECT id, name FROM lda_client WHERE id = ANY(${ldaClientIds}::int[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`lda_client:${r.id}`, r.name);
        }),
      );
    }

    const ldaRegistrantIds = Array.from(idsByKind.get('lda_registrant') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (ldaRegistrantIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; name: string }>>`
            SELECT id, name FROM lda_registrant WHERE id = ANY(${ldaRegistrantIds}::int[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`lda_registrant:${r.id}`, r.name);
        }),
      );
    }

    const ldaLobbyistIds = Array.from(idsByKind.get('lda_lobbyist') ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (ldaLobbyistIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: number; first_name: string; last_name: string }>>`
            SELECT id, first_name, last_name FROM lda_lobbyist WHERE id = ANY(${ldaLobbyistIds}::int[])
          `.then((rows) => {
          for (const r of rows) {
            const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();
            labelByNodeKey.set(`lda_lobbyist:${r.id}`, name || `Lobbyist ${r.id}`);
          }
        }),
      );
    }

    const contractorIds = Array.from(idsByKind.get('federal_contractor') ?? []);
    if (contractorIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
            SELECT id, name FROM federal_contractor WHERE id::text = ANY(${contractorIds}::text[])
          `.then((rows) => {
          for (const r of rows) labelByNodeKey.set(`federal_contractor:${r.id}`, r.name);
        }),
      );
    }

    const fecCommitteeIds = Array.from(idsByKind.get('fec_committee') ?? []);
    if (fecCommitteeIds.length) {
      lookups.push(
        this.prisma.$queryRaw<Array<{ committee_id: string; committee_name: string | null }>>`
            SELECT DISTINCT committee_id, committee_name
            FROM fec_contribution
            WHERE committee_id = ANY(${fecCommitteeIds}::text[])
              AND committee_name IS NOT NULL
          `.then((rows) => {
          for (const r of rows) {
            if (r.committee_name)
              labelByNodeKey.set(`fec_committee:${r.committee_id}`, r.committee_name);
          }
        }),
      );
    }

    const capabilityIds = Array.from(idsByKind.get('capability') ?? []);
    if (capabilityIds.length) {
      lookups.push(
        this.prisma
          .withTenant(tenantId, (tx) =>
            tx.clientCapability.findMany({
              where: { id: { in: capabilityIds }, tenantId },
              select: { id: true, name: true },
            }),
          )
          .then((rows) => {
            for (const r of rows) labelByNodeKey.set(`capability:${r.id}`, r.name);
          }),
      );
    }

    await Promise.all(lookups);

    // Step 3, expand kindToUiType so distinct kinds get distinct visual
    // treatment instead of all collapsing onto "AGENCY".
    const kindToUiType = (
      kind: string,
    ): 'client' | 'registrant' | 'lobbyist' | 'contractor' | 'bill' | 'pac' | 'agency' => {
      switch (kind) {
        case 'client':
          return 'client';
        case 'lda_client':
        case 'lda_registrant':
        case 'registrant':
          // LDA clients/registrants are both org-like; render with the
          // registrant chrome since they share the "lobbying firm" feel.
          return 'registrant';
        case 'lda_lobbyist':
        case 'lobbyist':
        case 'member':
        case 'candidate':
          // People, legislators, candidates, registered lobbyists.
          return 'lobbyist';
        case 'federal_contractor':
        case 'contractor':
          return 'contractor';
        case 'bill':
        case 'congress_bill':
        case 'subject':
        case 'policy_area':
        case 'lda_issue_code':
          // Bill-adjacent topical nodes share the bill chrome.
          return 'bill';
        case 'fec_committee':
        case 'fec_contribution':
        case 'employer':
        case 'pac':
          return 'pac';
        case 'capability':
        case 'program_element':
        case 'committee':
        case 'hearing':
        case 'agency':
        case 'docket':
        case 'fr_document':
        default:
          return 'agency';
      }
    };

    const prettyLabel = (kind: string, id: string) => {
      if (kind === 'client') return clientLabel;
      // Use the batch-resolved name if we have one.
      const resolved = labelByNodeKey.get(`${kind}:${id}`);
      if (resolved) {
        return resolved.length > 96 ? `${resolved.slice(0, 96)}…` : resolved;
      }
      // Some kinds carry meaningful values as their id (bill numbers,
      // committee codes, issue code names), let those pass through
      // verbatim.
      if (
        kind === 'bill' ||
        kind === 'subject' ||
        kind === 'policy_area' ||
        kind === 'committee' ||
        kind === 'agency' ||
        kind === 'employer' ||
        kind === 'candidate' ||
        kind === 'member' ||
        kind === 'program_element' ||
        kind === 'foreign_principal' ||
        kind === 'sec_company'
      ) {
        return id.length > 96 ? `${id.slice(0, 96)}…` : id;
      }
      // Last resort, opaque ID. Prefix with kind so it's at least
      // legible as "(lda_client) 189497" rather than a naked number.
      return `(${kind.replace(/_/g, ' ')}) ${id.length > 24 ? id.slice(0, 24) + '…' : id}`;
    };

    const nodeMap = new Map<
      string,
      { id: string; type: string; label: string; metadata: Record<string, unknown> }
    >();
    const edgeMap = new Map<
      string,
      { source: string; target: string; type: string; label: string }
    >();

    nodeMap.set(centerNodeId, {
      id: centerNodeId,
      type: 'client',
      label: clientLabel,
      metadata: { sectorTag: client?.sectorTag ?? null },
    });

    const upsertNode = (kind: string, id: string, extras: Record<string, unknown> = {}) => {
      const nodeId = `${kind}:${id}`;
      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          type: kindToUiType(kind),
          label: prettyLabel(kind, id),
          metadata: { kind, rawId: id, ...extras },
        });
      }
      return nodeId;
    };

    for (const row of filteredWalkRows) {
      const srcNodeId = upsertNode(row.src_kind, row.src_id, {
        source: row.source,
        observedAt: row.observed_at,
      });
      const dstNodeId = upsertNode(row.dst_kind, row.dst_id, {
        source: row.source,
        observedAt: row.observed_at,
      });

      const edgeKey = `${srcNodeId}->${dstNodeId}:${row.edge_type}`;
      if (!edgeMap.has(edgeKey)) {
        edgeMap.set(edgeKey, {
          source: srcNodeId,
          target: dstNodeId,
          type: row.edge_type,
          label: row.edge_type.replace(/_/g, ' '),
        });
      }
    }

    const confirmedMappings = mappings.filter((m) => m.confirmed);
    const avgConfidence =
      confirmedMappings.length > 0
        ? confirmedMappings.reduce((s, m) => s + (m.confidence ?? 0), 0) / confirmedMappings.length
        : 0;

    return {
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      resolutionQuality: {
        avgConfidence: Math.round(avgConfidence * 100),
        confirmedCount: confirmedMappings.length,
        unconfirmedCount: mappings.filter((m) => !m.confirmed).length,
      },
    };
  }

  /** Outreach intelligence context, formatted text block for AI prompt injection */
  async getOutreachContext(clientId: string, tenantId: string, recipientOffice?: string) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Phase 4c: union issue codes across the client's FULL confirmed LDA id set.
    const ldaClientIds = await this.confirmedLdaIds(clientId, tenantId);
    const issueCodes = await this.issueCodesForLdaIds(ldaClientIds);

    // Tracked bills + upcoming hearings + recent changes + comment deadlines in parallel.
    // Comment-period emitters now populate `relatedIssues` via SECTOR_TO_LDA_CODES;
    // other sync emitters (emit-changes, compute-health-scores) still leave it empty,
    // so the hasSome branch surfaces sector-mapped events but not source-summary rows.
    const changeOrConditions: Record<string, unknown>[] = [{ relatedClientIds: { has: clientId } }];
    if (issueCodes.length) changeOrConditions.push({ relatedIssues: { hasSome: issueCodes } });

    const [trackedBills, hearings, recentChanges, commentPeriods, healthScore] = await Promise.all([
      this.getTrackedBills(clientId, tenantId),
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: now, lte: fourteenDaysOut } },
        orderBy: { date: 'asc' },
        take: 5,
      }),
      this.prisma.intelligenceChange.findMany({
        where: { OR: changeOrConditions, detectedAt: { gte: sevenDaysAgo } },
        orderBy: { detectedAt: 'desc' },
        take: 5,
      }),
      this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now, lte: fourteenDaysOut },
        },
        orderBy: { commentEndDate: 'asc' },
        take: 5,
        select: { title: true, commentEndDate: true, agencyNames: true },
      }),
      this.computeEngagementHealth(clientId, tenantId),
    ]);

    const parts: string[] = [];

    if (trackedBills.bills.length) {
      const billList = trackedBills.bills
        .slice(0, 5)
        .map(
          (b) =>
            `- ${b.identifier}: ${b.title.slice(0, 60)}${b.latestActionText ? ` [${b.latestActionText.slice(0, 40)}]` : ''}`,
        )
        .join('\n');
      parts.push(`TRACKED BILLS:\n${billList}`);
    }

    if (hearings.length) {
      const hearingList = hearings
        .map((h) => {
          const daysOut = Math.ceil(
            (new Date(h.date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `- ${h.committeeName}: "${h.title.slice(0, 60)}" (in ${daysOut}d, ${h.chamber})`;
        })
        .join('\n');
      parts.push(`UPCOMING HEARINGS (14d):\n${hearingList}`);
    }

    if (recentChanges.length) {
      const changeList = recentChanges.map((c) => `- [${c.changeType}] ${c.title}`).join('\n');
      parts.push(`RECENT INTELLIGENCE (7d):\n${changeList}`);
    }

    if (commentPeriods.length) {
      const deadlineList = commentPeriods
        .map((d) => {
          const days = Math.ceil(
            (d.commentEndDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
          );
          return `- "${d.title.slice(0, 60)}", ${days}d left (${(d.agencyNames as string[]).slice(0, 2).join('/')})`;
        })
        .join('\n');
      parts.push(`COMMENT PERIOD DEADLINES:\n${deadlineList}`);
    }

    // Lobbyist coverage check for recipientOffice
    if (recipientOffice && ldaClientIds.length) {
      const regRows = await this.prisma.$queryRaw<Array<{ registrant_id: number }>>`
        SELECT DISTINCT registrant_id FROM lda_filing
        WHERE client_id = ANY(${ldaClientIds}::int[]) AND registrant_id IS NOT NULL
      `;
      const registrantIds = regRows.map((r) => r.registrant_id);
      if (registrantIds.length) {
        const lobbyists = await this.prisma.$queryRaw<
          Array<{ first_name: string; last_name: string; covered_positions: unknown }>
        >`
          SELECT first_name, last_name, covered_positions FROM lda_lobbyist
          WHERE registrant_ids && ${registrantIds}::int[]
            AND covered_positions::text != '[]'
          LIMIT 20
        `;
        const officeLower = recipientOffice.toLowerCase();
        const matched = lobbyists.filter((l) => {
          const positions = Array.isArray(l.covered_positions) ? l.covered_positions : [];
          return (positions as unknown[]).some((p) => {
            const pos = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
            const posTitle = typeof pos.position === 'string' ? pos.position.toLowerCase() : '';
            const posDept = typeof pos.department === 'string' ? pos.department.toLowerCase() : '';
            return posTitle.includes(officeLower) || posDept.includes(officeLower);
          });
        });
        if (matched.length) {
          const names = matched.slice(0, 3).map((l) => `${l.first_name} ${l.last_name}`.trim());
          parts.push(
            `LOBBYIST CONNECTIONS TO "${recipientOffice}":\n${names.map((n) => `- ${n}`).join('\n')}`,
          );
        }
      }
    }

    parts.push(`ENGAGEMENT HEALTH: ${healthScore.score}/100 (${healthScore.trend})`);

    return { context: parts.join('\n\n') };
  }

  /** Get all ClientIntelMappings for a tenant as a flat array with clientName included */
  async getAllMappingsForTenant(tenantId: string) {
    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      // Exclude soft-archived ("deleted") clients from the mappings admin view.
      tx.client.findMany({
        where: { status: { not: 'archived' } },
        select: { id: true, name: true },
      }),
    );

    const clientIds = clients.map((c) => c.id);
    if (!clientIds.length) return [];

    const mappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId: { in: clientIds } },
        orderBy: { confidence: 'desc' },
      }),
    );

    const clientMap = new Map(clients.map((c) => [c.id, c.name]));
    return mappings.map((m) => ({ ...m, clientName: clientMap.get(m.clientId) ?? '' }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 cross-references
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Phase 2.3, Capability → District Nexus.
   * Parses each client capability's districtNexus free-text field for state-district
   * codes (e.g. "CA-52", "TX 3", "FL-AL"), then joins the latest CensusDistrict row
   * for each. Produces "jobs in your district" talking-point data.
   */
  async getDistrictNexus(clientId: string, tenantId: string) {
    const caps = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: {
          id: true,
          name: true,
          sector: true,
          districtNexus: true,
          existingContracts: true,
        },
      }),
    );

    const pattern = /\b([A-Z]{2})[\s\-\/]+(?:CD[\s\-]?)?(\d{1,3}|AL)\b/g;
    const allKeys: string[] = [];
    const capDistricts = caps.map((cap) => {
      const text = cap.districtNexus ?? '';
      const seen = new Set<string>();
      const districtKeys: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text.toUpperCase())) !== null) {
        const state = m[1];
        const raw = m[2];
        if (!state || !raw) continue;
        const district = raw === 'AL' ? 'AL' : String(parseInt(raw, 10));
        const key = `${state}-${district}`;
        if (!seen.has(key)) {
          seen.add(key);
          districtKeys.push(key);
          allKeys.push(key);
        }
      }
      return { cap, districtKeys };
    });

    if (!allKeys.length) {
      return {
        capabilities: caps.map((c) => ({
          capabilityId: c.id,
          capabilityName: c.name,
          capabilitySector: c.sector,
          districtNexus: c.districtNexus,
          districts: [],
          talkingPoints: [],
          totalSupportedJobs: null,
        })),
      };
    }

    const districtRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        congress: number;
        state: string;
        district: string;
        total_population: number | null;
        median_household_income: number | null;
        labor_force_size: number | null;
        unemployment_rate: number | null;
        percent_veteran: number | null;
        top_industries: unknown;
        data_year: number;
      }>
    >`
      SELECT DISTINCT ON (state, district)
        id, congress, state, district, total_population, median_household_income,
        labor_force_size, unemployment_rate, percent_veteran, top_industries, data_year
      FROM census_district
      WHERE state || '-' || district = ANY(${allKeys}::text[])
      ORDER BY state, district, congress DESC
    `;

    const districtMap = new Map(districtRows.map((r) => [`${r.state}-${r.district}`, r]));

    const extractJobs = (value: string | null): number | null => {
      if (!value) return null;
      const m = value.match(/(\d[\d,]*)\s*(jobs?|employees?|workers?)/i);
      if (!m?.[1]) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    return {
      capabilities: capDistricts.map(({ cap, districtKeys }) => {
        const districts = districtKeys
          .map((key) => districtMap.get(key))
          .filter((d): d is NonNullable<typeof d> => Boolean(d))
          .map((d) => ({
            id: d.id,
            congress: d.congress,
            state: d.state,
            district: d.district,
            totalPopulation: d.total_population,
            medianHouseholdIncome: d.median_household_income,
            laborForceSize: d.labor_force_size,
            unemploymentRate: d.unemployment_rate,
            percentVeteran: d.percent_veteran,
            topIndustries: Array.isArray(d.top_industries) ? d.top_industries : [],
            dataYear: d.data_year,
          }));

        const explicitJobs =
          extractJobs(cap.existingContracts ?? null) ?? extractJobs(cap.districtNexus ?? null);
        const jobsPerDistrict =
          explicitJobs != null
            ? Math.max(1, Math.round(explicitJobs / Math.max(districts.length, 1)))
            : null;
        const talkingPoints = districts.map((d) => {
          const headline =
            jobsPerDistrict != null
              ? `${cap.name} supports ~${jobsPerDistrict.toLocaleString()} jobs in ${d.state}-${d.district}.`
              : `${cap.name} has district nexus in ${d.state}-${d.district} with labor force ${d.laborForceSize ? d.laborForceSize.toLocaleString() : 'N/A'}.`;
          return {
            district: `${d.state}-${d.district}`,
            headline,
            evidence: {
              laborForceSize: d.laborForceSize,
              unemploymentRate: d.unemploymentRate,
              topIndustries: d.topIndustries,
              dataYear: d.dataYear,
            },
          };
        });

        return {
          capabilityId: cap.id,
          capabilityName: cap.name,
          capabilitySector: cap.sector,
          districtNexus: cap.districtNexus,
          districts,
          talkingPoints,
          totalSupportedJobs: jobsPerDistrict != null ? jobsPerDistrict * districts.length : null,
        };
      }),
    };
  }

  /**
   * District Nexus (spend-based, the data-driven path). Aggregates ACTUAL federal
   * contract spend (federal_award) into the client's congressional districts and
   * joins CensusDistrict demographics. Unlike getDistrictNexus (which parses the
   * capability free-text districtNexus field), this derives districts from real
   * USAspending place-of-performance data.
   *
   * Client -> awards link: the client's confirmed `contracting` intel mapping(s)
   * supply the contractor name(s); awards are matched on federal_award.contractor_name.
   * Only awards enriched with pop_congressional_district (via enrich-award-districts)
   * contribute district-level rows; the rest roll up under state-only / unknown.
   *
   * Returns spend grouped by district, demographics, and the unmatched remainder so
   * the UI can be honest about coverage. Read-only over a GLOBAL table; no tenant
   * rows are written. The client/mapping lookup IS tenant-scoped.
   */
  async getDistrictNexusSpend(clientId: string, tenantId: string) {
    // 1. Resolve the client's contractor name(s) from confirmed contracting mappings.
    const mappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'contracting', confirmed: true },
        select: { externalName: true },
      }),
    );
    const contractorNames = Array.from(
      new Set(mappings.map((m) => m.externalName.trim()).filter((n) => n.length > 0)),
    );

    if (!contractorNames.length) {
      return {
        linked: false as const,
        reason: 'no_confirmed_contracting_mapping',
        contractorNames: [],
        totalAwards: 0,
        totalAmount: 0,
        districts: [],
        unmappedAmount: 0,
        disclaimer:
          'Spend is matched to this client via confirmed USAspending contractor mappings. Confirm a contracting source mapping in Manage Sources to populate district spend.',
      };
    }

    // 2. Aggregate award spend by place-of-performance district (global table, read-only).
    const spendRows = await this.prisma.$queryRaw<
      Array<{
        pop_state: string | null;
        pop_district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >`
      SELECT pop_state, pop_congressional_district AS pop_district,
             COUNT(*)::bigint AS award_count,
             COALESCE(SUM(amount), 0)::float8 AS total_amount
      FROM federal_award
      WHERE contractor_name = ANY(${contractorNames}::text[])
      GROUP BY pop_state, pop_congressional_district
    `;

    // 3. Join CensusDistrict demographics for the districts we resolved.
    const districtKeys = spendRows
      .filter((r) => r.pop_state && r.pop_district)
      .map((r) => `${r.pop_state}-${normalizeDistrict(r.pop_district)}`);

    const censusRows = districtKeys.length
      ? await this.prisma.$queryRaw<
          Array<{
            state: string;
            district: string;
            total_population: number | null;
            median_household_income: number | null;
            labor_force_size: number | null;
            unemployment_rate: number | null;
            percent_veteran: number | null;
            data_year: number;
          }>
        >`
          SELECT DISTINCT ON (state, district)
            state, district, total_population, median_household_income,
            labor_force_size, unemployment_rate, percent_veteran, data_year
          FROM census_district
          WHERE state || '-' || district = ANY(${districtKeys}::text[])
          ORDER BY state, district, congress DESC
        `
      : [];
    const censusMap = new Map(censusRows.map((c) => [`${c.state}-${c.district}`, c]));

    let totalAwards = 0;
    let totalAmount = 0;
    let unmappedAmount = 0;
    const districts = spendRows
      .map((r) => {
        const count = Number(r.award_count);
        const amount = Number(r.total_amount ?? 0);
        totalAwards += count;
        totalAmount += amount;
        // Rows without a resolved district roll into the "unmapped" bucket.
        if (!r.pop_state || !r.pop_district) {
          unmappedAmount += amount;
          return null;
        }
        const dnum = normalizeDistrict(r.pop_district);
        const key = `${r.pop_state}-${dnum}`;
        const c = censusMap.get(key);
        return {
          district: key,
          state: r.pop_state,
          districtNumber: dnum,
          awardCount: count,
          totalAmount: amount,
          demographics: c
            ? {
                totalPopulation: c.total_population,
                medianHouseholdIncome: c.median_household_income,
                laborForceSize: c.labor_force_size,
                unemploymentRate: c.unemployment_rate,
                percentVeteran: c.percent_veteran,
                dataYear: c.data_year,
              }
            : null,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => b.totalAmount - a.totalAmount);

    return {
      linked: true as const,
      contractorNames,
      totalAwards,
      totalAmount,
      districtCount: districts.length,
      unmappedAmount,
      districts,
      disclaimer:
        'Federal contract spend (USAspending) matched to this client via confirmed contractor mappings, grouped by place-of-performance congressional district. Awards without a resolved district are shown as unmapped. Public data; for intelligence, not legal or compliance advice.',
    };
  }

  /**
   * Phase 2.5, Bill → Regulation lifecycle.
   * For each of the client's tracked bills, find FederalRegisterDocuments whose
   * `topics` array overlaps the bill's subjects, OR whose title/abstract references
   * the bill's identifier (e.g. "H.R. 1234"). Surfaces "the agency just published
   * a rule for a bill you track."
   */
  async getBillRegulationLinks(
    clientId: string,
    tenantId: string,
    precomputedTracked?:
      | Promise<Awaited<ReturnType<typeof this.getTrackedBills>>>
      | Awaited<ReturnType<typeof this.getTrackedBills>>,
  ) {
    const tracked = await (precomputedTracked ?? this.getTrackedBills(clientId, tenantId));
    if (!tracked.bills.length) {
      return { links: [], totalBills: 0, totalRegulations: 0 };
    }

    // Collect all subjects + identifier search terms across bills.
    const allSubjects = new Set<string>();
    const identifierTerms: string[] = [];
    for (const b of tracked.bills) {
      for (const s of b.subjectNames) allSubjects.add(s);
      // Build identifier variants from "119-hr-1234"
      const parts = b.identifier.split('-');
      if (parts.length === 3 && parts[1] && parts[2]) {
        const upper = parts[1].toUpperCase();
        const billNumber = parts[2];
        identifierTerms.push(`%${upper} ${billNumber}%`);
        identifierTerms.push(`%${upper}${billNumber}%`);
      }
    }
    const subjects = [...allSubjects];

    const regulations = await this.prisma.$queryRaw<
      Array<{
        id: string;
        document_number: string;
        type: string;
        title: string;
        agency_names: string[];
        topics: string[];
        comment_end_date: Date | null;
        publication_date: Date;
        effective_date: Date | null;
        significant_rule: boolean;
        html_url: string | null;
      }>
    >`
      SELECT id, document_number, type, title, agency_names, topics,
             comment_end_date, publication_date, effective_date, significant_rule, html_url
      FROM federal_register_document
      WHERE topics && ${subjects}::text[]
         OR title ILIKE ANY(${identifierTerms}::text[])
         OR abstract ILIKE ANY(${identifierTerms}::text[])
      ORDER BY publication_date DESC
      LIMIT 200
    `;

    // Group regulations back to bills by topic overlap or identifier mention.
    const links = tracked.bills
      .map((bill) => {
        const billSubjects = new Set(bill.subjectNames);
        const billIdentVariants = (() => {
          const parts = bill.identifier.split('-');
          if (parts.length !== 3 || !parts[1] || !parts[2]) return [];
          const upper = parts[1].toUpperCase();
          const num = parts[2];
          return [`${upper} ${num}`, `${upper}${num}`];
        })().map((s) => s.toLowerCase());

        const matched = regulations.filter((r) => {
          if (r.topics.some((t) => billSubjects.has(t))) return true;
          const haystack = r.title.toLowerCase();
          return billIdentVariants.some((v) => haystack.includes(v));
        });

        return {
          bill: {
            identifier: bill.identifier,
            title: bill.title,
            latestActionDate: bill.latestActionDate,
          },
          regulations: matched.slice(0, 10).map((r) => ({
            documentNumber: r.document_number,
            type: r.type,
            title: r.title,
            agencyNames: r.agency_names,
            publicationDate: r.publication_date,
            commentEndDate: r.comment_end_date,
            effectiveDate: r.effective_date,
            significantRule: r.significant_rule,
            htmlUrl: r.html_url,
            matchedTopics: r.topics.filter((t) => billSubjects.has(t)),
          })),
        };
      })
      .filter((l) => l.regulations.length > 0);

    return {
      links,
      totalBills: tracked.bills.length,
      totalRegulations: regulations.length,
    };
  }

  /**
   * Phase 2.6, GAO/CRS → Bill attachment.
   * For each tracked bill, find GAO and CRS reports whose `topics` array overlaps
   * the bill's subjects. Provides authoritative analysis to attach to in-flight
   * bills, feeds RAG grounding and meeting prep.
   */
  async getBillResearchAttachments(clientId: string, tenantId: string) {
    const tracked = await this.getTrackedBills(clientId, tenantId);
    if (!tracked.bills.length) {
      return { attachments: [], totalBills: 0, totalReports: 0 };
    }

    const allSubjects = new Set<string>();
    for (const b of tracked.bills) for (const s of b.subjectNames) allSubjects.add(s);
    const subjects = [...allSubjects];
    if (!subjects.length) {
      return { attachments: [], totalBills: tracked.bills.length, totalReports: 0 };
    }

    const [gaoRows, crsRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          publish_date: Date | null;
          topics: string[];
          report_type: string | null;
          recommendations: number | null;
          url: string | null;
        }>
      >`
        SELECT id, title, publish_date, topics, report_type, recommendations, url
        FROM gao_report
        WHERE topics && ${subjects}::text[]
        ORDER BY publish_date DESC NULLS LAST
        LIMIT 150
      `,
      this.prisma.$queryRaw<
        Array<{
          id: string;
          title: string;
          date: Date | null;
          topics: string[];
          authors: string[];
          html_url: string | null;
        }>
      >`
        SELECT id, title, date, topics, authors, html_url
        FROM crs_report
        WHERE topics && ${subjects}::text[]
          AND active = true
        ORDER BY date DESC NULLS LAST
        LIMIT 150
      `,
    ]);

    const attachments = tracked.bills
      .map((bill) => {
        const billSubjects = new Set(bill.subjectNames);
        const gao = gaoRows
          .filter((r) => r.topics.some((t) => billSubjects.has(t)))
          .slice(0, 8)
          .map((r) => ({
            id: r.id,
            title: r.title,
            publishDate: r.publish_date,
            topics: r.topics.filter((t) => billSubjects.has(t)),
            reportType: r.report_type,
            recommendations: r.recommendations,
            url: r.url,
          }));
        const crs = crsRows
          .filter((r) => r.topics.some((t) => billSubjects.has(t)))
          .slice(0, 8)
          .map((r) => ({
            id: r.id,
            title: r.title,
            date: r.date,
            topics: r.topics.filter((t) => billSubjects.has(t)),
            authors: r.authors,
            htmlUrl: r.html_url,
          }));
        return {
          bill: {
            identifier: bill.identifier,
            title: bill.title,
            latestActionDate: bill.latestActionDate,
          },
          gao,
          crs,
        };
      })
      .filter((a) => a.gao.length > 0 || a.crs.length > 0);

    return {
      attachments,
      totalBills: tracked.bills.length,
      totalReports: gaoRows.length + crsRows.length,
    };
  }

  /**
   * Today's calendar feed for the home dashboard. Aggregates:
   *  - Congressional hearings on date=today
   *  - Federal Register comment-period deadlines closing today (tenant-filtered)
   *  - Critical/notable intel changes detected in the last 24h that relate to tenant clients
   * Returns chronologically sorted events with severity counts.
   */
  async getTodayTimeline(tenantId: string) {
    const now = new Date();
    // ET day bounds for timestamp columns; UTC-midnight bounds for @db.Date columns.
    const { start: startOfDay, end: endOfDay } = dayBoundsInZone(now, 'America/New_York');
    const dateBounds = dateBoundsInZone(now, 'America/New_York');
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [hearings, deadlines, changes, clientIds] = await Promise.all([
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: dateBounds.start, lte: dateBounds.end } },
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

    const tenantClientIds = new Set(clientIds.map((c) => c.id));

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

    const events: TimelineEvent[] = [];

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

    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const counts = { critical: 0, notable: 0, info: 0 };
    for (const e of events) counts[e.severity]++;

    return { events, counts, today: startOfDay.toISOString() };
  }

  /**
   * Live ticker: most recent intel changes for the right-rail feed.
   * Tenant-aware, prefers changes touching this tenant's clients, falls back
   * to TENANT-NEUTRAL recent changes (empty relatedClientIds) to keep the feed
   * populated. Never returns changes that touch other tenants' clients -
   * those rows include client names in their description and would leak across
   * tenants if returned.
   */
  async getLiveTicker(tenantId: string, limit = 12) {
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

  /**
   * Coming Up: next-7-day forward calendar for the home dashboard.
   * Aggregates hearings + comment-period closes opening tomorrow through +7d,
   * picks the 3 highest-leverage items. Sorted by date ascending.
   * Tomorrow is computed in ET to match the dashboard's "all times ET" framing.
   */
  async getComingUp(tenantId: string) {
    const now = new Date();
    // Both `hearing.date` and `comment_end_date` come back at UTC midnight;
    // bounds must also be UTC midnight to include rows on the boundary day.
    const tomorrowStart = addDateInZone(now, 1, 'America/New_York');
    const sevenDaysOut = new Date(tomorrowStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Meetings come from this tenant's connected calendar (Outlook sync) or
    // manually-created meetings. We pull the same tomorrow→+7d window. The
    // href is the in-app meeting detail route so clicking on the dashboard
    // card opens the meeting inside Capiro; the Outlook webLink (stored in
    // metadata) is reachable from there.
    const [hearings, deadlines, meetings, clientIds] = await Promise.all([
      this.prisma.committeeHearing.findMany({
        where: { date: { gte: tomorrowStart, lte: sevenDaysOut } },
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
            startsAt: { gte: tomorrowStart, lte: sevenDaysOut },
            status: { not: 'cancelled' },
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
    // tenantClientIds reserved for future relevance ranking
    void clientIds;

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

    const items: ComingUpItem[] = [];

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

  /**
   * Portfolio summary, six numbers for the Portfolio list stat strip.
   * All cheap counts; LDA spend is summed across clients with confirmed
   * mappings using current-quarter filings.
   */
  async getPortfolioSummary(tenantId: string) {
    const now = new Date();
    const quarterStart = startOfQuarter(now);

    const [clients, mappings] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          where: { status: { not: 'archived' } },
          select: { id: true, profileStatus: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { confirmed: true, source: 'lda' },
          select: { clientId: true, externalId: true },
        }),
      ),
    ]);

    const tenantClientIds = new Set(clients.map((c) => c.id));
    const tenantLdaIds = mappings
      .filter((m) => tenantClientIds.has(m.clientId))
      .map((m) => Number(m.externalId))
      .filter((n) => Number.isFinite(n));

    const needAttention = clients.filter(
      (c) => c.profileStatus === 'PAUSED' || c.profileStatus === 'MONITORING',
    ).length;

    const [ldaSpendRows, billsTracked, regulationsTracked] = await Promise.all([
      tenantLdaIds.length
        ? this.prisma.$queryRaw<Array<{ total: string | null }>>`
            SELECT COALESCE(SUM(income), 0)::text AS total
            FROM lda_filing
            WHERE client_id = ANY(${tenantLdaIds}::int[])
              AND dt_posted >= ${quarterStart}
          `
        : Promise.resolve([{ total: '0' }]),
      tenantLdaIds.length
        ? this.prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT b.id)::bigint AS count
            FROM congress_bill b
            JOIN congress_bill_subject s ON s.bill_id = b.id
            WHERE lower(b.latest_action_text) NOT LIKE '%became public law%'
              AND lower(b.latest_action_text) NOT LIKE '%vetoed%'
              AND s.name ILIKE ANY(
                ARRAY(
                  SELECT DISTINCT name FROM lda_issue_code
                  WHERE code = ANY(
                    SELECT DISTINCT unnest(issue_codes)
                    FROM lda_client
                    WHERE id = ANY(${tenantLdaIds}::int[])
                  )
                )
              )
          `
        : Promise.resolve([{ count: 0n }]),
      this.prisma.federalRegisterDocument.count({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now },
        },
      }),
    ]);

    // LDA `income` is stored as Decimal dollars (not cents); SUM returns a
    // numeric string via the text cast, parsed back to a plain JS number.
    const ldaSpendDollars = Number(ldaSpendRows[0]?.total ?? '0');
    const billsTrackedCount = Number(billsTracked[0]?.count ?? 0n);

    return {
      activeClients: clients.length,
      needAttention,
      ldaSpendQtd: ldaSpendDollars,
      billsTracked: billsTrackedCount,
      activeRegulations: regulationsTracked,
    };
  }

  /**
   * Cross-client "Needs Attention" roll-up for the dashboard.
   *
   * Surfaces the SAME alert taxonomy as the client Intelligence tab's Top
   * Alerts (comment_deadline, comment_overdue, competitor_filing,
   * contract_award, hearing, bill_movement, change events) but across EVERY
   * active client, so the dashboard and the client tab stay in lockstep.
   *
   * Implementation reuses getClientProfileV1 per client (whose snapshot already
   * assembles, applies per-user worklist state to, and ranks that client's
   * alerts) then flattens + tags with clientId/clientName + re-ranks globally.
   * That guarantees one taxonomy with zero duplicated assembly logic. It is
   * expensive (full aggregate per client), so it is bounded-concurrency and
   * wrapped in a short per-tenant+user TTL cache.
   */
  async getPortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    opts?: { limit?: number; maxClients?: number },
  ): Promise<{
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  }> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 12, 50));
    // Cap the number of clients we will aggregate per roll-up. Each client runs
    // the full profile-v1 fan-out, so this is the dominant cost. Kept modest by
    // default; raise only with the cron-precompute path (see note below).
    const maxClients = Math.max(1, Math.min(opts?.maxClients ?? 40, 200));
    const cacheKey = `${tenantId}:${userId ?? 'anon'}:${limit}:${maxClients}`;

    const cached = this.portfolioAlertsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as Awaited<ReturnType<typeof this.getPortfolioAlerts>>;
    }

    // Coalesce concurrent callers for the same key onto one in-flight promise —
    // a dashboard reload (or several open tabs) must not each launch their own
    // N-client roll-up. Whoever arrives first computes; everyone else awaits it.
    const existing = this.portfolioAlertsInflight.get(cacheKey);
    if (existing) {
      return existing as unknown as Awaited<ReturnType<typeof this.getPortfolioAlerts>>;
    }

    const compute = this.computePortfolioAlerts(tenantId, userId, limit, maxClients)
      .then((result) => {
        this.portfolioAlertsCache.set(cacheKey, {
          expiresAt: Date.now() + IntelligenceService.PORTFOLIO_ALERTS_TTL_MS,
          value: result,
        });
        return result;
      })
      .finally(() => {
        this.portfolioAlertsInflight.delete(cacheKey);
      });

    this.portfolioAlertsInflight.set(cacheKey, compute);
    return compute;
  }

  /**
   * Internal worker for getPortfolioAlerts. Runs behind a PROCESS-WIDE gate so
   * only one roll-up computes at a time across all tenants/users, and processes
   * clients strictly SERIALLY (one profile-v1 at a time). This guarantees the
   * heavy per-client fan-out can never saturate the Prisma connection pool and
   * 500 unrelated requests (e.g. "Could not load your profile"), which is
   * exactly what an earlier parallel-batch version did.
   *
   * NOTE: serial-per-client keeps the pool safe but makes a cold roll-up slow
   * for large rosters. The intended follow-up is to precompute this on a cron
   * into a table and have this endpoint read that table; until then the 2-min
   * TTL cache + in-flight dedupe keep steady-state load cheap.
   */
  private computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): Promise<{
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  }> {
    const run = async () => {
      // Active (non-archived) clients for the tenant.
      const clients = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findMany({
          where: { status: { not: 'archived' } },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
          take: maxClients,
        }),
      );

      // SERIAL: one client aggregate at a time. Never parallelize here — the
      // per-client profile-v1 already fans out widely; running several at once
      // is what starved the pool.
      const tagged: Array<Record<string, unknown> & { clientId: string; clientName: string }> = [];
      for (const client of clients) {
        try {
          const profile = (await this.getClientProfileV1(client.id, tenantId, userId)) as {
            sections?: { snapshot?: { topAlerts?: Array<Record<string, unknown>> } };
          };
          const topAlerts = profile?.sections?.snapshot?.topAlerts ?? [];
          for (const alert of topAlerts) {
            // Canonical 7-field Alert sidecar (SC1.1/SC1.2): completeness flags
            // ride along; rows are NEVER filtered or hidden on incompleteness.
            const canonical = toCanonicalAlert(alert, client.id);
            tagged.push({
              ...alert,
              // Namespace the id with the client so identical alert ids across
              // clients (e.g. the same FedReg doc) stay distinct in the list.
              id: `${client.id}:${String(alert.id ?? '')}`,
              clientId: client.id,
              clientName: client.name,
              canonicalComplete: canonical.complete,
              canonicalMissingFields: canonical.missingFields,
            });
          }
        } catch (err) {
          this.logger.warn(
            `portfolio-alerts: profile-v1 failed for client ${client.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // Global re-rank: severity, then soonest deadline (countdownDays asc when
      // present), then most-recent `when`. Mirrors the per-client ordering
      // intent while making cross-client urgency comparable.
      const sevRank = (s: unknown): number => {
        const v = String(s ?? '').toLowerCase();
        if (v === 'critical') return 0;
        if (v === 'notable') return 1;
        return 2;
      };
      tagged.sort((a, b) => {
        const sev = sevRank(a.severity) - sevRank(b.severity);
        if (sev !== 0) return sev;
        const ad = typeof a.countdownDays === 'number' ? a.countdownDays : Number.POSITIVE_INFINITY;
        const bd = typeof b.countdownDays === 'number' ? b.countdownDays : Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
        return String(b.when ?? '').localeCompare(String(a.when ?? ''));
      });

      return {
        alerts: tagged.slice(0, limit),
        total: tagged.length,
        clientCount: clients.length,
        generatedAt: new Date().toISOString(),
      };
    };

    // Chain onto the process-wide gate so roll-ups never overlap. We attach the
    // next run regardless of whether the previous settled ok, and we keep the
    // gate from rejecting (a failed run must not poison the chain).
    const gated = this.portfolioAlertsGate.then(run, run);
    this.portfolioAlertsGate = gated.then(
      () => undefined,
      () => undefined,
    );
    return gated;
  }

  /**
   * Build 8-quarter ROI series for the quarter bar chart.
   * Lobbying values come from real LDA quarterly filings.
   * Obligations values are derived from annual contractor data (÷4 per quarter).
   */
  private async buildRoiQuarterSeries({
    mappedLdaClientIds,
    lobbyingYearly,
    obligationsYearly,
    now,
  }: {
    mappedLdaClientIds: number[];
    lobbyingYearly: Array<{ year: number; amount: number }>;
    obligationsYearly: Array<{ year: number; amount: number }>;
    now: Date;
  }): Promise<Array<{ label: string; lobbying: number; obligations: number }>> {
    // ── Build list of 8 quarters ending at current quarter ──────────
    const quarters: Array<{ year: number; q: number; label: string }> = [];
    let y = now.getFullYear();
    let q = Math.floor(now.getMonth() / 3) + 1; // 1-4
    for (let i = 7; i >= 0; i--) {
      let qy = y;
      let qq = q - i;
      while (qq < 1) {
        qq += 4;
        qy -= 1;
      }
      quarters.push({ year: qy, q: qq, label: `Q${qq}'${String(qy).slice(2)}` });
    }

    // ── Fetch quarterly LDA lobbying spend if we have a confirmed mapping ──
    const PERIOD_MAP: Record<string, number> = {
      first_quarter: 1,
      second_quarter: 2,
      third_quarter: 3,
      fourth_quarter: 4,
      mid_year: 2,
      year_end: 4,
    };

    const lobbyByQuarter = new Map<string, number>(); // key = "YYYY-Q#"
    if (mappedLdaClientIds.length) {
      const rows = await this.prisma.$queryRaw<
        Array<{ filing_year: number; filing_period: string | null; amount: number }>
      >`
          SELECT filing_year,
                 filing_period,
                 COALESCE(SUM(income), 0)::float AS amount
          FROM lda_filing
          WHERE client_id = ANY(${mappedLdaClientIds}::int[])
            AND filing_period IS NOT NULL
          GROUP BY filing_year, filing_period
        `;
      for (const row of rows) {
        const qNum = PERIOD_MAP[row.filing_period ?? ''];
        if (!qNum) continue;
        // Same quarter across multiple registrants sums (rows are disjoint per client_id).
        lobbyByQuarter.set(
          `${row.filing_year}-Q${qNum}`,
          (lobbyByQuarter.get(`${row.filing_year}-Q${qNum}`) ?? 0) + row.amount,
        );
      }
    } else {
      // Fall back to distributing annual lobbying data evenly across quarters
      for (const { year, amount } of lobbyingYearly) {
        const qAmt = amount / 4;
        for (let q2 = 1; q2 <= 4; q2++) {
          lobbyByQuarter.set(`${year}-Q${q2}`, qAmt);
        }
      }
    }

    // ── Distribute annual obligations evenly across quarters ─────────
    const obligByQuarter = new Map<string, number>();
    for (const { year, amount } of obligationsYearly) {
      const qAmt = amount / 4;
      for (let q2 = 1; q2 <= 4; q2++) {
        obligByQuarter.set(`${year}-Q${q2}`, qAmt);
      }
    }

    return quarters.map(({ year, q: qn, label }) => ({
      label,
      lobbying: lobbyByQuarter.get(`${year}-Q${qn}`) ?? 0,
      obligations: obligByQuarter.get(`${year}-Q${qn}`) ?? 0,
    }));
  }
}

function startOfQuarter(now: Date): Date {
  const month = now.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
}

/**
 * Normalize a USAspending congressional_code to match CensusDistrict.district.
 * USAspending returns zero-padded ('02', '11') or '90'/'98'/'00' for non-district
 * / at-large; CensusDistrict stores plain numbers ('2', '11') or 'AL' for at-large.
 * Returns 'AL' for at-large/unknown sentinels, else the leading-zero-stripped number.
 */
function normalizeDistrict(code: string | null): string {
  if (!code) return 'AL';
  const trimmed = code.trim().toUpperCase();
  if (
    trimmed === 'AL' ||
    trimmed === '00' ||
    trimmed === '98' ||
    trimmed === '90' ||
    trimmed === 'ZZ'
  ) {
    return 'AL';
  }
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? String(n) : 'AL';
}
