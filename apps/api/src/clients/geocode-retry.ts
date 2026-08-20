export type GeocodeRetryStatus = 'matched' | 'no_match' | 'ambiguous' | 'error' | 'manual_review';

export const MAX_GEOCODE_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

/** Delay before another provider attempt. Attempt numbers are 1-based. */
export function retryDelayMs(status: GeocodeRetryStatus, attemptCount: number): number {
  if (status !== 'error' && status !== 'no_match' && status !== 'ambiguous') {
    if (status === 'matched' || status === 'manual_review') return 0;
    throw new Error(`Unsupported geocode retry status: ${status}`);
  }
  const attempt = Math.max(1, Math.floor(attemptCount));
  const schedule = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, MAX_RETRY_DELAY_MS];
  return Math.min(schedule[Math.min(attempt - 1, schedule.length - 1)] ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
}

export function nextGeocodeAttempt(
  status: GeocodeRetryStatus,
  attemptCount: number,
  hasGeocodableAddress: boolean,
  now: Date,
): { status: GeocodeRetryStatus; nextAttemptAt: Date | null } {
  if (status === 'matched' || status === 'manual_review' || !hasGeocodableAddress) {
    return { status, nextAttemptAt: null };
  }
  if (status !== 'error' && status !== 'no_match' && status !== 'ambiguous') {
    throw new Error(`Unsupported geocode retry status: ${status}`);
  }
  if (attemptCount >= MAX_GEOCODE_ATTEMPTS) {
    return { status: 'manual_review', nextAttemptAt: null };
  }
  return {
    status,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(status, attemptCount)),
  };
}

export function hasGeocodableAddress(addressLine: string | null | undefined, city: string | null | undefined, state: string | null | undefined): boolean {
  return Boolean(addressLine?.trim() && city?.trim() && state?.trim());
}

export function isRetryDue(status: string | null, nextAttemptAt: Date | null, now: Date): boolean {
  return status === 'error' || status === 'no_match' || status === 'ambiguous'
    ? nextAttemptAt == null || nextAttemptAt <= now
    : false;
}