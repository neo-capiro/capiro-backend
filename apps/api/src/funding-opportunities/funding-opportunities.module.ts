import { Module } from '@nestjs/common';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { FundingOpportunityActionsService } from './funding-opportunity-actions.service.js';
import { FundingOpportunityInboxService } from './funding-opportunity-inbox.service.js';
import { ForecastOpportunityReadService } from './forecast-opportunity-read.service.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { ClientProfileEnrichmentService } from './client-profile-enrichment.service.js';
import { FederalBusinessProfileService } from './federal-business-profile.service.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesForecastFlagGuard,
  FundingOpportunitiesInboxFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
} from './funding-opportunities-flag.guard.js';

/**
 * Funding Opportunities (Grants.gov + SAM.gov contract opportunities).
 *
 * Ships DARK, and darker than District Nexus did: every route sits behind
 * FundingOpportunitiesFlagGuard, which 404s unless the tenant has an EXPLICIT
 * enabled `funding_opportunities` row in `intel_feature_flag`. Unlike
 * DistrictNexusFlagGuard there is no implicit internal-tenant fallback, so
 * merging this module changes nothing for any tenant including capiro-internal —
 * see the guard's docblock, and the rollout runbook for the flag write that turns
 * it on.
 *
 * Registering the module unconditionally is the house pattern: routes exist, the
 * flag decides whether they answer.
 *
 * No imports. The service reaches PrismaService through the global PrismaModule
 * and needs nothing else — deliberately, so this module cannot become the reason
 * an unrelated bootstrap cycle appears. (District Nexus needed
 * RepresentationModule and its docblock records why importing the owning module
 * directly is the only thing that works; nothing here needs that dependency.)
 *
 * `ClientProfileEnrichmentService` (P20) is the one exception to "no imports":
 * it depends on `TangoStoreService`, resolved via `TangoModule`'s `@Global()`
 * registration (P14) the same way every provider here already resolves
 * `PrismaService` via the global `PrismaModule` — no explicit import needed,
 * and for the same reason.
 */
@Module({
  controllers: [FundingOpportunitiesController],
  providers: [
    FundingOpportunitiesService,
    // P08. Depends only on PrismaService and FundingOpportunitiesService, so it
    // adds no import to this module and cannot introduce a bootstrap cycle —
    // deliberately, per the note above. It creates the Engagement task row
    // directly rather than calling EngagementService, because that service opens
    // its own transaction and the whole point of P08 is one transaction.
    FundingOpportunityActionsService,
    FundingOpportunityInboxService,
    // P26. Depends on PrismaService and FundingOpportunitiesService — both
    // already resolvable here, the second a SIBLING provider in this module, so
    // no new import and no cycle. The dependency runs one way only:
    // FundingOpportunitiesService knows nothing about forecasts, which is what
    // keeps a forecast from ever being served as a `FundingOpportunity`.
    ForecastOpportunityReadService,
    // P28. Depends only on PrismaService. Reads the global
    // tango_opportunity_notice table and derives the timeline; it holds no
    // dependency through which an alert could be sent, which is how "P28 emits
    // nothing" is enforced rather than remembered.
    OpportunityTimelineService,
    // P31. Reads the GLOBAL requirement table under withSystem and THIS
    // tenant's review rows under withTenant — the split that keeps one team's
    // decision off a row every tenant can see.
    OpportunityRequirementService,
    ClientProfileEnrichmentService,
    // P21. Depends on PrismaService, TangoStoreService (both already
    // resolvable here — see the note above) and ClientProfileEnrichmentService
    // (a sibling provider in this SAME module) — no new import needed.
    FederalBusinessProfileService,
    FundingOpportunitiesFlagGuard,
    FundingOpportunitiesInboxFlagGuard,
    FundingOpportunitiesForecastFlagGuard,
    FundingOpportunitiesNoticeHistoryFlagGuard,
    FundingOpportunitiesDocumentsFlagGuard,
  ],
  exports: [FundingOpportunitiesService, ClientProfileEnrichmentService, FederalBusinessProfileService],
})
export class FundingOpportunitiesModule {}
