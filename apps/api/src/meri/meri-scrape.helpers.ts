/**
 * Pure helpers for Meri's scrape_web_page tool. No I/O — unit-tested under the
 * repo's standard `src/**.spec.ts` matcher.
 */

/**
 * Whether a fetched resource should go down the PDF-extraction path: either
 * the response says application/pdf (params/case ignored) or, when the server
 * sends a generic/absent content type, the URL path itself ends in `.pdf`
 * (query string excluded). An explicit non-PDF content type like text/html
 * only defers to the URL when it is missing/generic — a .pdf-looking query
 * param never triggers the PDF path.
 */
export function looksLikePdf(
  contentType: string | null | undefined,
  url: string | null | undefined,
): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/pdf') || ct.includes('application/x-pdf')) return true;
  if (ct.includes('text/') || ct.includes('html') || ct.includes('xml') || ct.includes('json')) {
    return false;
  }
  if (!url) return false;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}
