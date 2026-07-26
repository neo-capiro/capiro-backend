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
