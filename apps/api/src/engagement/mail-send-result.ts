/**
 * Engagement Phase 0 — the provider-neutral send RESULT contract.
 *
 * Deliberately a dependency-free leaf module. Both change-controlled adapters
 * (microsoft-graph-sync, gmail-send) need `AmbiguousMailSendError` at RUNTIME,
 * and `mail-sender.service.ts` imports both adapters — so putting the class there
 * would create a genuine import cycle. mail-sender re-exports these symbols so
 * callers can keep importing from one place.
 */

/**
 * What a provider adapter must report back.
 *
 * The old `{ ok: boolean }` is why a sent message could not be traced: Gmail's
 * returned message resource was discarded, and Graph's fire-and-forget
 * `/me/sendMail` never produced an id at all.
 */
export interface EngagementMailSendResult {
  ok: true;
  provider: 'microsoft_graph' | 'gmail';
  /** Gmail message id. */
  providerMessageId?: string;
  /** Gmail thread id. */
  providerThreadId?: string;
  /** Microsoft Graph draft message id, created before the send. */
  providerDraftId?: string;
  /** RFC 5322 Message-ID, when the provider returns one. */
  providerInternetMessageId?: string;
  correlationId: string;
}

/**
 * Raised when a send's acceptance is genuinely UNDETERMINED — a timeout or socket
 * failure after the request body was transmitted, or an HTTP success carrying no
 * usable message id.
 *
 * The caller MUST record the delivery as `unknown` and MUST NOT retry: the
 * message may already be in the recipient's inbox. Carries ids only, never
 * message content.
 */
export class AmbiguousMailSendError extends Error {
  constructor(
    message: string,
    readonly correlationId: string,
    readonly providerDraftId?: string,
  ) {
    super(message);
    this.name = 'AmbiguousMailSendError';
  }
}

/**
 * Transport-level failures whose send outcome CANNOT be determined.
 *
 * A rejected `fetch()` on a send call means the request left this process but no
 * response came back: the provider may or may not have accepted the message. The
 * only safe classification is `unknown` — recording it as `failed` invites the
 * user to retry and duplicate an email that was in fact delivered.
 *
 * Deliberately broad (undici collapses most transport faults into a generic
 * `TypeError: fetch failed`, so even connection-refused lands here). That errs
 * toward "a human verifies Sent Items" instead of "we quietly resend", which is
 * the correct direction for an at-most-once external send.
 *
 * Shared by BOTH provider adapters so the Gmail and Graph paths cannot drift —
 * they previously did, and only Graph classified these correctly.
 */
const AMBIGUOUS_TRANSPORT_PATTERN =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|socket hang up|aborted|AbortError|timeout|network/i;

export function isAmbiguousTransportFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return AMBIGUOUS_TRANSPORT_PATTERN.test(text);
}
