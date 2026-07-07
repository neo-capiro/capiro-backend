/**
 * Canonical entity IDs (Bucket-#3 C6) — the contract lives in @capiro/shared
 * (lowest common dependency of every surface). Re-export seam so meriv2-core
 * tools import from their own package like every other primitive.
 */
export {
  CANONICAL_ID_TYPES,
  BILL_TYPES,
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillId,
  formatBillId,
  parseBillDesignation,
  billIdToCongressGovPath,
  type CanonicalIdType,
  type BillType,
  type ParsedBillId,
} from '@capiro/shared';
