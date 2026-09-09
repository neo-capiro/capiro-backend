export interface FecPage<T> {
  results: T[];
  pagination?: {
    pages?: number;
    last_indexes?: Record<string, string | number | boolean | null> | null;
  };
}

export type FecFetcher = <T>(path: string, params: Record<string, string>) => Promise<FecPage<T>>;

export function createFecFetcher(apiKey: string, delayMs = 8000): FecFetcher {
  return async <T>(path: string, params: Record<string, string>): Promise<FecPage<T>> => {
    const url = new URL(`https://api.open.fec.gov/v1${path}`);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('per_page', '100');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // These two daily FEC jobs share a standard 1,000 requests/hour key. Eight
    // seconds each leaves room for overlap. Never log the keyed request URL.
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      } catch {
        throw new Error(`FEC ${path} request failed or timed out`);
      }
      if (response.ok) {
        const data = (await response.json()) as FecPage<T>;
        if (!Array.isArray(data?.results))
          throw new Error(`FEC ${path} returned malformed results`);
        return data;
      }
      if (attempt >= 2 || (response.status !== 429 && response.status < 500)) {
        throw new Error(`FEC ${path} returned HTTP ${response.status}`);
      }
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter == null ? NaN : Number(retryAfter);
      const requestedMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retryAfter ?? '') - Date.now();
      // An hour-long quota exhaustion should be reported as failed coverage; a
      // short service throttle can recover without abandoning the old snapshot.
      if (requestedMs > 60_000)
        throw new Error(`FEC ${path} returned HTTP ${response.status}; retry later`);
      const waitMs = Math.max(Number.isFinite(requestedMs) ? requestedMs : 0, 1000 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

/**
 * Schedule A/B counts are approximate. Only an empty response proves exhaustion.
 * https://github.com/fecgov/openFEC/blob/develop/webservices/docs.py
 */
export async function* fecSchedulePages<T>(
  fetchFec: FecFetcher,
  path: string,
  params: Record<string, string>,
): AsyncGenerator<T[]> {
  let cursor: Record<string, string> = {};
  const seen = new Set<string>();
  while (true) {
    const data = await fetchFec<T>(path, { ...params, ...cursor });
    if (!Array.isArray(data?.results)) throw new Error(`FEC ${path} returned malformed results`);
    if (data.results.length === 0) return;
    const indexes = data.pagination?.last_indexes;
    if (!indexes || indexes.last_index == null) {
      throw new Error(`FEC ${path} omitted the continuation cursor`);
    }
    // Replace, do not merge: the date cursor disappears when sort_null_only starts.
    cursor = Object.fromEntries(
      Object.entries(indexes)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]),
    );
    const signature = JSON.stringify(Object.entries(cursor).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(signature)) throw new Error(`FEC ${path} repeated its continuation cursor`);
    seen.add(signature);
    yield data.results;
  }
}
