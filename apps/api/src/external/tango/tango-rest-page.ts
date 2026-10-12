import type { TangoRateMetadata } from './tango.errors.js';

/** Existing REST clients intentionally differ in header read/coercion order. */
export type RateReadProfile = 'interleaved' | 'captured';

export function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * Reduce the next link to its page number without following its URL. An
 * unparseable next ends the walk; callers report completeness separately.
 */
export function nextPageOf(next: unknown, baseUrl: string): number | null {
  if (typeof next !== 'string' || !next.trim()) return null;
  try {
    const raw = new URL(next, baseUrl).searchParams.get('page');
    const page = raw == null ? NaN : Number(raw);
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

function asRateInteger(value: string | null): number | null {
  const n = value == null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

export function rateOf(headers: Headers, profile: RateReadProfile): TangoRateMetadata | null {
  let remaining: number | null;
  let limit: number | null;
  let resetIn: number | null;
  let retryAfter: number | null;
  if (profile === 'captured') {
    const remainingRaw = headers.get('x-ratelimit-remaining');
    const limitRaw = headers.get('x-ratelimit-limit');
    const resetRaw = headers.get('x-ratelimit-reset-in');
    const retryRaw = headers.get('retry-after');
    remaining = asRateInteger(remainingRaw);
    limit = asRateInteger(limitRaw);
    resetIn = asRateInteger(resetRaw);
    retryAfter = asRateInteger(retryRaw);
  } else {
    remaining = asRateInteger(headers.get('x-ratelimit-remaining'));
    limit = asRateInteger(headers.get('x-ratelimit-limit'));
    resetIn = asRateInteger(headers.get('x-ratelimit-reset-in'));
    retryAfter = asRateInteger(headers.get('retry-after'));
  }
  const limitType = headers.get('x-ratelimit-type');
  if (
    remaining == null &&
    limit == null &&
    resetIn == null &&
    retryAfter == null &&
    limitType == null
  ) {
    return null;
  }
  return { remaining, limit, resetIn, retryAfter, limitType };
}
