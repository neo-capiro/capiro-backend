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
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';


import {
  AGENCY_SECTOR_MAP,
  ldaCodesForSectors,
  normalizeSector,
  type SectorTag,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ownMeetingWhere,
  clientAssociatedMeetingWhere,
} from '../engagement/engagement-access.helpers.js';
import { toCanonicalAlert } from './canonical-alert.adapter.js';
import { addDateInZone, dateBoundsInZone, dayBoundsInZone } from './time-bounds.js';


import type { PacCoverage } from './fec-pac-coverage.js';

import { columnKeywordMatchSql } from './bill-keyword-match.helpers.js';
import { withBillKeywordProfileDeadline } from './bill-keyword-deadline.js';
import { commentDeadlineDedupeKey } from './comment-deadline.util.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import type { OfficeRecommendation } from './office-recommender.service.js';

import {
  buildDistrictNexusIdentity,
  districtNexusContractorIdsToResolve,
  type DistrictNexusIdentitySeed,
} from '../district-nexus/district-nexus.identity.js';



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
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, status: true } }),
    );
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');
    const now = new Date();
    const results = await Promise.allSettled([
      this.withSourceBudget(
        'billRegulationLinks',
        clientId,
        this.getBillRegulationLinks(clientId, tenantId),
      ),
      this.withSourceBudget(
        'clientRelevantRegulations',
        clientId,
        this.getClientRelevantRegulations(clientId, tenantId, now),
      ),
    ] as const);
    const labels = ['Tracked-bill regulations', 'Client-relevant regulations'];
    const sources = results.map((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `regulatory-profile source ${labels[index]} failed for client ${clientId}: ${String(result.reason)}`,
        );
      }
      return {
        name: labels[index]!,
        status: result.status === 'fulfilled' ? ('available' as const) : ('unavailable' as const),
      };
    });
    if (results.every((result) => result.status === 'rejected')) {
      throw new ServiceUnavailableException('Regulatory sources are unavailable. Please retry.');
    }
    const links =
      results[0].status === 'fulfilled'
        ? results[0].value
        : { links: [], totalBills: 0, totalRegulations: 0 };
    const relevant = results[1].status === 'fulfilled' ? results[1].value : [];
    return {
      clientId,
      generatedAt: now.toISOString(),
      partial: sources.some((source) => source.status === 'unavailable'),
      sources,
      regulatoryLifecycle: this.buildRegulatoryLifecycle(links, relevant, now),
    };
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
        // Start-of-Eastern-day, not `now`: see the note at the portfolio feed above.
        // `date` is a UTC-midnight @db.Date, so `gte: now` dropped today's rows.
        where: federalHearingWhere({
          date: { gte: dateBoundsInZone(now, 'America/New_York').start, lte: until },
        }),
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
      // Release 1 fix: `externalId` on a `contracting` mapping is a
      // `federal_contractor.id` UUID, NOT a contractor name — this used to
      // compare that UUID against `federal_award.contractor_name`, which can
      // never match, and read as "no new awards" for every client with a
      // confirmed contracting mapping. Resolved through the same canonical
      // identity primitive every other District Nexus award reader uses.
      const [mapping, client] = await this.prisma.withTenant(tenantId, (tx) =>
        Promise.all([
          tx.clientIntelMapping.findFirst({
            where: {
              clientId,
              source: 'contracting',
              confirmed: true,
              reviewStatus: 'confirmed',
              rollUpAwards: true,
            },
            select: { externalId: true, externalName: true, matchBasis: true, matchTier: true },
          }),
          tx.client.findFirst({ where: { id: clientId }, select: { uei: true } }),
        ]),
      );
      if (!mapping) return [];

      const seed: DistrictNexusIdentitySeed = {
        clientId,
        clientName: '',
        uei: client?.uei ?? null,
        mappings: [
          {
            source: 'contracting',
            externalId: mapping.externalId,
            externalName: mapping.externalName,
            matchBasis: mapping.matchBasis,
            matchTier: mapping.matchTier,
          },
        ],
      };
      const contractorUeis = await this.resolveContractorUeisForAlerts(
        districtNexusContractorIdsToResolve([seed]),
      );
      const identity = buildDistrictNexusIdentity(seed, contractorUeis);
      if (identity.contract.basis === 'none') return [];

      const awards = await this.prisma.federalAward.findMany({
        where:
          identity.contract.basis === 'exact_uei'
            ? { recipientUei: { in: identity.contract.ueis }, awardedAt: { gte: since } }
            : {
                contractorName: { in: identity.contract.fallbackNames, mode: 'insensitive' },
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

  /** Resolve `federal_contractor.id -> uei`, outside any tenant transaction. See district-nexus.service.ts's twin. */
  private async resolveContractorUeisForAlerts(
    contractorIds: string[],
  ): Promise<Map<string, string | null>> {
    if (!contractorIds.length) return new Map();
    const rows = await this.prisma.federalContractor.findMany({
      where: { id: { in: contractorIds } },
      select: { id: true, uei: true },
    });
    return new Map(rows.map((r) => [r.id, r.uei]));
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
    try {
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: {
            id: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      );
      if (!client) return [];

      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const docs = await this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          OR: [{ commentEndDate: { gte: now } }, { publicationDate: { gte: ninetyDaysAgo } }],
        },
        orderBy: { publicationDate: 'desc' },
        take: 200,
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

      const matched: typeof docs = [];
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
        if (relevant) matched.push(doc);
        if (matched.length >= 20) break;
      }

      return matched.map((doc) => ({
        documentNumber: doc.documentNumber,
        type: doc.type,
        title: doc.title,
        agencyNames: (doc.agencyNames as string[]) ?? [],
        publicationDate: doc.publicationDate,
        commentEndDate: doc.commentEndDate,
        effectiveDate: doc.effectiveDate,
        htmlUrl: doc.htmlUrl,
      }));
    } catch (err) {
      this.logger.warn(
        `getClientRelevantRegulations failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
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
    const now = new Date();
    // ET day bounds for timestamp columns; UTC-midnight bounds for @db.Date columns.
    const { start: startOfDay, end: endOfDay } = dayBoundsInZone(now, 'America/New_York');
    const dateBounds = dateBoundsInZone(now, 'America/New_York');
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [hearings, deadlines, changes, clientIds] = await Promise.all([
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
   *
   * Meetings are scoped to the current user's own calendar (ownMeetingWhere,
   * the same ownership as GET /api/engagement/meetings), not tenant-wide.
   */
  async getComingUp(tenantId: string, userId: string) {
    if (!userId) {
      throw new UnauthorizedException('Current user is required');
    }
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
        where: federalHearingWhere({ date: { gte: tomorrowStart, lte: sevenDaysOut } }),
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
            ...ownMeetingWhere(userId),
            startsAt: { gte: tomorrowStart, lte: sevenDaysOut },
            status: { notIn: ['cancelled', 'canceled', 'deleted'] },
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
    const now = new Date();
    const quarterStart = startOfQuarter(now);

    // G1: meetings this week — same weekBounds logic the frontend used.
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
    monday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    const from = window?.from ? new Date(window.from) : monday;
    const to = window?.to ? new Date(window.to) : nextMonday;
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to.getTime() - from.getTime() > 8 * 86400_000) {
      throw new BadRequestException('A valid week window is required');
    }

    const [tenantScoped, regulationsTracked] = await Promise.all([
      this.prisma.withTenant(tenantId, async (tx) => {
        const clients = await tx.client.findMany({
          where: { tenantId, status: { not: 'archived' } },
          select: { id: true, profileStatus: true, primaryContactEmail: true, people: { where: { tenantId }, select: { email: true } } },
        });
        const clientAssociations = clientAssociatedMeetingWhere(
          clients.map((client) => client.id),
          clients.flatMap((client) => [client.primaryContactEmail, ...client.people.map((person) => person.email)])
            .filter((email): email is string => Boolean(email)),
        );
        const [mappings, meetingsThisWeek, billsTracked, activeStrategies] = await Promise.all([
            tx.clientIntelMapping.findMany({
              where: { confirmed: true, source: 'lda' },
              select: { clientId: true, externalId: true },
            }),
            tx.meeting.count({
              where: {
                tenantId,
                ...ownMeetingWhere(userId),
                startsAt: { gte: from, lt: to },
                AND: [clientAssociations],
                isInternal: false,
                status: { notIn: ['cancelled', 'canceled', 'deleted'] },
              },
            }),
            // Match Clients → Intelligence column (rollup uses trackedBill.groupBy).
            tx.trackedBill.count(),
            // sp_strategy is owned by api-strategy but lives in the same DB and
            // FORCE-RLS on tenant_id. Must use the tenant-scoped tx client.
            tx.$queryRaw<Array<{ count: bigint }>>`
              SELECT COUNT(*)::bigint AS count
              FROM sp_strategy
              WHERE tenant_id = ${tenantId}::uuid
                AND archived_at IS NULL
            `.catch(() => [{ count: 0n }]),
          ]);
        return { clients, mappings, meetingsThisWeek, billsTracked, activeStrategies };
      }),
      // Global FR catalog (not tenant-RLS); open proposed/final rules with a comment window.
      this.prisma.federalRegisterDocument.count({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now },
        },
      }),
    ]);

    const { clients, mappings, meetingsThisWeek, billsTracked, activeStrategies } = tenantScoped;

    const tenantClientIds = new Set(clients.map((c) => c.id));
    const tenantLdaIds = mappings
      .filter((m) => tenantClientIds.has(m.clientId))
      .map((m) => Number(m.externalId))
      .filter((n) => Number.isFinite(n));

    const needAttention = clients.filter(
      (c) => c.profileStatus === 'PAUSED' || c.profileStatus === 'MONITORING',
    ).length;

    // LDA filings are a shared catalog keyed by LDA client id (not tenant RLS).
    const ldaSpendRows = tenantLdaIds.length
      ? await this.prisma.$queryRaw<Array<{ total: string | null }>>`
          SELECT COALESCE(SUM(income), 0)::text AS total
          FROM lda_filing
          WHERE client_id = ANY(${tenantLdaIds}::int[])
            AND dt_posted >= ${quarterStart}
        `
      : [{ total: '0' }];

    // LDA `income` is stored as Decimal dollars (not cents).
    const ldaSpendDollars = Number(ldaSpendRows[0]?.total ?? '0');

    return {
      activeClients: clients.length,
      needAttention,
      ldaSpendQtd: ldaSpendDollars,
      billsTracked,
      activeRegulations: regulationsTracked,
      meetingsThisWeek,
      activeStrategies: Number(activeStrategies[0]?.count ?? 0n),
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
  private emptyPortfolioAlerts(): {
    alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
    total: number;
    clientCount: number;
    generatedAt: string;
  } {
    return {
      alerts: [],
      total: 0,
      clientCount: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Race an in-flight or fresh portfolio-alerts compute against the hard
   * request budget. Fail open with empty alerts so HTTP never hangs.
   */
  private async withPortfolioAlertsRequestBudget<
    T extends ReturnType<IntelligenceService['emptyPortfolioAlerts']>,
  >(cacheKey: string, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(
          `portfolio-alerts: exceeded ${IntelligenceService.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS}ms request budget for ${cacheKey}; failing open`,
        );
        resolve(this.emptyPortfolioAlerts() as T);
      }, IntelligenceService.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    // N-client roll-up. Whoever arrives first computes; everyone else awaits it
    // under the same request budget (so waiters also fail open).
    const existing = this.portfolioAlertsInflight.get(cacheKey);
    if (existing) {
      return this.withPortfolioAlertsRequestBudget(
        cacheKey,
        existing as Promise<Awaited<ReturnType<typeof this.getPortfolioAlerts>>>,
      );
    }

    const compute = this.computePortfolioAlerts(tenantId, userId, limit, maxClients)
      .then((result) => {
        this.portfolioAlertsCache.set(cacheKey, {
          expiresAt: Date.now() + IntelligenceService.PORTFOLIO_ALERTS_TTL_MS,
          value: result,
        });
        return result;
      })
      .catch((err) => {
        // Never leave the HTTP request hanging on an unexpected throw; fail open.
        this.logger.warn(
          `portfolio-alerts: compute failed for ${cacheKey}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return this.emptyPortfolioAlerts();
      })
      .finally(() => {
        this.portfolioAlertsInflight.delete(cacheKey);
      });

    this.portfolioAlertsInflight.set(cacheKey, compute);

    // Race the roll-up against a hard request budget. The in-flight map still
    // holds `compute` (not the raced promise) so a late success can populate
    // the TTL cache for the next caller even if this request already failed open.
    return this.withPortfolioAlertsRequestBudget(cacheKey, compute);
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
    const now = new Date();

    const [taskCounts, billCounts, meetings, workCounts] = await Promise.all([
      // Attention: open (non-done/canceled) engagement tasks per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementTask.groupBy({
          by: ['clientId'],
          where: {
            status: { in: ['todo', 'in_progress', 'blocked'] },
            clientId: { not: null },
          },
          _count: { id: true },
        }),
      ),
      // Intelligence: tracked bills per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.groupBy({
          by: ['clientId'],
          _count: { id: true },
        }),
      ),
      // Next touch: earliest future shared meeting per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meeting.findMany({
          where: {
            startsAt: { gte: now },
            visibility: 'shared',
            status: { not: 'cancelled' },
            clientId: { not: null },
          },
          select: { id: true, clientId: true, startsAt: true, subject: true },
          orderBy: { startsAt: 'asc' },
        }),
      ),
      // Item 5 — Work column: in_progress engagement tasks per client.
      this.prisma.withTenant(tenantId, (tx) =>
        tx.engagementTask.groupBy({
          by: ['clientId'],
          where: {
            status: 'in_progress',
            clientId: { not: null },
          },
          _count: { id: true },
        }),
      ),
    ]);

    const rollup: Record<
      string,
      {
        attentionCount: number;
        intelCount: number;
        nextTouch: { id: string; startsAt: string; subject: string } | null;
        workCount: number;
      }
    > = {};

    // Initialize from task counts (these have the client set).
    for (const row of taskCounts) {
      const cid = row.clientId as string;
      rollup[cid] = { attentionCount: row._count.id, intelCount: 0, nextTouch: null, workCount: 0 };
    }

    // Merge in bill counts.
    for (const row of billCounts) {
      const cid = row.clientId;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      rollup[cid].intelCount = row._count.id;
    }

    // Merge in earliest meeting per client (meetings are ordered by startsAt asc,
    // so the first one we encounter for each client is the earliest).
    for (const meeting of meetings) {
      const cid = meeting.clientId as string;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      if (!rollup[cid].nextTouch) {
        rollup[cid].nextTouch = {
          id: meeting.id,
          startsAt: meeting.startsAt.toISOString(),
          subject: meeting.subject,
        };
      }
    }

    // Merge in work counts (in_progress tasks).
    for (const row of workCounts) {
      const cid = row.clientId as string;
      if (!rollup[cid])
        rollup[cid] = { attentionCount: 0, intelCount: 0, nextTouch: null, workCount: 0 };
      rollup[cid].workCount = row._count.id;
    }

    return { rollup };
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
    // 1. Fetch watched PE codes for this tenant (all users in tenant — the
    //    portfolio surface is tenant-wide, not per-user).
    const watches = await this.prisma.withTenant(tenantId, (tx) =>
      tx.programElementWatch.findMany({
        where: { tenantId },
        select: { peCode: true },
      }),
    );

    const peCodes = [...new Set(watches.map((w) => w.peCode))];
    if (peCodes.length === 0) {
      return { netDeltaPct: null, peAttribution: {}, watchedCount: 0 };
    }

    // 2. Fetch the most-material live delta per watched PE (supersededAt IS NULL).
    //    Use the deltaPct from the row with the highest materialityScore per PE.
    const deltas = await this.prisma.$queryRaw<
      Array<{ pe_code: string; delta_pct: number | null }>
    >`
      SELECT pe_code, delta_pct
      FROM (
        SELECT
          d.pe_code,
          d.delta_pct,
          d.materiality_score,
          ROW_NUMBER() OVER (PARTITION BY d.pe_code ORDER BY d.materiality_score DESC) AS rn
        FROM program_element_delta d
        WHERE d.pe_code = ANY(${peCodes}::text[])
          AND d.superseded_at IS NULL
      ) ranked
      WHERE rn = 1
    `;

    // 3. Average the delta percentages for the net figure. Only count PEs with a
    //    non-null deltaPct — a null means "no comparable delta" and is not zero.
    const validDeltas = deltas.filter((d) => d.delta_pct != null && Number.isFinite(d.delta_pct));
    const netDeltaPct =
      validDeltas.length > 0
        ? validDeltas.reduce((sum, d) => sum + (d.delta_pct as number), 0) / validDeltas.length
        : null;

    // 4. Client attribution: find clients whose ClientCapability.peNumbers
    //    includes any of the watched PE codes. This is the join from watched
    //    PEs → clients who fund them.
    const capabilities = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: {
          OR: [{ peNumber: { in: peCodes } }, { peNumbers: { hasSome: peCodes } }],
        },
        select: {
          clientId: true,
          peNumber: true,
          peNumbers: true,
        },
      }),
    );

    // Resolve client names for the attribution map.
    const clientIds = [...new Set(capabilities.map((c) => c.clientId))];
    const clients =
      clientIds.length > 0
        ? await this.prisma.withTenant(tenantId, (tx) =>
            tx.client.findMany({
              where: { id: { in: clientIds }, status: { not: 'archived' } },
              select: { id: true, name: true },
            }),
          )
        : [];
    const clientNameMap = new Map(clients.map((c) => [c.id, c.name]));

    // Build peAttribution: peCode → array of client names.
    const peAttribution: Record<string, string[]> = {};
    for (const peCode of peCodes) {
      peAttribution[peCode] = [];
    }
    for (const cap of capabilities) {
      const name = clientNameMap.get(cap.clientId);
      if (!name) continue;
      // Check both peNumber (single) and peNumbers (array).
      if (cap.peNumber && peCodes.includes(cap.peNumber)) {
        if (!peAttribution[cap.peNumber]!.includes(name)) {
          peAttribution[cap.peNumber]!.push(name);
        }
      }
      if (Array.isArray(cap.peNumbers)) {
        for (const pe of cap.peNumbers) {
          if (peCodes.includes(pe) && !peAttribution[pe]!.includes(name)) {
            peAttribution[pe]!.push(name);
          }
        }
      }
    }

    return { netDeltaPct, peAttribution, watchedCount: peCodes.length };
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
    const quarters = buildQuarterWindows(new Date(), 6); // oldest → newest
    const windowStart = quarters[0]!.start;

    const [outreach, mail] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.outreachRecord.findMany({
          where: {
            clientId: { not: null },
            deletedAt: null,
            sentAt: { gte: windowStart },
            client: { status: { not: 'archived' } },
          },
          select: { sentAt: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.mailThread.findMany({
          where: {
            clientId: { not: null },
            lastMessageAt: { gte: windowStart },
            client: { status: { not: 'archived' } },
          },
          select: { lastMessageAt: true },
        }),
      ),
    ]);

    return foldEngagementTrend(quarters, outreach, mail);
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

function startOfQuarter(now: Date): Date {
  const month = now.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  return new Date(now.getFullYear(), quarterStartMonth, 1);
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
 * Adapted from the quarter-label loop in buildRoiQuarterSeries above and the
 * startOfQuarter helper directly above this function — parameterized on
 * count (6, not 8) and with no per-client scoping. Pure: no DB access.
 */
export function buildQuarterWindows(
  now: Date,
  count: number,
): Array<{ label: string; start: Date; end: Date }> {
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) + 1; // 1-4
  const windows: Array<{ label: string; start: Date; end: Date }> = [];
  for (let i = count - 1; i >= 0; i--) {
    let qy = y;
    let qq = q - i;
    while (qq < 1) {
      qq += 4;
      qy -= 1;
    }
    const nextQq = qq === 4 ? 1 : qq + 1;
    const nextQy = qq === 4 ? qy + 1 : qy;
    windows.push({
      label: `Q${qq}'${String(qy).slice(2)}`,
      start: new Date(qy, (qq - 1) * 3, 1),
      end: new Date(nextQy, (nextQq - 1) * 3, 1),
    });
  }
  return windows;
}

interface OutreachSendRow {
  sentAt: Date | null;
}

interface ClientEmailRow {
  lastMessageAt: Date | null;
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
  const buckets = quarters.map((q) => ({
    label: q.label,
    start: q.start,
    end: q.end,
    outreachSends: 0,
    clientEmails: 0,
  }));

  const bucketFor = (t: Date) => buckets.find((b) => t >= b.start && t < b.end);

  for (const row of outreach) {
    if (!row.sentAt) continue;
    const bucket = bucketFor(row.sentAt);
    if (bucket) bucket.outreachSends += 1;
  }
  for (const row of mail) {
    if (!row.lastMessageAt) continue;
    const bucket = bucketFor(row.lastMessageAt);
    if (bucket) bucket.clientEmails += 1;
  }

  const quartersOut = buckets.map((b) => ({
    label: b.label,
    start: b.start.toISOString(),
    end: b.end.toISOString(),
    outreachSends: b.outreachSends,
    clientEmails: b.clientEmails,
    total: b.outreachSends + b.clientEmails,
  }));

  const currentQuarterTotal = quartersOut.length ? quartersOut[quartersOut.length - 1]!.total : 0;
  const priorQuarterTotal =
    quartersOut.length > 1 ? quartersOut[quartersOut.length - 2]!.total : null;
  const qoqDeltaPct =
    priorQuarterTotal != null && priorQuarterTotal > 0
      ? ((currentQuarterTotal - priorQuarterTotal) / priorQuarterTotal) * 100
      : null;

  return { quarters: quartersOut, currentQuarterTotal, qoqDeltaPct };
}
