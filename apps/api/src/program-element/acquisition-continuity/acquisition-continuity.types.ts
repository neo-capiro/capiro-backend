export const ACQUISITION_RECORD_KINDS = [
  'notice',
  'solicitation',
  'vehicle',
  'order',
  'award',
  'modification',
] as const;

export type AcquisitionRecordKind = (typeof ACQUISITION_RECORD_KINDS)[number];

export const ACQUISITION_RELATIONSHIP_CLASSES = [
  'source_stated_financial_allocation',
  'deterministic_financial_allocation',
  'reviewed_association',
  'inferred_relevance',
  'unresolved',
] as const;

export type AcquisitionRelationshipClass = (typeof ACQUISITION_RELATIONSHIP_CLASSES)[number];

export interface AcquisitionIdentityInput {
  source: string;
  recordKind: AcquisitionRecordKind;
  /** USAspending generated award identity. Preferred and authoritative for prime awards. */
  generatedAwardId?: string | null;
  /** Stable provider identity for notices, solicitations, vehicles, and other keyed records. */
  sourceRecordId?: string | null;
  noticeId?: string | null;
  solicitationId?: string | null;
  vehicleId?: string | null;
  orderId?: string | null;
  modificationId?: string | null;
  transactionId?: string | null;
  /** Required with PIID for order/award fallback identities; never sufficient alone. */
  parentAwardId?: string | null;
  piid?: string | null;
  modificationNumber?: string | null;
  /** An independently resolved parent record key, when known. */
  parentIdentityKey?: string | null;
}

export interface AcquisitionIdentity {
  source: string;
  recordKind: AcquisitionRecordKind;
  key: string;
  authority: 'usaspending_generated_award_id' | 'source_record_id' | 'parent_award_and_piid' | 'source_transaction_id' | 'parent_piid_modification';
  parentIdentityKey: string | null;
}

export type AcquisitionIdentityResult =
  | { ok: true; identity: AcquisitionIdentity }
  | { ok: false; reason: string };

export type CoverageState = 'complete' | 'partial' | 'unknown' | 'unavailable';

export interface SourceFreshness {
  observedAt: string | null;
  sourceAsOf: string | null;
}

export interface AcquisitionCoverage {
  state: CoverageState;
  note: string;
}

export interface AcquisitionRelationshipInput {
  source: string;
  sourceRecordId: string;
  fromIdentityKey: string;
  toIdentityKey: string;
  relationshipClass: AcquisitionRelationshipClass;
  evidenceReference?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  allocatedAmountUsd?: string | null;
  unresolvedReason?: string | null;
  sourceFreshness?: SourceFreshness;
  coverage?: AcquisitionCoverage;
}

export interface AcquisitionRelationship extends AcquisitionRelationshipInput {
  key: string;
  evidenceReference: string | null;
  validFrom: string | null;
  validTo: string | null;
  allocatedAmountUsd: string | null;
  unresolvedReason: string | null;
}

export type AcquisitionRelationshipResult =
  | { ok: true; relationship: AcquisitionRelationship }
  | { ok: false; reason: string };

export interface AwardTransaction {
  /** Stable identity of this source action. A corrected observation reuses this key and advances revision. */
  identityKey: string;
  awardIdentityKey: string;
  /** Signed USD delta. Negative values are valid deobligations/corrections. */
  signedDeltaUsd: string;
  revision: number;
  /** When a source emits a distinct correcting action, this points at the action it supersedes. */
  correctsIdentityKey?: string | null;
}

export interface AccountTotal {
  identityKey: string;
  amountUsd: string;
  sourceAsOf: string | null;
}

export interface PortfolioAcquisitionProjectionInput {
  /** Each pair is a path through which the award was reached. */
  awardPaths: Array<{ awardIdentityKey: string; pathIdentityKey: string }>;
  transactions: AwardTransaction[];
  /** Account totals are returned separately and are never added to award actions. */
  accountTotals: AccountTotal[];
}

export interface PortfolioAcquisitionProjection {
  awardIdentityKeys: string[];
  awardCount: number;
  signedTransactionDeltaUsd: string;
  transactionCount: number;
  accountTotals: AccountTotal[];
}
