import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { StripeClient } from './stripe.client.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

/**
 * Stripe webhook receiver. Endpoint registered in the Stripe dashboard:
 *   https://app.capiro.ai/onboard-api/webhooks/stripe
 * (path chosen so the existing ALB `/webhooks/*`→apps/api rule is untouched —
 * `/onboard-api/*` routes here).
 *
 * Signature verification uses the Stripe SDK against STRIPE_WEBHOOK_SECRET.
 * The raw body is required; main.ts mounts `express.raw()` on this exact path.
 * When billing is not configured on the env, deliveries are accepted and
 * ignored (204) so probes never error.
 */
@Controller('webhooks/stripe')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private readonly secret?: string;

  constructor(
    config: ConfigService,
    private readonly stripe: StripeClient,
    private readonly service: StripeWebhookService,
  ) {
    this.secret = config.get<string>('STRIPE_WEBHOOK_SECRET') || undefined;
  }

  @Post()
  @HttpCode(204)
  async receive(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<void> {
    if (!this.stripe.enabled || !this.secret) {
      this.logger.warn('Received Stripe webhook but billing is not configured — ignoring.');
      return;
    }
    if (!signature) throw new BadRequestException('Missing stripe-signature header');

    // main.ts mounts raw() on this path, so req.body is a Buffer.
    const raw = (req as unknown as { body: Buffer }).body;
    if (!Buffer.isBuffer(raw)) throw new BadRequestException('Expected raw body');

    let event: Stripe.Event;
    try {
      event = this.stripe.require().webhooks.constructEvent(raw, signature, this.secret);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    await this.service.handle(event);
  }
}
