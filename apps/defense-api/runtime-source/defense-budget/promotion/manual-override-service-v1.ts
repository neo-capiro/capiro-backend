/**
 * Phase 7 Workstream K — proposing and approving a governed manual override.
 *
 * Pure policy over a narrow repository port, in the same style as the rest of
 * the promotion module: no Nest, no Prisma, no clock. Time and identity arrive
 * as arguments so every decision here is reproducible in a test.
 *
 * This is the module that replaces the legacy reconciliation resolve path. That
 * path did three things this one deliberately does not:
 *
 * 1. it coerced money with `Number()`, even though the queue stores the value
 *    as a string and the exactness was still there to keep;
 * 2. it applied the correction through `ProgramElementWriterService` under a
 *    `manual_override` source string, which made a human decision look like a
 *    parsed J-book line and let it flip a winner flag;
 * 3. it let one admin both decide and apply, with no second party anywhere.
 */
import {
  DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
  defenseBudgetManualOverrideV1Schema,
  manualOverrideHashV1,
  manualOverrideTargetKeyV1,
  type DefenseBudgetManualOverrideV1,
} from './manual-override-v1.js';
import { isCanonicalDecimalString } from '../contracts/decimal-string.js';
import type { CanonicalEntityV1 } from './canonical-mapping-registry-v1.js';
import type { FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import { FUNDING_FIELD_V1_VALUES } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* K6. Refusals                                                        */
/* ------------------------------------------------------------------ */

export const MANUAL_OVERRIDE_REFUSAL_V1_VALUES = [
  'unknown_funding_field',
  'value_not_canonical_decimal',
  'target_has_open_proposal',
  'proposal_not_found',
  'proposal_not_pending',
  'approver_is_author',
  'approver_not_admin',
  'override_not_approved',
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

/* ------------------------------------------------------------------ */
/* K7. Ports                                                           */
/* ------------------------------------------------------------------ */

export interface ManualOverrideTargetV1 {
  canonicalEntity: CanonicalEntityV1;
  naturalKey: string;
  fiscalYear: number | null;
  fundingField: FundingFieldV1 | null;
}

export interface ManualOverrideRepositoryV1 {
  /** The highest existing version for a target, whatever its status. */
  findLatestForTarget(
    target: ManualOverrideTargetV1,
  ): Promise<{ overrideId: string; version: number; status: string } | null>;
  findById(overrideId: string): Promise<DefenseBudgetManualOverrideV1 | null>;
  insert(record: DefenseBudgetManualOverrideV1, overrideHash: string): Promise<void>;
  /** The single proposed -> approved transition the lifecycle trigger permits. */
  markApproved(input: {
    overrideId: string;
    approverActorId: string;
    approvedAt: string;
  }): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* K8. The legacy queue's vocabulary                                   */
/* ------------------------------------------------------------------ */

/**
 * `reconciliation_review_queue.field_name` is a `program_element_year` column
 * name, and those columns are exactly the funding-field vocabulary — `request`,
 * `hascMark`, … `executed`. The mapping is therefore identity, but it is
 * validated rather than cast: an unrecognized column name refuses instead of
 * becoming an override against a field that does not exist.
 */
export function fundingFieldForLegacyFieldNameV1(fieldName: string): FundingFieldV1 {
  const match = (FUNDING_FIELD_V1_VALUES as readonly string[]).includes(fieldName);
  if (!match) {
    return refuse(
      'unknown_funding_field',
      `"${fieldName}" is not a funding field; a manual override cannot target it`,
    );
  }
  return fieldName as FundingFieldV1;
}

/**
 * The canonical identity a legacy `(peCode, fy)` queue entry refers to.
 * `canonical_rdte_program_element_year` keys on `peCode|fiscalYear`, which is
 * what the Phase 4 projection planner emits.
 */
export function canonicalTargetForLegacyPeYearV1(input: {
  peCode: string;
  fy: number;
  fieldName: string;
}): ManualOverrideTargetV1 {
  return {
    canonicalEntity: 'canonical_rdte_program_element_year',
    naturalKey: `${input.peCode}|${input.fy}`,
    fiscalYear: input.fy,
    fundingField: fundingFieldForLegacyFieldNameV1(input.fieldName),
  };
}

/* ------------------------------------------------------------------ */
/* K9. Propose                                                         */
/* ------------------------------------------------------------------ */

export interface ProposeManualOverrideInputV1 {
  overrideId: string;
  target: ManualOverrideTargetV1;
  /** Exact decimal strings. The caller must not have been through `Number()`. */
  value: { originalValue: string; originalUnit: string; valueMillions: string };
  authorActorId: string;
  reason: string;
  evidenceIds: string[];
  changeRequestRef?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  proposedAt: string;
}

/**
 * Author a correction. The result is `proposed`: it names no approver, is not
 * in force, and defends nothing until a second `capiro_admin` approves it.
 *
 * A target may carry only one open proposal at a time. Two admins proposing
 * different values for the same figure is a disagreement to settle before
 * either becomes governed truth, not a race for whoever approves first.
 */
export async function proposeManualOverrideV1(
  input: ProposeManualOverrideInputV1,
  repository: ManualOverrideRepositoryV1,
): Promise<DefenseBudgetManualOverrideV1> {
  for (const [field, value] of [
    ['originalValue', input.value.originalValue],
    ['valueMillions', input.value.valueMillions],
  ] as const) {
    if (!isCanonicalDecimalString(value)) {
      refuse(
        'value_not_canonical_decimal',
        `${field}="${value}" is not a canonical decimal string; a manual override never rounds`,
      );
    }
  }

  const latest = await repository.findLatestForTarget(input.target);
  if (latest?.status === 'proposed') {
    refuse(
      'target_has_open_proposal',
      `${manualOverrideTargetKeyV1(input.target)} already has proposal ${latest.overrideId} awaiting approval`,
    );
  }

  const version = (latest?.version ?? 0) + 1;

  const record = defenseBudgetManualOverrideV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION,
    overrideId: input.overrideId,
    canonicalEntity: input.target.canonicalEntity,
    naturalKey: input.target.naturalKey,
    fiscalYear: input.target.fiscalYear,
    fundingField: input.target.fundingField,
    value: input.value,
    governance: {
      authorActorId: input.authorActorId,
      reason: input.reason,
      evidenceIds: input.evidenceIds,
      changeRequestRef: input.changeRequestRef ?? undefined,
    },
    status: 'proposed',
    version,
    priorOverrideId: version === 1 ? undefined : latest?.overrideId,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? undefined,
    proposedAt: input.proposedAt,
  });

  await repository.insert(record, manualOverrideHashV1(record));
  return record;
}

/* ------------------------------------------------------------------ */
/* K10. Approve                                                        */
/* ------------------------------------------------------------------ */

export interface ApproveManualOverrideInputV1 {
  overrideId: string;
  approverActorId: string;
  approverRole: string;
  approvedAt: string;
}

/**
 * A second `capiro_admin` puts a proposal into force.
 *
 * The author check is repeated here even though the database enforces it in
 * `enforce_manual_override_lifecycle`. That is deliberate: the caller gets a
 * typed refusal naming the reason instead of a raw constraint violation, and
 * the boundary still holds if this service is ever bypassed.
 */
export async function approveManualOverrideV1(
  input: ApproveManualOverrideInputV1,
  repository: ManualOverrideRepositoryV1,
): Promise<DefenseBudgetManualOverrideV1> {
  const existing = await repository.findById(input.overrideId);
  if (existing == null) {
    return refuse('proposal_not_found', `no manual override ${input.overrideId}`);
  }
  if (existing.status !== 'proposed') {
    return refuse(
      'proposal_not_pending',
      `manual override ${input.overrideId} is already ${existing.status}`,
    );
  }
  if (input.approverRole !== 'capiro_admin') {
    return refuse('approver_not_admin', 'a manual override must be approved by a capiro_admin');
  }
  if (input.approverActorId === existing.governance.authorActorId) {
    return refuse('approver_is_author', 'a manual override may not be approved by its own author');
  }

  await repository.markApproved({
    overrideId: input.overrideId,
    approverActorId: input.approverActorId,
    approvedAt: input.approvedAt,
  });

  return defenseBudgetManualOverrideV1Schema.parse({
    ...existing,
    status: 'approved',
    approvedAt: input.approvedAt,
    governance: {
      ...existing.governance,
      approverActorId: input.approverActorId,
      approverRole: 'capiro_admin',
    },
  });
}
