/**
 * Session 3 — governed manual-override propose/approve, scoped to the
 * Program Elements reconciliation-queue routes.
 *
 * Pure policy module: no Nest, no Prisma, no clock (time/identity arrive as
 * arguments). This is new source for defense-api, not a byte-copy of
 * apps/api's defense-budget/promotion/manual-override-service-v1.ts (that
 * module's full canonical-mapping-registry spans 1370 lines wiring the
 * broader Phase 7 promotion surface; Session 3's frozen contract only needs
 * the propose/approve semantics for the legacy (peCode, fy, fieldName)
 * reconciliation target). The invariants are the same and deliberately
 * preserved:
 *
 *   1. An override is never a government source observation — it targets a
 *      canonical identity and carries its own governance/provenance, so a
 *      human decision never gets recorded as (or merged with) a parsed
 *      J-book line.
 *   2. The approver may never be the author (enforced here AND in the DB
 *      lifecycle trigger this route boundary does not own).
 *   3. Money travels as canonical exact-decimal strings — this module never
 *      touches a JavaScript float.
 */

const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function isCanonicalDecimalStringV1(value: string): boolean {
  if (!CANONICAL_DECIMAL_RE.test(value)) return false;
  if (value === '-0') return false;
  // Reject unnecessary trailing fractional zeros ("1.20", "5.100") — matches
  // apps/api's isCanonicalDecimalString (contracts/decimal-string.ts). Without
  // this, a non-canonical string round-trips through NUMERIC(24,9) and comes
  // back padded, silently drifting from the exact value the author supplied.
  const dot = value.indexOf('.');
  if (dot >= 0 && value.endsWith('0')) return false;
  return true;
}

/**
 * Normalize a NUMERIC(24,9)-sourced decimal string back to canonical form.
 * Postgres pads a NUMERIC to its declared scale (e.g. "1.25" -> "1.250000000"
 * on read), which is not canonical — canonical form strips trailing
 * fractional zeros. Money is compared/hashed as canonical strings elsewhere
 * in this module, so a value read from the DB must be renormalized before
 * it's treated as equal to the string that was originally proposed.
 */
export function normalizeCanonicalDecimalStringV1(value: string): string {
  if (!CANONICAL_DECIMAL_RE.test(value)) {
    throw new Error(`not a decimal string: "${value}"`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf('.');
  if (dot < 0) return negative ? `-${unsigned}` : unsigned;
  const intPart = unsigned.slice(0, dot);
  const fracPart = unsigned.slice(dot + 1).replace(/0+$/, '');
  const magnitude = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  if (negative && !/^0(\.0*)?$/.test(magnitude)) return `-${magnitude}`;
  return magnitude;
}

export const MANUAL_OVERRIDE_REFUSAL_V1_VALUES = [
  'value_not_canonical_decimal',
  'target_has_open_proposal',
  'proposal_not_found',
  'proposal_not_pending',
  'approver_is_author',
  'approver_not_admin',
] as const;
export type ManualOverrideRefusalV1 = (typeof MANUAL_OVERRIDE_REFUSAL_V1_VALUES)[number];

export class ManualOverrideRefusalError extends Error {
  constructor(
    readonly reason: ManualOverrideRefusalV1,
    detail: string,
  ) {
    super(detail);
    this.name = 'ManualOverrideRefusalError';
  }
}

const refuse = (reason: ManualOverrideRefusalV1, detail: string): never => {
  throw new ManualOverrideRefusalError(reason, detail);
};

export interface ManualOverrideTargetV1 {
  canonicalEntity: 'canonical_rdte_program_element_year';
  naturalKey: string;
  fiscalYear: number | null;
  fundingField: string | null;
}

export interface ManualOverrideRecordV1 {
  overrideId: string;
  canonicalEntity: string;
  canonicalNaturalKey: string;
  fiscalYear: number | null;
  fundingField: string | null;
  value: { originalValue: string; originalUnit: string; valueMillions: string };
  governance: {
    authorActorId: string;
    approverActorId?: string | null;
    approverRole?: string | null;
    reason: string;
    evidenceIds: string[];
  };
  status: 'proposed' | 'approved';
  version: number;
  priorOverrideId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  proposedAt: string;
  approvedAt?: string | null;
}

export interface ManualOverrideRepositoryV1 {
  findLatestForTarget(target: ManualOverrideTargetV1): Promise<{ overrideId: string; version: number; status: string } | null>;
  findById(overrideId: string): Promise<ManualOverrideRecordV1 | null>;
  insert(record: ManualOverrideRecordV1, overrideHash: string): Promise<void>;
  markApproved(input: { overrideId: string; approverActorId: string; approvedAt: string }): Promise<void>;
}

/** `reconciliation_review_queue.field_name` mirrors program_element_year column names. */
export function canonicalTargetForLegacyPeYearV1(input: {
  peCode: string;
  fy: number;
  fieldName: string;
}): ManualOverrideTargetV1 {
  return {
    canonicalEntity: 'canonical_rdte_program_element_year',
    naturalKey: `${input.peCode}|${input.fy}`,
    fiscalYear: input.fy,
    fundingField: input.fieldName,
  };
}

export interface ProposeManualOverrideInputV1 {
  overrideId: string;
  target: ManualOverrideTargetV1;
  value: { originalValue: string; originalUnit: string; valueMillions: string };
  authorActorId: string;
  reason: string;
  evidenceIds: string[];
  effectiveFrom: string;
  proposedAt: string;
}

export async function proposeManualOverrideV1(
  input: ProposeManualOverrideInputV1,
  repository: ManualOverrideRepositoryV1,
): Promise<ManualOverrideRecordV1> {
  for (const [field, value] of [
    ['originalValue', input.value.originalValue],
    ['valueMillions', input.value.valueMillions],
  ] as const) {
    if (!isCanonicalDecimalStringV1(value)) {
      refuse('value_not_canonical_decimal', `${field}="${value}" is not a canonical decimal string`);
    }
  }

  const latest = await repository.findLatestForTarget(input.target);
  if (latest?.status === 'proposed') {
    refuse('target_has_open_proposal', `target already has proposal ${latest.overrideId} awaiting approval`);
  }
  const version = (latest?.version ?? 0) + 1;

  const record: ManualOverrideRecordV1 = {
    overrideId: input.overrideId,
    canonicalEntity: input.target.canonicalEntity,
    canonicalNaturalKey: input.target.naturalKey,
    fiscalYear: input.target.fiscalYear,
    fundingField: input.target.fundingField,
    value: input.value,
    governance: {
      authorActorId: input.authorActorId,
      reason: input.reason,
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
    },
    status: 'proposed',
    version,
    priorOverrideId: version === 1 ? undefined : latest?.overrideId,
    effectiveFrom: input.effectiveFrom,
    proposedAt: input.proposedAt,
  };

  await repository.insert(record, manualOverrideHashV1(record));
  return record;
}

export interface ApproveManualOverrideInputV1 {
  overrideId: string;
  approverActorId: string;
  approverRole: string;
  approvedAt: string;
}

export async function approveManualOverrideV1(
  input: ApproveManualOverrideInputV1,
  repository: ManualOverrideRepositoryV1,
): Promise<ManualOverrideRecordV1> {
  const existing = await repository.findById(input.overrideId);
  if (existing == null) return refuse('proposal_not_found', `no manual override ${input.overrideId}`);
  if (existing.status !== 'proposed') return refuse('proposal_not_pending', `manual override ${input.overrideId} is already ${existing.status}`);
  if (input.approverRole !== 'capiro_admin') return refuse('approver_not_admin', 'a manual override must be approved by a capiro_admin');
  if (input.approverActorId === existing.governance.authorActorId) {
    return refuse('approver_is_author', 'a manual override may not be approved by its own author');
  }

  await repository.markApproved({ overrideId: input.overrideId, approverActorId: input.approverActorId, approvedAt: input.approvedAt });

  return {
    ...existing,
    status: 'approved',
    approvedAt: input.approvedAt,
    governance: { ...existing.governance, approverActorId: input.approverActorId, approverRole: 'capiro_admin' },
  };
}

/** Deterministic hash over the record's stable fields (order-independent). */
export function manualOverrideHashV1(record: ManualOverrideRecordV1): string {
  const stable = JSON.stringify({
    overrideId: record.overrideId,
    canonicalEntity: record.canonicalEntity,
    canonicalNaturalKey: record.canonicalNaturalKey,
    fiscalYear: record.fiscalYear,
    fundingField: record.fundingField,
    value: record.value,
    authorActorId: record.governance.authorActorId,
    reason: record.governance.reason,
    evidenceIds: record.governance.evidenceIds,
    version: record.version,
    proposedAt: record.proposedAt,
  });
  // A permanent gate proves NO parser/GPU/promoter credential exists in this
  // HTTP service; a lightweight FNV-1a-style hash over the stable JSON
  // (rather than importing node:crypto's sha256) keeps this module free of
  // any dependency on the promotion module's canonical-json/hash helpers.
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i++) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8).slice(0, 64);
}
