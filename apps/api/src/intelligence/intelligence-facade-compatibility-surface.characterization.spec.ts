import * as facade from './intelligence.service.js';
import { IntelligenceService } from './intelligence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import { harness, installHooks } from '../../test/fixtures/intelligence-facade-compatibility.js';

installHooks();

const methodRows: ReadonlyArray<readonly [string, number, boolean]> = [
  ['asFinite', 1, false],
  ['asFiniteOrNull', 1, false],
  ['asIsoOrNull', 1, false],
  ['normalizeProfileV1Sections', 1, false],
  ['getClientProfile', 2, true],
  ['withSourceBudget', 3, false],
  ['getClientRegulatoryProfile', 2, true],
  ['buildRegulatoryLifecycle', 3, false],
  ['getClientProfileV1', 3, true],
  ['getClientProfileV1WithinBillDeadline', 3, true],
  ['pickLdaClientIds', 2, false],
  ['resolveLdaClientIds', 2, true],
  ['confirmedLdaIds', 2, true],
  ['issueCodesForLdaIds', 1, true],
  ['fetchLdaByIds', 1, true],
  ['getClientLdaFilings', 2, true],
  ['isUuid', 1, false],
  ['fetchContractorById', 1, true],
  ['fetchLobbyIntelById', 1, true],
  ['fuzzyMatchLda', 1, true],
  ['fuzzyMatchContractor', 1, true],
  ['fuzzyMatchLobbyIntel', 1, true],
  ['capabilityFallbackTerms', 2, true],
  ['findRelevantBills', 1, true],
  ['findRelevantBillsByEmbeddings', 1, true],
  ['findRelevantBillsByKeyword', 1, true],
  ['findActiveRegulations', 1, true],
  ['findCompetitors', 2, true],
  ['getChanges', 6, true],
  ['getMappings', 2, true],
  ['searchLdaClients', 1, true],
  ['searchFecEmployers', 1, true],
  ['searchFecCommittees', 1, true],
  ['searchContractors', 1, true],
  ['searchAssistanceRecipients', 1, true],
  ['createManualMapping', 3, true],
  ['rejectMappingCandidate', 3, true],
  ['resolveMapping', 2, true],
  ['confirmMapping', 3, true],
  ['markChangeConsumed', 2, true],
  ['getUnreadChangesCount', 0, true],
  ['getLobbyingRoi', 2, true],
  ['getPacGiving', 2, true],
  ['getFecMoneyFlow', 2, true],
  ['getCompetitorBoard', 2, true],
  ['getExStaffers', 2, true],
  ['getClientBills', 2, true],
  ['getSetupCompleteness', 2, true],
  ['getIssueCodeSignal', 2, true],
  ['computeOfficeRecommendations', 2, true],
  ['getClientRelevanceTerms', 2, true],
  ['getTrackedBills', 2, true],
  ['getManualTrackedBillIds', 2, true],
  ['fetchBillsByIds', 1, true],
  ['listTrackedBills', 2, true],
  ['addTrackedBill', 5, true],
  ['removeTrackedBill', 3, true],
  ['findTrackedBillsByEmbeddings', 1, true],
  ['findTrackedBillsByKeyword', 1, true],
  ['getIssueLeaderboard', 1, true],
  ['computeEngagementHealth', 2, true],
  ['getCommentPeriodAlerts', 1, true],
  ['alertCountdownLabel', 1, false],
  ['getClientIssueCodes', 2, true],
  ['getHearingAlerts', 5, true],
  ['getOverdueCommentAlerts', 4, true],
  ['getCompetitorLdaAlerts', 3, true],
  ['getContractAwardAlerts', 3, true],
  ['resolveContractorUeisForAlerts', 1, true],
  ['setAlertState', 6, true],
  ['clearAlertState', 4, true],
  ['listClientBriefs', 2, true],
  ['addClientBrief', 4, true],
  ['deleteClientBrief', 3, true],
  ['walkClientGraph', 3, true],
  ['getKnowledgeGraph', 3, true],
  ['getOutreachContext', 3, true],
  ['getAllMappingsForTenant', 1, true],
  ['getDistrictNexus', 2, true],
  ['getDistrictNexusSpend', 2, true],
  ['getBillRegulationLinks', 3, true],
  ['getClientRelevantRegulations', 3, true],
  ['getBillResearchAttachments', 2, true],
  ['getTodayTimeline', 1, true],
  ['getLiveTicker', 1, true],
  ['getComingUp', 2, true],
  ['getPortfolioSummary', 3, true],
  ['emptyPortfolioAlerts', 0, false],
  ['withPortfolioAlertsRequestBudget', 2, true],
  ['getPortfolioAlerts', 3, true],
  ['computePortfolioAlerts', 4, false],
  ['getPortfolioRollup', 1, true],
  ['getPortfolioPeSummary', 2, true],
  ['getPortfolioEngagementTrend', 1, true],
  ['buildRoiQuarterSeries', 1, true],
];

it('facade retains all95 Core own method descriptors, names, runtime parameter lengths and async classification', () => {
  const prototype = IntelligenceService.prototype;
  expect(Object.getOwnPropertyNames(prototype)).toEqual(
    expect.arrayContaining(['constructor', ...methodRows.map(([name]) => name)]),
  );
  for (const [name, length, isAsync] of methodRows) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    expect(descriptor).toMatchObject({ configurable: true, enumerable: false, writable: true });
    expect(descriptor.get).toBeUndefined();
    expect(descriptor.set).toBeUndefined();
    expect(descriptor.value).toEqual(expect.any(Function));
    const value = descriptor.value as { name: string; length: number };
    expect(value.name).toBe(name);
    expect(value.length).toBe(length);
    expect(Object.prototype.toString.call(descriptor.value)).toBe(
      isAsync ? '[object AsyncFunction]' : '[object Function]',
    );
  }
});

it('facade constructor remains the exported three-argument service with the original prototype identity', () => {
  const h = harness();
  expect(IntelligenceService.name).toBe('IntelligenceService');
  expect(IntelligenceService.length).toBe(3);
  expect(IntelligenceService.prototype.constructor).toBe(IntelligenceService);
  expect(
    Object.getOwnPropertyDescriptor(IntelligenceService.prototype, 'constructor'),
  ).toMatchObject({
    configurable: true,
    enumerable: false,
    writable: true,
    value: IntelligenceService,
  });
  expect(Object.getPrototypeOf(h.service)).toBe(IntelligenceService.prototype);
  expect(h.service).toBeInstanceOf(IntelligenceService);
  expect(h.fields.prisma).toBe(h.prisma);
  expect(h.fields.prepopulation).toBe(h.prepopulation);
  expect(h.fields.officeRecommender).toBe(h.officeRecommender);
  for (const name of ['prisma', 'prepopulation', 'officeRecommender']) {
    expect(Object.getOwnPropertyDescriptor(h.service, name)).toMatchObject({
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  expect(h.forbidden).not.toHaveBeenCalled();
});

it('facade supports absent optional constructor collaborators without I/O or missing dependency fields', () => {
  const h = harness(false);
  expect(h.fields.prepopulation).toBeUndefined();
  expect(h.fields.officeRecommender).toBeUndefined();
  expect(Object.hasOwn(h.service, 'prepopulation')).toBe(true);
  expect(Object.hasOwn(h.service, 'officeRecommender')).toBe(true);
  expect(h.forbidden).not.toHaveBeenCalled();
});

it('facade retains Nest injectable identity and the original three runtime DI tokens', () => {
  expect(Reflect.getMetadata('__injectable__', IntelligenceService)).toBe(true);
  expect(Reflect.getMetadata('design:paramtypes', IntelligenceService)).toEqual([
    PrismaService,
    ClientPrepopulationService,
    OfficeRecommenderService,
  ]);
});

it('facade module keeps its original runtime exports and singleton policy identities', () => {
  expect(Object.keys(facade).sort()).toEqual([
    'AWARD_BEARING_MAPPING_SOURCES',
    'IntelligenceService',
    'THIN_SIGNAL_SIMILARITY_FLOOR',
    'TRACKED_BILL_SIMILARITY_FLOOR',
    'buildQuarterWindows',
    'embeddingSimilarityFloor',
    'foldEngagementTrend',
  ]);
  expect(facade.IntelligenceService).toBe(IntelligenceService);
  expect(facade.AWARD_BEARING_MAPPING_SOURCES).toBeInstanceOf(Set);
  expect([...facade.AWARD_BEARING_MAPPING_SOURCES]).toEqual([
    'contracting',
    'assistance_recipient',
  ]);
  expect(facade.TRACKED_BILL_SIMILARITY_FLOOR).toBe(0.65);
  expect(facade.THIN_SIGNAL_SIMILARITY_FLOOR).toBe(0.75);
  expect(facade.embeddingSimilarityFloor.name).toBe('embeddingSimilarityFloor');
  expect(facade.embeddingSimilarityFloor.length).toBe(1);
  expect(facade.buildQuarterWindows.name).toBe('buildQuarterWindows');
  expect(facade.buildQuarterWindows.length).toBe(2);
  expect(facade.foldEngagementTrend.name).toBe('foldEngagementTrend');
  expect(facade.foldEngagementTrend.length).toBe(3);
});
