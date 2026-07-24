import {
  hasRequiredCongressDistrictIdentity,
  hasRequiredMemberIdentity,
  hasRequiredOfficeIdentity,
  hasRequiredStaffIdentity,
  type LegiStormCongressDistrictRecord,
  type LegiStormMemberRecord,
  type LegiStormOfficeRecord,
  type LegiStormStaffRecord,
  type LegiStormVendorRecord,
} from './legistorm-types.js';

const DEFAULT_BASE_URL = 'https://api.legistorm.com/v2.019.10/congress';
// A browser-shaped User-Agent. www.legistorm.com (the KML host — NOT
// api.legistorm.com) sits behind an edge that 403s a bare/non-browser UA;
// verified live 2026-07-24 (curl default UA -> 403 Forbidden; this UA -> 200).
const KML_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// LegiStorm caps `limit` at 100 per request (over-100 → HTTP 422 VALIDATION_ERROR),
// so the default AND any configured value are clamped to this ceiling.
const LEGISTORM_MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_REQUEST_DELAY_MS = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Sleep = (ms: number) => Promise<void>;

export interface LegiStormDateRange {
  updatedFrom: string;
  updatedTo: string;
}

export interface LegiStormRawPage {
  page: number;
  body: unknown[];
}

export interface LegiStormPagedResult<T extends LegiStormVendorRecord> {
  records: T[];
  rawPages: LegiStormRawPage[];
}

export interface LegiStormRetiredIdsResult {
  ids: number[];
  rawBody: unknown[];
}

/**
 * Legislative Districts API result — a single, non-paged JSON array response
 * (no updated_from/updated_to window, no page/limit; the whole list or a
 * single ZIP match comes back in one call). Distinct from
 * LegiStormPagedResult, which models the Congressional API's paged,
 * date-windowed list endpoints.
 */
export interface LegiStormDistrictListResult {
  records: LegiStormCongressDistrictRecord[];
  rawBody: unknown[];
}

export interface LegiStormClientOptions {
  apiKey: string;
  baseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  requestDelayMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: Sleep;
  randomImpl?: () => number;
  nowImpl?: () => number;
}

export class LegiStormClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly requestDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: LegiStormClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error('LEGISTORM_API_KEY is required');

    const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (baseUrl.protocol !== 'https:') throw new Error('baseUrl must use HTTPS');

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.toString().replace(/\/+$/, '');
    this.pageSize = Math.min(
      positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 'pageSize'),
      LEGISTORM_MAX_PAGE_SIZE,
    );
    this.maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 'maxPages');
    this.requestDelayMs = nonnegativeInteger(
      options.requestDelayMs,
      DEFAULT_REQUEST_DELAY_MS,
      'requestDelayMs',
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.maxRetries = nonnegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries');
    this.maxRetryDelayMs = positiveInteger(
      options.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS,
      'maxRetryDelayMs',
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.randomImpl ?? Math.random;
    this.now = options.nowImpl ?? Date.now;
  }

  fetchMembers(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormMemberRecord>> {
    return this.fetchPaged('/member/list', range, hasRequiredMemberIdentity, { status: 'c' });
  }

  fetchOffices(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormOfficeRecord>> {
    return this.fetchPaged('/office/list', range, hasRequiredOfficeIdentity);
  }

  fetchStaff(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormStaffRecord>> {
    return this.fetchPaged('/staff/list', range, hasRequiredStaffIdentity);
  }

  fetchRetiredOfficeIds(): Promise<LegiStormRetiredIdsResult> {
    return this.fetchRetiredIds('/office/retired-ids');
  }

  fetchRetiredStaffIds(): Promise<LegiStormRetiredIdsResult> {
    return this.fetchRetiredIds('/staff/retired-ids');
  }

  /**
   * Legislative Districts API — all Congressional districts + Senate seats
   * for a state. NOT routed through `fetchPaged`: this endpoint has no
   * updated_from/updated_to window and returns the whole list in one call
   * (districts change only at redistricting, not incrementally). Construct
   * this LegiStormClient with `baseUrl` pointed at the Districts API
   * (`.../v2.023.07/legislative_districts`) — the Congressional-API default
   * base URL does not serve this path.
   */
  async fetchCongressDistrictList(
    state: string,
    status?: 'C' | 'F',
  ): Promise<LegiStormDistrictListResult> {
    const params: Record<string, string> = { state };
    if (status) params.status = status;
    const body = await this.requestJson('/congress/list', params);
    return this.toDistrictListResult('/congress/list', body);
  }

  /**
   * Legislative Districts API — ZIP-to-district matching. A ZIP can span
   * multiple districts (boundaries aren't ZIP-aligned), so this can return
   * more than one record; `zip4` narrows to a single match when known.
   */
  async fetchCongressDistrictsByZip(
    zip: string,
    zip4?: string,
  ): Promise<LegiStormDistrictListResult> {
    const params: Record<string, string> = { zip };
    if (zip4) params.zip4 = zip4;
    const body = await this.requestJson('/congress/zipcode', params);
    return this.toDistrictListResult('/congress/zipcode', body);
  }

  /**
   * Fetch a district boundary from a `kml` URL LegiStorm already returned on
   * a district record (see LegiStormCongressDistrictRecord.kml) — this does
   * NOT construct a URL itself. That URL embeds our API key in its PATH, not
   * a header: auth here is the URL itself, so this method deliberately does
   * NOT send `X-API-KEY`. www.legistorm.com (unlike api.legistorm.com) 403s a
   * non-browser User-Agent, so this sends one. Caller is responsible for
   * never logging/persisting the raw kmlUrl — re-host the returned content
   * under our own S3 key instead.
   */
  async fetchDistrictKml(kmlUrl: string): Promise<string> {
    const url = new URL(kmlUrl);
    if (url.protocol !== 'https:') throw new Error('kmlUrl must use HTTPS');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': KML_USER_AGENT,
          Accept: 'application/vnd.google-earth.kml+xml, text/xml, */*',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new Error(`LegiStorm KML fetch failed with HTTP ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private toDistrictListResult(path: string, body: unknown): LegiStormDistrictListResult {
    if (!Array.isArray(body)) throw new Error(`LegiStorm ${path} expected an array response`);
    const records: LegiStormCongressDistrictRecord[] = [];
    for (const value of body) {
      if (hasRequiredCongressDistrictIdentity(value)) records.push(value);
    }
    return { records, rawBody: body };
  }

  private async fetchPaged<T extends LegiStormVendorRecord>(
    path: string,
    range: LegiStormDateRange,
    guard: (value: unknown) => value is T,
    extraParams: Record<string, string> = {},
  ): Promise<LegiStormPagedResult<T>> {
    validateDateRange(range);
    const records: T[] = [];
    const rawPages: LegiStormRawPage[] = [];
    const seenFullPages = new Set<string>();

    for (let page = 1; ; page += 1) {
      if (page > this.maxPages) {
        throw new Error(`LegiStorm ${path} exceeded maximum page count ${this.maxPages}`);
      }
      const body = await this.requestJson(path, {
        updated_from: range.updatedFrom,
        updated_to: range.updatedTo,
        ...extraParams,
        limit: String(this.pageSize),
        page: String(page),
      });
      if (!Array.isArray(body)) throw new Error(`LegiStorm ${path} expected an array response`);

      if (body.length === this.pageSize) {
        const fingerprint = JSON.stringify(body);
        if (seenFullPages.has(fingerprint)) {
          throw new Error(`LegiStorm ${path} returned a repeated page`);
        }
        seenFullPages.add(fingerprint);
      }

      // The live list responses are mixed arrays — e.g. /office/list appends a
      // trailing `{ office_member_addresses: [...] }` element with no `office`.
      // Skip elements that aren't the expected record (they're preserved verbatim
      // in rawPages); a throw-all on one non-record element would kill the pull.
      const pageRecords: T[] = [];
      for (let index = 0; index < body.length; index += 1) {
        const record = body[index];
        if (guard(record)) pageRecords.push(record);
      }

      rawPages.push({ page, body });
      records.push(...pageRecords);
      if (body.length < this.pageSize) break;
      if (this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
    }

    return { records, rawPages };
  }

  private async fetchRetiredIds(path: string): Promise<LegiStormRetiredIdsResult> {
    const body = await this.requestJson(path);
    if (!Array.isArray(body)) throw new Error(`LegiStorm ${path} expected an array response`);

    const ids = body.map((value, index) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`LegiStorm ${path} returned an invalid retired ID at index ${index}`);
      }
      return value;
    });
    return { ids, rawBody: body };
  }

  private async requestJson(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let result: { response: Response; body: unknown };
      try {
        result = await this.fetchOnce(url);
      } catch (error) {
        if (error instanceof InvalidJsonError) {
          throw new Error(`LegiStorm ${path} returned invalid JSON`);
        }
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs());
          continue;
        }
        throw new Error(`LegiStorm ${path} request failed after ${attempt + 1} attempts`);
      }

      const { response, body } = result;
      if (response.ok) {
        return body;
      }

      if (isRetryable(response.status) && attempt < this.maxRetries) {
        await this.sleep(
          retryDelayMs(response, this.backoffMs(), this.maxRetryDelayMs, this.now()),
        );
        continue;
      }
      throw new Error(`LegiStorm ${path} failed with HTTP ${response.status}`);
    }

    throw new Error(`LegiStorm ${path} request failed`);
  }

  private async fetchOnce(url: URL): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'X-API-KEY': this.apiKey, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) return { response, body: undefined };
      try {
        return { response, body: await response.json() };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new InvalidJsonError();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffMs(): number {
    return 500 + Math.floor(clampRandom(this.random()) * 250);
  }
}

class InvalidJsonError extends Error {}

function validateDateRange(range: LegiStormDateRange): void {
  for (const [name, value] of [
    ['updatedFrom', range.updatedFrom],
    ['updatedTo', range.updatedTo],
  ] as const) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    const roundTrip = Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
    if (!ISO_DATE.test(value) || roundTrip !== value) {
      throw new Error(`${name} must be a valid YYYY-MM-DD date`);
    }
  }
  if (range.updatedFrom > range.updatedTo) {
    throw new Error('updatedFrom must not be after updatedTo');
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(response: Response, fallback: number, maximum: number, now: number): number {
  const header = response.headers.get('retry-after');
  if (header === null) return Math.min(fallback, maximum);

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maximum);

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return Math.min(fallback, maximum);
  return Math.min(Math.max(0, retryAt - now), maximum);
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
