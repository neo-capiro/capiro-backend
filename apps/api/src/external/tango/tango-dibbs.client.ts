import { TangoNotConfiguredError, type TangoRateMetadata } from './tango.errors.js';

/**
 * Funding Opportunities P40 part 3 — the DIBBS REST surface.
 *
 * `@makegov/tango-node` has no DIBBS method (re-confirmed 2026-08-08 by a
 * full-text scan of the installed package), so this talks to the documented
 * REST API directly. The contract is transcribed in
 * `docs/plans/funding-opportunities-makegov-v1/dibbs-sbir-rest-contract.md`.
 *
 * ── THE ENVELOPE IS A GUESS, AND IT FAILS LOUDLY ────────────────────────────
 *
 * `TangoSubawardClient` reads the same provider's `results`/`next`/`count`
 * envelope, and P44 confirmed `X-API-KEY` live against it — so modelling DIBBS
 * the same way is the best available reading. It is still a READING. The
 * contract doc flags the envelope as unconfirmed, and specifically warns it may
 * differ from the SDK's `PaginatedResponse<T>`.
 *
 * So this client differs from the subaward one in exactly one deliberate way:
 * when `results` is not an array it THROWS instead of returning `items: []`.
 * An empty page is indistinguishable from a clean end-of-walk — a wrong
 * envelope would end every run with "0 records, complete", which is the
 * quietest possible way to be wrong, and precisely the failure mode this
 * program keeps rediscovering. A run against an unexpected shape must stop
 * with an error a human reads, not a green summary.
 *
 * ── NO `ordering` PARAMETER ─────────────────────────────────────────────────
 *
 * `ordering` is documented as accepted, but which field names it accepts is
 * not. The walk pages to exhaustion and upserts on the provider's own `uuid`,
 * so page order cannot affect the result — sending an unconfirmed value would
 * add a 400-risk on every call and buy nothing.
 *
 * ── EACH ENDPOINT NAMES ITS OWN DATE FILTER ─────────────────────────────────
 *
 * RFQ filters on `issue_date_after`, RFP on `issued_date_after`, awards on
 * `posted_date_after`. Three methods naming three spellings, rather than one
 * `dateAfter` option that guesses — the same discipline, and the same reason,
 * as the two separate mappers in `tango-dibbs.mapper.ts`.
 */

const DEFAULT_BASE_URL = 'https://tango.makegov.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;
/** Documented maximum. A larger value is silently clamped by the provider; clamp here so the page size we ask for is the page size we reason about. */
const MAX_LIMIT = 100;

export interface TangoDibbsClientConfig {
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TangoDibbsHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Rate metadata from the FAILING response, when the provider sent any.
     *
     * Carried on the error rather than dropped because a 429's `Retry-After`
     * is the only thing that says how long to wait — a caller that has to
     * guess will either hammer the limit or idle far longer than needed.
     * P17's live probe measured this account at 25 requests per ~31s, which a
     * page-complete catalog walk reaches almost immediately.
     */
    readonly rate: TangoRateMetadata | null = null,
  ) {
    super(message);
    this.name = 'TangoDibbsHttpError';
  }

  /** The provider refused for rate reasons, not for content or auth reasons. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * The envelope did not look like the documented one.
 *
 * Separate from the HTTP error because it means something different and calls
 * for a different response: the request SUCCEEDED and the body was not what
 * this code was written against. That is a contract-update-and-new-fixture
 * event, never something to coerce past.
 */
export class TangoDibbsEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TangoDibbsEnvelopeError';
  }
}

export interface TangoDibbsPage {
  items: Array<Record<string, unknown>>;
  totalCount: number | null;
  nextPage: number | null;
  rate: TangoRateMetadata | null;
}

export interface TangoDibbsListOptions {
  page?: number;
  limit?: number;
}

/** `/api/dibbs/rfqs/` — the provider's own spelling is `issue_date`. */
export interface TangoDibbsRfqListOptions extends TangoDibbsListOptions {
  issueDateAfter?: string;
}

/** `/api/dibbs/rfps/` — the provider's own spelling is `issued_date`. */
export interface TangoDibbsRfpListOptions extends TangoDibbsListOptions {
  issuedDateAfter?: string;
}

/** `/api/dibbs/awards/` — the provider's own spelling is `posted_date`. */
export interface TangoDibbsAwardListOptions extends TangoDibbsListOptions {
  postedDateAfter?: string;
}

export interface TangoDibbsGateway {
  readonly configured: boolean;
  listRfqs(options?: TangoDibbsRfqListOptions): Promise<TangoDibbsPage>;
  listRfps(options?: TangoDibbsRfpListOptions): Promise<TangoDibbsPage>;
  listAwards(options?: TangoDibbsAwardListOptions): Promise<TangoDibbsPage>;
}

interface RawPage {
  count?: unknown;
  next?: unknown;
  results?: unknown;
}

function asCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * The `next` link reduced to its page number.
 *
 * A `next` this code cannot parse becomes null, which ENDS the walk. That is
 * the safe direction only because the caller reports completeness separately:
 * a short page ends a walk legitimately, and the sync's summary states how many
 * pages it actually read, so a truncated walk is visible rather than implied.
 */
function nextPageOf(next: unknown, baseUrl: string): number | null {
  if (typeof next !== 'string' || !next.trim()) return null;
  try {
    const raw = new URL(next, baseUrl).searchParams.get('page');
    const page = raw == null ? NaN : Number(raw);
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

function rateOf(headers: Headers): TangoRateMetadata | null {
  const asInteger = (value: string | null): number | null => {
    const n = value == null ? NaN : Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  };
  const remaining = asInteger(headers.get('x-ratelimit-remaining'));
  const limit = asInteger(headers.get('x-ratelimit-limit'));
  const resetIn = asInteger(headers.get('x-ratelimit-reset-in'));
  const retryAfter = asInteger(headers.get('retry-after'));
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

export class TangoDibbsClient implements TangoDibbsGateway {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TangoDibbsClientConfig = {}) {
    this.apiKey = config.apiKey?.trim() || null;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey != null;
  }

  listRfqs(options: TangoDibbsRfqListOptions = {}): Promise<TangoDibbsPage> {
    return this.list('/api/dibbs/rfqs/', 'listRfqs', options, (params) => {
      if (options.issueDateAfter) params.set('issue_date_after', options.issueDateAfter);
    });
  }

  listRfps(options: TangoDibbsRfpListOptions = {}): Promise<TangoDibbsPage> {
    return this.list('/api/dibbs/rfps/', 'listRfps', options, (params) => {
      if (options.issuedDateAfter) params.set('issued_date_after', options.issuedDateAfter);
    });
  }

  listAwards(options: TangoDibbsAwardListOptions = {}): Promise<TangoDibbsPage> {
    return this.list('/api/dibbs/awards/', 'listAwards', options, (params) => {
      if (options.postedDateAfter) params.set('posted_date_after', options.postedDateAfter);
    });
  }

  private async list(
    path: string,
    label: string,
    options: TangoDibbsListOptions,
    applyFilters: (params: URLSearchParams) => void,
  ): Promise<TangoDibbsPage> {
    if (!this.apiKey) throw new TangoNotConfiguredError(label);

    const url = new URL(path, `${this.baseUrl}/`);
    const page = Number.isInteger(options.page) && (options.page ?? 0) > 0 ? options.page! : 1;
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    applyFilters(url.searchParams);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-API-KEY': this.apiKey },
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        // Bounded AND redacted. The key cannot reach a log line even if the
        // provider echoes the request back in its error body.
        const bounded = rawText.split(this.apiKey).join('[REDACTED]').slice(0, 500);
        throw new TangoDibbsHttpError(
          response.status,
          `Tango DIBBS request failed (${response.status})${bounded ? `: ${bounded}` : ''}`,
          rateOf(response.headers),
        );
      }

      let parsed: RawPage;
      try {
        parsed = JSON.parse(rawText) as RawPage;
      } catch {
        throw new TangoDibbsEnvelopeError(`Tango DIBBS ${label} response was not valid JSON`);
      }
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TangoDibbsEnvelopeError(
          `Tango DIBBS ${label} response was not a JSON object — the pagination envelope is not what the contract describes.`,
        );
      }
      // THE assertion. `results` missing is not "no records"; it is "this is
      // not the shape we were written against". See the file header.
      if (!Array.isArray(parsed.results)) {
        throw new TangoDibbsEnvelopeError(
          `Tango DIBBS ${label} response had no \`results\` array — the pagination envelope is not what the contract describes. ` +
            `Update dibbs-sbir-rest-contract.md and capture a fixture; do not widen this client to accept both shapes.`,
        );
      }

      const items = parsed.results.filter(
        (value): value is Record<string, unknown> =>
          value != null && typeof value === 'object' && !Array.isArray(value),
      );
      return {
        items,
        totalCount: asCount(parsed.count),
        nextPage: nextPageOf(parsed.next, this.baseUrl),
        rate: rateOf(response.headers),
      };
    } catch (error) {
      if (
        error instanceof TangoDibbsHttpError ||
        error instanceof TangoDibbsEnvelopeError ||
        error instanceof TangoNotConfiguredError
      ) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TangoDibbsHttpError(0, `Tango DIBBS request timed out after ${this.timeoutMs}ms`);
      }
      throw new TangoDibbsHttpError(0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}
