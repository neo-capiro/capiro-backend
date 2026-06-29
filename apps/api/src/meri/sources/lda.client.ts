import { fetchJson } from './http.js';
import type { SearchOptions, SearchResult } from './types.js';
import { clampPositiveInt, compactSnippet } from './utils.js';

// Legacy host lda.senate.gov retires 2026-06-30; lda.gov serves the same
// /api/v1 surface. Anonymous works (15 req/min); LDA_API_KEY raises it to 120.
const LDA_API_ROOT = 'https://lda.gov/api/v1/';
const LDA_API_KEY = process.env.LDA_API_KEY ?? '';

// LDA authenticates via `Authorization: Token <key>` (a bad token 401s; the
// older `x-api-key` header is ignored). Returns {} when no key is configured.
function ldaAuthHeaders(): Record<string, string> {
  return LDA_API_KEY ? { Authorization: `Token ${LDA_API_KEY}` } : {};
}

export interface LdaOrganization {
  id?: number;
  url?: string;
  name?: string;
  description?: string | null;
  state?: string | null;
  state_display?: string | null;
  country?: string | null;
  country_display?: string | null;
}

export interface LdaLobbyingActivity {
  general_issue_code?: string | null;
  general_issue_code_display?: string | null;
  description?: string | null;
  foreign_entity_issues?: string | null;
}

export interface LdaFiling {
  url: string;
  filing_uuid: string;
  filing_type?: string;
  filing_type_display?: string;
  filing_year?: number;
  filing_period?: string | null;
  filing_period_display?: string | null;
  filing_document_url?: string | null;
  income?: string | null;
  expenses?: string | null;
  dt_posted?: string | null;
  registrant?: LdaOrganization | null;
  client?: LdaOrganization | null;
  lobbying_activities?: LdaLobbyingActivity[];
  [key: string]: unknown;
}

export interface LdaSearchOptions extends SearchOptions {
  year?: number;
  registrantName?: string;
  issue?: string;
}

interface LdaSearchResponse {
  results?: LdaFiling[];
}

export class LdaClient {
  async search(query: string, opts: LdaSearchOptions = {}): Promise<SearchResult[]> {
    return this.searchFilings(query, opts.year ?? new Date().getUTCFullYear(), opts);
  }

  async searchFilings(clientName: string, year: number, opts: LdaSearchOptions = {}): Promise<SearchResult[]> {
    const url = ldaUrl('filings/');
    url.searchParams.set('client_name', clientName.trim());
    url.searchParams.set('filing_year', String(year));
    url.searchParams.set('page_size', String(clampPositiveInt(opts.limit, 20, 100)));
    url.searchParams.set('page', String(clampPositiveInt(opts.page, 1, 1000)));
    if (opts.registrantName) url.searchParams.set('registrant_name', opts.registrantName);
    if (opts.issue) url.searchParams.set('general_issue_code', opts.issue);

    const response = await fetchJson<LdaSearchResponse>(url, {
      headers: ldaAuthHeaders(),
      secrets: LDA_API_KEY ? [LDA_API_KEY] : [],
    });
    return (response.results ?? []).map(ldaFilingToSearchResult);
  }

  async getFiling(filingId: string): Promise<LdaFiling> {
    return fetchJson<LdaFiling>(ldaUrl(`filings/${encodeURIComponent(filingId.trim())}/`), {
      headers: ldaAuthHeaders(),
      secrets: LDA_API_KEY ? [LDA_API_KEY] : [],
    });
  }
}

function ldaUrl(path: string): URL {
  return new URL(path, LDA_API_ROOT);
}

function ldaFilingToSearchResult(filing: LdaFiling): SearchResult {
  const clientName = filing.client?.name ?? 'Unknown client';
  const registrantName = filing.registrant?.name ?? 'Unknown registrant';
  const filingType = filing.filing_type_display ?? filing.filing_type ?? 'LDA filing';
  const year = filing.filing_year ? ` ${filing.filing_year}` : '';

  return {
    id: filing.filing_uuid,
    title: `${clientName} - ${filingType}${year}`,
    url: filing.filing_document_url ?? filing.url,
    snippet: compactSnippet([
      `Registrant: ${registrantName}`,
      filing.filing_period_display,
      filing.income ? `Income: ${filing.income}` : null,
      filing.expenses ? `Expenses: ${filing.expenses}` : null,
      ...(filing.lobbying_activities ?? [])
        .slice(0, 3)
        .map((activity) => compactSnippet([activity.general_issue_code_display, activity.description], 220)),
    ]),
    publishedAt: filing.dt_posted ?? null,
    source: 'lda',
  };
}

