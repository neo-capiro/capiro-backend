import { sha256Bytes } from '../../defense-budget/contracts/canonical-json.js';
import type { Chamber } from './community-funding.types.js';

export const SOURCE_PAGES: Record<Chamber, Record<number, string>> = {
  house: {
    2022: 'https://appropriations.house.gov/fy22-community-project-funding',
    2023: 'https://appropriations.house.gov/member-requests/fy23-community-project-funding',
    2024: 'https://appropriations.house.gov/fiscal-year-2024-community-project-funding',
    2025: 'https://appropriations.house.gov/committee-activity/fy25-community-project-funding',
    2026: 'https://appropriations.house.gov/fy26-member-requests/fy26-community-project-funding',
    2027: 'https://appropriations.house.gov/fy27-information/fy27-community-project-funding',
  },
  senate: {
    2022: 'https://www.appropriations.senate.gov/fy-2022-congressionally-directed-spending',
    2023: 'https://www.appropriations.senate.gov/fy-2023-congressionally-directed-spending',
    2024: 'https://www.appropriations.senate.gov/fy-2024-congressionally-directed-spending',
    2025: 'https://www.appropriations.senate.gov/fy-2025-congressionally-directed-spending',
    2026: 'https://www.appropriations.senate.gov/fy-2026-congressionally-directed-spending',
    2027: 'https://www.appropriations.senate.gov/fy27-appropriations-requests-and-congressionally-directed-spending',
  },
};

export interface DiscoveredSource { url: string; title: string | null; format: 'pdf' | 'xlsx'; resolution: 'accepted' | 'rejected'; reason: string }

export function discoverDocumentLinks(html: string, baseUrl: string, chamber: Chamber): DiscoveredSource[] {
  const seen = new Set<string>(), out: DiscoveredSource[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const url = new URL(match[1]!, baseUrl).href, ext = new URL(url).pathname.toLowerCase();
    if (!ext.endsWith('.pdf') && !ext.endsWith('.xlsx')) continue;
    if (seen.has(url)) continue; seen.add(url);
    const format = ext.endsWith('.xlsx') ? 'xlsx' : 'pdf';
    const accepted = chamber === 'house' || format === 'pdf';
    out.push({ url, title: match[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || null, format,
      resolution: accepted ? 'accepted' : 'rejected', reason: accepted ? 'official fiscal-year document link' : 'Senate adapter accepts PDF only' });
  }
  return out;
}

export async function fetchDiscoveryPage(chamber: Chamber, fiscalYear: number, fetcher: typeof fetch = fetch) {
  const requestUrl = SOURCE_PAGES[chamber][fiscalYear];
  if (!requestUrl) throw new Error(`unsupported ${chamber} fiscal year ${fiscalYear}; verified coverage is FY2022-FY2027`);
  const startedAt = new Date(), response = await fetcher(requestUrl), bytes = new Uint8Array(await response.arrayBuffer());
  const html = new TextDecoder().decode(bytes), candidates = response.ok ? discoverDocumentLinks(html, requestUrl, chamber) : [];
  return { adapterId: `community-funding-${chamber}-v1`, runKey: `${chamber}-fy${fiscalYear}-${sha256Bytes(bytes).slice(0, 16)}`,
    requestUrl, statusCode: response.status, status: response.ok ? 'ok' : 'failed', contentSha256: sha256Bytes(bytes), byteSize: bytes.length,
    itemsSeen: candidates.length, startedAt, finishedAt: new Date(), failureReason: response.ok ? null : `HTTP ${response.status}`, candidates };
}
