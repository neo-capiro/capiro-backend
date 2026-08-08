import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  TANGO_DELIVERY_HEADER,
  TANGO_SIGNATURE_HEADER,
  TANGO_TIMESTAMP_HEADER,
  type TangoWebhookRejection,
  TangoWebhookService,
} from './tango-webhook.service.js';

/**
 * MakeGov/Tango webhook receiver — Funding Opportunities P46.
 *
 * Endpoint (NOT yet registered with the provider — P46 ships dark, and
 * registering the endpoint is P50's operator step):
 *   https://api.<env>.capiro.ai/webhooks/tango
 *
 * ── Why this route needs no tenant, and must not have one ────────────────────
 *
 * `app.module.ts` already excludes `webhooks/(.*)` from TenantContextMiddleware,
 * so this handler runs with no tenant context — which is correct, because a
 * provider webhook carries no Capiro session and no tenant. Deriving a tenant
 * from an inbound payload would be inventing one from data the provider
 * controls. Tenant fan-out happens in P48, after P47 has resolved a delivery to
 * real local rows.
 *
 * ── Raw bytes ────────────────────────────────────────────────────────────────
 *
 * `configure-api-http-app.ts` mounts express `raw()` on this exact path, ahead
 * of the global JSON parser, so `req.body` is the precise byte sequence the
 * provider signed. Re-serializing parsed JSON would change key order and
 * whitespace and break every signature.
 *
 * ── Status codes are the retry contract ──────────────────────────────────────
 *
 * At-least-once senders retry on 5xx and give up on 4xx, so these are chosen to
 * make the provider do the right thing:
 *
 *   202  recorded            — durable, will be drained by P47. Stop retrying.
 *   200  duplicate           — already durable. Stop retrying.
 *   401  signature failures  — will never succeed as sent. Stop retrying.
 *   400  malformed / stale   — will never succeed as sent. Stop retrying.
 *   503  not configured, or persistence failed — NOT recorded. Please retry.
 *
 * The 503 cases are the important ones: P46's acceptance requires that a
 * database failure "does not acknowledge unrecorded delivery". Answering 2xx
 * after a failed write would silently drop a real event forever.
 */
@Controller('webhooks/tango')
export class TangoWebhookController {
  constructor(private readonly service: TangoWebhookService) {}

  @Post()
  @HttpCode(202)
  async receive(
    @Req() req: Request,
    @Headers(TANGO_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(TANGO_TIMESTAMP_HEADER) timestamp: string | undefined,
    @Headers(TANGO_DELIVERY_HEADER) deliveryId: string | undefined,
  ): Promise<{ status: 'recorded' | 'duplicate' }> {
    // After the raw() mount for this path, req.body is a Buffer.
    const rawBody = (req as unknown as { body?: unknown }).body;

    let outcome;
    try {
      outcome = await this.service.receive(Buffer.isBuffer(rawBody) ? rawBody : undefined, {
        signature,
        timestamp,
        deliveryId,
      });
    } catch {
      // Persistence failed. The delivery is NOT recorded, so it must be re-sent.
      // The underlying error is logged inside the service; it is not echoed to
      // the caller, which would leak schema detail to an authenticated-but-
      // untrusted sender.
      throw new ServiceUnavailableException('Delivery not recorded; retry');
    }

    if (outcome.kind === 'recorded') return { status: 'recorded' };
    if (outcome.kind === 'duplicate') return { status: 'duplicate' };

    throw rejectionToHttp(outcome.rejection);
  }
}

/**
 * Map a rejection class to its HTTP answer.
 *
 * Every message here is a fixed string. None names the expected digest, the
 * supplied digest, the secret, or any payload content — a caller must not be
 * able to distinguish "your HMAC was two bytes off" from "your HMAC was
 * nonsense", because that difference is an oracle for forging one.
 */
function rejectionToHttp(rejection: TangoWebhookRejection): Error {
  switch (rejection) {
    case 'not_configured':
      // Honest and retryable: the receiver is dark, not the sender's fault.
      return new ServiceUnavailableException('Webhook receiver not configured');

    case 'missing_signature':
    case 'malformed_signature':
    case 'invalid_signature':
      return new UnauthorizedException('Invalid webhook signature');

    case 'missing_body':
      return new BadRequestException('Expected raw body');
    case 'malformed_json':
      return new BadRequestException('Malformed JSON payload');
    case 'missing_delivery_id':
      return new BadRequestException('Missing delivery id');
    case 'missing_event_type':
      return new BadRequestException('Missing event type');
    case 'stale_timestamp':
      return new BadRequestException('Delivery outside replay window');
  }
}
