import { Module } from '@nestjs/common';
import { ClerkWebhookController } from './clerk-webhook.controller.js';
import { ClerkWebhookService } from './clerk-webhook.service.js';
import { TangoWebhookController } from './tango-webhook.controller.js';
import { TangoWebhookService } from './tango-webhook.service.js';

/** General webhooks; Recall has its own independently composable module. */
@Module({
  controllers: [ClerkWebhookController, TangoWebhookController],
  providers: [ClerkWebhookService, TangoWebhookService],
})
export class WebhooksModule {}
