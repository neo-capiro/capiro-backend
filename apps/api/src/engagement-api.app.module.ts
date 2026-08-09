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
import { EngagementIntegrationActionsModule } from './engagement-integrations/engagement-integration-actions.module.js';
import { EngagementCallbacksModule } from './engagement-callbacks/engagement-callbacks.module.js';
import { EngagementWorkersModule } from './engagement-workers/engagement-workers.module.js';
import { RecallWebhookModule } from './webhooks/recall-webhook.module.js';
import { CapabilitiesModule } from './capabilities/capabilities.module.js';
import { OutreachV3StateModule } from './outreach-v3/api/outreach-v3-state.module.js';
import { OutreachV3TargetsModule } from './outreach-v3/targets/outreach-v3-targets.module.js';
import { OutreachV3ReasoningModule } from './outreach-v3/reasoning/outreach-v3-reasoning.module.js';
import { EngagementRuntimeGuard } from './engagement/runtime/engagement-runtime.guard.js';
import { EngagementApiHealthController } from './engagement-api/engagement-api-health.controller.js';

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
    EngagementIntegrationActionsModule,
    EngagementCallbacksModule,
    EngagementWorkersModule,
    RecallWebhookModule,
    CapabilitiesModule,
    OutreachV3StateModule,
    OutreachV3TargetsModule,
    OutreachV3ReasoningModule,
  ],
  controllers: [EngagementApiHealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: EngagementRuntimeGuard },
  ],
})
export class EngagementApiAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantContextMiddleware)
      .exclude(
        { path: 'health', method: RequestMethod.ALL },
        { path: 'webhooks/(.*)', method: RequestMethod.ALL },
        { path: '/api/engagement/integrations/microsoft/callback', method: RequestMethod.GET },
        { path: 'api/engagement/integrations/microsoft/callback', method: RequestMethod.GET },
        { path: '/api/engagement/integrations/microsoft/notifications', method: RequestMethod.ALL },
        { path: 'api/engagement/integrations/microsoft/notifications', method: RequestMethod.ALL },
        { path: '/api/engagement/integrations/google/callback', method: RequestMethod.GET },
        { path: 'api/engagement/integrations/google/callback', method: RequestMethod.GET },
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
