import { ClientFinancialV1Lobbying } from './client-financial-v1.js';
import { ClientFinancialV1Pac } from './client-financial-v1-pac.js';
import { ClientFinancialV1MoneyFlow } from './client-financial-v1-flow.js';
import { ClientFinancialV1Quarters } from './client-financial-v1-quarters.js';
import { ClientRelationshipsV1 } from './client-relationships-v1.js';
import { ClientChangesV1 } from './client-changes-v1.js';
import { ClientBriefsV1 } from './client-briefs-v1.js';
import { ClientDistrictV1 } from './client-district-v1.js';
import { ClientDistrictV1Spend } from './client-district-v1-spend.js';
import type { IntelligenceService } from './intelligence.service.js';
import type { SupportingIntelligenceSources } from './intelligence-facade-owners.js';

export function createSupportingSources(host: IntelligenceService): SupportingIntelligenceSources {
  return {
    financial: new ClientFinancialV1Lobbying(host['prisma'], {
      pickLdaClientIds: (...args) => host['pickLdaClientIds'](...args),
    }),
    pac: new ClientFinancialV1Pac(host['prisma']),
    flow: new ClientFinancialV1MoneyFlow(host['prisma'], {
      getPacGiving: (...args) => host['getPacGiving'](...args),
    }),
    quarters: new ClientFinancialV1Quarters(host['prisma']),
    relationships: new ClientRelationshipsV1(host['prisma'], {
      confirmedLdaIds: (...args) => host['confirmedLdaIds'](...args),
      getTrackedBills: (...args) => host['getTrackedBills'](...args),
      getIssueLeaderboard: (...args) => host['getIssueLeaderboard'](...args),
      officeRecommender: () => host['officeRecommender'],
    }),
    changes: new ClientChangesV1(host['prisma']),
    briefs: new ClientBriefsV1(host['prisma']),
    district: new ClientDistrictV1(host['prisma']),
    districtSpend: new ClientDistrictV1Spend(host['prisma'], {
      resolveContractorUeisForAlerts: (...args) => host['resolveContractorUeisForAlerts'](...args),
    }),
  };
}
