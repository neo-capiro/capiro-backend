import type { Prisma } from '@prisma/client';
import { bool, int, num, str } from './tango.mappers.js';

/**
 * Funding Opportunities P40 — raw DIBBS JSON to the rows `tango_dibbs_*` store.
 *
 * The provider publishes three list endpoints — `/api/dibbs/rfqs/`,
 * `/api/dibbs/rfps/`, `/api/dibbs/awards/` — whose contract is transcribed in
 * `docs/plans/funding-opportunities-makegov-v1/dibbs-sbir-rest-contract.md`.
 *
 * ── EVERYTHING HERE IS PROVISIONAL, AND THAT IS NOT A DISCLAIMER ────────────
 *
 * The published documentation gives field NAMES. It does not give types, null
 * semantics, date formats, or the pagination envelope. No live call has been
 * made — no key was available, and per plan §4.6 a key must never pass through
 * an agent session. So every coercion below is a conservative READING of a
 * name, not a confirmed fact, and the tests pin the reading rather than the
 * provider's behaviour.
 *
 * Concretely, that means this file is written to survive being wrong: an
 * unparseable value becomes null rather than a guess, a record with no usable
 * identity is dropped and counted rather than half-mapped, and no field is
 * inferred from another. Confirm against one real response before trusting any
 * type here — and expect at least one of them to be wrong.
 *
 * ── WHY RFQ AND RFP SHARE A ROW TYPE BUT NOT A MAPPER ───────────────────────
 *
 * They normalize to one table (see the migration header). But the provider
 * spells two of their fields differently for the same concept:
 *
 *     RFQ: issue_date  / return_by_date
 *     RFP: issued_date / closes_date
 *
 * Two mappers, each naming its own source spelling explicitly, rather than one
 * that reads four keys and takes whichever is present. The latter would silently
 * accept an RFP that arrived with an RFQ's field names, which is exactly the
 * kind of "it worked, so the shape must be right" inference this program has
 * been burned by. If the provider changes a spelling, the correct outcome is a
 * null and a failing test — not a quiet success against the other endpoint's
 * schema.
 */

export type TangoDibbsSolicitationRow = Omit<
  Prisma.TangoDibbsSolicitationCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

export type TangoDibbsAwardRow = Omit<
  Prisma.TangoDibbsAwardCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

/**
 * A DATE column wants a calendar day, not an instant.
 *
 * Anchored at UTC midnight so that a bid closing on the 30th is the 30th
 * everywhere, rather than the 29th for anyone west of Greenwich. The provider's
 * format is undocumented; both a date-only string and a full timestamp are
 * accepted, and anything else is null rather than an Invalid Date — a row whose
 * closing date silently became `NaN` would pass every type check and be wrong
 * in the one field a pursuer acts on.
 */
export function dateOnly(value: unknown): Date | null {
  const text = str(value);
  if (text == null) return null;

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    const parsed = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/**
 * Money and quantity, as an EXACT decimal string.
 *
 * Deliberately not `num()`. `num()` returns a JS number, and these columns are
 * NUMERIC(18,2)/(18,4) — a value near the top of that range exceeds 2^53 and
 * would lose its last digits on the way through a float. Prisma accepts a
 * string for a Decimal column, so the provider's own digits are handed over
 * untouched whenever they already are digits.
 *
 * A numeric string keeps its exact text. A JS number is stringified. Currency
 * decoration (`$1,234.50`) is stripped via `num()` as a fallback, accepting the
 * float round-trip in the one case where the alternative is dropping the value:
 * a decorated string was never exact input to begin with.
 */
export function decimalString(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;

  const text = str(value);
  if (text == null) return null;

  if (/^-?\d+(\.\d+)?$/.test(text)) return text;

  const fallback = num(text);
  return fallback == null ? null : String(fallback);
}

/** The fields RFQ and RFP genuinely share, read identically for both. */
function commonSolicitationFields(raw: Record<string, unknown>) {
  return {
    solicitation: str(raw['solicitation']),
    nsn: str(raw['nsn']),
    partNumber: str(raw['part_number']),
    nomenclature: str(raw['nomenclature']),
    isOpen: bool(raw['is_open']),
    documentUrl: str(raw['document_url']),
  };
}

/**
 * A quantity with no unit of issue is dropped, and the row is kept.
 *
 * `tango_dibbs_solicitation_quantity_unit_chk` refuses a quantity whose unit is
 * null, so something has to give. The choice is deliberate: inventing a unit
 * ("EA") would be inventing the FACT — 500 of an unknown unit is not 500 each —
 * while dropping the whole solicitation would lose a real, biddable item over a
 * secondary field. So the quantity goes and the solicitation stays.
 *
 * This is a real, if small, data loss, which is why it returns the pair rather
 * than mutating quietly: the caller can count it. It should be rare, and if a
 * sync run reports it often, that is evidence the reading of one of these two
 * fields is wrong — not something to tune away.
 */
export function reconcileQuantity(
  quantity: string | null,
  unitOfIssue: string | null,
): { quantity: string | null; unitOfIssue: string | null; quantityDropped: boolean } {
  if (quantity != null && unitOfIssue == null) {
    return { quantity: null, unitOfIssue: null, quantityDropped: true };
  }
  return { quantity, unitOfIssue, quantityDropped: false };
}

/**
 * `/api/dibbs/rfqs/` — a request for quote.
 *
 * Returns null when the record has no provider `uuid` or no `solicitation`:
 * the first is the upsert key and the second is NOT NULL on the table, so a
 * record missing either cannot be stored without inventing one. Dropped and
 * counted, never half-mapped.
 */
export function mapDibbsRfq(raw: Record<string, unknown>): TangoDibbsSolicitationRow | null {
  const tangoDibbsId = str(raw['uuid']);
  const common = commonSolicitationFields(raw);
  if (tangoDibbsId == null || common.solicitation == null) return null;

  const { quantity, unitOfIssue } = reconcileQuantity(
    decimalString(raw['quantity']),
    str(raw['unit_of_issue']),
  );

  return {
    tangoDibbsId,
    documentType: 'rfq',
    solicitation: common.solicitation,
    solicitationFormatted: str(raw['solicitation_formatted']),
    purchaseRequest: str(raw['purchase_request']),
    nsn: common.nsn,
    partNumber: common.partNumber,
    nomenclature: common.nomenclature,
    quantity,
    unitOfIssue,
    setAside: str(raw['set_aside']),
    statusCode: str(raw['status_code']),
    buyerCode: null, // RFP-only field; an RFQ never states one.
    // RFQ's own spelling. Not `issued_date`/`closes_date` — see the file doc.
    issuedDate: dateOnly(raw['issue_date']),
    closesDate: dateOnly(raw['return_by_date']),
    isOpen: common.isOpen,
    documentUrl: common.documentUrl,
    techDocsUrl: null, // RFP-only.
  };
}

/** `/api/dibbs/rfps/` — a request for proposal / invitation for bid. */
export function mapDibbsRfp(raw: Record<string, unknown>): TangoDibbsSolicitationRow | null {
  const tangoDibbsId = str(raw['uuid']);
  const common = commonSolicitationFields(raw);
  if (tangoDibbsId == null || common.solicitation == null) return null;

  return {
    tangoDibbsId,
    documentType: 'rfp',
    solicitation: common.solicitation,
    solicitationFormatted: null, // RFQ-detail-only.
    purchaseRequest: null, // RFQ-only.
    nsn: common.nsn,
    partNumber: common.partNumber,
    nomenclature: common.nomenclature,
    // An RFP states no quantity or unit at all. Null, never zero: the provider
    // did not say "none", it did not say anything.
    quantity: null,
    unitOfIssue: null,
    setAside: null, // RFQ-only.
    statusCode: null, // RFQ-only.
    buyerCode: str(raw['buyer_code']),
    // RFP's own spelling, distinct from RFQ's.
    issuedDate: dateOnly(raw['issued_date']),
    closesDate: dateOnly(raw['closes_date']),
    isOpen: common.isOpen,
    documentUrl: common.documentUrl,
    techDocsUrl: str(raw['tech_docs_url']),
  };
}

/**
 * `/api/dibbs/awards/` — an award. INFORMATIONAL ONLY.
 *
 * These rows go to their own table precisely so they cannot be pursued; see the
 * migration header. Nothing in this mapper should ever be reused to build a
 * pursuable row.
 *
 * `awardee_cage` (top level) and the nested `awardee.cage_code` are both stored
 * and NEITHER is derived from the other. The contract documents both, so they
 * are two facts that usually agree — and a mapper that collapsed them would
 * destroy the only evidence available on the day they do not.
 */
export function mapDibbsAward(raw: Record<string, unknown>): TangoDibbsAwardRow | null {
  const tangoDibbsId = str(raw['uuid']);
  const awardNumber = str(raw['award_number']);
  if (tangoDibbsId == null || awardNumber == null) return null;

  const awardee =
    typeof raw['awardee'] === 'object' && raw['awardee'] !== null && !Array.isArray(raw['awardee'])
      ? (raw['awardee'] as Record<string, unknown>)
      : {};

  return {
    tangoDibbsId,
    awardNumber,
    deliveryOrderNumber: str(raw['delivery_order_number']),
    deliveryOrderCounter: int(raw['delivery_order_counter']),
    solicitation: str(raw['solicitation']),
    purchaseRequest: str(raw['purchase_request']),
    nsn: str(raw['nsn']),
    partNumber: str(raw['part_number']),
    nomenclature: str(raw['nomenclature']),
    // NEVER SUM THESE ACROSS ROWS — line-item grain. See the column comment.
    totalContractPrice: decimalString(raw['total_contract_price']),
    totalContractPriceText: str(raw['total_contract_price_text']),
    awardeeCage: str(raw['awardee_cage']),
    awardeeUei: str(awardee['uei']),
    awardeeCageCode: str(awardee['cage_code']),
    awardeeLegalBusinessName: str(awardee['legal_business_name']),
    awardDate: dateOnly(raw['award_date']),
    postedDate: dateOnly(raw['posted_date']),
    lastModPostingDate: dateOnly(raw['last_mod_posting_date']),
  };
}
