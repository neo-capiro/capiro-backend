import type { AlertRow } from './client-alerts-v1.shared.js';
import {
  buildQuarterWindows as portfolioBuildQuarterWindows,
  foldEngagementTrend as portfolioFoldEngagementTrend,
} from './intelligence-portfolio-quarters.js';
import type { OutreachSendRow, ClientEmailRow } from './intelligence-portfolio-quarters.js';
import {
  normalizeProfileV1Sections,
  profileV1Finite,
  profileV1FiniteOrNull,
  profileV1IsoOrNull,
} from './client-profile-v1-presentation.js';
import { buildProfileV1RegulatoryLifecycle } from './client-profile-v1-regulatory.js';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { withBillKeywordProfileDeadline } from './bill-keyword-deadline.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import type { OfficeRecommendation } from './office-recommender.service.js';
import type * as FacadeOwners from './intelligence-facade-owners.js';
import type * as FacadeContracts from './intelligence-facade-contracts.js';
import * as FacadePolicy from './intelligence-facade-policy-values.js';
import {
  createProfileV1,
  createBillRelevanceInputs,
  createRelevantBillDiscovery,
  createTrackedBillDiscovery,
  createManualBillTracking,
  createBillEnrichment,
} from './intelligence-facade-profile-composition.js';
import { createSupportingSources } from './intelligence-facade-supporting-composition.js';
import { createClientSources } from './intelligence-facade-client-composition.js';
import { createFinalSources } from './intelligence-facade-final-composition.js';
import { withIntelligenceSourceBudget } from './intelligence-profile-source-budget.js';

export const TRACKED_BILL_SIMILARITY_FLOOR = FacadePolicy.TRACKED_BILL_SIMILARITY_FLOOR;

export const THIN_SIGNAL_SIMILARITY_FLOOR = FacadePolicy.THIN_SIGNAL_SIMILARITY_FLOOR;

export function embeddingSimilarityFloor(hasCapabilitySignal: boolean): number {
  return hasCapabilitySignal ? TRACKED_BILL_SIMILARITY_FLOOR : THIN_SIGNAL_SIMILARITY_FLOOR;
}

export const AWARD_BEARING_MAPPING_SOURCES: ReadonlySet<string> =
  FacadePolicy.AWARD_BEARING_MAPPING_SOURCES;

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

export function buildQuarterWindows(
  now: Date,
  count: number,
): Array<{ label: string; start: Date; end: Date }> {
  return portfolioBuildQuarterWindows(now, count);
}

export function foldEngagementTrend(
  quarters: Array<{ label: string; start: Date; end: Date }>,
  outreach: OutreachSendRow[],
  mail: ClientEmailRow[],
): PortfolioEngagementTrendResponse {
  return portfolioFoldEngagementTrend(quarters, outreach, mail);
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);
  private readonly finalSources: FacadeOwners.FinalIntelligenceSources;
  private readonly clientSources: FacadeOwners.ClientIntelligenceSources;
  private readonly supportingSources: FacadeOwners.SupportingIntelligenceSources;
  private readonly profileV1: FacadeOwners.IntelligenceClientProfileV1;
  private readonly billRelevanceInputs: FacadeOwners.IntelligenceBillRelevanceInputs;
  private readonly relevantBillDiscovery: FacadeOwners.IntelligenceRelevantBillDiscovery;
  private readonly trackedBillDiscovery: FacadeOwners.IntelligenceTrackedBillDiscovery;
  private readonly manualBillTracking: FacadeOwners.IntelligenceManualBillTracking;
  private readonly billEnrichment: FacadeOwners.IntelligenceBillEnrichment;
  private readonly portfolioAlertsCache = new Map<string, { expiresAt: number; value: unknown }>();
  private static readonly PORTFOLIO_ALERTS_TTL_MS = 2 * 60 * 1000;
  static PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 12_000;
  private readonly portfolioAlertsInflight = new Map<string, Promise<unknown>>();
  private portfolioAlertsGate: Promise<unknown> = Promise.resolve();
  static readonly PROFILE_V1_SOURCE_BUDGET_MS = 20_000;
  static readonly PROFILE_V1_SLOW_SOURCE_MS = 3_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prepopulation?: ClientPrepopulationService,
    private readonly officeRecommender?: OfficeRecommenderService,
  ) {
    this.profileV1 = createProfileV1(this);
    this.billRelevanceInputs = createBillRelevanceInputs(this);
    this.relevantBillDiscovery = createRelevantBillDiscovery(this);
    this.trackedBillDiscovery = createTrackedBillDiscovery(this, (hasCapabilitySignal) =>
      embeddingSimilarityFloor(hasCapabilitySignal),
    );
    this.manualBillTracking = createManualBillTracking(this);
    this.billEnrichment = createBillEnrichment(this);
    this.supportingSources = createSupportingSources(this);
    this.clientSources = createClientSources(this, (source) =>
      AWARD_BEARING_MAPPING_SOURCES.has(source),
    );
    this.finalSources = createFinalSources(this, {
      ttlMs: () => IntelligenceService.PORTFOLIO_ALERTS_TTL_MS,
      requestBudgetMs: () => IntelligenceService.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS,
    });
  }

  private asFinite(value: unknown, fallback = 0): number { return profileV1Finite(value, fallback); }

  private asFiniteOrNull(value: unknown): number | null { return profileV1FiniteOrNull(value); }

  private asIsoOrNull(value: unknown): string | null { return profileV1IsoOrNull(value); }

  private normalizeProfileV1Sections(
    sections: FacadeContracts.ProfileV1Sections,
  ) {
    return normalizeProfileV1Sections(sections, {
      asFinite: (value, fallback) => this.asFinite(value, fallback),
      asFiniteOrNull: (value) => this.asFiniteOrNull(value),
      asIsoOrNull: (value) => this.asIsoOrNull(value),
    });
  }

  async getClientProfile(clientId: string, tenantId: string) { return this.clientSources.identityProfile.getClientProfile(clientId, tenantId); }

  private withSourceBudget<T>(label: string, clientId: string, work: Promise<T>): Promise<T> {
    return withIntelligenceSourceBudget(
      {
        budgetMs: () => IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS,
        slowMs: () => IntelligenceService.PROFILE_V1_SLOW_SOURCE_MS,
        logger: () => this.logger,
      },
      label,
      clientId,
      work,
    );
  }

  async getClientRegulatoryProfile(clientId: string, tenantId: string) { return this.finalSources.regulatory.getClientRegulatoryProfile(clientId, tenantId); }

  private buildRegulatoryLifecycle(
    regLinks: Awaited<ReturnType<IntelligenceService['getBillRegulationLinks']>>,
    clientRelevantRegs: Awaited<ReturnType<IntelligenceService['getClientRelevantRegulations']>>,
    now: Date,
  ) { return buildProfileV1RegulatoryLifecycle(regLinks, clientRelevantRegs, now); }

  async getClientProfileV1(clientId: string, tenantId: string, userId?: string) {
    return withBillKeywordProfileDeadline(() =>
      this.getClientProfileV1WithinBillDeadline(clientId, tenantId, userId),
    );
  }

  private async getClientProfileV1WithinBillDeadline(
    clientId: string,
    tenantId: string,
    userId?: string,
  ) { return this.profileV1.getClientProfileV1WithinBillDeadline(clientId, tenantId, userId); }

  private pickLdaClientIds(
    cached: number[] | null | undefined,
    confirmedExternalIds: string[],
  ): number[] { return this.clientSources.identityLda.pickLdaClientIds(cached, confirmedExternalIds); }

  private async resolveLdaClientIds(clientId: string, tenantId: string): Promise<number[]> { return this.clientSources.identityLda.resolveLdaClientIds(clientId, tenantId); }

  private async confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]> { return this.clientSources.identityLda.confirmedLdaIds(clientId, tenantId); }

  private async issueCodesForLdaIds(ldaClientIds: number[]): Promise<string[]> { return this.clientSources.identityLda.issueCodesForLdaIds(ldaClientIds); }

  private async fetchLdaByIds(ldaClientIds: number[]) { return this.clientSources.identityLda.fetchLdaByIds(ldaClientIds); }

  async getClientLdaFilings(clientId: string, tenantId: string) { return this.clientSources.identityFilings.getClientLdaFilings(clientId, tenantId); }

  private isUuid(id: string): boolean { return this.clientSources.identityCatalog.isUuid(id); }

  private async fetchContractorById(id: string) { return this.clientSources.identityCatalog.fetchContractorById(id); }

  private async fetchLobbyIntelById(id: string) { return this.clientSources.identityCatalog.fetchLobbyIntelById(id); }

  private async fuzzyMatchLda(clientName: string) { return this.clientSources.identityLda.fuzzyMatchLda(clientName); }

  private async fuzzyMatchContractor(clientName: string) { return this.clientSources.identityCatalog.fuzzyMatchContractor(clientName); }

  private async fuzzyMatchLobbyIntel(clientName: string) { return this.clientSources.identityCatalog.fuzzyMatchLobbyIntel(clientName); }

  private async capabilityFallbackTerms(tenantId: string, clientId: string): Promise<string[]> { return this.billRelevanceInputs.capabilityFallbackTerms(tenantId, clientId); }

  private async findRelevantBills(issueCodes: string[], fallbackTerms: string[] = []) { return this.relevantBillDiscovery.findRelevantBills(issueCodes, fallbackTerms); }

  private async findRelevantBillsByEmbeddings(
    allTerms: string[],
  ): Promise<FacadeContracts.RelevantBillsResult | null> { return this.relevantBillDiscovery.findRelevantBillsByEmbeddings(allTerms); }

  private async findRelevantBillsByKeyword(allTerms: string[]) { return this.relevantBillDiscovery.findRelevantBillsByKeyword(allTerms); }

  private async findActiveRegulations(issueCodes: string[], fallbackTerms: string[] = []) { return this.finalSources.regulatory.findActiveRegulations(issueCodes, fallbackTerms); }

  private async findCompetitors(
    clientName: string,
    issueCodes: string[],
    ldaClientIds: number[] = [],
  ) { return this.clientSources.identityLda.findCompetitors(clientName, issueCodes, ldaClientIds); }

  async getChanges(
    tenantId: string,
    since?: string,
    clientId?: string,
    source?: string,
    consumed?: boolean,
    peCodes?: string[],
  ) { return this.supportingSources.changes.getChanges( tenantId, since, clientId, source, consumed, peCodes, ); }

  async getMappings(clientId: string, tenantId: string) { return this.clientSources.mapping.getMappings(clientId, tenantId); }

  async searchLdaClients(query: string) { return this.clientSources.mappingCatalog.searchLdaClients(query); }

  async searchFecEmployers(query: string) { return this.clientSources.mappingCatalog.searchFecEmployers(query); }

  async searchFecCommittees(query: string) { return this.clientSources.mappingCatalog.searchFecCommittees(query); }

  async searchContractors(query: string) { return this.clientSources.mappingCatalog.searchContractors(query); }

  async searchAssistanceRecipients(query: string) { return this.clientSources.mappingCatalog.searchAssistanceRecipients(query); }

  async createManualMapping(
    clientId: string,
    tenantId: string,
    input: FacadeContracts.ManualMappingInput,
  ) { return this.clientSources.mappingReview.createManualMapping(clientId, tenantId, input); }

  async rejectMappingCandidate(
    clientId: string,
    tenantId: string,
    input: FacadeContracts.MappingRejectionInput,
  ) { return this.clientSources.mappingReview.rejectMappingCandidate(clientId, tenantId, input); }

  async resolveMapping(clientId: string, tenantId: string) { return this.clientSources.mapping.resolveMapping(clientId, tenantId); }

  async confirmMapping(
    mappingId: string,
    input: FacadeContracts.MappingConfirmationInput,
    tenantId: string,
  ) { return this.clientSources.mappingReview.confirmMapping(mappingId, input, tenantId); }

  async markChangeConsumed(id: string, consumed: boolean) { return this.supportingSources.changes.markChangeConsumed(id, consumed); }

  async getUnreadChangesCount() { return this.supportingSources.changes.getUnreadChangesCount(); }

  async getLobbyingRoi(clientId: string, tenantId: string) { return this.supportingSources.financial.getLobbyingRoi(clientId, tenantId); }

  private async getPacGiving(
    clientId: string,
    tenantId: string,
  ): Promise<FacadeContracts.PacGiving> { return this.supportingSources.pac.getPacGiving(clientId, tenantId); }

  async getFecMoneyFlow(clientId: string, tenantId: string) { return this.supportingSources.flow.getFecMoneyFlow(clientId, tenantId); }

  async getCompetitorBoard(clientId: string, tenantId: string) { return this.supportingSources.relationships.getCompetitorBoard(clientId, tenantId); }

  async getExStaffers(clientId: string, tenantId: string) { return this.supportingSources.relationships.getExStaffers(clientId, tenantId); }

  async getClientBills(clientId: string, tenantId: string) { return this.relevantBillDiscovery.getClientBills(clientId, tenantId); }

  async getSetupCompleteness(clientId: string, tenantId: string) { return this.clientSources.mappingSetup.getSetupCompleteness(clientId, tenantId); }

  async getIssueCodeSignal(clientId: string, tenantId: string) { return this.billRelevanceInputs.getIssueCodeSignal(clientId, tenantId); }

  async computeOfficeRecommendations(
    clientId: string,
    tenantId: string,
  ): Promise<OfficeRecommendation[]> { return this.supportingSources.relationships.computeOfficeRecommendations(clientId, tenantId); }

  async getClientRelevanceTerms(
    clientId: string,
    tenantId: string,
  ): Promise<FacadeContracts.ClientRelevanceTerms> { return this.billRelevanceInputs.getClientRelevanceTerms(clientId, tenantId); }

  async getTrackedBills(clientId: string, tenantId?: string) { return this.trackedBillDiscovery.getTrackedBills(clientId, tenantId); }

  private async getManualTrackedBillIds(clientId: string, tenantId: string): Promise<string[]> { return this.manualBillTracking.getManualTrackedBillIds(clientId, tenantId); }

  private async fetchBillsByIds(
    ids: string[],
  ): Promise<Array<FacadeContracts.BillDetail>> { return this.manualBillTracking.fetchBillsByIds(ids); }

  async listTrackedBills(clientId: string, tenantId: string) { return this.manualBillTracking.listTrackedBills(clientId, tenantId); }

  async addTrackedBill(
    clientId: string,
    tenantId: string,
    billId: string,
    note?: string,
    createdBy?: string,
  ) { return this.manualBillTracking.addTrackedBill(clientId, tenantId, billId, note, createdBy); }

  async removeTrackedBill(clientId: string, tenantId: string, billId: string) { return this.manualBillTracking.removeTrackedBill(clientId, tenantId, billId); }

  private async findTrackedBillsByEmbeddings(
    allTerms: string[],
    similarityFloor: number = TRACKED_BILL_SIMILARITY_FLOOR,
  ): Promise<FacadeContracts.TrackedBillMatch | null> { return this.trackedBillDiscovery.findTrackedBillsByEmbeddings(allTerms, similarityFloor); }

  private async findTrackedBillsByKeyword(
    allTerms: string[],
  ): Promise<FacadeContracts.TrackedBillMatch> { return this.trackedBillDiscovery.findTrackedBillsByKeyword(allTerms); }

  async getIssueLeaderboard(issueCode: string) { return this.supportingSources.relationships.getIssueLeaderboard(issueCode); }

  async computeEngagementHealth(clientId: string, tenantId: string) { return this.clientSources.health.computeEngagementHealth(clientId, tenantId); }

  async getCommentPeriodAlerts(tenantId: string) { return this.finalSources.commentDeadlines.getCommentPeriodAlerts(tenantId); }

  private alertCountdownLabel(days: number | null): string | null { return this.finalSources.alerts.alertCountdownLabel(days); }

  private async getClientIssueCodes(clientId: string, tenantId: string): Promise<string[]> { return this.finalSources.alerts.getClientIssueCodes(clientId, tenantId); }

  async getHearingAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    until: Date,
    precomputedTracked?:
      | Promise<Awaited<ReturnType<typeof this.getTrackedBills>>>
      | Awaited<ReturnType<typeof this.getTrackedBills>>,
  ): Promise<AlertRow[]> { return this.finalSources.alerts.getHearingAlerts( clientId, tenantId, now, until, precomputedTracked, ); }

  async getOverdueCommentAlerts(
    clientId: string,
    tenantId: string,
    now: Date,
    lookbackStart: Date,
  ): Promise<AlertRow[]> { return this.finalSources.alerts.getOverdueCommentAlerts(clientId, tenantId, now, lookbackStart); }

  async getCompetitorLdaAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> { return this.finalSources.alerts.getCompetitorLdaAlerts(clientId, tenantId, since); }

  async getContractAwardAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> { return this.finalSources.awardAlerts.getContractAwardAlerts(clientId, tenantId, since); }

  private async resolveContractorUeisForAlerts(
    contractorIds: string[],
  ): Promise<Map<string, string | null>> { return this.finalSources.awardAlerts.resolveContractorUeisForAlerts(contractorIds); }

  async setAlertState(
    tenantId: string,
    userId: string,
    clientId: string,
    alertId: string,
    state: 'acknowledged' | 'dismissed' | 'snoozed',
    snoozedUntil?: Date | null,
  ) { return this.finalSources.alerts.setAlertState( tenantId, userId, clientId, alertId, state, snoozedUntil, ); }

  async clearAlertState(tenantId: string, userId: string, clientId: string, alertId: string) { return this.finalSources.alerts.clearAlertState(tenantId, userId, clientId, alertId); }

  async listClientBriefs(tenantId: string, clientId: string) { return this.supportingSources.briefs.listClientBriefs(tenantId, clientId); }

  async addClientBrief(
    tenantId: string,
    clientId: string,
    userId: string,
    input: FacadeContracts.ClientBriefInput,
  ) { return this.supportingSources.briefs.addClientBrief(tenantId, clientId, userId, input); }

  async deleteClientBrief(tenantId: string, clientId: string, briefId: string) { return this.supportingSources.briefs.deleteClientBrief(tenantId, clientId, briefId); }

  private async walkClientGraph(tenantId: string, clientId: string, viewerUserId: string | null) { return this.clientSources.graph.walkClientGraph(tenantId, clientId, viewerUserId); }

  async getKnowledgeGraph(
    clientId: string,
    tenantId: string,
    opts?: FacadeContracts.KnowledgeGraphOptions,
  ) { return this.clientSources.graph.getKnowledgeGraph(clientId, tenantId, opts); }

  async getOutreachContext(clientId: string, tenantId: string, recipientOffice?: string) { return this.clientSources.outreach.getOutreachContext(clientId, tenantId, recipientOffice); }

  async getAllMappingsForTenant(tenantId: string) { return this.clientSources.mapping.getAllMappingsForTenant(tenantId); }

  async getDistrictNexus(clientId: string, tenantId: string) { return this.supportingSources.district.getDistrictNexus(clientId, tenantId); }

  async getDistrictNexusSpend(clientId: string, tenantId: string) { return this.supportingSources.districtSpend.getDistrictNexusSpend(clientId, tenantId); }

  async getBillRegulationLinks(
    clientId: string,
    tenantId: string,
    precomputedTracked?:
      | Promise<Awaited<ReturnType<typeof this.getTrackedBills>>>
      | Awaited<ReturnType<typeof this.getTrackedBills>>,
  ) { return this.billEnrichment.getBillRegulationLinks(clientId, tenantId, precomputedTracked); }

  private async getClientRelevantRegulations(
    clientId: string,
    tenantId: string,
    now: Date,
  ): Promise<Array<FacadeContracts.RelevantRegulation>> { return this.finalSources.regulatory.getClientRelevantRegulations(clientId, tenantId, now); }

  async getBillResearchAttachments(clientId: string, tenantId: string) { return this.billEnrichment.getBillResearchAttachments(clientId, tenantId); }

  async getTodayTimeline(tenantId: string) { return this.finalSources.timeline.getTodayTimeline(tenantId); }

  async getLiveTicker(tenantId: string, limit = 12) { return this.finalSources.timeline.getLiveTicker(tenantId, limit); }

  async getComingUp(tenantId: string, userId: string) { return this.finalSources.comingUp.getComingUp(tenantId, userId); }

  async getPortfolioSummary(
    tenantId: string,
    userId: string,
    window?: FacadeContracts.PortfolioWindow,
  ) { return this.finalSources.summary.getPortfolioSummary(tenantId, userId, window); }

  private emptyPortfolioAlerts(): FacadeContracts.PortfolioAlertsResult { return this.finalSources.portfolioAlerts.emptyPortfolioAlerts(); }

  private async withPortfolioAlertsRequestBudget<
    T extends ReturnType<IntelligenceService['emptyPortfolioAlerts']>,
  >(cacheKey: string, work: Promise<T>): Promise<T> { return this.finalSources.portfolioAlerts.withPortfolioAlertsRequestBudget(cacheKey, work); }

  async getPortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    opts?: FacadeContracts.PortfolioAlertsOptions,
  ): Promise<FacadeContracts.PortfolioAlertsResult> { return this.finalSources.portfolioAlerts.getPortfolioAlerts(tenantId, userId, opts); }

  private computePortfolioAlerts(
    tenantId: string,
    userId: string | undefined,
    limit: number,
    maxClients: number,
  ): Promise<FacadeContracts.PortfolioAlertsResult> { return this.finalSources.portfolioAlerts.computePortfolioAlerts( tenantId, userId, limit, maxClients, ); }

  async getPortfolioRollup(tenantId: string): Promise<FacadeContracts.PortfolioRollup> { return this.finalSources.rollup.getPortfolioRollup(tenantId); }

  async getPortfolioPeSummary(
    tenantId: string,
    _userId: string | undefined,
  ): Promise<FacadeContracts.PortfolioPeSummary> { return this.finalSources.rollup.getPortfolioPeSummary(tenantId, _userId); }

  async getPortfolioEngagementTrend(tenantId: string): Promise<PortfolioEngagementTrendResponse> { return this.finalSources.trend.getPortfolioEngagementTrend(tenantId); }

  private async buildRoiQuarterSeries({
    mappedLdaClientIds,
    lobbyingYearly,
    obligationsYearly,
    now,
  }: FacadeContracts.RoiQuarterInput): Promise<
    Array<FacadeContracts.RoiQuarterPoint>
  > {
    return this.supportingSources.quarters.buildRoiQuarterSeries({
      mappedLdaClientIds,
      lobbyingYearly,
      obligationsYearly,
      now,
    });
  }
}
