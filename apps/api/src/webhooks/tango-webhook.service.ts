import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * MakeGov/Tango webhook receiver — Funding Opportunities P46.
 *
 * ── What this service is allowed to do ───────────────────────────────────────
 *
 * Verify bytes, and record that they arrived. That is the entire mandate.
 *
 * It makes NO product decision. It does not touch a source table, compute a
 * recommendation, raise an alert, write a workflow row, or call Meri — all of
 * which P46 lists explicitly as out of scope for the request path. The
 * reconciler (P47) drains this table out of band, dry-run first.
 *
 * ── Fail closed, always ──────────────────────────────────────────────────────
 *
 * With no signing secret configured, EVERY delivery is rejected unverified —
 * the same posture the Recall receiver takes. This is what "deploy the receiver
 * dark" means in practice: the route exists, and until an operator provisions
 * `TANGO_WEBHOOK_SIGNING_SECRET` it cannot accept anything. There is no
 * development-mode bypass and no internal-tenant fallback, matching this
 * program's rule that no flag has an implicit fallback.
 *
 * ── Order of operations is a security property, not a style choice ───────────
 *
 * Signature is verified against the RAW BYTES before `JSON.parse` is ever
 * called. §4.6 of the plan requires exactly this ("webhook raw bytes are
 * verified before JSON trust"), and it matters: parsing first would expose the
 * JSON parser to unauthenticated input and would let an attacker probe
 * behaviour through parse-error differences.
 *
 * ── The secret never leaves this file's HMAC call ────────────────────────────
 *
 * No log line, error message, or thrown exception in this module interpolates
 * the secret, the expected digest, or the supplied digest. A rejection says
 * which CLASS of check failed and nothing more — telling a caller how close
 * their forgery was is an oracle.
 */

/** Header carrying the provider's HMAC, formatted `sha256=<lowercase hex>`. */
export const TANGO_SIGNATURE_HEADER = 'x-tango-signature';
/** Optional header carrying the provider's send time, used for the replay window. */
export const TANGO_TIMESTAMP_HEADER = 'x-tango-timestamp';
/** Optional header carrying the provider's delivery id. */
export const TANGO_DELIVERY_HEADER = 'x-tango-delivery-id';

const SIGNATURE_PREFIX = 'sha256=';
/** A SHA-256 digest is always 32 bytes / 64 lowercase hex characters. */
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Why a delivery was refused. Deliberately coarse: these map to HTTP status
 * classes and to metrics, never to a message that helps an attacker iterate.
 */
export type TangoWebhookRejection =
  | 'not_configured'
  | 'missing_body'
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_signature'
  | 'malformed_json'
  | 'missing_delivery_id'
  | 'missing_event_type'
  | 'stale_timestamp';

export type TangoSignatureResult = { ok: true } | { ok: false; rejection: TangoWebhookRejection };

/**
 * Constant-time HMAC-SHA256 verification over the exact received bytes.
 *
 * Pure and exported so the spec can hammer it directly without an HTTP layer.
 *
 * `timingSafeEqual` throws when its two buffers differ in length, so the hex
 * shape is validated first and the decoded length is re-checked. Both of those
 * are checks on the ATTACKER-SUPPLIED value's format, which carries no
 * information about the secret, so short-circuiting there leaks nothing. The
 * only comparison that could leak — digest against digest — is constant-time.
 */
export function verifyTangoSignature(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string,
): TangoSignatureResult {
  if (!secret) return { ok: false, rejection: 'not_configured' };
  if (headerValue === undefined || headerValue.trim() === '') {
    return { ok: false, rejection: 'missing_signature' };
  }

  const trimmed = headerValue.trim();
  if (!trimmed.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, rejection: 'malformed_signature' };
  }

  const suppliedHex = trimmed.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!HEX_DIGEST_PATTERN.test(suppliedHex)) {
    return { ok: false, rejection: 'malformed_signature' };
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  if (supplied.length !== expected.length) {
    return { ok: false, rejection: 'malformed_signature' };
  }

  return timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, rejection: 'invalid_signature' };
}

/**
 * Replay-window check over the provider's send time.
 *
 * P46 says to add this "if the payload contract supports them", so it is
 * CONDITIONAL: a delivery with no timestamp header is not rejected. A missing
 * timestamp is missing evidence, not stale evidence, and refusing it would
 * break the receiver outright if the provider turns out not to send one.
 *
 * This is defence in depth only. The real replay guarantee is the unique index
 * on `delivery_id` — a window cannot stop a replay inside the window, and the
 * unique index stops replays regardless of clock skew.
 *
 * Skew is allowed in BOTH directions: a provider clock running slightly fast
 * would otherwise have every delivery rejected as "from the future".
 */
export function isWithinReplayWindow(
  headerValue: string | undefined,
  windowSeconds: number,
  now: Date,
): { ok: true; providerEventAt: Date | null } | { ok: false; rejection: 'stale_timestamp' } {
  if (headerValue === undefined || headerValue.trim() === '') {
    return { ok: true, providerEventAt: null };
  }

  const parsed = parseProviderTimestamp(headerValue.trim());
  // An unparseable timestamp is treated as absent rather than hostile: the
  // signature already authenticated it, so this is a contract mismatch with the
  // provider, and failing the delivery would lose an authenticated event over a
  // format disagreement.
  if (parsed === null) return { ok: true, providerEventAt: null };

  const skewMs = Math.abs(now.getTime() - parsed.getTime());
  if (skewMs > windowSeconds * 1000) return { ok: false, rejection: 'stale_timestamp' };

  return { ok: true, providerEventAt: parsed };
}

/** Accepts either epoch seconds or an ISO-8601 instant. */
function parseProviderTimestamp(value: string): Date | null {
  if (/^\d{1,15}$/.test(value)) {
    const asDate = new Date(Number(value) * 1000);
    return Number.isNaN(asDate.getTime()) ? null : asDate;
  }
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

/** Lowercase hex SHA-256 over the verified bytes. Matches the column CHECK. */
export function payloadDigest(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * The subset of an authenticated payload this phase reads.
 *
 * Everything here is optional in the parsed JSON and validated explicitly,
 * because "the signature verified" says the bytes came from the provider — it
 * says nothing about their SHAPE. An authenticated malformed payload is still
 * malformed.
 */
export interface TangoWebhookEnvelope {
  deliveryId: string;
  eventType: string;
  eventId: string | null;
  providerEventAt: Date | null;
}

export type TangoEnvelopeResult =
  | { ok: true; envelope: TangoWebhookEnvelope }
  | { ok: false; rejection: TangoWebhookRejection };

/**
 * Pull the envelope out of a verified payload, preferring headers over body.
 *
 * The header is preferred for the delivery id because it is the transport's own
 * identifier for THIS delivery, whereas a body field identifies the event —
 * and one event may be delivered more than once. Falling back to body fields
 * keeps the receiver working if the provider only carries them there.
 */
export function readEnvelope(
  payload: unknown,
  deliveryHeader: string | undefined,
  providerEventAt: Date | null,
): TangoEnvelopeResult {
  const envelope: Record<string, unknown> =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  // THE DELIVERY MAY BE A BATCH. The provider's own SDK models a sample
  // delivery as `{ timestamp, events: [...] }` — an ARRAY of events, not one
  // event at the top level (`WebhookSampleDelivery` in @makegov/tango-node).
  //
  // P46 originally read event fields from the top level only, which would have
  // rejected a real batch delivery as `missing_event_type`: authenticated,
  // recorded nowhere, and answered 400 so the provider would never retry it.
  // That is the worst possible failure for this receiver.
  //
  // So: if the body carries an `events` array, the FIRST event supplies the
  // envelope fields. The whole payload is still stored, so P47/P48 see every
  // event; this only decides which one names the delivery. Confirm the real
  // shape with `diag-tango-webhook-contract` before going live — the batch
  // form comes from the SDK's model, which is strong evidence but not a
  // live observation.
  const events = envelope.events;
  const firstEvent =
    Array.isArray(events) &&
    events.length > 0 &&
    typeof events[0] === 'object' &&
    events[0] !== null &&
    !Array.isArray(events[0])
      ? (events[0] as Record<string, unknown>)
      : null;

  // Top level wins when it states a field; the first event fills the gaps.
  const body: Record<string, unknown> = firstEvent
    ? { ...firstEvent, ...stripUndefined(envelope) }
    : envelope;

  const deliveryId = firstNonEmptyString([
    deliveryHeader,
    body.delivery_id,
    body.deliveryId,
    body.id,
  ]);
  if (deliveryId === null) return { ok: false, rejection: 'missing_delivery_id' };

  const eventType = firstNonEmptyString([body.event_type, body.eventType, body.event, body.type]);
  if (eventType === null) return { ok: false, rejection: 'missing_event_type' };

  const eventId = firstNonEmptyString([body.event_id, body.eventId]);

  const bodyTimestamp = firstNonEmptyString([
    body.occurred_at,
    body.occurredAt,
    body.timestamp,
    body.created_at,
  ]);
  const resolvedEventAt =
    providerEventAt ?? (bodyTimestamp === null ? null : parseProviderTimestamp(bodyTimestamp));

  return {
    ok: true,
    envelope: { deliveryId, eventType, eventId, providerEventAt: resolvedEventAt },
  };
}

/** Drop keys whose value is undefined, so a spread cannot blank a real value. */
function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && k !== 'events') out[k] = v;
  }
  return out;
}

function firstNonEmptyString(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

/** What the controller needs to know to answer. */
export type TangoWebhookOutcome =
  | { kind: 'recorded'; deliveryId: string }
  | { kind: 'duplicate'; deliveryId: string }
  | { kind: 'rejected'; rejection: TangoWebhookRejection };

@Injectable()
export class TangoWebhookService {
  private readonly logger = new Logger(TangoWebhookService.name);
  private readonly signingSecret: string;
  private readonly replayWindowSeconds: number;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    // Optional by design: absent secret means the receiver is dark, not broken.
    this.signingSecret = config.get('TANGO_WEBHOOK_SIGNING_SECRET', { infer: true }) ?? '';
    this.replayWindowSeconds = config.get('TANGO_WEBHOOK_REPLAY_WINDOW_SECONDS', { infer: true });
  }

  /** True when a signing secret is configured. Used only for diagnostics. */
  get isConfigured(): boolean {
    return this.signingSecret !== '';
  }

  /**
   * Verify and record one delivery.
   *
   * Throws ONLY on a persistence failure, so the controller can answer with a
   * retryable status. That distinction is the point of P46's acceptance rule
   * "a database failure returns a retryable response and does not acknowledge
   * unrecorded delivery": every other failure is the caller's fault and is
   * terminal, but a write that did not happen must be re-sent.
   */
  async receive(
    rawBody: Buffer | undefined,
    headers: {
      signature: string | undefined;
      timestamp: string | undefined;
      deliveryId: string | undefined;
    },
    now: Date = new Date(),
  ): Promise<TangoWebhookOutcome> {
    if (!this.signingSecret) {
      // Deliberately terse and rate-limit-friendly: an unconfigured receiver
      // that logs per-delivery detail is a log-flood target.
      this.logger.warn('Tango webhook rejected: no signing secret configured');
      return { kind: 'rejected', rejection: 'not_configured' };
    }

    if (!Buffer.isBuffer(rawBody)) {
      return { kind: 'rejected', rejection: 'missing_body' };
    }

    // ── 1. Signature, over raw bytes, BEFORE any parse. ──────────────────────
    const signature = verifyTangoSignature(rawBody, headers.signature, this.signingSecret);
    if (!signature.ok) {
      this.logger.warn(`Tango webhook rejected: ${signature.rejection}`);
      return { kind: 'rejected', rejection: signature.rejection };
    }

    // ── 2. Replay window (defence in depth; the unique index is the guarantee). ──
    const window = isWithinReplayWindow(headers.timestamp, this.replayWindowSeconds, now);
    if (!window.ok) {
      this.logger.warn(`Tango webhook rejected: ${window.rejection}`);
      return { kind: 'rejected', rejection: window.rejection };
    }

    // ── 3. Only now is the JSON trusted enough to parse. ─────────────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // The parse error itself is not logged: it can echo payload content.
      this.logger.warn('Tango webhook rejected: malformed_json');
      return { kind: 'rejected', rejection: 'malformed_json' };
    }

    const envelope = readEnvelope(parsed, headers.deliveryId, window.providerEventAt);
    if (!envelope.ok) {
      this.logger.warn(`Tango webhook rejected: ${envelope.rejection}`);
      return { kind: 'rejected', rejection: envelope.rejection };
    }

    // ── 4. Record. The unique index, not a pre-read, decides duplicates. ─────
    //
    // No findUnique-then-create: two concurrent retries of the same delivery
    // both pass such a check and both insert. Letting the constraint arbitrate
    // is the only correct resolution, so a duplicate is detected by catching
    // P2002 rather than by looking first.
    const { deliveryId, eventType, eventId, providerEventAt } = envelope.envelope;
    try {
      await this.prisma.tangoWebhookDelivery.create({
        data: {
          deliveryId,
          eventType,
          eventId,
          payloadSha256: payloadDigest(rawBody),
          payloadBytes: rawBody.byteLength,
          payload: parsed as never,
          status: 'received',
          providerEventAt,
        },
      });
      return { kind: 'recorded', deliveryId };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Exact replay. Safe to acknowledge: the first copy is already durable
        // and P47 will drain it exactly once.
        return { kind: 'duplicate', deliveryId };
      }
      // Rethrow so the controller answers retryable. Never swallowed: a
      // swallowed write failure would acknowledge a delivery we did not record,
      // and the provider would never send it again.
      this.logger.error(
        `Tango webhook persistence failed for delivery ${deliveryId}: ${describeError(err)}`,
      );
      throw err;
    }
  }
}

/** Prisma's unique-constraint violation. Matched without importing the enum. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Error text for logs, with no payload and no secret. */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return 'unknown error';
}
