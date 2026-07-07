/**
 * Canonical entity IDs (Bucket-#3 C6) — the contract lives in @capiro/shared
 * (lowest common dependency of every surface). Re-export seam so meriv2-core
 * tools import from their own package like every other primitive.
 *
 * The zod schemas below (P6.2 tool enforcement) live HERE, not in shared:
 * zod is a meriv2-core dependency, and native ToolDefinitions declare their
 * inputSchema in this package. A param typed with one of these can only ever
 * carry a validated, normalized canonical id — a member NAME or a made-up id
 * shape fails at the registry's safeParse choke point before the handler runs.
 */
import { z } from 'zod';
import {
  isValidCanonicalId as _isValidCanonicalId,
  normalizeCanonicalId as _normalizeCanonicalId,
  type CanonicalIdType as _CanonicalIdType,
} from '@capiro/shared';

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

/** zod schema for one canonical-id type: normalizes, then validates. */
export function zCanonicalId(type: _CanonicalIdType) {
  return z
    .string()
    .transform((v) => _normalizeCanonicalId(type, v))
    .refine((v) => _isValidCanonicalId(type, v), {
      message: `not a valid canonical ${type} id`,
    });
}

export const zBioguideId = zCanonicalId('bioguide');
export const zBillId = zCanonicalId('billId');
export const zCommitteeSystemCode = zCanonicalId('committee');
