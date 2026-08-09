import { TangoNotConfiguredError, type TangoRateMetadata } from './tango.errors.js';

/**
 * Funding Opportunities P42 part 1 — the SBIR/STTR REST surface.
 *
 * `@makegov/tango-node` has no SBIR or STTR method (re-confirmed 2026-08-08 by
 * a full-text scan of the installed package: zero occurrences of
 * `dibbs`/`sbir`/`sttr` across its 96-method surface). So this talks to the
 * documented REST API directly, exactly as `TangoDibbsClient` does for DIBBS.
 * The contract is transcribed in
 * `docs/plans/funding-opportunities-makegov-v1/dibbs-sbir-rest-contract.md`.
 *
 * ── WHY THIS EXISTS BEFORE ANY SCHEMA ───────────────────────────────────────
 *
 * P42's plan names "P17 must show access" as its gate, and P17 currently
 * reports `sbir_sttr: not_attempted / no_rest_client_wired`. That is a fact
 * about CAPIRO'S CODE, not about the provider — decision-log D-64, which is the
 * whole reason that status exists as something distinct from `unsupported`.
 * The gate therefore cannot be satisfied by waiting: nothing will ever answer
 * it until a client exists to make the call. This file is that client, and it
 * is deliberately the FIRST thing P42 ships, so the entitlement question
 * becomes answerable by an operator run before any table is designed around an
 * assumption.
 *
 * ── THE ENVELOPE IS A READING, AND IT FAILS LOUDLY ──────────────────────────
 *
 * Same posture as the DIBBS client, for the same reason. The `results`/`next`/
 * `count` envelope is the best available reading — `TangoSubawardClient` reads
 * it from the same provider and P44 confirmed `X-API-KEY` live against it — but
 * it is still a reading, and P17's 2026-08-08 run confirmed the envelope for
 * `/api/dibbs/` ONLY. Nothing has ever called `/api/sbir/`.
 *
 * So when `results` is not an array this THROWS rather than returning
 * `items: []`. An empty page is indistinguishable from a clean end-of-walk, so
 * a wrong envelope would end every run with "0 records, complete" — the
 * quietest possible way to be wrong, and the exact failure mode this program
 * keeps rediscovering (P48's unexecuted SQL, P49's three broken queries
 * rendering as an em dash).
 *
 * ── TWO ENDPOINTS, TWO IDENTIFIERS, AND NEITHER IS `uuid` ───────────────────
 *
 * The contract doc is explicit that topics are keyed `topic_id` and
 * solicitations `solicitation_id`, neither of which is the `uuid` DIBBS uses.
 * Nothing here depends on that — a client returns rows verbatim — but it is
 * called out because the natural assumption ("this provider keys everything on
 * uuid") is wrong, and the mapper P42 part 2 builds is where that assumption
 * would do damage.
 *
 * ── EACH ENDPOINT NAMES ITS OWN DATE FILTER ─────────────────────────────────
 *
 * Topics filter on `open_date_after`/`close_date_after`/`release_date_after`;
 * solicitations on `start_date_after`/`end_date_after`. Two methods naming
 * their own documented spellings rather than one `dateAfter` option that
 * guesses — the same discipline, and the same reason, as the DIBBS client's
 * three separate date parameters.
 *
 * ── NO `ordering` PARAMETER ─────────────────────────────────────────────────
 *
 * Not documented for either endpoint. The walk pages to exhaustion, so page
 * order cannot affect the result; sending an unconfirmed value would add a
 * 400-risk on every call and buy nothing.
 */

const DEFAULT_BASE_URL = 'https://tango.makegov.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;
/**
 * Matches the DIBBS client's clamp.
 *
 * The SBIR docs do not state a maximum. Clamping to the one value this provider
 * IS documented to cap at keeps the page size we ask for equal to the page size
 * we reason about; asking for more and being silently clamped is how a walk
 * starts miscounting its own progress.
 */
const MAX_LIMIT = 100;

export interface TangoSbirClientConfig {
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TangoSbirHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Rate metadata from the FAILING response, when the provider sent any.
     *
     * Carried rather than dropped because a 429's `Retry-After` is the only
     * thing that says how long to wait. P17 measured this account at 25
     * requests per ~31s — small enough that any page-complete walk reaches it.
     */
    readonly rate: TangoRateMetadata | null = null,
  ) {
    super(message);
    this.name = 'TangoSbirHttpError';
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
export class TangoSbirEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TangoSbirEnvelopeError';
  }
}

export interface TangoSbirPage {
  items: Array<Record<string, unknown>>;
  totalCount: number | null;
  nextPage: number | null;
  rate: TangoRateMetadata | null;
}

export interface TangoSbirListOptions {
  page?: number;
  limit?: number;
}

/** `/api/sbir/topics/` — the documented date filters are open/close/release. */
export interface TangoSbirTopicListOptions extends TangoSbirListOptions {
  openDateAfter?: string;
  closeDateAfter?: string;
  releaseDateAfter?: string;
  /** The provider's own `solicitation_number`, for topic-to-cycle joins. */
  solicitationNumber?: string;
}

/** `/api/sbir/solicitations/` — the documented date filters are start/end. */
export interface TangoSbirSolicitationListOptions extends TangoSbirListOptions {
  startDateAfter?: string;
  endDateAfter?: string;
  /**
   * `'SBIR' | 'STTR'` as the provider spells it. NOT narrowed to a union here:
   * this is the discriminator between the two programs and the contract doc
   * records its exact values as undocumented, so a caller passes through what
   * it means to filter on rather than what this file guessed.
   */
  program?: string;
}

export interface TangoSbirGateway {
  readonly configured: boolean;
  listTopics(options?: TangoSbirTopicListOptions): Promise<TangoSbirPage>;
  listSolicitations(options?: TangoSbirSolicitationListOptions): Promise<TangoSbirPage>;
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
 * A `next` this code cannot parse becomes null, which ENDS the walk. Safe only
 * because the caller reports completeness separately: the sync's summary states
 * how many pages it actually read, so a truncated walk is visible rather than
 * implied.
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

export class TangoSbirClient implements TangoSbirGateway {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TangoSbirClientConfig = {}) {
    this.apiKey = config.apiKey?.trim() || null;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey != null;
  }

  listTopics(options: TangoSbirTopicListOptions = {}): Promise<TangoSbirPage> {
    return this.list('/api/sbir/topics/', 'listTopics', options, (params) => {
      if (options.openDateAfter) params.set('open_date_after', options.openDateAfter);
      if (options.closeDateAfter) params.set('close_date_after', options.closeDateAfter);
      if (options.releaseDateAfter) params.set('release_date_after', options.releaseDateAfter);
      if (options.solicitationNumber) params.set('solicitation_number', options.solicitationNumber);
    });
  }

  listSolicitations(options: TangoSbirSolicitationListOptions = {}): Promise<TangoSbirPage> {
    return this.list('/api/sbir/solicitations/', 'listSolicitations', options, (params) => {
      if (options.startDateAfter) params.set('start_date_after', options.startDateAfter);
      if (options.endDateAfter) params.set('end_date_after', options.endDateAfter);
      if (options.program) params.set('program', options.program);
    });
  }

  private async list(
    path: string,
    label: string,
    options: TangoSbirListOptions,
    applyFilters: (params: URLSearchParams) => void,
  ): Promise<TangoSbirPage> {
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
        throw new TangoSbirHttpError(
          response.status,
          `Tango SBIR request failed (${response.status})${bounded ? `: ${bounded}` : ''}`,
          rateOf(response.headers),
        );
      }

      let parsed: RawPage;
      try {
        parsed = JSON.parse(rawText) as RawPage;
      } catch {
        throw new TangoSbirEnvelopeError(`Tango SBIR ${label} response was not valid JSON`);
      }
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TangoSbirEnvelopeError(
          `Tango SBIR ${label} response was not a JSON object — the pagination envelope is not what the contract describes.`,
        );
      }
      // THE assertion. `results` missing is not "no records"; it is "this is
      // not the shape we were written against". See the file header.
      if (!Array.isArray(parsed.results)) {
        throw new TangoSbirEnvelopeError(
          `Tango SBIR ${label} response had no \`results\` array — the pagination envelope is not what the contract describes. ` +
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
        error instanceof TangoSbirHttpError ||
        error instanceof TangoSbirEnvelopeError ||
        error instanceof TangoNotConfiguredError
      ) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TangoSbirHttpError(0, `Tango SBIR request timed out after ${this.timeoutMs}ms`);
      }
      throw new TangoSbirHttpError(0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}
