/**
 * Shared committee source-health vocabulary.
 *
 * `CommitteeSource.sourceHealth` is a lowercase enum in Postgres
 * (`healthy | degraded | failing | unknown`, defaulting to "unknown"), and both
 * committee surfaces — the directory grid and the Committee Room header — must
 * label it identically. The Room previously inlined its own ternary, which
 * rendered "SOURCE UNKNOWN" where the directory says "SOURCE STATUS UNKNOWN",
 * so the two disagreed about the same row.
 *
 * `unknown` is a real, displayable state: "we do not know whether this
 * committee's official source is being fetched successfully". It must render a
 * pill, never nothing — an absent pill reads as "healthy" to the operator.
 */
import type { Tone } from './types.js';

export type SourceHealth = 'healthy' | 'degraded' | 'failing' | 'unknown';

export const SOURCE_HEALTH_TONE: Record<SourceHealth, Tone> = {
  healthy: 'success',
  degraded: 'warning',
  failing: 'error',
  unknown: 'gray',
};

export const SOURCE_HEALTH_LABEL: Record<SourceHealth, string> = {
  healthy: 'SOURCE HEALTHY',
  degraded: 'SOURCE DEGRADED',
  failing: 'SOURCE FAILING',
  unknown: 'SOURCE STATUS UNKNOWN',
};

/** Any wire value → a displayable health state. Never throws, never returns ''. */
export function normalizeSourceHealth(value: unknown): SourceHealth {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return key in SOURCE_HEALTH_TONE ? (key as SourceHealth) : 'unknown';
}
