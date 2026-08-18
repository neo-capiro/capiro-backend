/**
 * Proof-pack source ordering — exhibits in document order
 * (R-1 -> R-2 -> R-2A -> R-3 -> P-1 -> P-40 -> other), then FY desc, page asc.
 *
 * Hoisted verbatim from `apps/api/src/program-element/proof-pack.ts` so
 * defense-api's `GET /program-elements/:peCode/sources` orders citations
 * identically without importing apps/api. Pinned by the Session 3 provenance
 * parity suite, which imports both comparators and asserts they induce the same
 * permutation over a shuffled fixture.
 */
const EXHIBIT_ORDER = ['R-1', 'R-2', 'R-2A', 'R-3', 'P-1', 'P-40'];

/** Lower rank sorts first. Unknown exhibits sort after the known ones (stable by docType). */
export function proofPackRank(
  docType: string | null | undefined,
  exhibitType: string | null | undefined,
): number {
  const e = (exhibitType ?? '').toUpperCase().replace(/\s+/g, '');
  const idx = EXHIBIT_ORDER.indexOf(e);
  if (idx >= 0) return idx;
  // No recognized exhibit: keep procurement (P) docs after R docs, everything else last.
  const d = (docType ?? '').toUpperCase();
  if (d === 'P') return EXHIBIT_ORDER.length + 1;
  return EXHIBIT_ORDER.length + 2;
}

export interface ProofPackSortable {
  docType: string | null;
  exhibitType: string | null;
  fy: number | null;
  pageNumber: number | null;
}

/** Comparator for proof-pack citations: exhibit order, then FY desc, then page asc. */
export function compareProofPackSources(a: ProofPackSortable, b: ProofPackSortable): number {
  const ra = proofPackRank(a.docType, a.exhibitType);
  const rb = proofPackRank(b.docType, b.exhibitType);
  if (ra !== rb) return ra - rb;
  const fya = a.fy ?? -1;
  const fyb = b.fy ?? -1;
  if (fya !== fyb) return fyb - fya; // most recent fiscal year first
  return (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER);
}
