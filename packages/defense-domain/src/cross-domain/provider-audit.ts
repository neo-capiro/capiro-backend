/**
 * Phase 8 Session 9 — provider invocation audit records.
 *
 * Sessions 7 and 8 established that a component making decisions the product
 * depends on must leave a record of them, because "found nothing" and "was turned
 * away" are otherwise indistinguishable. That applies with more force here: both
 * ports Session 9 wires degrade silently by design, so without an audit row an
 * empty capability search is unattributable — a genuinely empty result, an
 * unconfigured provider, a throttle and an expired credential all look the same.
 *
 * What an audit row must NOT contain is equally important. These invocations
 * carry user query text, tenant PE-code lists and a credential. So:
 *
 *  * the payload is recorded as a SHA-256 digest, never as text;
 *  * no embedding vector is stored — only its dimension;
 *  * no secret, header or credential value is representable in the row shape;
 *  * no monetary column exists, here or in the table. Provider cost is not a
 *    funding fact and this session asserts no dollars, exactly as 7 and 8 did.
 *
 * `assertProviderAuditCarriesNoSecrets` enforces that at runtime rather than by
 * convention, walking the record at any depth the way Session 7's signal guard
 * walks a payload for funding keys.
 */

export type ProviderOperation = 'embed_query' | 'relevant_pe_codes';

export type ProviderOutcome =
  | 'succeeded'
  | 'degraded_unconfigured'
  | 'degraded_failed'
  | 'degraded_concurrency'
  | 'degraded_empty_input';

export interface ProviderInvocationAudit {
  readonly provider: string;
  readonly operation: ProviderOperation;
  readonly outcome: ProviderOutcome;
  /** Model id for an embedding call; null for a relevance call. */
  readonly model: string | null;
  readonly tenantId: string;
  /** SHA-256 of the request payload. Never the payload itself. */
  readonly payloadSha256: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly latencyMs: number;
  /** Failure class of the LAST failed attempt, when there was one. */
  readonly failureClass: string | null;
  /** Short, non-sensitive explanation. Always present. */
  readonly reason: string;
  /** Vector dimension returned, for an embedding call. Never the vector. */
  readonly resultDimension: number | null;
  /** Count of PE codes returned, for a relevance call. Never the codes. */
  readonly resultCount: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Outcomes that mean the caller served its documented degraded result. */
const DEGRADED: readonly ProviderOutcome[] = Object.freeze([
  'degraded_unconfigured',
  'degraded_failed',
  'degraded_concurrency',
  'degraded_empty_input',
]);

export function isDegradedOutcome(outcome: ProviderOutcome): boolean {
  return DEGRADED.includes(outcome);
}

export class ProviderAuditLeakError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`Provider audit record would leak at ${path}: ${detail}`);
    this.name = 'ProviderAuditLeakError';
  }
}

/** Field names that must never appear on an audit record, at any depth. */
const FORBIDDEN_KEY_PATTERN =
  /(secret|token|credential|password|apikey|api_key|authorization|bearer|signature|vector|embedding|query|querytext|peCodes|pe_codes|amount|usd|dollar|obligat|outlay)/i;

/** Values that look like credential material regardless of their field name. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^Bearer\s+/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /^aws4-hmac-sha256/i,
  /^x-internal-service-secret/i,
]);

/**
 * Walk a record and refuse anything that looks like a secret, a payload or a
 * dollar. Depth-first at any nesting, like Session 7's funding-key guard.
 */
export function assertProviderAuditCarriesNoSecrets(
  record: unknown,
  path = 'audit',
): void {
  if (record === null || record === undefined) return;

  if (typeof record === 'string') {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(record)) {
        throw new ProviderAuditLeakError(path, 'value matches a credential shape');
      }
    }
    return;
  }

  if (typeof record !== 'object') return;

  if (Array.isArray(record)) {
    record.forEach((item, index) => {
      assertProviderAuditCarriesNoSecrets(item, `${path}[${index}]`);
    });
    return;
  }

  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    // `payloadSha256` and `resultDimension` are the SAFE forms of the very
    // things this guard forbids, so they are named exemptions rather than
    // accidental passes.
    const exempt = key === 'payloadSha256' || key === 'resultDimension' || key === 'resultCount';
    if (!exempt && FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new ProviderAuditLeakError(`${path}.${key}`, 'field name is not permitted on an audit row');
    }
    assertProviderAuditCarriesNoSecrets(value, `${path}.${key}`);
  }
}

/**
 * Build an audit record and validate it in one step, so there is no path that
 * produces one without the guard having run.
 */
export function buildProviderAudit(input: ProviderInvocationAudit): ProviderInvocationAudit {
  if (input.attempts < 0 || !Number.isInteger(input.attempts)) {
    throw new RangeError(`Invalid attempt count: ${String(input.attempts)}`);
  }
  if (input.latencyMs < 0 || !Number.isFinite(input.latencyMs)) {
    throw new RangeError(`Invalid latency: ${String(input.latencyMs)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.payloadSha256)) {
    throw new RangeError('payloadSha256 must be a sha256 hex digest');
  }
  if (!/^[0-9a-f]{64}$/.test(input.idempotencyKey)) {
    throw new RangeError('idempotencyKey must be a sha256 hex digest');
  }
  if (input.reason.trim() === '') {
    throw new RangeError('a provider audit row must state a reason');
  }
  // A success has to have produced something; a degrade must not claim it did.
  if (input.outcome === 'succeeded' && input.resultDimension === null && input.resultCount === null) {
    throw new RangeError('a successful invocation must record a result dimension or count');
  }
  if (isDegradedOutcome(input.outcome) && input.resultDimension !== null) {
    throw new RangeError('a degraded invocation cannot report an embedding dimension');
  }
  // Mirrors `dpi_failure_class_chk`: a failed invocation must name its failure
  // class, and nothing else may claim one. Enforced here as well as in SQL so a
  // caller that never reaches the database still cannot record "it just returned
  // nothing" as a storable state.
  if ((input.outcome === 'degraded_failed') !== (input.failureClass !== null)) {
    throw new RangeError(
      `outcome ${input.outcome} and failureClass ${String(input.failureClass)} disagree: ` +
        'exactly the degraded_failed outcome carries a failure class',
    );
  }

  const record = Object.freeze({ ...input });
  assertProviderAuditCarriesNoSecrets(record);
  return record;
}

export const PROVIDER_OPERATIONS: readonly ProviderOperation[] = Object.freeze([
  'embed_query',
  'relevant_pe_codes',
]);

export const PROVIDER_OUTCOMES: readonly ProviderOutcome[] = Object.freeze([
  'succeeded',
  'degraded_unconfigured',
  'degraded_failed',
  'degraded_concurrency',
  'degraded_empty_input',
]);
