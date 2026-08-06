/**
 * Phase 6 Workstream D — non-owning committee request baselines and typed
 * committee stage-action facts.
 *
 * Both values travel through `document_fact` assertions because the Phase 1
 * extraction union intentionally has no dedicated action assertion kind.
 * Request baselines printed in congressional tables remain comparison facts;
 * they are never emitted as `request` funding assertions by a later authority.
 */
import { z } from 'zod';
import { isCanonicalDecimalString } from '../../contracts/decimal-string.js';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  type BudgetLineIdentityV1,
  type MoneyValueV1,
} from '../../contracts/extraction-artifact-v1.js';

export const COMMITTEE_REQUEST_BASELINE_FIELD = 'committee_request_baseline_v1' as const;
export const DEFENSE_BUDGET_STAGE_ACTION_FIELD = 'defense_budget_stage_action_v1' as const;

export const COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION =
  'committee_request_baseline_v1' as const;
export const DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION =
  'defense_budget_stage_action_v1' as const;

export const committeeRequestBaselineV1Schema = z
  .object({
    schemaVersion: z.literal(COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION),
    stage: z.enum(['hasc', 'sasc', 'hac_d', 'sac_d', 'ndaa_conference', 'appropriations_conference']),
    authority: z.enum([
      'hasc_authorization',
      'sasc_authorization',
      'hacd_appropriations',
      'sacd_appropriations',
      'ndaa_conference_authorization',
      'appropriations_conference',
    ]),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    money: moneyValueV1Schema,
    evidenceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CommitteeRequestBaselineV1 = z.infer<typeof committeeRequestBaselineV1Schema>;

export const COMMITTEE_STAGE_ACTION_TYPE_VALUES = [
  'increase',
  'decrease',
  'transfer_in',
  'transfer_out',
  'rescission',
  'undistributed_adjustment',
  'general_provision',
] as const;
export const committeeStageActionTypeV1Schema = z.enum(COMMITTEE_STAGE_ACTION_TYPE_VALUES);
export type CommitteeStageActionTypeV1 = z.infer<typeof committeeStageActionTypeV1Schema>;

export const committeeStageActionV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION),
    actionId: z.string().min(1),
    track: z.enum(['authorization', 'appropriations']),
    stage: z.enum(['hasc', 'sasc', 'hac_d', 'sac_d', 'ndaa_conference', 'appropriations_conference']),
    authority: z.enum([
      'hasc_authorization',
      'sasc_authorization',
      'hacd_appropriations',
      'sacd_appropriations',
      'ndaa_conference_authorization',
      'appropriations_conference',
    ]),
    actionType: committeeStageActionTypeV1Schema,
    identity: budgetLineIdentityV1Schema.optional(),
    packageScope: z.string().min(1).optional(),
    fiscalYear: z.number().int().min(1900).max(2200),
    amount: moneyValueV1Schema,
    /** Exact signed value used for arithmetic. Never a JavaScript number. */
    signedValueMillions: z
      .string()
      .refine(isCanonicalDecimalString, { message: 'expected canonical decimal string' }),
    rationale: z.string().optional(),
    evidenceIds: z.array(z.string().min(1)).min(1),
    direct: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.identity == null && value.packageScope == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stage action requires identity or packageScope',
        path: ['identity'],
      });
    }
    if (value.identity != null && value.packageScope != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stage action cannot carry both identity and packageScope',
        path: ['packageScope'],
      });
    }
    const negative = value.signedValueMillions.startsWith('-');
    if (
      (value.actionType === 'decrease' ||
        value.actionType === 'transfer_out' ||
        value.actionType === 'rescission') &&
      !negative &&
      value.signedValueMillions !== '0'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.actionType} requires a non-positive signed value`,
        path: ['signedValueMillions'],
      });
    }
    if (
      (value.actionType === 'increase' || value.actionType === 'transfer_in') &&
      negative
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.actionType} requires a non-negative signed value`,
        path: ['signedValueMillions'],
      });
    }
  });
export type CommitteeStageActionV1 = z.infer<typeof committeeStageActionV1Schema>;

export function parseCommitteeRequestBaselineV1(value: unknown): CommitteeRequestBaselineV1 {
  return committeeRequestBaselineV1Schema.parse(value);
}

export function parseCommitteeStageActionV1(value: unknown): CommitteeStageActionV1 {
  return committeeStageActionV1Schema.parse(value);
}

export interface CommitteeRequestComparableV1 {
  assertionId: string;
  evidenceIds: string[];
  identity: BudgetLineIdentityV1;
  fiscalYear: number;
  money: MoneyValueV1;
}
