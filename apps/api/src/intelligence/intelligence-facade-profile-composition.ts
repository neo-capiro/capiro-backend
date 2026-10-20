import { IntelligenceClientProfileV1 } from './client-profile-v1.js';
import { IntelligenceBillRelevanceInputs } from './intelligence-bill-relevance-inputs.js';
import { IntelligenceRelevantBillDiscovery } from './intelligence-relevant-bill-discovery.js';
import { IntelligenceTrackedBillDiscovery } from './intelligence-tracked-bill-discovery.js';
import { IntelligenceManualBillTracking } from './intelligence-manual-bill-tracking.js';
import { IntelligenceBillEnrichment } from './intelligence-bill-enrichment.js';
import type { IntelligenceService } from './intelligence.service.js';

export function createProfileV1(host: IntelligenceService): IntelligenceClientProfileV1 {
  return new IntelligenceClientProfileV1(host['prisma'], {
    getClientProfile: (...args) => host['getClientProfile'](...args),
    getLobbyingRoi: (...args) => host['getLobbyingRoi'](...args),
    getFecMoneyFlow: (...args) => host['getFecMoneyFlow'](...args),
    getDistrictNexus: (...args) => host['getDistrictNexus'](...args),
    getTrackedBills: (...args) => host['getTrackedBills'](...args),
    getBillRegulationLinks: (...args) => host['getBillRegulationLinks'](...args),
    getKnowledgeGraph: (...args) => host['getKnowledgeGraph'](...args),
    computeEngagementHealth: (...args) => host['computeEngagementHealth'](...args),
    getExStaffers: (...args) => host['getExStaffers'](...args),
    getCommentPeriodAlerts: (...args) => host['getCommentPeriodAlerts'](...args),
    getChanges: (...args) => host['getChanges'](...args),
    getDistrictNexusSpend: (...args) => host['getDistrictNexusSpend'](...args),
    getOverdueCommentAlerts: (...args) => host['getOverdueCommentAlerts'](...args),
    getCompetitorLdaAlerts: (...args) => host['getCompetitorLdaAlerts'](...args),
    getContractAwardAlerts: (...args) => host['getContractAwardAlerts'](...args),
    getHearingAlerts: (...args) => host['getHearingAlerts'](...args),
    getClientRelevantRegulations: (...args) => host['getClientRelevantRegulations'](...args),
    buildRoiQuarterSeries: (...args) => host['buildRoiQuarterSeries'](...args),
    buildRegulatoryLifecycle: (...args) => host['buildRegulatoryLifecycle'](...args),
    normalizeProfileV1Sections: (...args) => host['normalizeProfileV1Sections'](...args),
    withSourceBudget: <T>(label: string, clientId: string, work: Promise<T>) =>
      host['withSourceBudget'](label, clientId, work),
    officeRecommender: () => host['officeRecommender'],
    warn: (message) => host['logger'].warn(message),
  });
}

export function createBillRelevanceInputs(
  host: IntelligenceService,
): IntelligenceBillRelevanceInputs {
  return new IntelligenceBillRelevanceInputs(host['prisma']);
}

export function createRelevantBillDiscovery(
  host: IntelligenceService,
): IntelligenceRelevantBillDiscovery {
  return new IntelligenceRelevantBillDiscovery(host['prisma'], {
    confirmedLdaIds: (...args) => host['confirmedLdaIds'](...args),
    issueCodesForLdaIds: (...args) => host['issueCodesForLdaIds'](...args),
    findRelevantBills: (...args) => host['findRelevantBills'](...args),
    findRelevantBillsByEmbeddings: (...args) => host['findRelevantBillsByEmbeddings'](...args),
    findRelevantBillsByKeyword: (...args) => host['findRelevantBillsByKeyword'](...args),
    warn: (message) => host['logger'].warn(message),
  });
}

export function createTrackedBillDiscovery(
  host: IntelligenceService,
  embeddingFloor: (hasCapabilitySignal: boolean) => number,
): IntelligenceTrackedBillDiscovery {
  return new IntelligenceTrackedBillDiscovery(host['prisma'], {
    getManualTrackedBillIds: (...args) => host['getManualTrackedBillIds'](...args),
    getClientRelevanceTerms: (...args) => host['getClientRelevanceTerms'](...args),
    fetchBillsByIds: (...args) => host['fetchBillsByIds'](...args),
    findTrackedBillsByEmbeddings: (...args) => host['findTrackedBillsByEmbeddings'](...args),
    findTrackedBillsByKeyword: (...args) => host['findTrackedBillsByKeyword'](...args),
    embeddingSimilarityFloor: (hasCapabilitySignal) => embeddingFloor(hasCapabilitySignal),
    warn: (message) => host['logger'].warn(message),
  });
}

export function createManualBillTracking(
  host: IntelligenceService,
): IntelligenceManualBillTracking {
  return new IntelligenceManualBillTracking(host['prisma'], {
    fetchBillsByIds: (...args) => host['fetchBillsByIds'](...args),
  });
}

export function createBillEnrichment(host: IntelligenceService): IntelligenceBillEnrichment {
  return new IntelligenceBillEnrichment(host['prisma'], {
    getTrackedBills: (...args) => host['getTrackedBills'](...args),
  });
}
