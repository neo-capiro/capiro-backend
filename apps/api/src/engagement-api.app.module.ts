import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEngagementApiConfig } from './engagement-api/engagement-api-config.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { TenantContextMiddleware } from './tenant/tenant-context.middleware.js';
import { ApiLatencyMiddleware } from './observability/api-latency.middleware.js';
import { EngagementModule } from './engagement/engagement.module.js';
import { EngagementRuntimeGuard } from './engagement/runtime/engagement-runtime.guard.js';
import { EngagementApiHealthController } from './engagement-api/engagement-api-health.controller.js';

/**
 * Engagement API — second NestJS application module.
 *
 * Phase 1: runs as a shadow clone of the Engagement backend on port 4500.
 * It does NOT import AppModule, WebhooksModule, or any main-only module.
 *
 * The Engagement controllers (EngagementController, MicrosoftOAuthController,
 * GoogleOAuthController, InternalAiCredentialsController, OutcomeController)
 * arrive through EngagementModule.
 *
 * The only controller registered directly here is EngagementApiHealthController.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => validateEngagementApiConfig(raw as Record<string, unknown>),
    }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 30 },
      { name: 'long', ttl: 60_000, limit: 600 },
    ]),
    PrismaModule,
    AuthModule,
    TenantModule,
    EngagementModule,
  ],
  controllers: [EngagementApiHealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: EngagementRuntimeGuard },
  ],
})
export class EngagementApiAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Tenant context resolution — same exclusions as AppModule, but only the
    // subset relevant to this app (no Clio MCP, no demo-requests, no insights).
    consumer
      .apply(TenantContextMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'webhooks/(.*)', method: RequestMethod.ALL },
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
        {
          path: '/api/engagement/integrations/google/callback',
          method: RequestMethod.GET,
        },
        {
          path: 'api/engagement/integrations/google/callback',
          method: RequestMethod.GET,
        },
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
