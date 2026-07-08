import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ClerkWebhookController } from './clerk-webhook.controller.js';
import { ClerkWebhookService } from './clerk-webhook.service.js';
import { RecallWebhookController } from './recall-webhook.controller.js';

@Module({
  // EngagementModule exports NotetakerService (used by the Recall webhook receiver).
  imports: [EngagementModule],
  controllers: [ClerkWebhookController, RecallWebhookController],
  providers: [ClerkWebhookService],
})
export class WebhooksModule {}
