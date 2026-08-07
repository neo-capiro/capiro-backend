/**
 * MakeGov/Tango failures, classified into the seven kinds Capiro reacts to
 * differently.
 *
 * ── Why not just re-export the SDK's errors ──────────────────────────────────
 *
 * The SDK raises `TangoAuthError`, `TangoNotFoundError`, `TangoValidationError`,
 * `TangoRateLimitError`, `TangoTimeoutError` and a catch-all `TangoAPIError`.
 * That is a good vocabulary and this module maps onto it — but two things are
 * missing and both matter more than the taxonomy:
 *
 *   1. TIER. A 403 because the plan does not include a dataset is not an
 *      authentication failure, and treating it as one sends an operator to rotate
 *      a key that is working perfectly. It is also not retryable, ever.
 *   2. RETRYABILITY as a property of the error rather than a decision made at
 *      each call site. P18 builds the retry policy; it reads `retryable` here
 *      rather than re-deriving it from status codes, so there is one answer.
 *
 * Wrapping also means product code never imports from `@makegov/tango-node`,
 * which is the boundary the import test enforces.
 *
 * ── Redaction is not optional ────────────────────────────────────────────────
 *
 * The API key travels in an `X-API-KEY` header. Anything reachable from an error
 * — message, response body, headers, a URL with a query string — goes through
 * {@link redact} before it is stored on the error object. An error is the single
 * most likely thing to end up in a log, a Sentry event, a PR comment and a test
 * snapshot, which is four ways to leak a credential from one careless `throw`.
 */

/** Every classification, in the order a caller should think about them. */
export const TANGO_ERROR_KINDS = [
  /** The key is missing, wrong, or revoked. Never retry; a human must act. */
  'auth',
  /** The key is fine; the PLAN does not include this. Never retry. */
  'tier',
  /** Capiro sent something the API rejected. A bug here, not there. Never retry. */
  'validation',
  /** The resource does not exist. Often meaningful evidence, not a failure. */
  'not_found',
  /** Rate limited. Retryable, but only after the provider's stated delay. */
  'rate_limit',
  /** Timeout, 5xx, socket error. Retryable. */
  'transient',
  /** Anything else. NOT retryable — an unknown failure repeated is still unknown. */
  'permanent',
] as const;
export type TangoErrorKind = (typeof TANGO_ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<TangoErrorKind> = new Set<TangoErrorKind>([
  'rate_limit',
  'transient',
]);

/** Rate metadata the provider reported, if any. P18 consumes this; P14 only carries it. */
export interface TangoRateMetadata {
  remaining: number | null;
  limit: number | null;
  /** Seconds until the window resets. */
  resetIn: number | null;
  /** The provider's own stated delay, in seconds. Honour this over any local backoff. */
  retryAfter: number | null;
  limitType: string | null;
}

export interface TangoErrorContext {
  kind: TangoErrorKind;
  /** The gateway method that failed, e.g. `getEntity`. Never a URL with a query string. */
  operation: string;
  statusCode: number | null;
  /** Already redacted. */
  detail: string | null;
  rate: TangoRateMetadata | null;
  cause?: unknown;
}

/**
 * Patterns that must never survive into an error.
 *
 * Deliberately BROAD. A false positive costs a `[redacted]` in a message nobody
 * needed; a false negative is a credential in a log. The key format is not
 * documented as stable, so this matches on the SHAPE of secret-carrying text
 * rather than on the key itself.
 */
const REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer abc123`. FIRST, and separate from the rule below,
  // because the generic one would replace the word "Bearer" and leave the token
  // sitting immediately after it — a redaction that looks like it worked.
  [/((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(bearer|basic|token)\s+\S+/gi, '$1$2 [redacted]'],
  // `X-API-KEY: abc123`, `api_key=abc123`, `"apiKey":"abc123"`, `token: abc123`.
  [/((?:x-)?api[-_]?key|apikey|authorization|token|secret|bearer)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, '$1$2[redacted]'],
  // A query string carrying any of the above.
  [/([?&](?:api[-_]?key|apikey|token|key|secret)=)[^&\s]+/gi, '$1[redacted]'],
];

/**
 * Strip anything that looks like a credential from text.
 *
 * Also used on the actual key value when one is known — see
 * {@link redactWithKnownSecret} — because the patterns above cannot catch a bare
 * key echoed with no surrounding label.
 */
export function redact(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Pattern redaction PLUS a literal replacement of a known secret.
 *
 * The adapter knows its own key, so it can catch the one case the patterns
 * cannot: a bare value echoed back with no label around it, which is exactly what
 * a badly-behaved upstream does in a "invalid key: <the key>" message.
 *
 * A short secret is ignored: replacing every occurrence of a 3-character string
 * would mangle unrelated text without protecting anything real.
 */
export function redactWithKnownSecret(value: string, secret: string | null | undefined): string {
  const patterned = redact(value);
  if (!secret || secret.length < 8) return patterned;
  return patterned.split(secret).join('[redacted]');
}

/** Redact recursively through an arbitrary payload, bounded in size and depth. */
export function redactUnknown(value: unknown, secret?: string | null, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactWithKnownSecret(value, secret ?? null);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactUnknown(v, secret, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      // A key whose NAME says it is a secret is dropped whole, not redacted in
      // place — there is no version of its value worth keeping.
      out[k] = /api[-_]?key|apikey|authorization|token|secret|password/i.test(k)
        ? '[redacted]'
        : redactUnknown(v, secret, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * One error type, carrying its classification.
 *
 * A single class rather than seven subclasses: callers switch on `kind`, and a
 * seven-way `instanceof` ladder is the thing that silently gains an eighth
 * unhandled branch. `retryable` is derived, never passed in, so it cannot
 * disagree with the kind.
 */
export class TangoError extends Error {
  readonly kind: TangoErrorKind;
  readonly operation: string;
  readonly statusCode: number | null;
  /** Redacted. Safe to log. */
  readonly detail: string | null;
  readonly rate: TangoRateMetadata | null;

  constructor(message: string, context: TangoErrorContext) {
    // The message is redacted here, at construction, so there is no window in
    // which an unredacted TangoError exists.
    super(redact(message));
    this.name = 'TangoError';
    this.kind = context.kind;
    this.operation = context.operation;
    this.statusCode = context.statusCode;
    this.detail = context.detail == null ? null : redact(context.detail);
    this.rate = context.rate;
    if (context.cause !== undefined) {
      // Non-enumerable: a serialiser walking this error must not re-introduce the
      // raw SDK error (and its unredacted response body) through the back door.
      Object.defineProperty(this, 'cause', {
        value: context.cause,
        enumerable: false,
        writable: false,
      });
    }
  }

  /** Whether a retry could plausibly succeed. P18 owns HOW to retry. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** Everything safe to log, in one object. */
  toLogContext(): Record<string, unknown> {
    return {
      provider: 'tango',
      kind: this.kind,
      operation: this.operation,
      statusCode: this.statusCode,
      retryable: this.retryable,
      detail: this.detail,
      rateRemaining: this.rate?.remaining ?? null,
      retryAfterSeconds: this.rate?.retryAfter ?? null,
    };
  }
}

/**
 * No API key is configured.
 *
 * Its own type, and deliberately NOT a `TangoError` with `kind: 'auth'`: the
 * difference between "we never had a credential" and "the credential was
 * rejected" is the difference between a configuration task and an incident.
 * Boot must never depend on this being absent — see TangoModule.
 */
export class TangoNotConfiguredError extends Error {
  constructor(operation: string) {
    super(
      `MakeGov/Tango is not configured (no TANGO_API_KEY), so ${operation} cannot run. ` +
        'This is a configuration state, not a failure: every product read serves local data ' +
        'and no user-facing path calls the provider.',
    );
    this.name = 'TangoNotConfiguredError';
  }
}

/**
 * Classify a status code.
 *
 * The 403 branch is the interesting one. Tango returns 403 both for "this key
 * cannot do that" (tier) and for genuine authorisation failures; the body is what
 * distinguishes them, and only sometimes. When the body says nothing useful the
 * classification is `tier`, because that is the FALSE-SAFE choice: a tier error
 * is never retried, so mislabelling an auth failure as a tier failure costs one
 * clear operator message, while the reverse would retry a rejected credential
 * against a rate limit.
 */
export function classifyStatus(status: number | null | undefined, body?: unknown): TangoErrorKind {
  if (status == null) return 'transient';
  if (status === 401) return 'auth';
  if (status === 403) {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
    if (/invalid|expired|revoked|missing.*key|authentication/i.test(text)) return 'auth';
    return 'tier';
  }
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'transient';
  if (status >= 400 && status < 500) return 'validation';
  if (status >= 500) return 'transient';
  return 'permanent';
}
