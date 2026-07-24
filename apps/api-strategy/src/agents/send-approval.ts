import { createHash, timingSafeEqual } from 'node:crypto';

/*
 * Stage G send-approval token machinery. PURE module (no Nest imports) — the
 * Execution Agent computes a token over the EXACT message it intends to send;
 * a human approves that token; the run presents it back to authorise a send.
 *
 * The token is a sha256 over a CANONICAL serialization of the send request, so
 * ANY change to any hashed field (message, recipients, ask, or either window
 * bound) yields a different token and invalidates a prior approval. A token is
 * also BOUND TO ITS RUN (plan §G2 / Lane④): verification requires the token's
 * originating runId to equal the run presenting it — "no standing/prior
 * approval satisfies it".
 *
 * SAFETY BOUNDARY (plan §G, non-negotiable): this module authorises NOTHING by
 * itself. The actual external send stays HARD-DISABLED until Stage H security
 * evals — the send path throws SEND_DISABLED_REASON regardless of any token.
 * sendEnabled() reads STRATEGY_EXECUTION_SEND_ENABLED (an env that is NEVER set
 * in Stage G) purely as the Stage-H seam.
 */

export interface SendTokenInput {
  message: string;
  recipients: string[];
  ask: string;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface SendTokenVerification {
  valid: boolean;
  reason?: string;
}

/** Why the external send is disabled in Stage G (thrown by the send path). */
export const SEND_DISABLED_REASON = 'External send is disabled until Stage H security review';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic, order-insensitive serialization: recipients are
 * whitespace-normalized, de-duplicated and sorted; free-text fields are
 * whitespace-normalized; window bounds are pass-through (or null). Object keys
 * are written in a fixed alphabetical order so the JSON string is stable.
 */
function canonicalize(input: SendTokenInput): string {
  const recipients = [
    ...new Set(
      (input.recipients ?? [])
        .map((r) => normalizeWhitespace(String(r)))
        .filter((r) => r.length > 0),
    ),
  ].sort();
  return JSON.stringify({
    ask: normalizeWhitespace(input.ask ?? ''),
    message: normalizeWhitespace(input.message ?? ''),
    recipients,
    windowEnd: input.windowEnd ?? null,
    windowStart: input.windowStart ?? null,
  });
}

/** sha256 hex of the canonical serialization of the send request. */
export function computeSendToken(input: SendTokenInput): string {
  return createHash('sha256').update(canonicalize(input), 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A token is valid ONLY when it matches the recomputed hash of `input` AND its
 * originating run (`tokenRunId`) is the run presenting it (`runId`). Either
 * mismatch (a tampered field, or a token minted for a different run) fails.
 */
export function verifySendToken(
  input: SendTokenInput,
  presentedToken: string,
  runId: string,
  tokenRunId: string,
): SendTokenVerification {
  if (!presentedToken) {
    return { valid: false, reason: 'no send-approval token presented' };
  }
  if (!runId || tokenRunId !== runId) {
    return {
      valid: false,
      reason: 'token is bound to a different run — no standing/prior approval satisfies this run',
    };
  }
  if (!safeEqualHex(presentedToken, computeSendToken(input))) {
    return {
      valid: false,
      reason: 'token does not match the approved message, recipients, ask or window',
    };
  }
  return { valid: true };
}

export interface SendEnvLike {
  STRATEGY_EXECUTION_SEND_ENABLED?: string;
}

/**
 * Stage-H seam. STRATEGY_EXECUTION_SEND_ENABLED is NEVER set in Stage G, so this
 * is always false here — the send path throws SEND_DISABLED_REASON regardless.
 */
export function sendEnabled(env: SendEnvLike): boolean {
  return env.STRATEGY_EXECUTION_SEND_ENABLED === 'true';
}
