import { ClientRegulatoryV1 } from './client-regulatory-v1.js';
import { ClientCommentDeadlineAlertsV1 } from './client-alerts-v1-comment-deadlines.js';
import { ClientAlertsV1 } from './client-alerts-v1.js';
import { ClientAwardAlertsV1 } from './client-alerts-v1-awards.js';
import { IntelligencePortfolioTimeline } from './intelligence-portfolio-timeline.js';
import { IntelligencePortfolioComingUp } from './intelligence-portfolio-coming-up.js';
import { IntelligencePortfolioSummary } from './intelligence-portfolio-summary.js';
import { IntelligencePortfolioAlerts } from './intelligence-portfolio-alerts.js';
import { IntelligencePortfolioRollup } from './intelligence-portfolio-rollup.js';
import { IntelligencePortfolioTrend } from './intelligence-portfolio-trend.js';
import type { AlertRow } from './client-alerts-v1.shared.js';
import {
  buildQuarterWindows as portfolioBuildQuarterWindows,
  foldEngagementTrend as portfolioFoldEngagementTrend,
} from './intelligence-portfolio-quarters.js';
import type { OutreachSendRow, ClientEmailRow } from './intelligence-portfolio-quarters.js';
import { ClientIdentityV1Profile } from './client-identity-v1.js';
import { ClientIdentityV1Lda } from './client-identity-v1-lda.js';
import { ClientIdentityV1Filings } from './client-identity-v1-filings.js';
import { ClientIdentityV1Catalog } from './client-identity-v1-catalog.js';
import { ClientMappingV1 } from './client-mapping-v1.js';
import { ClientMappingV1Catalog } from './client-mapping-v1-catalog.js';
import { ClientMappingV1Review } from './client-mapping-v1-review.js';
import { ClientMappingV1Setup } from './client-mapping-v1-setup.js';
import { ClientContextV1Graph } from './client-context-v1-graph.js';
import { ClientContextV1Health } from './client-context-v1-health.js';
import { ClientContextV1Outreach } from './client-context-v1-outreach.js';
import { ClientFinancialV1Lobbying } from './client-financial-v1.js';
import { ClientFinancialV1Pac } from './client-financial-v1-pac.js';
import { ClientFinancialV1MoneyFlow } from './client-financial-v1-flow.js';
import { ClientFinancialV1Quarters } from './client-financial-v1-quarters.js';
import { ClientRelationshipsV1 } from './client-relationships-v1.js';
import { ClientChangesV1 } from './client-changes-v1.js';
import { ClientBriefsV1 } from './client-briefs-v1.js';
import { ClientDistrictV1 } from './client-district-v1.js';
import { ClientDistrictV1Spend } from './client-district-v1-spend.js';
import { IntelligenceBillRelevanceInputs } from './intelligence-bill-relevance-inputs.js';
import { IntelligenceRelevantBillDiscovery } from './intelligence-relevant-bill-discovery.js';
import { IntelligenceTrackedBillDiscovery } from './intelligence-tracked-bill-discovery.js';
import { IntelligenceManualBillTracking } from './intelligence-manual-bill-tracking.js';
import { IntelligenceBillEnrichment } from './intelligence-bill-enrichment.js';
import { IntelligenceClientProfileV1 } from './client-profile-v1.js';
import {
  normalizeProfileV1Sections,
  profileV1Finite,
  profileV1FiniteOrNull,
  profileV1IsoOrNull,
} from './client-profile-v1-presentation.js';
import { buildProfileV1RegulatoryLifecycle } from './client-profile-v1-regulatory.js';

import { Injectable, Logger } from '@nestjs/common';




import { PrismaService } from '../prisma/prisma.service.js';





import type { PacCoverage } from './fec-pac-coverage.js';


import { withBillKeywordProfileDeadline } from './bill-keyword-deadline.js';

import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import type { OfficeRecommendation } from './office-recommender.service.js';





type FinalIntelligenceSources = {
  regulatory: ClientRegulatoryV1;
  commentDeadlines: ClientCommentDeadlineAlertsV1;
  alerts: ClientAlertsV1;
  awardAlerts: ClientAwardAlertsV1;
  timeline: IntelligencePortfolioTimeline;
  comingUp: IntelligencePortfolioComingUp;
  summary: IntelligencePortfolioSummary;
  portfolioAlerts: IntelligencePortfolioAlerts;
  rollup: IntelligencePortfolioRollup;
  trend: IntelligencePortfolioTrend;
};

type ClientIntelligenceSources = {
  identityProfile: ClientIdentityV1Profile;
  identityLda: ClientIdentityV1Lda;
  identityFilings: ClientIdentityV1Filings;
  identityCatalog: ClientIdentityV1Catalog;
  mapping: ClientMappingV1;
  mappingCatalog: ClientMappingV1Catalog;
  mappingReview: ClientMappingV1Review;
  mappingSetup: ClientMappingV1Setup;
  graph: ClientContextV1Graph;
  health: ClientContextV1Health;
  outreach: ClientContextV1Outreach;
};

type SupportingIntelligenceSources = {
  financial: ClientFinancialV1Lobbying;
  pac: ClientFinancialV1Pac;
  flow: ClientFinancialV1MoneyFlow;
  quarters: ClientFinancialV1Quarters;
  relationships: ClientRelationshipsV1;
  changes: ClientChangesV1;
  briefs: ClientBriefsV1;
  district: ClientDistrictV1;
  districtSpend: ClientDistrictV1Spend;
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

/**
 * Mapping sources that attribute FEDERAL AWARD MONEY to a client.
 *
 * These are the only sources where "it matched" is not an answer to "whose money
 * is this", so every one of them needs an explicit reviewed relationship and an
 * explicit roll-up decision. Every other source (lda, fec_*, lobby_intel, sec,
 * fara) is a reference link and carries no attribution claim.
 */
export const AWARD_BEARING_MAPPING_SOURCES: ReadonlySet<string> = new Set([
  'contracting',
  'assistance_recipient',
]);

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);
  private readonly finalSources: FinalIntelligenceSources;
  private readonly clientSources: ClientIntelligenceSources;
  private readonly supportingSources: SupportingIntelligenceSources;
  private readonly profileV1: IntelligenceClientProfileV1;
  private readonly billRelevanceInputs: IntelligenceBillRelevanceInputs;
  private readonly relevantBillDiscovery: IntelligenceRelevantBillDiscovery;
  private readonly trackedBillDiscovery: IntelligenceTrackedBillDiscovery;
  private readonly manualBillTracking: IntelligenceManualBillTracking;
  private readonly billEnrichment: IntelligenceBillEnrichment;

  // Short-TTL in-memory cache for the cross-client portfolio alerts roll-up.
  // The roll-up runs the full per-client profile-v1 aggregate for every active
  // client, so it is expensive; the dashboard polls it on load. A 2-minute TTL
  // keyed by tenant+user (worklist state is per-user) keeps repeat loads cheap
  // without serving stale alerts for long. Process-local is fine: it is a
  // best-effort read cache, not a source of truth.
  private readonly portfolioAlertsCache = new Map<string, { expiresAt: number; value: unknown }>();
  private static readonly PORTFOLIO_ALERTS_TTL_MS = 2 * 60 * 1000;
  /**
   * Hard wall-clock budget for ONE portfolio-alerts HTTP request.
   *
   * Cold roll-ups serially run full profile-v1 per client (up to maxClients)
   * behind a process-wide gate. Without a request-level budget the handler can
   * hang open (Chrome shows pending forever) and leave Needs Attention
   * unresolved — observed live on os.capiro.ai as a brief paint then white
   * screen while other dashboard calls completed. Fail open with an empty
   * alerts payload so the dashboard can still paint; the 2-min TTL cache still
   * serves successful roll-ups once one completes.
   *
   * Tests may overwrite this static for a short budget. Not a cancellation of
   * in-flight Prisma work (same class as PROFILE_V1_SOURCE_BUDGET_MS).
   */
  static PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 12_000;

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
  ) {
    this.profileV1 = new IntelligenceClientProfileV1(this.prisma, {
      getClientProfile: (...args) => this.getClientProfile(...args),
      getLobbyingRoi: (...args) => this.getLobbyingRoi(...args),
      getFecMoneyFlow: (...args) => this.getFecMoneyFlow(...args),
      getDistrictNexus: (...args) => this.getDistrictNexus(...args),
      getTrackedBills: (...args) => this.getTrackedBills(...args),
      getBillRegulationLinks: (...args) => this.getBillRegulationLinks(...args),
      getKnowledgeGraph: (...args) => this.getKnowledgeGraph(...args),
      computeEngagementHealth: (...args) => this.computeEngagementHealth(...args),
      getExStaffers: (...args) => this.getExStaffers(...args),
      getCommentPeriodAlerts: (...args) => this.getCommentPeriodAlerts(...args),
      getChanges: (...args) => this.getChanges(...args),
      getDistrictNexusSpend: (...args) => this.getDistrictNexusSpend(...args),
      getOverdueCommentAlerts: (...args) => this.getOverdueCommentAlerts(...args),
      getCompetitorLdaAlerts: (...args) => this.getCompetitorLdaAlerts(...args),
      getContractAwardAlerts: (...args) => this.getContractAwardAlerts(...args),
      getHearingAlerts: (...args) => this.getHearingAlerts(...args),
      getClientRelevantRegulations: (...args) => this.getClientRelevantRegulations(...args),
      buildRoiQuarterSeries: (...args) => this.buildRoiQuarterSeries(...args),
      buildRegulatoryLifecycle: (...args) => this.buildRegulatoryLifecycle(...args),
      normalizeProfileV1Sections: (...args) => this.normalizeProfileV1Sections(...args),
      withSourceBudget: <T>(label: string, clientId: string, work: Promise<T>) =>
        this.withSourceBudget(label, clientId, work),
      officeRecommender: () => this.officeRecommender,
      warn: (message) => this.logger.warn(message),
    });
    this.billRelevanceInputs = new IntelligenceBillRelevanceInputs(this.prisma);

    this.relevantBillDiscovery = new IntelligenceRelevantBillDiscovery(this.prisma, {
      confirmedLdaIds: (...args) => this.confirmedLdaIds(...args),
      issueCodesForLdaIds: (...args) => this.issueCodesForLdaIds(...args),
      findRelevantBills: (...args) => this.findRelevantBills(...args),
      findRelevantBillsByEmbeddings: (...args) => this.findRelevantBillsByEmbeddings(...args),
      findRelevantBillsByKeyword: (...args) => this.findRelevantBillsByKeyword(...args),
      warn: (message) => this.logger.warn(message),
    });

    this.trackedBillDiscovery = new IntelligenceTrackedBillDiscovery(this.prisma, {
      getManualTrackedBillIds: (...args) => this.getManualTrackedBillIds(...args),
      getClientRelevanceTerms: (...args) => this.getClientRelevanceTerms(...args),
      fetchBillsByIds: (...args) => this.fetchBillsByIds(...args),
      findTrackedBillsByEmbeddings: (...args) => this.findTrackedBillsByEmbeddings(...args),
      findTrackedBillsByKeyword: (...args) => this.findTrackedBillsByKeyword(...args),
      embeddingSimilarityFloor: (hasCapabilitySignal) =>
        embeddingSimilarityFloor(hasCapabilitySignal),
      warn: (message) => this.logger.warn(message),
    });

    this.manualBillTracking = new IntelligenceManualBillTracking(this.prisma, {
      fetchBillsByIds: (...args) => this.fetchBillsByIds(...args),
    });

    this.billEnrichment = new IntelligenceBillEnrichment(this.prisma, {
      getTrackedBills: (...args) => this.getTrackedBills(...args),
    });
    this.supportingSources = this.createSupportingSources();
    this.clientSources = this.createClientSources();
    this.finalSources = this.createFinalSources();
  }

  private createSupportingSources(): SupportingIntelligenceSources {
    return {
      financial: new ClientFinancialV1Lobbying(this.prisma, {
        pickLdaClientIds: (...args) => this.pickLdaClientIds(...args),
      }),
      pac: new ClientFinancialV1Pac(this.prisma),
      flow: new ClientFinancialV1MoneyFlow(this.prisma, {
        getPacGiving: (...args) => this.getPacGiving(...args),
      }),
      quarters: new ClientFinancialV1Quarters(this.prisma),
      relationships: new ClientRelationshipsV1(this.prisma, {
        confirmedLdaIds: (...args) => this.confirmedLdaIds(...args),
        getTrackedBills: (...args) => this.getTrackedBills(...args),
        getIssueLeaderboard: (...args) => this.getIssueLeaderboard(...args),
        officeRecommender: () => this.officeRecommender,
      }),
      changes: new ClientChangesV1(this.prisma),
      briefs: new ClientBriefsV1(this.prisma),
      district: new ClientDistrictV1(this.prisma),
      districtSpend: new ClientDistrictV1Spend(this.prisma, {
        resolveContractorUeisForAlerts: (...args) => this.resolveContractorUeisForAlerts(...args),
      }),
    };
  }

  private createClientSources(): ClientIntelligenceSources {
    return {
      identityProfile: new ClientIdentityV1Profile(this.prisma, {
        pickLdaClientIds: (...args) => this.pickLdaClientIds(...args),
        fetchLdaByIds: (...args) => this.fetchLdaByIds(...args),
        fuzzyMatchLda: (...args) => this.fuzzyMatchLda(...args),
        fetchContractorById: (...args) => this.fetchContractorById(...args),
        fuzzyMatchContractor: (...args) => this.fuzzyMatchContractor(...args),
        fetchLobbyIntelById: (...args) => this.fetchLobbyIntelById(...args),
        fuzzyMatchLobbyIntel: (...args) => this.fuzzyMatchLobbyIntel(...args),
        capabilityFallbackTerms: (...args) => this.capabilityFallbackTerms(...args),
        findRelevantBills: (...args) => this.findRelevantBills(...args),
        findActiveRegulations: (...args) => this.findActiveRegulations(...args),
        findCompetitors: (...args) => this.findCompetitors(...args),
      }),
      identityLda: new ClientIdentityV1Lda(this.prisma, {
        pickLdaClientIds: (...args) => this.pickLdaClientIds(...args),
      }),
      identityFilings: new ClientIdentityV1Filings(this.prisma, {
        resolveLdaClientIds: (...args) => this.resolveLdaClientIds(...args),
      }),
      identityCatalog: new ClientIdentityV1Catalog(this.prisma, {
        isUuid: (...args) => this.isUuid(...args),
      }),
      mapping: new ClientMappingV1(this.prisma),
      mappingCatalog: new ClientMappingV1Catalog(this.prisma),
      mappingReview: new ClientMappingV1Review(this.prisma, {
        awardBearingMappingSource: (source) => AWARD_BEARING_MAPPING_SOURCES.has(source),
        prepopulation: () => this.prepopulation,
      }),
      mappingSetup: new ClientMappingV1Setup(this.prisma),
      graph: new ClientContextV1Graph(this.prisma, {
        walkClientGraph: (...args) => this.walkClientGraph(...args),
        warn: (message) => this.logger.warn(message),
      }),
      health: new ClientContextV1Health(this.prisma),
      outreach: new ClientContextV1Outreach(this.prisma, {
        confirmedLdaIds: (...args) => this.confirmedLdaIds(...args),
        issueCodesForLdaIds: (...args) => this.issueCodesForLdaIds(...args),
        getTrackedBills: (...args) => this.getTrackedBills(...args),
        computeEngagementHealth: (...args) => this.computeEngagementHealth(...args),
      }),
    };
  }

  private createFinalSources(): FinalIntelligenceSources {
    return {
      regulatory: new ClientRegulatoryV1(this.prisma, {
        withSourceBudget: <T,>(label: string, clientId: string, work: Promise<T>) =>
          this.withSourceBudget(label, clientId, work),
        getBillRegulationLinks: (...args) => this.getBillRegulationLinks(...args),
        getClientRelevantRegulations: (...args) => this.getClientRelevantRegulations(...args),
        buildRegulatoryLifecycle: (...args) => this.buildRegulatoryLifecycle(...args),
        logger: () => this.logger,
      }),
      commentDeadlines: new ClientCommentDeadlineAlertsV1(this.prisma, {
        logger: () => this.logger,
      }),
      alerts: new ClientAlertsV1(this.prisma, {
        getTrackedBills: (...args) => this.getTrackedBills(...args),
        alertCountdownLabel: (...args) => this.alertCountdownLabel(...args),
        getClientIssueCodes: (...args) => this.getClientIssueCodes(...args),
        confirmedLdaIds: (...args) => this.confirmedLdaIds(...args),
        issueCodesForLdaIds: (...args) => this.issueCodesForLdaIds(...args),
        logger: () => this.logger,
      }),
      awardAlerts: new ClientAwardAlertsV1(this.prisma, {
        resolveContractorUeisForAlerts: (...args) => this.resolveContractorUeisForAlerts(...args),
        logger: () => this.logger,
      }),
      timeline: new IntelligencePortfolioTimeline(this.prisma),
      comingUp: new IntelligencePortfolioComingUp(this.prisma),
      summary: new IntelligencePortfolioSummary(this.prisma),
      portfolioAlerts: new IntelligencePortfolioAlerts(this.prisma, {
        cache: () => this.portfolioAlertsCache,
        inflight: () => this.portfolioAlertsInflight,
        gate: () => this.portfolioAlertsGate,
        setGate: (value) => {
          this.portfolioAlertsGate = value;
        },
        ttlMs: () => IntelligenceService.PORTFOLIO_ALERTS_TTL_MS,
        requestBudgetMs: () => IntelligenceService.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS,
        logger: () => this.logger,
        emptyPortfolioAlerts: () => this.emptyPortfolioAlerts(),
        withPortfolioAlertsRequestBudget: (cacheKey, work) =>
          this.withPortfolioAlertsRequestBudget(cacheKey, work),
        computePortfolioAlerts: (...args) => this.computePortfolioAlerts(...args),
        getClientProfileV1: (...args) => this.getClientProfileV1(...args),
      }),
      rollup: new IntelligencePortfolioRollup(this.prisma),
      trend: new IntelligencePortfolioTrend(this.prisma),
    };
  }

  private asFinite(value: unknown, fallback = 0): number {
    return profileV1Finite(value, fallback);
  }

  private asFiniteOrNull(value: unknown): number | null {
    return profileV1FiniteOrNull(value);
  }

  private asIsoOrNull(value: unknown): string | null {
    return profileV1IsoOrNull(value);
  }

  private normalizeProfileV1Sections(sections: {
    snapshot: Record<string, any>;
    financialFootprint: Record<string, any>;
    legislativeRegulatory: Record<string, any>;
    relationships: Record<string, any>;
  }) {
    return normalizeProfileV1Sections(sections, {
      asFinite: (value, fallback) => this.asFinite(value, fallback),
      asFiniteOrNull: (value) => this.asFiniteOrNull(value),
      asIsoOrNull: (value) => this.asIsoOrNull(value),
    });
  }

  /**
   * Build a 360° intelligence profile for a CRM client.
   * Uses confirmed mappings from client_intel_mapping when available;
   * falls back to fuzzy matching for sources without confirmed mappings.
   */
  async getClientProfile(clientId: string, tenantId: string) {
    return this.clientSources.identityProfile.getClientProfile(clientId, tenantId);
  }

  /**
   * Client Profile / Intel Tab, redesigned v1 aggregate payload.
   * Opinionated 4-section contract so the frontend can render a single
   * anchored surface without stitching 10+ calls client-side.
   */
  /**
   * Wall-clock budget for ONE profile-v1 source. Chosen to sit under the
   * client's own request timeout so a degraded section is what the user sees,
   * rather than a dead page.
   *
   * Deliberately NOT a cancellation: `Promise.race` cannot abort an in-flight
   * Prisma query, so a timed-out source still holds its connection until the
   * database returns. What this buys is that the REQUEST completes and the
   * offending source is named — turning a silent hang into a diagnosable
   * warning. Bill keyword COUNT/row owners also enforce a real server statement
   * deadline within this profile's inherited budget; they cannot keep querying
   * after this wrapper times out. Other sources remain non-cancelling here.
   */
  static readonly PROFILE_V1_SOURCE_BUDGET_MS = 20_000;

  /** Log any source slower than this even when it completes inside the budget. */
  static readonly PROFILE_V1_SLOW_SOURCE_MS = 3_000;

  private withSourceBudget<T>(label: string, clientId: string, work: Promise<T>): Promise<T> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `exceeded its ${IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS}ms budget (still running)`,
          ),
        );
      }, IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS);
      // Never hold the process open for a budget that no longer matters — the
      // api container and the jest run both exit on their own schedule.
      timer.unref?.();
    });

    // race() keeps a handler attached to `work`, so a rejection arriving after
    // the budget fired is still consumed and cannot surface as an
    // unhandledRejection.
    return Promise.race([work, budget]).finally(() => {
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - startedAt;
      if (elapsed >= IntelligenceService.PROFILE_V1_SLOW_SOURCE_MS) {
        this.logger.warn(`profile-v1 source "${label}" took ${elapsed}ms for client ${clientId}`);
      }
    }) as Promise<T>;
  }

  /** The regulatory view does not depend on financial, graph, or AI profile sources. */
  async getClientRegulatoryProfile(clientId: string, tenantId: string) {
    return this.finalSources.regulatory.getClientRegulatoryProfile(clientId, tenantId);
  }

  private buildRegulatoryLifecycle(
    regLinks: Awaited<ReturnType<IntelligenceService['getBillRegulationLinks']>>,
    clientRelevantRegs: Awaited<ReturnType<IntelligenceService['getClientRelevantRegulations']>>,
    now: Date,
  ) {
    return buildProfileV1RegulatoryLifecycle(regLinks, clientRelevantRegs, now);
  }

  async getClientProfileV1(clientId: string, tenantId: string, userId?: string) {
    return withBillKeywordProfileDeadline(() =>
      this.getClientProfileV1WithinBillDeadline(clientId, tenantId, userId),
    );
  }

  private async getClientProfileV1WithinBillDeadline(
    clientId: string,
    tenantId: string,
    userId?: string,
  ) {
    return this.profileV1.getClientProfileV1WithinBillDeadline(clientId, tenantId, userId);
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
    return this.clientSources.identityLda.pickLdaClientIds(cached, confirmedExternalIds);
  }

  /**
   * Tenant-safe LDA id-set resolution for callers that don't already hold the
   * client + mappings. Prefers the clients.lda_client_ids cache, falling back to the
   * confirmed source='lda' mappings — BOTH read under the same tenant scope (clients
   * and client_intel_mapping are RLS-protected), so a foreign clientId yields [].
   */
  private async resolveLdaClientIds(clientId: string, tenantId: string): Promise<number[]> {
    return this.clientSources.identityLda.resolveLdaClientIds(clientId, tenantId);
  }

  /**
   * The client's confirmed source='lda' externalIds as an int set, tenant-scoped
   * (client_intel_mapping now carries tenant_id + forced RLS, so a foreign clientId
   * yields []). Functionally the same set as the clients.lda_client_ids cache
   * (kept in sync by prepopulation).
   */
  private async confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]> {
    return this.clientSources.identityLda.confirmedLdaIds(clientId, tenantId);
  }

  /**
   * Distinct issue codes unioned across a SET of LDA client ids (Phase 4c). One
   * real company is a SET of lda_client ids (one per firm that lobbies for it);
   * reading codes off a single id undercounts. Mirrors the union idiom already
   * used by getCompetitorBoard / fetchLdaByIds. Returns [] for an empty set.
   */
  private async issueCodesForLdaIds(ldaClientIds: number[]): Promise<string[]> {
    return this.clientSources.identityLda.issueCodesForLdaIds(ldaClientIds);
  }

  /**
   * Fetch a client's LDA profile aggregated across its FULL confirmed id set
   * (replaces the old single-id fetchLdaById, which undercounted to one of N firm
   * relationships — e.g. Boeing's 27 ids). Two-pass aggregate so id rows that have
   * no issue_codes still contribute to filings/spend.
   */
  private async fetchLdaByIds(ldaClientIds: number[]) {
    return this.clientSources.identityLda.fetchLdaByIds(ldaClientIds);
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
    return this.clientSources.identityFilings.getClientLdaFilings(clientId, tenantId);
  }

  /**
   * True when `id` is a RFC-style UUID that Postgres will accept for `::uuid`.
   * Confirmed contracting mappings MUST pin federal_contractor.id (uuid), but
   * historical ops pins and award-name backfills have used synthetic ids like
   * `award-name:L3HARRIS…`. Casting those with `${id}::uuid` throws 22P02 and
   * 500s the entire client-profile / federal footprint card. Guard first.
   */
  private isUuid(id: string): boolean {
    return this.clientSources.identityCatalog.isUuid(id);
  }

  /** Fetch contractor data by confirmed ID (skips fuzzy match) */
  private async fetchContractorById(id: string) {
    return this.clientSources.identityCatalog.fetchContractorById(id);
  }

  /** Fetch lobby intel data by confirmed ID (skips fuzzy match) */
  private async fetchLobbyIntelById(id: string) {
    return this.clientSources.identityCatalog.fetchLobbyIntelById(id);
  }

  /** Fuzzy match client name against LDA clients */
  private async fuzzyMatchLda(clientName: string) {
    return this.clientSources.identityLda.fuzzyMatchLda(clientName);
  }

  /** Fuzzy match client name against federal contractors */
  private async fuzzyMatchContractor(clientName: string) {
    return this.clientSources.identityCatalog.fuzzyMatchContractor(clientName);
  }

  /** Fuzzy match client name against lobby intel */
  private async fuzzyMatchLobbyIntel(clientName: string) {
    return this.clientSources.identityCatalog.fuzzyMatchLobbyIntel(clientName);
  }

  /** Find Congress bills relevant to the client's issue areas */
  /**
   * Pull capability-derived match terms for a client. Mirrors the keyword
   * extraction inside getTrackedBills() so the profile's `relevantBills` /
   * `activeRegulations` and the standalone /tracked-bills endpoint produce
   * the same fallback set when LDA matching yields no issue codes.
   */
  private async capabilityFallbackTerms(tenantId: string, clientId: string): Promise<string[]> {
    return this.billRelevanceInputs.capabilityFallbackTerms(tenantId, clientId);
  }

  private async findRelevantBills(issueCodes: string[], fallbackTerms: string[] = []) {
    return this.relevantBillDiscovery.findRelevantBills(issueCodes, fallbackTerms);
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
    return this.relevantBillDiscovery.findRelevantBillsByEmbeddings(allTerms);
  }

  private async findRelevantBillsByKeyword(allTerms: string[]) {
    return this.relevantBillDiscovery.findRelevantBillsByKeyword(allTerms);
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
    return this.finalSources.regulatory.findActiveRegulations(issueCodes, fallbackTerms);
  }

  /** Find competitors: other entities lobbying on the same issue codes */
  private async findCompetitors(
    clientName: string,
    issueCodes: string[],
    ldaClientIds: number[] = [],
  ) {
    return this.clientSources.identityLda.findCompetitors(clientName, issueCodes, ldaClientIds);
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
    return this.supportingSources.changes.getChanges(
      tenantId,
      since,
      clientId,
      source,
      consumed,
      peCodes,
    );
  }

  /**
   * Get client-to-intel source mappings. TENANT-SCOPED: the client must belong
   * to the caller's tenant, otherwise this would be a cross-tenant read (the
   * route is auth-guarded but not tenant-scoped, so we enforce ownership here).
   * `clients` is RLS-isolated; the mapping read is additionally backstopped by
   * RLS once client_intel_mapping carries tenant_id.
   */
  async getMappings(clientId: string, tenantId: string) {
    return this.clientSources.mapping.getMappings(clientId, tenantId);
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
    return this.clientSources.mappingCatalog.searchLdaClients(query);
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
    return this.clientSources.mappingCatalog.searchFecEmployers(query);
  }

  /** Search the imported PAC catalog by official committee ID or name. */
  async searchFecCommittees(query: string) {
    return this.clientSources.mappingCatalog.searchFecCommittees(query);
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
    return this.clientSources.mappingCatalog.searchContractors(query);
  }

  /**
   * Free-text / by-UEI search over federal_assistance_award recipients for
   * the District Nexus manual-attach panel (source 'assistance_recipient').
   * federal_assistance_award is a flat award fact table, not a recipient
   * dimension table like federal_contractor — so recipients are grouped
   * on the fly (by UEI when present, else by name) rather than looked up in
   * a pre-aggregated table. externalId pinned into the mapping is the UEI
   * when available; callers must not silently substitute a parent UEI for a
   * missing child/legal-entity UEI (§8.4 — never auto-confirm a weak match).
   */
  async searchAssistanceRecipients(query: string) {
    return this.clientSources.mappingCatalog.searchAssistanceRecipients(query);
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
    input: {
      source: string;
      externalId: string;
      externalName: string;
      relationshipType?: string | null;
      rollUpAwards?: boolean | null;
      actorUserId: string;
    },
  ) {
    return this.clientSources.mappingReview.createManualMapping(clientId, tenantId, input);
  }

  async rejectMappingCandidate(
    clientId: string,
    tenantId: string,
    input: {
      source: 'contracting';
      externalId: string;
      externalName: string;
      reason: string | null;
      actorUserId: string;
    },
  ) {
    return this.clientSources.mappingReview.rejectMappingCandidate(clientId, tenantId, input);
  }

  /**
   * Resolve mappings by fuzzy matching a CRM client against all sources.
   *
   * ── This used to auto-confirm fuzzy name matches. It no longer does. ────────
   *
   * Every row it wrote was created with `confirmed: r.confidence >= 0.6`, where
   * `confidence` was a RAW pg_trgm similarity between the client's name and a
   * federal record's name — no fingerprinting, no distinctiveness guard, no
   * ambiguity check, none of the protections `EntityResolutionService` applies.
   * A trigram score of 0.6 is routinely reached by genuinely different
   * organizations ("Santa Rosa County" / "Santa Clara County"), and a CONFIRMED
   * mapping is what the client's award footprint, the agency-history relevance
   * signals and the District Nexus obligation rails all read. The equivalent
   * defect on the assistance side produced 173 wrong candidates out of 183 live,
   * several with $B+ obligated attached.
   *
   * So every row this endpoint writes is now created UNCONFIRMED, whatever its
   * similarity, and a human confirms it from the mappings review UI. Nothing
   * about the candidate discovery changed — only that a name can no longer
   * silently become a confirmed corporate identity.
   *
   * An existing confirmed row is never downgraded: the upsert's update path
   * deliberately does not touch `confirmed`, so a human's decision survives a
   * re-run.
   */
  async resolveMapping(clientId: string, tenantId: string) {
    return this.clientSources.mapping.resolveMapping(clientId, tenantId);
  }

  /**
   * Confirm or reject a mapping. TENANT-SCOPED: the mapping's client must belong to
   * the caller's tenant (the route is auth-guarded but not tenant-scoped). With
   * client_intel_mapping now carrying tenant_id + forced RLS, the tx-scoped read of
   * a foreign id returns null. After the flip, re-run the prepopulation cascade so
   * lda_client_ids + issue codes reflect the new confirmed set (confirm + un-confirm).
   */
  async confirmMapping(
    mappingId: string,
    input: {
      confirmed: boolean;
      relationshipType?: string;
      rollUpAwards?: boolean;
      rejectionReason?: string;
      actorUserId: string;
    },
    tenantId: string,
  ) {
    return this.clientSources.mappingReview.confirmMapping(mappingId, input, tenantId);
  }

  /** Mark an intelligence change as consumed/unconsumed */
  async markChangeConsumed(id: string, consumed: boolean) {
    return this.supportingSources.changes.markChangeConsumed(id, consumed);
  }

  /** Count non-consumed changes detected in the last 7 days */
  async getUnreadChangesCount() {
    return this.supportingSources.changes.getUnreadChangesCount();
  }

  /** Lobbying $ vs Contract $ ROI for a client via confirmed mappings */
  async getLobbyingRoi(clientId: string, tenantId: string) {
    return this.supportingSources.financial.getLobbyingRoi(clientId, tenantId);
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
    coverage: PacCoverage;
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
    return this.supportingSources.pac.getPacGiving(clientId, tenantId);
  }

  /**
   * Phase 2.2, FEC money flow trace.
   * contributor_employer (mapped client) → committee → candidate → sponsoring member → committee → bill
   */
  async getFecMoneyFlow(clientId: string, tenantId: string) {
    return this.supportingSources.flow.getFecMoneyFlow(clientId, tenantId);
  }

  /** Competitor surge detector: other registrants lobbying on same issue codes in last 90 days */
  async getCompetitorBoard(clientId: string, tenantId: string) {
    return this.supportingSources.relationships.getCompetitorBoard(clientId, tenantId);
  }

  /** Ex-staffers: lobbyists on this client's filings who have covered government positions */
  async getExStaffers(clientId: string, tenantId: string) {
    return this.supportingSources.relationships.getExStaffers(clientId, tenantId);
  }

  /** Relevant bills for a client, derived from their confirmed LDA issue codes */
  async getClientBills(clientId: string, tenantId: string) {
    return this.relevantBillDiscovery.getClientBills(clientId, tenantId);
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
    return this.clientSources.mappingSetup.getSetupCompleteness(clientId, tenantId);
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
    return this.billRelevanceInputs.getIssueCodeSignal(clientId, tenantId);
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
    return this.supportingSources.relationships.computeOfficeRecommendations(clientId, tenantId);
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
    return this.billRelevanceInputs.getClientRelevanceTerms(clientId, tenantId);
  }

  async getTrackedBills(clientId: string, tenantId?: string) {
    return this.trackedBillDiscovery.getTrackedBills(clientId, tenantId);
  }

  // ── Manual bill tracking (user-pinned) ────────────────────────────────────

  /** Confirmed-tracked bill ids for a client (tenant-scoped). */
  private async getManualTrackedBillIds(clientId: string, tenantId: string): Promise<string[]> {
    return this.manualBillTracking.getManualTrackedBillIds(clientId, tenantId);
  }

  /** Fetch congress_bill rows by id, shaped like the tracked-bill list entries. */
  private async fetchBillsByIds(ids: string[]): Promise<
    Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      status?: string | null;
      actionTexts?: string[];
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>
  > {
    return this.manualBillTracking.fetchBillsByIds(ids);
  }

  /** List a client's manually tracked bills with full bill detail. */
  async listTrackedBills(clientId: string, tenantId: string) {
    return this.manualBillTracking.listTrackedBills(clientId, tenantId);
  }

  /** Pin a bill for a client (idempotent on clientId+billId). */
  async addTrackedBill(
    clientId: string,
    tenantId: string,
    billId: string,
    note?: string,
    createdBy?: string,
  ) {
    return this.manualBillTracking.addTrackedBill(clientId, tenantId, billId, note, createdBy);
  }

  /** Unpin a tracked bill. No-op if it wasn't tracked. */
  async removeTrackedBill(clientId: string, tenantId: string, billId: string) {
    return this.manualBillTracking.removeTrackedBill(clientId, tenantId, billId);
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
      status?: string | null;
      actionTexts?: string[];
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>;
  } | null> {
    return this.trackedBillDiscovery.findTrackedBillsByEmbeddings(allTerms, similarityFloor);
  }

  private async findTrackedBillsByKeyword(allTerms: string[]): Promise<{
    total: number;
    bills: Array<{
      identifier: string;
      title: string;
      latestActionDate: Date | null;
      latestActionText: string | null;
      status?: string | null;
      actionTexts?: string[];
      sponsorName: string | null;
      sponsorParty: string | null;
      subjectNames: string[];
    }>;
  }> {
    return this.trackedBillDiscovery.findTrackedBillsByKeyword(allTerms);
  }

  /** Live competitor leaderboard per LDA issue code with new-entrant and shared-lobbyist signals */
  async getIssueLeaderboard(issueCode: string) {
    return this.supportingSources.relationships.getIssueLeaderboard(issueCode);
  }

  /** Engagement health score (0-100) per client, per 7-day window */
  async computeEngagementHealth(clientId: string, tenantId: string) {
    return this.clientSources.health.computeEngagementHealth(clientId, tenantId);
  }

  /** Comment-period urgency alerts: upcoming FederalRegisterDocument deadlines matched to tenant clients */
  async getCommentPeriodAlerts(tenantId: string) {
    return this.finalSources.commentDeadlines.getCommentPeriodAlerts(tenantId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Compute-on-read alert sources for the client-profile "Top alerts" card.
  // Each returns the builder's normalized internal shape and NEVER throws —
  // a failure inside profile-v1's allSettled simply omits that alert type.
  // ──────────────────────────────────────────────────────────────────────────

  /** Internal alert row shape shared by every compute-on-read alert source. */
  private alertCountdownLabel(days: number | null): string | null {
    return this.finalSources.alerts.alertCountdownLabel(days);
  }

  /** Resolve a client's LDA issue codes (confirmed mapping) for competitor matching. */
  private async getClientIssueCodes(clientId: string, tenantId: string): Promise<string[]> {
    return this.finalSources.alerts.getClientIssueCodes(clientId, tenantId);
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
    return this.finalSources.alerts.getHearingAlerts(
      clientId,
      tenantId,
      now,
      until,
      precomputedTracked,
    );
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
    return this.finalSources.alerts.getOverdueCommentAlerts(clientId, tenantId, now, lookbackStart);
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
    return this.finalSources.alerts.getCompetitorLdaAlerts(clientId, tenantId, since);
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
    return this.finalSources.awardAlerts.getContractAwardAlerts(clientId, tenantId, since);
  }

  /** Resolve `federal_contractor.id -> uei`, outside any tenant transaction. See district-nexus.service.ts's twin. */
  private async resolveContractorUeisForAlerts(
    contractorIds: string[],
  ): Promise<Map<string, string | null>> {
    return this.finalSources.awardAlerts.resolveContractorUeisForAlerts(contractorIds);
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
    return this.finalSources.alerts.setAlertState(
      tenantId,
      userId,
      clientId,
      alertId,
      state,
      snoozedUntil,
    );
  }

  /** Clear per-user state for an alert (undo ack/dismiss/snooze). Idempotent. */
  async clearAlertState(tenantId: string, userId: string, clientId: string, alertId: string) {
    return this.finalSources.alerts.clearAlertState(tenantId, userId, clientId, alertId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Client briefs — saved notes promoted from alerts (or free-form). Surface in
  // the Outreach wizard context section. Tenant-scoped.
  // ──────────────────────────────────────────────────────────────────────────

  async listClientBriefs(tenantId: string, clientId: string) {
    return this.supportingSources.briefs.listClientBriefs(tenantId, clientId);
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
    return this.supportingSources.briefs.addClientBrief(tenantId, clientId, userId, input);
  }

  async deleteClientBrief(tenantId: string, clientId: string, briefId: string) {
    return this.supportingSources.briefs.deleteClientBrief(tenantId, clientId, briefId);
  }

  /**
   * Bounded, tenant + ethical-wall SCOPED walk over the materialized
   * kg_edge_cache (Track B M2) — the ONLY walk this service performs; the
   * legacy unscoped kg_walk is retired from tenant paths. Isolation is
   * enforced inside kg_walk_bounded by the mandatory (tenant_id, denied[])
   * params — fetched here from the caller's own transaction so the wall
   * applies per-hop. Returns the legacy row shape so all downstream
   * label/dedup logic is source-agnostic.
   */
  private async walkClientGraph(tenantId: string, clientId: string, viewerUserId: string | null) {
    return this.clientSources.graph.walkClientGraph(tenantId, clientId, viewerUserId);
  }

  /**
   * Knowledge graph nodes + edges for hub-and-spoke visualization, served ONLY
   * on the scoped bounded-traversal path. Gates resolve per-tenant (a
   * settings_jsonb.clioFeatureFlags override wins over the env value passed in
   * by the controller): kgIntelGraph must be 'scoped' AND kgTraversalSource
   * must be 'cache' — any other combination 503s rather than expose the
   * legacy unscoped, RLS-exempt kg_walk surface. Fail-safe by default.
   */
  async getKnowledgeGraph(
    clientId: string,
    tenantId: string,
    opts?: {
      viewerUserId?: string | null;
      envIntelGraphOn?: boolean;
      envTraversalSource?: 'legacy' | 'cache';
    },
  ) {
    return this.clientSources.graph.getKnowledgeGraph(clientId, tenantId, opts);
  }

  /** Outreach intelligence context, formatted text block for AI prompt injection */
  async getOutreachContext(clientId: string, tenantId: string, recipientOffice?: string) {
    return this.clientSources.outreach.getOutreachContext(clientId, tenantId, recipientOffice);
  }

  /** Get all ClientIntelMappings for a tenant as a flat array with clientName included */
  async getAllMappingsForTenant(tenantId: string) {
    return this.clientSources.mapping.getAllMappingsForTenant(tenantId);
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
    return this.supportingSources.district.getDistrictNexus(clientId, tenantId);
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
  /**
   * Profile contract footprint and the Federal Spending drilldown share one
   * reviewed scope. Exact approved names recover only rows missing a UEI;
   * a populated, conflicting award UEI never falls through to a name match.
   */
  async getDistrictNexusSpend(clientId: string, tenantId: string) {
    return this.supportingSources.districtSpend.getDistrictNexusSpend(clientId, tenantId);
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
    return this.billEnrichment.getBillRegulationLinks(clientId, tenantId, precomputedTracked);
  }

  /**
   * Regulatory matters relevant to a client, independent of bill tracking.
   *
   * getBillRegulationLinks (above) only ever surfaces a Federal Register
   * document when it topically overlaps a TRACKED bill. A client that does no
   * legislative tracking — a purely regulatory/rulemaking advocacy practice,
   * with no bills to track — therefore always got a completely empty
   * Regulatory panel (profile-v1.regulatoryLifecycle.rails === []),
   * regardless of any real regulatory activity affecting that client.
   *
   * This reuses the SAME client-relevance matching getOverdueCommentAlerts
   * and getCommentPeriodAlerts already use in production (agency → sector map
   * against the client's sectorTag/capabilities, falling back to topic/
   * capability keyword overlap) rather than inventing a second, unproven
   * relevance signal. Scope here is open/recent rulemakings for one client —
   * not restricted to a lapsed comment window like getOverdueCommentAlerts,
   * since this panel shows ongoing matters, not a deadline-just-closed nudge.
   */
  private async getClientRelevantRegulations(
    clientId: string,
    tenantId: string,
    now: Date,
  ): Promise<
    Array<{
      documentNumber: string;
      type: string;
      title: string;
      agencyNames: string[];
      publicationDate: Date;
      commentEndDate: Date | null;
      effectiveDate: Date | null;
      htmlUrl: string | null;
    }>
  > {
    return this.finalSources.regulatory.getClientRelevantRegulations(clientId, tenantId, now);
  }

  /**
   * Phase 2.6, GAO/CRS → Bill attachment.
   * For each tracked bill, find GAO and CRS reports whose `topics` array overlaps
   * the bill's subjects. Provides authoritative analysis to attach to in-flight
   * bills, feeds RAG grounding and meeting prep.
   */
  async getBillResearchAttachments(clientId: string, tenantId: string) {
    return this.billEnrichment.getBillResearchAttachments(clientId, tenantId);
  }

  /**
   * Today's calendar feed for the home dashboard. Aggregates:
   *  - Congressional hearings on date=today
   *  - Federal Register comment-period deadlines closing today (tenant-filtered)
   *  - Critical/notable intel changes detected in the last 24h that relate to tenant clients
   * Returns chronologically sorted events with severity counts.
   */
  async getTodayTimeline(tenantId: string) {
    return this.finalSources.timeline.getTodayTimeline(tenantId);
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
    return this.finalSources.timeline.getLiveTicker(tenantId, limit);
  }

  /**
   * Coming Up: next-7-day forward calendar for the home dashboard.
   * Aggregates hearings + comment-period closes opening tomorrow through +7d,
   * picks the 3 highest-leverage items. Sorted by date ascending.
   * Tomorrow is computed in ET to match the dashboard's "all times ET" framing.
   *
   * Meetings are scoped to the current user's own calendar (ownMeetingWhere,
   * the same ownership as GET /api/engagement/meetings), not tenant-wide.
   */
  async getComingUp(tenantId: string, userId: string) {
    return this.finalSources.comingUp.getComingUp(tenantId, userId);
  }

  /**
   * Portfolio summary, seven numbers for the Portfolio list stat strip.
   *
   * Tenant-scoped counts (clients, meetings, strategies, tracked bills, LDA
   * mappings) MUST run inside `withTenant`. `sp_strategy` / `tracked_bill` /
   * `client_intel_mapping` all FORCE RLS; bare `$queryRaw` outside the tenant
   * transaction returns 0 under `capiro_app` (FORCE RLS, no GUC) and the old
   * `.catch(() => 0)` path silently papered that over as a real zero.
   *
   * `billsTracked` is the tenant's pinned `tracked_bill` rows — the same source
   * as the Clients table Intelligence column / portfolio-rollup — not the LDA
   * issue-code × congress_bill subject join (which can be empty while pins exist).
   */
  async getPortfolioSummary(tenantId: string, userId: string, window?: { from?: string; to?: string }) {
    return this.finalSources.summary.getPortfolioSummary(tenantId, userId, window);
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
  private emptyPortfolioAlerts(): {
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  } {
    return this.finalSources.portfolioAlerts.emptyPortfolioAlerts();
  }

  /**
   * Race an in-flight or fresh portfolio-alerts compute against the hard
   * request budget. Fail open with empty alerts so HTTP never hangs.
   */
  private async withPortfolioAlertsRequestBudget<
    T extends ReturnType<IntelligenceService['emptyPortfolioAlerts']>,
  >(cacheKey: string, work: Promise<T>): Promise<T> {
    return this.finalSources.portfolioAlerts.withPortfolioAlertsRequestBudget(cacheKey, work);
  }

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
    return this.finalSources.portfolioAlerts.getPortfolioAlerts(tenantId, userId, opts);
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
    return this.finalSources.portfolioAlerts.computePortfolioAlerts(
      tenantId,
      userId,
      limit,
      maxClients,
    );
  }

  /**
   * G3 portfolio rollup (wire-audit "4 New capability" items 1-4).
   *
   * Returns per-client aggregates keyed by clientId so the portfolio index
   * table can render the Work, Intelligence, Attention, and Next-touch
   * columns without N+1 per-client fan-out. Three bounded queries:
   *
   *  - attention: open engagement tasks grouped by clientId
   *  - intel: tracked bills grouped by clientId
   *  - nextTouch: earliest future shared meeting per clientId
   *
   * All are portfolio-wide reads, not per-client calls.
   */
  async getPortfolioRollup(tenantId: string): Promise<{
    rollup: Record<
      string,
      {
        attentionCount: number;
        intelCount: number;
        nextTouch: { id: string; startsAt: string; subject: string } | null;
        /** Item 5: count of in_progress engagement tasks (work/readiness signal). */
        workCount: number;
      }
    >;
  }> {
    return this.finalSources.rollup.getPortfolioRollup(tenantId);
  }

  /**
   * G2 portfolio PE summary (wire-audit "4 New capability" items 7-8).
   *
   * Item 7 — Net portfolio delta: averages the deltaPct of the most-material
   * live ProgramElementDelta for each watched PE in the tenant, returning the
   * net.
   *
   * Item 8 — Client attribution: for each watched PE, joins via
   * ClientCapability.peNumbers to find which clients claim that PE code,
   * returning the client names so the card footer can show them.
   *
   * Both are bounded: watched PEs per tenant, then a single batch of PE delta
   * + capability lookups — no per-PE fan-out.
   */
  async getPortfolioPeSummary(
    tenantId: string,
    _userId: string | undefined,
  ): Promise<{
    netDeltaPct: number | null;
    peAttribution: Record<string, string[]>;
    watchedCount: number;
  }> {
    return this.finalSources.rollup.getPortfolioPeSummary(tenantId, _userId);
  }

  /**
   * Portfolio engagement trend — outreach sends + client emails across every
   * non-archived client, bucketed by quarter (six quarters / 18 months).
   *
   * Two bounded, portfolio-wide reads (not per-client fan-out):
   *  - outreach sends: OutreachRecord.sentAt within the window, non-deleted,
   *    scoped to a client that isn't archived.
   *  - client emails: MailThread.lastMessageAt within the window, scoped to
   *    a client that isn't archived. MailThread.clientId is already the
   *    correctly-resolved "this is a client email" flag — ClientAssociation-
   *    Service excludes Hill/gov domains and personal-email providers at
   *    ingest time, so `clientId IS NOT NULL` alone is sufficient here; no
   *    new email-resolution logic needed.
   *
   * Bucketing/derivation happens in the pure, unit-testable
   * foldEngagementTrend helper below — this method only fetches.
   */
  async getPortfolioEngagementTrend(tenantId: string): Promise<PortfolioEngagementTrendResponse> {
    return this.finalSources.trend.getPortfolioEngagementTrend(tenantId);
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
    return this.supportingSources.quarters.buildRoiQuarterSeries({
      mappedLdaClientIds,
      lobbyingYearly,
      obligationsYearly,
      now,
    });
  }
}



/** Response shape for GET /api/intelligence/portfolio-engagement-trend. */
export interface PortfolioEngagementTrendResponse {
  quarters: Array<{
    label: string;
    start: string;
    end: string;
    outreachSends: number;
    clientEmails: number;
    total: number;
  }>;
  currentQuarterTotal: number;
  qoqDeltaPct: number | null;
}

/**
 * Build `count` labeled quarter windows ending at the quarter containing
 * `now`, oldest first. `end` is the start of the FOLLOWING quarter (an
 * exclusive upper bound), so a timestamp buckets via `start <= t < end`.
 * The canonical implementation is in intelligence-portfolio-quarters.ts.
 * This wrapper preserves the original module contract. Pure: no DB access.
 */
export function buildQuarterWindows(
  now: Date,
  count: number,
): Array<{ label: string; start: Date; end: Date }> {
  return portfolioBuildQuarterWindows(now, count);
}





/**
 * Bucket outreach sends + client emails into their quarter windows and
 * derive the current-quarter total + QoQ delta. Modeled directly on
 * aggregateUsageRows (ai-usage.service.ts): a bounded findMany result folded
 * in plain JS, pure and unit-testable with no DB access.
 *
 * qoqDeltaPct is null (never a fabricated percentage) whenever there is no
 * prior-quarter bucket or its total is 0 — same zero-denominator convention
 * as netDeltaPct in getPortfolioPeSummary above.
 */
export function foldEngagementTrend(
  quarters: Array<{ label: string; start: Date; end: Date }>,
  outreach: OutreachSendRow[],
  mail: ClientEmailRow[],
): PortfolioEngagementTrendResponse {
  return portfolioFoldEngagementTrend(quarters, outreach, mail);
}
