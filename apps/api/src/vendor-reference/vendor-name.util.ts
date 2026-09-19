/**
 * Company-name normalization for EXACT comparison, kept byte-for-byte in step
 * with `SamEntityEnrichmentService.normalize` (intelligence/sam-entity.service.ts)
 * — the parity spec in vendor-name.util.spec.ts fails if the two ever drift.
 *
 * Duplicated rather than injected because the SAM enrichment service lives in
 * IntelligenceModule (a wide module graph this read-only module has no other
 * reason to import), and because the rule must stay identical to the one that
 * assigns UEIs to the firm's own clients: a vendor matched by a looser rule
 * would be held to a lower identity standard than the client it is compared to.
 *
 * Deliberately excludes ambiguous words like GROUP / HOLDINGS / PARTNERS that
 * are part of a distinct legal name.
 */
const LEGAL_SUFFIX_RE =
  /\b(THE|INC|INCORPORATED|LLC|L L C|LLP|L L P|LP|L P|CO|CORP|CORPORATION|COMPANY|LTD|LIMITED|PLLC|PC)\b/g;

export function normalizeCompanyName(name: string | null | undefined): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const UEI_RE = /^[A-Z0-9]{12}$/;
export const CAGE_RE = /^[A-Z0-9]{5}$/;

export function normalizeUei(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return UEI_RE.test(s) ? s : null;
}

export function normalizeCage(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase();
  return CAGE_RE.test(s) ? s : null;
}

/** Distinct, non-empty name variants in input order. */
export function uniqueNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = (n ?? '').trim();
    if (!t) continue;
    const key = normalizeCompanyName(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
