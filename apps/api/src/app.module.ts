import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateConfig } from './config/config.schema.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { TenantContextMiddleware } from './tenant/tenant-context.middleware.js';
import { UsersModule } from './users/users.module.js';
import { HealthController } from './health/health.controller.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { CapiroAdminModule } from './capiro-admin/capiro-admin.module.js';
import { TenantAdminModule } from './tenant-admin/tenant-admin.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { HelpModule } from './help/help.module.js';
import { DirectoryModule } from './directory/directory.module.js';
import { DistrictNexusModule } from './district-nexus/district-nexus.module.js';
import { FundingOpportunitiesModule } from './funding-opportunities/funding-opportunities.module.js';
import { EngagementModule } from './engagement/engagement.module.js';
import { CapabilitiesModule } from './capabilities/capabilities.module.js';
import { DemoRequestsModule } from './demo-requests/demo-requests.module.js';
import { MeriModule } from './meri/meri.module.js';
import { LobbyIntelModule } from './lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from './federal-spending/federal-spending.module.js';
import { LdaIntelModule } from './lda-intel/lda-intel.module.js';
import { FederalRegisterModule } from './federal-register/federal-register.module.js';
import { RegulatoryDocketModule } from './regulatory-docket/regulatory-docket.module.js';
import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { AlertMemoModule } from './intelligence/alert-memo/alert-memo.module.js';
import { DistrictBriefModule } from './intelligence/alert-memo/district-brief.module.js';
import { ChokepointModule } from './intelligence/chokepoint/chokepoint.module.js';
import { AgenticModule } from './agentic/agentic.module.js';
import { TrackerModule } from './tracker/tracker.module.js';
import { WorkspaceCollabModule } from './workspace-collab/workspace-collab.module.js';
import { WorkspaceAssistantModule } from './workspace-assistant/workspace-assistant.module.js';
import { WorkspaceTableModule } from './workspace-table/workspace-table.module.js';
import { ExplorerModule } from './explorer/explorer.module.js';
import { SearchModule } from './search/search.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { ProgramElementModule } from './program-element/program-element.module.js';
import { AcquisitionPersonnelModule } from './acquisition-personnel/acquisition-personnel.module.js';
import { AiUsageModule } from './ai-usage/ai-usage.module.js';
import { BillingModule } from './billing/billing.module.js';
import { MemoryModule } from './memory/memory.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { InternalOnboardingModule } from './internal-onboarding/internal-onboarding.module.js';
import { BudgetPackagesModule } from './budget-packages/budget-packages.module.js';
import { GovInfoModule } from './external/govinfo/govinfo.module.js';
import { TangoModule } from './external/tango/tango.module.js';
import { ApiLatencyMiddleware } from './observability/api-latency.middleware.js';

@Module({
  imports: [
    ProgramElementModule,
    AcquisitionPersonnelModule,
    GovInfoModule,
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => validateConfig(raw as Record<string, unknown>),
    }),
    TangoModule,
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 30 },
      { name: 'long', ttl: 60_000, limit: 600 },
    ]),
    PrismaModule,
    AuthModule,
    TenantModule,
    UsersModule,
    WebhooksModule,
    CapiroAdminModule,
    TenantAdminModule,
    ClientsModule,
    BrandingModule,
    DirectoryModule,
    DistrictNexusModule,
    FundingOpportunitiesModule,
    EngagementModule,
    CapabilitiesModule,
    DemoRequestsModule,
    MeriModule,
    LobbyIntelModule,
    FederalSpendingModule,
    LdaIntelModule,
    FederalRegisterModule,
    RegulatoryDocketModule,
    IntelligenceModule,
    AlertMemoModule,
    DistrictBriefModule,
    ChokepointModule,
    AgenticModule,
    TrackerModule,
    WorkspaceCollabModule,
    WorkspaceAssistantModule,
    WorkspaceTableModule,
    ExplorerModule,
    SearchModule,
    InsightsModule,
    HelpModule,
    AiUsageModule,
    BillingModule,
    MemoryModule,
    ReviewsModule,
    InternalOnboardingModule,
    BudgetPackagesModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantContextMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'webhooks/(.*)', method: RequestMethod.ALL },
        { path: '/api/v1/demo-requests', method: RequestMethod.POST },
        { path: 'api/v1/demo-requests', method: RequestMethod.POST },
        { path: '/api/engagement/integrations/microsoft/callback', method: RequestMethod.GET },
        { path: 'api/engagement/integrations/microsoft/callback', method: RequestMethod.GET },
        { path: '/api/engagement/integrations/microsoft/notifications', method: RequestMethod.ALL },
        { path: 'api/engagement/integrations/microsoft/notifications', method: RequestMethod.ALL },
        { path: '/api/engagement/integrations/google/callback', method: RequestMethod.GET },
        { path: 'api/engagement/integrations/google/callback', method: RequestMethod.GET },
        { path: '/api/clio/runtime/(.*)', method: RequestMethod.ALL },
        { path: 'api/clio/runtime/(.*)', method: RequestMethod.ALL },
        { path: '/api/clio/mcp-oauth/callback', method: RequestMethod.GET },
        { path: 'api/clio/mcp-oauth/callback', method: RequestMethod.GET },
        { path: '/api/insights', method: RequestMethod.GET },
        { path: 'api/insights', method: RequestMethod.GET },
        { path: '/api/internal/(.*)', method: RequestMethod.ALL },
        { path: 'api/internal/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes('*');

    consumer
      .apply(ApiLatencyMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'webhooks/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes('*');
  }
}
