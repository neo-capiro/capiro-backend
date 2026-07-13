import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { configSchema } from './config/config.schema.js';
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
import { EngagementModule } from './engagement/engagement.module.js';
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
import { GovInfoModule } from './external/govinfo/govinfo.module.js';
import { ApiLatencyMiddleware } from './observability/api-latency.middleware.js';

@Module({
  imports: [
    ProgramElementModule,
    AcquisitionPersonnelModule,
    // GovInfoModule was defined but never imported — wired here so GovInfoService
    // is resolvable app-wide (the sync-hearing-transcripts verb needs it; safe/
    // additive — the service fails closed only when GOVINFO_API_KEY is used, not
    // at boot).
    GovInfoModule,
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => configSchema.parse(raw),
    }),
    // Per-IP rate limiting at the application edge. WAF already drops
    // sustained 2000 req/IP at the ALB; this is the second-layer defence
    // that catches accidental client loops and bot-net-style fan-out within
    // the WAF allowance. In-memory storage is per-task, which is fine while
    // we run with a small task count; swap to Redis once ElastiCache lands.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 30 }, // 30 req / sec / IP
      { name: 'long', ttl: 60_000, limit: 600 }, // 600 req / min / IP
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
    EngagementModule,
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
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Tenant context resolution runs on every authenticated route.
    // Webhooks and /health are explicitly excluded, they have no Clerk session.
    // The Microsoft OAuth callback is also excluded: Microsoft redirects the
    // user's browser to it as a top-level navigation, which doesn't carry the
    // Clerk bearer token. The callback authenticates via the HMAC-signed
    // `state` parameter (which encodes tenantId + connectionId) instead.
    consumer
      .apply(TenantContextMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'webhooks/(.*)', method: RequestMethod.ALL },
        { path: '/api/v1/demo-requests', method: RequestMethod.POST },
        { path: 'api/v1/demo-requests', method: RequestMethod.POST },
        {
          path: '/api/engagement/integrations/microsoft/callback',
          method: RequestMethod.GET,
        },
        {
          path: 'api/engagement/integrations/microsoft/callback',
          method: RequestMethod.GET,
        },
        {
          path: '/api/engagement/integrations/microsoft/notifications',
          method: RequestMethod.ALL,
        },
        {
          path: 'api/engagement/integrations/microsoft/notifications',
          method: RequestMethod.ALL,
        },
        // Google OAuth callback — top-level browser redirect from Google with
        // ?code&state and no Clerk session; authenticates via the HMAC-signed
        // `state`, same as the Microsoft callback above.
        {
          path: '/api/engagement/integrations/google/callback',
          method: RequestMethod.GET,
        },
        {
          path: 'api/engagement/integrations/google/callback',
          method: RequestMethod.GET,
        },
        {
          path: '/api/clio/runtime/(.*)',
          method: RequestMethod.ALL,
        },
        {
          path: 'api/clio/runtime/(.*)',
          method: RequestMethod.ALL,
        },
        // MCP connector OAuth callback (connector-library v1) — a top-level
        // browser redirect from the external OAuth provider with ?code&state and
        // no Clerk session. Authenticates via the HMAC-signed `state`
        // (MeriMcpOAuthService.verifyState), same pattern as the Microsoft
        // callback above.
        {
          path: '/api/clio/mcp-oauth/callback',
          method: RequestMethod.GET,
        },
        {
          path: 'api/clio/mcp-oauth/callback',
          method: RequestMethod.GET,
        },
        // Public marketing endpoint (capiro.ai Insights page) — no Clerk session.
        { path: '/api/insights', method: RequestMethod.GET },
        { path: 'api/insights', method: RequestMethod.GET },
        // Internal service-to-service endpoints (BYOK3: intel-api resolves a
        // tenant AI credential for live-hearing extraction). Authenticated by
        // InternalServiceGuard (shared INTERNAL_SERVICE_SECRET header), NOT a
        // Clerk session — the caller sends no Bearer, so TenantContextMiddleware
        // MUST be excluded or it 401s before the guard runs (the endpoint reads
        // tenantId from the body, never from req.tenantContext).
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
