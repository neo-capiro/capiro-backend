import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

/**
 * Thin wrapper around the Stripe SDK (ported from apps/api — onboard-api is
 * now the SINGLE Stripe writer platform-wide). Constructs a single client
 * from STRIPE_SECRET_KEY.
 *
 * Fail-soft: when the key is unset the client is null and {@link enabled} is
 * false — callers either skip work (webhook, overage job) or surface a clean
 * 503 via {@link require}, so the service boots everywhere.
 *
 * We intentionally do NOT pin `apiVersion` in code: the installed SDK's typed
 * default tracks the account's dashboard API version, which avoids a literal
 * type mismatch on upgrade and keeps a single source of truth in the Stripe
 * dashboard.
 */
@Injectable()
export class StripeClient {
  private readonly logger = new Logger(StripeClient.name);
  readonly client: Stripe | null;

  constructor(config: ConfigService) {
    const key = config.get<string>('STRIPE_SECRET_KEY');
    if (!key) {
      this.logger.warn(
        'STRIPE_SECRET_KEY is unset — billing is INACTIVE (checkout/portal/overage no-op until configured).',
      );
      this.client = null;
      return;
    }
    this.client = new Stripe(key, {
      appInfo: { name: 'Capiro', url: 'https://capiro.ai' },
      maxNetworkRetries: 2,
    });
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Returns the client or throws a clean 503 when billing isn't configured. */
  require(): Stripe {
    if (!this.client) {
      throw new ServiceUnavailableException('Billing is not configured on this environment.');
    }
    return this.client;
  }
}
