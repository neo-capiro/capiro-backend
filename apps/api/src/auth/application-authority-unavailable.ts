import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Clerk did not answer the online session check: the bounded deadline passed, the request failed in transit,
 * or Clerk reported 429/5xx. Callers treat this as "authority did not answer" (HTTP 503, retryable), never as
 * a refusal. An inactive, ended, mismatched or unknown session stays an UnauthorizedException (401).
 */
export class ApplicationAuthorityUnavailableException extends ServiceUnavailableException {
  constructor() {
    super('Application authority unavailable');
  }
}

/** Only Clerk throttling, a Clerk server error, or a request with no HTTP answer at all counts as unanswered. */
export function isClerkUnanswered(error: unknown): boolean {
  if (error instanceof ApplicationAuthorityUnavailableException) return true;
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== 'number') return true;
  return status === 429 || status >= 500;
}
