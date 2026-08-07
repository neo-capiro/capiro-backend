import { Module } from '@nestjs/common';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { FundingOpportunityActionsService } from './funding-opportunity-actions.service.js';
import { FundingOpportunityInboxService } from './funding-opportunity-inbox.service.js';
import { ForecastOpportunityReadService } from './forecast-opportunity-read.service.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';
import { ClientProfileEnrichmentService } from './client-profile-enrichment.service.js';
import { FederalBusinessProfileService } from './federal-business-profile.service.js';
import { MeriOpportunityToolsAdapter } from './meri-opportunity-tools.adapter.js';
import { MeriOpportunityAssessmentService } from './meri-opportunity-assessment.service.js';
import { OpportunityBudgetContextService } from './opportunity-budget-context.service.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesForecastFlagGuard,
  FundingOpportunitiesInboxFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesLandscapeFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
  FundingOpportunitiesPipelineFlagGuard,
  FundingOpportunitiesMeriFlagGuard,
  FundingOpportunitiesBudgetFlagGuard,
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
    // P33. Depends only on PrismaService, and CONSUMES the PE, facility and
    // notice reads rather than duplicating them — the plan's own "consume, do
    // not duplicate" line for program-element and client data.
    GovernmentLandscapeService,
    // P35. Depends only on PrismaService. Writes BOTH pipeline_stage and the
    // legacy workflow_status in one statement, so an older reader stays correct.
    FundingOpportunityPipelineService,
    ClientProfileEnrichmentService,
    // P21. Depends on PrismaService, TangoStoreService (both already
    // resolvable here — see the note above) and ClientProfileEnrichmentService
    // (a sibling provider in this SAME module) — no new import needed.
    FederalBusinessProfileService,
    // P37. Depends on PrismaService and two SIBLING providers in this module —
    // no new import, and deliberately no dependency on Meri. MeriModule imports
    // THIS module to reach the adapter; the reverse would be a cycle, since
    // MeriModule already imports eleven feature modules. See the adapter's own
    // docblock, and meri-opportunity-tools.spec.ts, which asserts the import
    // graph rather than trusting the comment.
    MeriOpportunityToolsAdapter,
    // P38. Depends on PrismaService, ConfigService and three SIBLING providers.
    // Its context-compiler, claim-writer and audit collaborators are NOT
    // constructor parameters: two of the three live in MeriModule, and taking
    // them here would be the cycle this module refuses. MeriModule — which
    // already imports this one — injects them at bootstrap through
    // `withCollaborators`. All three are audit surfaces; none can change what
    // the assessment says, which is what makes their absence degrade to a
    // stated `compilerVersion: null` rather than a wrong answer.
    MeriOpportunityAssessmentService,
    // P44. Depends only on PrismaService. Reads two GLOBAL provider tables and
    // the client's own uei; it holds no writer for anything, which is how
    // "cannot overwrite Capiro budget values" is enforced rather than promised.
    OpportunityBudgetContextService,
    FundingOpportunitiesFlagGuard,
    FundingOpportunitiesInboxFlagGuard,
    FundingOpportunitiesForecastFlagGuard,
    FundingOpportunitiesNoticeHistoryFlagGuard,
    FundingOpportunitiesDocumentsFlagGuard,
    FundingOpportunitiesLandscapeFlagGuard,
    FundingOpportunitiesPipelineFlagGuard,
    FundingOpportunitiesMeriFlagGuard,
    FundingOpportunitiesBudgetFlagGuard,
  ],
  exports: [
    FundingOpportunitiesService,
    ClientProfileEnrichmentService,
    FederalBusinessProfileService,
    MeriOpportunityToolsAdapter,
    MeriOpportunityAssessmentService,
    OpportunityBudgetContextService,
  ],
})
export class FundingOpportunitiesModule {}
