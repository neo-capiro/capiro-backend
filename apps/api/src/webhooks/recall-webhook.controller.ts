import { BadRequestException, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotetakerService } from '../engagement/notetaker/notetaker.service.js';

/**
 * Recall.ai webhook receiver — docs/plans/meeting-notetaker-bot-plan.md (Phase 1).
 * Endpoint registered in the Recall dashboard: https://app.capiro.ai/webhooks/recall
 *
 * Signature verification (svix) + event normalization + async processing all live
 * in NotetakerService.receiveWebhook (which delegates verification to RecallProvider).
 *
 * main.ts mounts the express `raw()` body parser on `/webhooks/recall` (next to the
 * Clerk mount) so `req.body` is the exact bytes svix signed; the tenant-context
 * middleware skips `webhooks/(.*)` (app.module exclude). Fail-closed: until
 * RECALL_WEBHOOK_SECRET is configured, every delivery is rejected unverified.
 */
@Controller('webhooks/recall')
export class RecallWebhookController {
  constructor(private readonly notetaker: NotetakerService) {}

  @Post()
  @HttpCode(204)
  receive(
    @Req() req: Request,
    @Headers('webhook-id') webhookId: string | undefined,
    @Headers('webhook-timestamp') webhookTimestamp: string | undefined,
    @Headers('webhook-signature') webhookSignature: string | undefined,
    @Headers('svix-id') svixId: string | undefined,
    @Headers('svix-timestamp') svixTimestamp: string | undefined,
    @Headers('svix-signature') svixSignature: string | undefined,
  ): void {
    // After main.ts mounts raw() for this path, req.body is a Buffer.
    const raw = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(raw)) {
      throw new BadRequestException('Expected raw body');
    }
    // Verifies the signature (throws 4xx on failure) then processes out of band,
    // returning a fast 204 per Recall's retry model.
    this.notetaker.receiveWebhook(
      {
        'webhook-id': webhookId,
        'webhook-timestamp': webhookTimestamp,
        'webhook-signature': webhookSignature,
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      },
      raw,
    );
  }
}
