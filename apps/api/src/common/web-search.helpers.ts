/**
 * Shared public web-search transport helpers (Tavily/Serper request shaping +
 * response normalization). No I/O here — request construction and response
 * normalization are pure so they unit-test under the repo's standard
 * `src/**.spec.ts` matcher. Callers (meri-tools.service.ts's search_public_web
 * tool, the Knowledge Plane public_web entity-resolution provider, and
 * client-profile-fill.service.ts) perform the actual fetch, pick the provider
 * from CLIO_WEB_SEARCH_PROVIDER + key presence, and own their own fallback
 * behavior when no key is configured or the provider call fails.
 */

export type WebSearchProvider = 'duckduckgo' | 'tavily' | 'serper';

export interface NormalizedWebResult {
  title: string;
  url: string;
  snippet: string | null;
  source: string;
  publishedAt: string | null;
}

export interface WebSearchRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  };
}

/** Build the provider HTTP request. The API key travels in a header, never the body. */
export function buildWebSearchRequest(
  provider: 'tavily' | 'serper',
  query: string,
  limit: number,
  apiKey: string,
): WebSearchRequest {
  if (provider === 'tavily') {
    return {
      url: 'https://api.tavily.com/search',
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, max_results: limit }),
      },
    };
  }
  return {
    url: 'https://google.serper.dev/search',
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({ q: query, num: limit }),
    },
  };
}

/**
 * Normalize a provider response body to the shared result shape. Defensive
 * against malformed payloads: anything that is not a well-formed row (missing
 * title, missing/non-http url) is skipped; a malformed envelope yields [].
 */
export function normalizeWebResults(
  provider: 'tavily' | 'serper',
  raw: unknown,
): NormalizedWebResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const body = raw as Record<string, unknown>;
  const rows = provider === 'tavily' ? body.results : body.organic;
  if (!Array.isArray(rows)) return [];

  const results: NormalizedWebResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const title = cleanText(r.title, 180);
    const url = cleanText(provider === 'tavily' ? r.url : r.link, 2000);
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const snippet = cleanText(provider === 'tavily' ? r.content : r.snippet, 320);
    const publishedAt = cleanText(provider === 'tavily' ? r.published_date : r.date, 40);
    results.push({ title, url, snippet, source: provider, publishedAt });
  }
  return results;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}
