import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { RecallWebhookController } from './recall-webhook.controller.js';

/** Recall is registered independently from general webhooks and fails closed by owner policy. */
@Module({
  imports: [EngagementModule],
  controllers: [RecallWebhookController],
})
export class RecallWebhookModule {}
