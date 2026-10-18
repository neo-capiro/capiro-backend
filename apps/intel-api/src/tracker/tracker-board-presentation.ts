import { isStateBillKey, humanizeStateBillKey } from '@capiro/shared';
import { BILL_STAGES, type BillStage } from './bill-stage.util.js';
import { humanizeBillId, type RelevanceBill } from './relevance.util.js';
/**
 * Build the two bound LIKE patterns for bill search (P1.1, ported from
 * apps/api tracker.service.searchBills): a lowercase title substring, plus a
 * bill-id token — "H.R. 4455" → "%hr-4455%" (strip dots/spaces, hyphen between
 * the alpha type and the first digit) so the query matches the id form.
 * Exported for the pure-unit spec.
 */
export function billSearchPatterns(query: string): { titleLike: string; idLike: string } {
  const titleLike = `%${query.toLowerCase()}%`;
  const idLike = `%${query
    .toLowerCase()
    .replace(/[.\s]+/g, '')
    .replace(/^([a-z]+)(\d)/, '$1-$2')}%`;
  return { titleLike, idLike };
}

/**
 * Pure reducer for the client-profile tab-badge summary — legacy-identical
 * `{ boardCount, unread }` (apps/api tracker.service.getSummary). The legacy
 * service derives `unread` per card from change events vs 'opened' feedback;
 * here `intel_tracked_bill.unread` already stores that bit (getBoard's cards
 * read it verbatim), so counting rows matches the board without paying for fit
 * scoring or alert lookups. Exported for the unit spec.
 */
export function summarizeTrackedRows(rows: Array<{ unread: boolean }>): {
  boardCount: number;
  unread: number;
} {
  let unread = 0;
  for (const r of rows) if (r.unread) unread += 1;
  return { boardCount: rows.length, unread };
}
export const stageLabelOf = (s: BillStage): string =>
  BILL_STAGES.find((x) => x.id === s)?.label ?? s;

/**
 * P0-04: `id` and `sponsorName` are optional because `fetchMergedBills`'s
 * minimal common shape (board/getTenantBoard matchedTags) carries neither —
 * legislator routing is consequently inert on that rail. Callers that DO have
 * the underlying congress_bill/state bill row (recommendations) pass both.
 */
export const toRelevanceBill = (b: {
  title: string | null;
  policyArea: string | null;
  subjects: string[] | null;
  latestActionText: string | null;
  id?: string;
  sponsorName?: string | null;
  /** Gate K (HP-02, e-4): only fetchRecommendationBills' row shape carries this. */
  peCodes?: string[] | null;
}): RelevanceBill => ({
  title: b.title ?? '',
  policyArea: b.policyArea,
  subjects: b.subjects,
  latestActionText: b.latestActionText,
  ...(b.id
    ? {
        billId: b.id,
        displayNum: isStateBillKey(b.id) ? humanizeStateBillKey(b.id) : humanizeBillId(b.id),
      }
    : {}),
  ...(b.sponsorName !== undefined ? { sponsorName: b.sponsorName } : {}),
  ...(b.peCodes !== undefined ? { programElements: b.peCodes } : {}),
});
