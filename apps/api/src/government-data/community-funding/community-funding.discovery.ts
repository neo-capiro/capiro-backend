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

export type DiscoveredSourceKind =
  | 'table_pdf'
  | 'consolidated_xlsx'
  | 'guidance'
  | 'jurisdiction_rules'
  | 'unknown';

export interface DiscoveredSource {
  url: string;
  title: string | null;
  format: 'pdf' | 'xlsx' | 'download';
  kind: DiscoveredSourceKind;
  resolution: 'accepted' | 'rejected';
  reason: string;
}

const NON_TABLE_TITLE =
  /\b(jurisdiction|jurisdictions|rules|guidance|general guidance|instructions|faq|form)\b/i;
const TABLE_TITLE =
  /\b(table|posted|updated|final|addendum|consolidated|cds|cpf|community project|directed spending)\b/i;

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function classifyCandidate(opts: {
  chamber: Chamber;
  title: string | null;
  format: 'pdf' | 'xlsx' | 'download';
  path: string;
}): { kind: DiscoveredSourceKind; accepted: boolean; reason: string } {
  const title = opts.title ?? '';
  const path = opts.path.toLowerCase();

  if (opts.format === 'xlsx') {
    if (opts.chamber === 'senate') {
      return {
        kind: 'unknown',
        accepted: false,
        reason: 'Senate adapter accepts PDF/download only',
      };
    }
    return {
      kind: 'consolidated_xlsx',
      accepted: true,
      reason: 'House consolidated spreadsheet',
    };
  }

  if (NON_TABLE_TITLE.test(title) && !TABLE_TITLE.test(title)) {
    return {
      kind: 'jurisdiction_rules',
      accepted: false,
      reason: 'non-table guidance/rules/jurisdiction document',
    };
  }

  if (/\bguidance\b/i.test(title) || /guidance\.pdf$/i.test(path)) {
    return {
      kind: 'guidance',
      accepted: false,
      reason: 'guidance document, not a funding table',
    };
  }

  // Senate CMS often uses /download/<slug> without a .pdf extension.
  if (opts.format === 'download' || /\/download\//i.test(path)) {
    if (opts.chamber !== 'senate') {
      return {
        kind: 'unknown',
        accepted: false,
        reason: 'download links are Senate-only in this adapter',
      };
    }
    // Prefer CDS-ish slugs; reject obvious non-table outcomes only when title/path say so.
    if (/\boutcomes?\b/i.test(title) || /outcome/i.test(path)) {
      // Outcomes tables are still spending tables for some FYs — accept, mark table_pdf.
      return {
        kind: 'table_pdf',
        accepted: true,
        reason: 'Senate downloadable CDS/outcomes table',
      };
    }
    return {
      kind: 'table_pdf',
      accepted: true,
      reason: 'Senate downloadable CDS document',
    };
  }

  if (opts.format === 'pdf') {
    if (TABLE_TITLE.test(title) || /cds|cpf|table/i.test(path)) {
      return {
        kind: 'table_pdf',
        accepted: true,
        reason: 'official fiscal-year table document link',
      };
    }
    // House pages label many real tables only as "Posted Table" / "Final Table".
    if (opts.chamber === 'house' && /\btable\b/i.test(title || 'table')) {
      return {
        kind: 'table_pdf',
        accepted: true,
        reason: 'House posted/final/updated table link',
      };
    }
    // Bare PDF on a CPF/CDS index page is accepted unless filtered above.
    return {
      kind: 'table_pdf',
      accepted: true,
      reason: 'official fiscal-year document link',
    };
  }

  return {
    kind: 'unknown',
    accepted: false,
    reason: 'unrecognized document shape',
  };
}

/**
 * Resolve a Senate /download/<slug> landing page into a direct PDF URL when the
 * CMS serves an interstitial HTML page with a `...&download=1` link.
 */
export function resolveSenateDownloadUrl(landingUrl: string, html: string): string | null {
  const match = html.match(/href=["']([^"']*download=1[^"']*)["']/i);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], landingUrl).href;
  } catch {
    return null;
  }
}

export function discoverDocumentLinks(
  html: string,
  baseUrl: string,
  chamber: Chamber,
): DiscoveredSource[] {
  const seen = new Set<string>();
  const out: DiscoveredSource[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(re)) {
    let href = match[1]!;
    // Senate relative download paths sometimes start with ../../../download/...
    if (href.includes('/download/') && !/^https?:/i.test(href)) {
      // normalize relative junk
      href = href.replace(/^(\.\.\/)+/, '/');
    }
    let url: string;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    const path = new URL(url).pathname.toLowerCase();
    const isPdf = path.endsWith('.pdf');
    const isXlsx = path.endsWith('.xlsx') || path.endsWith('.xls');
    const isDownload = /\/download\//i.test(path) || /\/download\//i.test(href);
    if (!isPdf && !isXlsx && !isDownload) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const format: DiscoveredSource['format'] = isXlsx ? 'xlsx' : isPdf ? 'pdf' : 'download';
    const title = stripHtml(match[2]!) || null;
    const classified = classifyCandidate({ chamber, title, format, path });
    out.push({
      url,
      title,
      format,
      kind: classified.kind,
      resolution: classified.accepted ? 'accepted' : 'rejected',
      reason: classified.reason,
    });
  }
  return out;
}

export async function fetchDiscoveryPage(
  chamber: Chamber,
  fiscalYear: number,
  fetcher: typeof fetch = fetch,
) {
  const requestUrl = SOURCE_PAGES[chamber][fiscalYear];
  if (!requestUrl) {
    throw new Error(
      `unsupported ${chamber} fiscal year ${fiscalYear}; verified index coverage is FY2022-FY2027`,
    );
  }
  const startedAt = new Date();
  const response = await fetcher(requestUrl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const html = new TextDecoder().decode(bytes);
  const candidates = response.ok ? discoverDocumentLinks(html, requestUrl, chamber) : [];
  return {
    adapterId: `community-funding-${chamber}-v1`,
    runKey: `${chamber}-fy${fiscalYear}-${sha256Bytes(bytes).slice(0, 16)}`,
    requestUrl,
    statusCode: response.status,
    status: response.ok ? 'ok' : 'failed',
    contentSha256: sha256Bytes(bytes),
    byteSize: bytes.length,
    itemsSeen: candidates.length,
    startedAt,
    finishedAt: new Date(),
    failureReason: response.ok ? null : `HTTP ${response.status}`,
    candidates,
  };
}
