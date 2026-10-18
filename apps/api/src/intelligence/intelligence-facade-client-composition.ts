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
import type { IntelligenceService } from './intelligence.service.js';
import type { ClientIntelligenceSources } from './intelligence-facade-owners.js';

export function createClientSources(
  host: IntelligenceService,
  awardBearingMappingSource: (source: string) => boolean,
): ClientIntelligenceSources {
  return {
    identityProfile: new ClientIdentityV1Profile(host['prisma'], {
      pickLdaClientIds: (...args) => host['pickLdaClientIds'](...args),
      fetchLdaByIds: (...args) => host['fetchLdaByIds'](...args),
      fuzzyMatchLda: (...args) => host['fuzzyMatchLda'](...args),
      fetchContractorById: (...args) => host['fetchContractorById'](...args),
      fuzzyMatchContractor: (...args) => host['fuzzyMatchContractor'](...args),
      fetchLobbyIntelById: (...args) => host['fetchLobbyIntelById'](...args),
      fuzzyMatchLobbyIntel: (...args) => host['fuzzyMatchLobbyIntel'](...args),
      capabilityFallbackTerms: (...args) => host['capabilityFallbackTerms'](...args),
      findRelevantBills: (...args) => host['findRelevantBills'](...args),
      findActiveRegulations: (...args) => host['findActiveRegulations'](...args),
      findCompetitors: (...args) => host['findCompetitors'](...args),
    }),
    identityLda: new ClientIdentityV1Lda(host['prisma'], {
      pickLdaClientIds: (...args) => host['pickLdaClientIds'](...args),
    }),
    identityFilings: new ClientIdentityV1Filings(host['prisma'], {
      resolveLdaClientIds: (...args) => host['resolveLdaClientIds'](...args),
    }),
    identityCatalog: new ClientIdentityV1Catalog(host['prisma'], {
      isUuid: (...args) => host['isUuid'](...args),
    }),
    mapping: new ClientMappingV1(host['prisma']),
    mappingCatalog: new ClientMappingV1Catalog(host['prisma']),
    mappingReview: new ClientMappingV1Review(host['prisma'], {
      awardBearingMappingSource: (source) => awardBearingMappingSource(source),
      prepopulation: () => host['prepopulation'],
    }),
    mappingSetup: new ClientMappingV1Setup(host['prisma']),
    graph: new ClientContextV1Graph(host['prisma'], {
      walkClientGraph: (...args) => host['walkClientGraph'](...args),
      warn: (message) => host['logger'].warn(message),
    }),
    health: new ClientContextV1Health(host['prisma']),
    outreach: new ClientContextV1Outreach(host['prisma'], {
      confirmedLdaIds: (...args) => host['confirmedLdaIds'](...args),
      issueCodesForLdaIds: (...args) => host['issueCodesForLdaIds'](...args),
      getTrackedBills: (...args) => host['getTrackedBills'](...args),
      computeEngagementHealth: (...args) => host['computeEngagementHealth'](...args),
    }),
  };
}
