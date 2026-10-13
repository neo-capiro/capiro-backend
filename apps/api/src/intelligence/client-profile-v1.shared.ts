import type { IntelligenceService } from './intelligence.service.js';
import type { OfficeRecommenderService } from './office-recommender.service.js';

export interface ProfileV1Context {
  client: { id: string; name: string };
  clientId: string;
  tenantId: string;
  userId?: string;
  now: Date;
  day14: Date;
  day21: Date;
  day7: Date;
  day30: Date;
}

/** Request-time facade lookups preserve existing source and projector overrides. */
export interface ProfileV1Ports {
  getClientProfile: IntelligenceService['getClientProfile'];
  getLobbyingRoi: IntelligenceService['getLobbyingRoi'];
  getFecMoneyFlow: IntelligenceService['getFecMoneyFlow'];
  getDistrictNexus: IntelligenceService['getDistrictNexus'];
  getTrackedBills: IntelligenceService['getTrackedBills'];
  getBillRegulationLinks: IntelligenceService['getBillRegulationLinks'];
  getKnowledgeGraph: IntelligenceService['getKnowledgeGraph'];
  computeEngagementHealth: IntelligenceService['computeEngagementHealth'];
  getExStaffers: IntelligenceService['getExStaffers'];
  getCommentPeriodAlerts: IntelligenceService['getCommentPeriodAlerts'];
  getChanges: IntelligenceService['getChanges'];
  getDistrictNexusSpend: IntelligenceService['getDistrictNexusSpend'];
  getOverdueCommentAlerts: IntelligenceService['getOverdueCommentAlerts'];
  getCompetitorLdaAlerts: IntelligenceService['getCompetitorLdaAlerts'];
  getContractAwardAlerts: IntelligenceService['getContractAwardAlerts'];
  getHearingAlerts: IntelligenceService['getHearingAlerts'];
  getClientRelevantRegulations: IntelligenceService['getClientRelevantRegulations'];
  buildRoiQuarterSeries: IntelligenceService['buildRoiQuarterSeries'];
  buildRegulatoryLifecycle: IntelligenceService['buildRegulatoryLifecycle'];
  normalizeProfileV1Sections: IntelligenceService['normalizeProfileV1Sections'];
  withSourceBudget<T>(label: string, clientId: string, work: Promise<T>): Promise<T>;
  officeRecommender(): Pick<OfficeRecommenderService, 'recommend'> | undefined;
  warn(message: string): void;
}

export type ProfileV1Settler = <T>(index: number, fallback: T) => T;
