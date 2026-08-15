import { TangoNotConfiguredError, type TangoRateMetadata } from './tango.errors.js';
import type {
  TangoSubawardGateway,
  TangoSubawardListOptions,
  TangoSubawardPage,
} from './tango-subaward.types.js';

const DEFAULT_BASE_URL = 'https://tango.makegov.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const SUBAWARD_SHAPE = [
  'award_key',
  'awarding_office(*)',
  'fsrs_details(last_modified_date)',
  'funding_office(*)',
  'key',
  'naics_code',
  'piid',
  'place_of_performance(*)',
  'prime_recipient(uei,display_name)',
  'subaward_details(*)',
  'subaward_recipient(uei,display_name)',
  'subawardee_parent_uei',
  'subawardee_parent_name',
  'usaspending_permalink',
].join(',');

export interface TangoSubawardClientConfig {
  apiKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TangoSubawardHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TangoSubawardHttpError';
  }
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
  const remainingRaw = headers.get('x-ratelimit-remaining');
  const limitRaw = headers.get('x-ratelimit-limit');
  const resetRaw = headers.get('x-ratelimit-reset-in');
  const retryRaw = headers.get('retry-after');
  const asInteger = (value: string | null): number | null => {
    const n = value == null ? NaN : Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
  };
  const remaining = asInteger(remainingRaw);
  const limit = asInteger(limitRaw);
  const resetIn = asInteger(resetRaw);
  const retryAfter = asInteger(retryRaw);
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

export class TangoSubawardClient implements TangoSubawardGateway {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TangoSubawardClientConfig = {}) {
    this.apiKey = config.apiKey?.trim() || null;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.apiKey != null;
  }

  async listSubawards(options: TangoSubawardListOptions = {}): Promise<TangoSubawardPage> {
    if (!this.apiKey) throw new TangoNotConfiguredError('listSubawards');

    const url = new URL('/api/subawards/', `${this.baseUrl}/`);
    const page = Number.isInteger(options.page) && (options.page ?? 0) > 0 ? options.page! : 1;
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('ordering', '-last_modified_date');
    url.searchParams.set('shape', SUBAWARD_SHAPE);
    if (options.fiscalYear != null) url.searchParams.set('fiscal_year', String(options.fiscalYear));
    if (options.primeUei) url.searchParams.set('prime_uei', options.primeUei);
    if (options.subawardeeUei) url.searchParams.set('sub_uei', options.subawardeeUei);

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
        const bounded = rawText.replace(this.apiKey, '[REDACTED]').slice(0, 500);
        throw new TangoSubawardHttpError(
          response.status,
          `Tango subaward request failed (${response.status})${bounded ? `: ${bounded}` : ''}`,
        );
      }
      let parsed: RawPage;
      try {
        parsed = JSON.parse(rawText) as RawPage;
      } catch {
        throw new TangoSubawardHttpError(
          response.status,
          'Tango subaward response was not valid JSON',
        );
      }
      const items = Array.isArray(parsed.results)
        ? parsed.results.filter(
            (value): value is Record<string, unknown> =>
              value != null && typeof value === 'object' && !Array.isArray(value),
          )
        : [];
      return {
        items,
        totalCount: asCount(parsed.count),
        nextPage: nextPageOf(parsed.next, this.baseUrl),
        rate: rateOf(response.headers),
      };
    } catch (error) {
      if (error instanceof TangoSubawardHttpError || error instanceof TangoNotConfiguredError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TangoSubawardHttpError(
          0,
          `Tango subaward request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new TangoSubawardHttpError(0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}
