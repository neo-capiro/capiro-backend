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
import type { IntelligenceService } from './intelligence.service.js';
import type { FinalIntelligenceSources } from './intelligence-facade-owners.js';

export function createFinalSources(
  host: IntelligenceService,
  policies: { ttlMs(): number; requestBudgetMs(): number },
): FinalIntelligenceSources {
  return {
    regulatory: new ClientRegulatoryV1(host['prisma'], {
      withSourceBudget: <T>(label: string, clientId: string, work: Promise<T>) =>
        host['withSourceBudget'](label, clientId, work),
      getBillRegulationLinks: (...args) => host['getBillRegulationLinks'](...args),
      getClientRelevantRegulations: (...args) => host['getClientRelevantRegulations'](...args),
      buildRegulatoryLifecycle: (...args) => host['buildRegulatoryLifecycle'](...args),
      logger: () => host['logger'],
    }),
    commentDeadlines: new ClientCommentDeadlineAlertsV1(host['prisma'], {
      logger: () => host['logger'],
    }),
    alerts: new ClientAlertsV1(host['prisma'], {
      getTrackedBills: (...args) => host['getTrackedBills'](...args),
      alertCountdownLabel: (...args) => host['alertCountdownLabel'](...args),
      getClientIssueCodes: (...args) => host['getClientIssueCodes'](...args),
      confirmedLdaIds: (...args) => host['confirmedLdaIds'](...args),
      issueCodesForLdaIds: (...args) => host['issueCodesForLdaIds'](...args),
      logger: () => host['logger'],
    }),
    awardAlerts: new ClientAwardAlertsV1(host['prisma'], {
      resolveContractorUeisForAlerts: (...args) => host['resolveContractorUeisForAlerts'](...args),
      logger: () => host['logger'],
    }),
    timeline: new IntelligencePortfolioTimeline(host['prisma']),
    comingUp: new IntelligencePortfolioComingUp(host['prisma']),
    summary: new IntelligencePortfolioSummary(host['prisma']),
    portfolioAlerts: new IntelligencePortfolioAlerts(host['prisma'], {
      cache: () => host['portfolioAlertsCache'],
      inflight: () => host['portfolioAlertsInflight'],
      gate: () => host['portfolioAlertsGate'],
      setGate: (value) => {
        host['portfolioAlertsGate'] = value;
      },
      ttlMs: () => policies.ttlMs(),
      requestBudgetMs: () => policies.requestBudgetMs(),
      logger: () => host['logger'],
      emptyPortfolioAlerts: () => host['emptyPortfolioAlerts'](),
      withPortfolioAlertsRequestBudget: (cacheKey, work) =>
        host['withPortfolioAlertsRequestBudget'](cacheKey, work),
      computePortfolioAlerts: (...args) => host['computePortfolioAlerts'](...args),
      getClientProfileV1: (...args) => host['getClientProfileV1'](...args),
    }),
    rollup: new IntelligencePortfolioRollup(host['prisma']),
    trend: new IntelligencePortfolioTrend(host['prisma']),
  };
}
