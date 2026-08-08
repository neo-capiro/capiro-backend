import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ClerkWebhookController } from './clerk-webhook.controller.js';
import { ClerkWebhookService } from './clerk-webhook.service.js';
import { RecallWebhookController } from './recall-webhook.controller.js';
import { TangoWebhookController } from './tango-webhook.controller.js';
import { TangoWebhookService } from './tango-webhook.service.js';

@Module({
  // EngagementModule exports NotetakerService (used by the Recall webhook receiver).
  // TangoWebhookService needs only PrismaService and ConfigService, both global.
  imports: [EngagementModule],
  controllers: [ClerkWebhookController, RecallWebhookController, TangoWebhookController],
  providers: [ClerkWebhookService, TangoWebhookService],
})
export class WebhooksModule {}
