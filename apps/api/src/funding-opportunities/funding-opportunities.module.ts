import { Module } from '@nestjs/common';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunityAcquisitionPositionService } from './funding-opportunity-acquisition-position.service.js';
import { FundingOpportunityClientAccessGuard } from './funding-opportunity-client-access.guard.js';
import { OpportunityTimelineService } from './opportunity-timeline.service.js';
import { OpportunityRequirementService } from './requirements/opportunity-requirement.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { FundingOpportunityPipelineService } from './funding-opportunity-pipeline.js';
import { ClientProfileEnrichmentService } from './client-profile-enrichment.service.js';
import { FederalBusinessProfileService } from './federal-business-profile.service.js';
import { MeriOpportunityToolsAdapter } from './meri-opportunity-tools.adapter.js';
import { MeriOpportunityAssessmentService } from './meri-opportunity-assessment.service.js';
import { OpportunityBudgetContextService } from './opportunity-budget-context.service.js';
import { OpportunityRiskService } from './opportunity-risk.service.js';
import { FundingOpportunityOutcomeService } from './funding-opportunity-outcome.service.js';
import { FundingOpportunityV2SearchController } from './funding-opportunity-v2-search.controller.js';
import {
  createOpportunityClientProfileReader,
  createPrismaOpportunityCatalogAdapters,
  FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
  FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
  FundingOpportunityV2SearchService,
} from './funding-opportunity-v2-search.service.js';
import { CaliforniaGrantSourceReader } from './california-grant-source-reader.js';
import { FundingOpportunitySavedSearchController } from './funding-opportunity-saved-search.controller.js';
import { FundingOpportunitySavedSearchService, SAVED_SEARCH_APPLY_EXECUTOR } from './funding-opportunity-saved-search.service.js';
import { FundingOpportunityV2DetailController } from './funding-opportunity-v2-detail.controller.js';
import { FundingOpportunityV2DetailService } from './funding-opportunity-v2-detail.service.js';
import { FundingOpportunityV2WorkflowController } from './funding-opportunity-v2-workflow.controller.js';
import { FundingOpportunityV2WorkflowService } from './funding-opportunity-v2-workflow.service.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryModule } from '../memory/memory.module.js';
import {
  FundingOpportunitiesFlagGuard,
  FundingOpportunitiesDocumentsFlagGuard,
  FundingOpportunitiesLandscapeFlagGuard,
  FundingOpportunitiesNoticeHistoryFlagGuard,
  FundingOpportunitiesPipelineFlagGuard,
  FundingOpportunitiesMeriFlagGuard,
  FundingOpportunitiesBudgetFlagGuard,
  FundingOpportunitiesRiskFlagGuard,
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
 *
 * `MemoryModule` (P36) is the SECOND exception, and a real import rather than
 * a global resolution: `FundingOpportunityOutcomeService` needs
 * `MemoryCandidateService` directly at request time, and unlike P37/P38's
 * audit collaborators there is no "MeriModule already imports this module, so
 * hand it over at bootstrap" path available — this controller's own route
 * calls it synchronously. Verified no-cycle before adding it: `MemoryModule`
 * imports only `PrismaModule`/`TenantModule` and nothing under
 * `funding-opportunities/`.
 */
@Module({
  imports: [MemoryModule],
  // Keep static v2 routes ahead of the legacy `opportunities/:source/:id`
  // route so `/opportunities/v2/search` cannot be treated as a detail lookup.
  controllers: [FundingOpportunityV2SearchController, FundingOpportunityV2DetailController, FundingOpportunityV2WorkflowController, FundingOpportunitySavedSearchController, FundingOpportunitiesController],
  providers: [
    FundingOpportunityAcquisitionPositionService,
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
    // Funding tools depend on PrismaService and three SIBLING providers in this module —
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
    // P45. Depends only on PrismaService. Two GLOBAL provider tables and the
    // client's own uei; no writer, and nothing in it decides anything — an
    // active exclusion routes to review rather than resolving.
    OpportunityRiskService,
    // P36. Depends on PrismaService and MemoryCandidateService (imported via
    // MemoryModule above). Reuses the EXISTING outcome_event table — widened
    // CHECKs only, no new table — and calls the memory candidate service as a
    // fail-open audit surface: a proposal failure never loses the outcome
    // record already committed ahead of it.
    FundingOpportunityOutcomeService,
    FundingOpportunityV2SearchService,
    FundingOpportunityV2DetailService,
    FundingOpportunityV2WorkflowService,
    FundingOpportunityV2DecoratorService,
    CaliforniaGrantSourceReader,
    FundingOpportunitySavedSearchService,
    {
      provide: FUNDING_OPPORTUNITY_V2_CATALOG_ADAPTERS,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => createPrismaOpportunityCatalogAdapters(prisma),
    },
    {
      provide: FUNDING_OPPORTUNITY_V2_CLIENT_PROFILE_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => createOpportunityClientProfileReader(prisma),
    },
    {
      provide: SAVED_SEARCH_APPLY_EXECUTOR,
      inject: [FundingOpportunityV2SearchService],
      useFactory: (search: FundingOpportunityV2SearchService) =>
        (ctx: { tenantId: string; userId: string }, criteria: Parameters<FundingOpportunityV2SearchService['search']>[1]) =>
          search.search(ctx, criteria),
    },
    FundingOpportunitiesFlagGuard,
    FundingOpportunityClientAccessGuard,
    FundingOpportunitiesNoticeHistoryFlagGuard,
    FundingOpportunitiesDocumentsFlagGuard,
    FundingOpportunitiesLandscapeFlagGuard,
    FundingOpportunitiesPipelineFlagGuard,
    FundingOpportunitiesMeriFlagGuard,
    FundingOpportunitiesBudgetFlagGuard,
    FundingOpportunitiesRiskFlagGuard,
  ],
  exports: [
    FundingOpportunityAcquisitionPositionService,
    FundingOpportunityV2SearchService,
    FundingOpportunityV2DetailService,
    ClientProfileEnrichmentService,
    FederalBusinessProfileService,
    MeriOpportunityToolsAdapter,
    MeriOpportunityAssessmentService,
    OpportunityBudgetContextService,
    OpportunityRiskService,
    FundingOpportunityOutcomeService,
  ],
})
export class FundingOpportunitiesModule {}
