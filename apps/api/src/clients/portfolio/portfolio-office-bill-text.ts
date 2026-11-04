import type { CongressBill } from '@prisma/client';
import {
  billTextSearchQuery,
  validateBillTextSearch,
  type BillTextDocumentRow,
} from '../../retrieval/bill-text-query.js';
import { readBillDocument } from '../../retrieval/bill-text-read.js';
import type { PortfolioTx } from './portfolio-proposal.store.js';
import { hitsTerms, officialEvidence } from './portfolio-office-evidence.js';
import type { OfficeSignal } from './portfolio-office-signals.js';

/** Use the immutable bill-text owner and its structure/hash proof. Each phrase is
 * searched separately because the existing keyword owner deliberately ANDs terms. */
export async function defenseTextSignals(
  tx: PortfolioTx,
  bills: CongressBill[],
  terms: string[],
): Promise<OfficeSignal[]> {
  const queries = terms
    .slice(0, 8)
    .map((term) => term.replace(/["\\\n\r]/g, ' ').trim())
    .filter(Boolean);
  const signals: OfficeSignal[] = [];
  for (const bill of bills
    .filter((row) =>
      /\b(?:national defense authorization|defense appropriations|NDAA)\b/i.test(row.title),
    )
    .slice(0, 8)) {
    for (const term of queries) {
      const request = validateBillTextSearch({
        mode: 'keyword',
        query: `"${term}"`,
        billId: bill.id,
        limit: 3,
      });
      const search = billTextSearchQuery(request);
      const rows = await tx.$queryRawUnsafe<BillTextDocumentRow[]>(search.sql, ...search.values);
      for (const row of rows) {
        const phraseAt = row.text?.toLowerCase().indexOf(term.toLowerCase()) ?? -1;
        const passage = readBillDocument(row, {
          offset: Math.max(0, (phraseAt >= 0 ? phraseAt : (row.hitOffset ?? 0)) - 150),
          length: 1400,
          contextChars: 2400,
        });
        if (!passage.available || !('text' in passage) || !hitsTerms(passage.text, terms)) continue;
        const evidence = officialEvidence(
          row.sourceUrl,
          bill.title,
          passage.text,
          bill.lastSyncedAt,
        );
        if (evidence)
          signals.push({
            kind: 'defense_priority',
            rationale: `Approved terms occur in the retained ${row.version ?? 'published'} text of ${bill.title}; confirm the operative version before making an ask.`,
            evidence,
          });
      }
      if (signals.some((signal) => signal.evidence.title === bill.title.slice(0, 180))) break;
    }
  }
  return signals;
}
