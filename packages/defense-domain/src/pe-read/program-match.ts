/**
 * PE -> Program match confidence tiers + the "Why-shown" evidence line.
 *
 * Hoisted from `apps/api/src/program-element/matching/program-match-thresholds.ts`
 * and the `buildWhyShown` / `buildProgramWhyShown` helpers in `programs.service.ts` /
 * `program-element-read.service.ts` (which are the same function, duplicated there).
 * Pure: no DB, no Nest.
 */
export type MatchStatus = 'accepted' | 'candidate' | 'quarantined' | 'rejected';

export type EvidenceTier =
  | 'mdap_curated'
  | 'exact_pe_number'
  | 'exact_project_title'
  | 'r2a_office_named'
  | 'other_funding_link'
  | 'official_office_page'
  | 'sar_msar'
  | 'sam_match'
  | 'award_match'
  | 'press_release'
  | 'news_only';

export const OFFICIAL_EXACT_TIERS: ReadonlySet<EvidenceTier> = new Set<EvidenceTier>([
  'exact_pe_number',
  'exact_project_title',
  'r2a_office_named',
  'official_office_page',
]);

/** Auto-accept lower bound (inclusive). Below this, never accepted from any path. */
export const ACCEPT_MIN = 0.9;
/** Candidate lower bound (inclusive): [0.70, 0.90) -> candidate. */
export const CANDIDATE_MIN = 0.7;
/** Quarantine lower bound (inclusive): [0.50, 0.70) -> quarantined. */
export const QUARANTINE_MIN = 0.5;

export function isOfficialExactTier(tier: string): boolean {
  return OFFICIAL_EXACT_TIERS.has(tier as EvidenceTier);
}

export function deriveMatchStatus(score: number, evidenceTier: string): MatchStatus {
  if (
    score >= ACCEPT_MIN &&
    (evidenceTier === 'mdap_curated' || isOfficialExactTier(evidenceTier))
  ) {
    return 'accepted';
  }
  if (score >= CANDIDATE_MIN) return 'candidate';
  return 'quarantined';
}

/** True when a match is a weak signal (<0.50): stored, flagged, NEVER surfaced. */
export function isWeakSignal(score: number): boolean {
  return score < QUARANTINE_MIN;
}

/** Human-readable confidence band for the UI. */
export function confidenceBand(score: number): 'high' | 'medium' | 'low' | 'weak' {
  if (score >= ACCEPT_MIN) return 'high';
  if (score >= CANDIDATE_MIN) return 'medium';
  if (score >= QUARANTINE_MIN) return 'low';
  return 'weak';
}

/**
 * Build the "Why-shown" evidence summary line from the evidence jsonb, e.g.
 * "project title exact match + R-2A p.144 + P-1 line 027".
 */
export function buildWhyShown(evidence: unknown): string {
  if (!Array.isArray(evidence)) return '';
  const parts: string[] = [];
  for (const item of evidence as Array<Record<string, unknown>>) {
    const kind = typeof item?.kind === 'string' ? item.kind : '';
    const page = typeof item?.pageNumber === 'number' ? ` p.${item.pageNumber}` : '';
    const quote = typeof item?.quote === 'string' ? item.quote : '';
    if (kind === 'mdap_curated') parts.push('curated MDAP map');
    else if (kind === 'other_funding_link') parts.push(`shared P-1 line${page}`);
    else if (kind.startsWith('alias_trigram')) parts.push(quote || 'alias match');
    else if (quote) parts.push(`${quote}${page}`);
    else if (kind) parts.push(`${kind}${page}`);
  }
  return parts.join(' + ');
}
