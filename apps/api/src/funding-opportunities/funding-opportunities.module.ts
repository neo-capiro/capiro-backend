import { Module } from '@nestjs/common';
import { FundingOpportunitiesController } from './funding-opportunities.controller.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { FundingOpportunitiesFlagGuard } from './funding-opportunities-flag.guard.js';

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
 */
@Module({
  controllers: [FundingOpportunitiesController],
  providers: [FundingOpportunitiesService, FundingOpportunitiesFlagGuard],
  exports: [FundingOpportunitiesService],
})
export class FundingOpportunitiesModule {}
