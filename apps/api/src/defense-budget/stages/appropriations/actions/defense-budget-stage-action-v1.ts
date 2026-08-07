/** Phase 6 Workstream J — strict typed stage-action companion contract. */
import { z } from 'zod';
import { stripUndefinedProperties } from '../../../contracts/canonical-json.js';
import { isCanonicalDecimalString } from '../../../contracts/decimal-string.js';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  type BudgetLineIdentityV1,
  type MoneyValueV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  committeeStageActionV1Schema,
  type CommitteeStageActionV1,
} from '../../authorization/committee-stage-facts-v1.js';

export const DEFENSE_BUDGET_STAGE_ACTION_V1_SCHEMA_VERSION =
  'defense_budget_stage_action_v1' as const;
export const DEFENSE_BUDGET_STAGE_ACTION_V1_FIELD = 'defense_budget_stage_action_v1' as const;

export const DEFENSE_BUDGET_STAGE_ACTION_TYPE_V1_VALUES = [
  'increase',
  'decrease',
  'transfer_in',
  'transfer_out',
  'rescission',
  'realignment',
  'undistributed_adjustment',
  'general_provision',
  'restriction',
  'directive',
  'reporting_requirement',
  'other',
] as const;
export const defenseBudgetStageActionTypeV1Schema = z.enum(
  DEFENSE_BUDGET_STAGE_ACTION_TYPE_V1_VALUES,
);
export type DefenseBudgetStageActionTypeV1 = z.infer<typeof defenseBudgetStageActionTypeV1Schema>;

export const DEFENSE_BUDGET_ACTION_DIRECTION_V1_VALUES = [
  'increase',
  'decrease',
  'in',
  'out',
  'neutral',
] as const;
export const defenseBudgetActionDirectionV1Schema = z.enum(
  DEFENSE_BUDGET_ACTION_DIRECTION_V1_VALUES,
);
export type DefenseBudgetActionDirectionV1 = z.infer<
  typeof defenseBudgetActionDirectionV1Schema
>;

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const canonicalDecimal = z
  .string()
  .refine(isCanonicalDecimalString, { message: 'expected canonical decimal string' });

function magnitude(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

function absoluteMoney(value: MoneyValueV1): MoneyValueV1 {
  return {
    ...value,
    originalValue: magnitude(value.originalValue),
    valueMillions: magnitude(value.valueMillions),
  };
}

function expectedDirection(
  actionType: DefenseBudgetStageActionTypeV1,
  signedValueMillions: string | undefined,
): DefenseBudgetActionDirectionV1 | null {
  if (actionType === 'increase') return 'increase';
  if (actionType === 'decrease' || actionType === 'rescission') return 'decrease';
  if (actionType === 'transfer_in') return 'in';
  if (actionType === 'transfer_out') return 'out';
  if (actionType === 'realignment' || actionType === 'undistributed_adjustment') {
    if (signedValueMillions == null || signedValueMillions === '0') return 'neutral';
    return signedValueMillions.startsWith('-') ? 'decrease' : 'increase';
  }
  return null;
}

export const defenseBudgetStageActionV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_STAGE_ACTION_V1_SCHEMA_VERSION),
    actionId: nonBlank,
    track: z.enum(['authorization', 'appropriations', 'post_enactment']),
    stage: z.enum([
      'hasc',
      'sasc',
      'hac_d',
      'sac_d',
      'ndaa_conference',
      'appropriations_conference',
      'public_law',
      'reprogramming',
      'execution',
    ]),
    authority: nonBlank,
    vehicleClass: z.enum([
      'committee_report',
      'conference_report',
      'joint_explanatory_statement',
      'public_law',
      'reprogramming_document',
      'execution_source',
    ]),
    actionType: defenseBudgetStageActionTypeV1Schema,
    identity: budgetLineIdentityV1Schema.optional(),
    packageScope: nonBlank.optional(),
    accountScope: nonBlank.optional(),
    transferGroupId: nonBlank.optional(),
    sourceIdentity: budgetLineIdentityV1Schema.optional(),
    destinationIdentity: budgetLineIdentityV1Schema.optional(),
    fiscalYear: z.number().int().min(1900).max(2200),
    amount: moneyValueV1Schema.optional(),
    signedValueMillions: canonicalDecimal.optional(),
    baseline: moneyValueV1Schema.optional(),
    after: moneyValueV1Schema.optional(),
    direction: defenseBudgetActionDirectionV1Schema,
    rationale: z.string().optional(),
    evidenceIds: z.array(nonBlank).min(1),
    languageEvidenceIds: z.array(nonBlank).default([]),
    directOrDerived: z.enum(['direct', 'derived']),
  })
  .strict()
  .superRefine((value, ctx) => {
    const primaryScopeCount = [value.identity, value.packageScope, value.accountScope].filter(
      (item) => item != null,
    ).length;
    if (primaryScopeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stage action cannot carry more than one primary scope',
        path: ['identity'],
      });
    }
    if (
      primaryScopeCount === 0 &&
      value.sourceIdentity == null &&
      value.destinationIdentity == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'stage action requires native identity, package/account scope, or transfer endpoints',
        path: ['identity'],
      });
    }

    const numericTypes = new Set<DefenseBudgetStageActionTypeV1>([
      'increase',
      'decrease',
      'transfer_in',
      'transfer_out',
      'rescission',
      'realignment',
      'undistributed_adjustment',
    ]);
    if (
      numericTypes.has(value.actionType) &&
      (value.amount == null || value.signedValueMillions == null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.actionType} requires amount and signedValueMillions`,
        path: ['amount'],
      });
    }
    if ((value.amount == null) !== (value.signedValueMillions == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'amount and signedValueMillions must be provided together',
        path: ['signedValueMillions'],
      });
    }

    const signed = value.signedValueMillions;
    if (signed != null) {
      const negative = signed.startsWith('-');
      const nonZero = signed !== '0';
      if (
        ['decrease', 'transfer_out', 'rescission'].includes(value.actionType) &&
        nonZero &&
        !negative
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.actionType} requires a non-positive signed value`,
          path: ['signedValueMillions'],
        });
      }
      if (['increase', 'transfer_in'].includes(value.actionType) && negative) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.actionType} requires a non-negative signed value`,
          path: ['signedValueMillions'],
        });
      }
      if (value.amount != null) {
        if (
          value.amount.originalValue.startsWith('-') ||
          value.amount.valueMillions.startsWith('-')
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'amount is an unsigned magnitude; direction belongs in signedValueMillions',
            path: ['amount'],
          });
        }
        if (value.amount.valueMillions !== magnitude(signed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'amount magnitude must equal the absolute signedValueMillions',
            path: ['signedValueMillions'],
          });
        }
      }
    }

    const direction = expectedDirection(value.actionType, signed);
    if (direction != null && value.direction !== direction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.actionType} requires direction=${direction}`,
        path: ['direction'],
      });
    }
  })
  .transform(stripUndefinedProperties);
export type DefenseBudgetStageActionV1 = z.infer<typeof defenseBudgetStageActionV1Schema>;

export const appropriationsLanguageFactV1Schema = z
  .object({
    languageFactId: nonBlank,
    stage: z.enum(['hac_d', 'sac_d', 'appropriations_conference', 'public_law']),
    sourceDocumentId: nonBlank,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: nonBlank,
    evidenceIds: z.array(nonBlank).min(1),
    actionIds: z.array(nonBlank).min(1),
  })
  .strict();
export type AppropriationsLanguageFactV1 = z.infer<typeof appropriationsLanguageFactV1Schema>;

export function parseDefenseBudgetStageActionV1(value: unknown): DefenseBudgetStageActionV1 {
  return defenseBudgetStageActionV1Schema.parse(value);
}

function directionFromLegacy(action: CommitteeStageActionV1): DefenseBudgetActionDirectionV1 {
  if (action.actionType === 'increase') return 'increase';
  if (action.actionType === 'decrease' || action.actionType === 'rescission') {
    return 'decrease';
  }
  if (action.actionType === 'transfer_in') return 'in';
  if (action.actionType === 'transfer_out') return 'out';
  if (action.signedValueMillions === '0') return 'neutral';
  return action.signedValueMillions.startsWith('-') ? 'decrease' : 'increase';
}

export function normalizeLegacyCommitteeStageActionV1(value: unknown): DefenseBudgetStageActionV1 {
  const action = committeeStageActionV1Schema.parse(value);
  return defenseBudgetStageActionV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_STAGE_ACTION_V1_SCHEMA_VERSION,
    actionId: action.actionId,
    track: action.track,
    stage: action.stage,
    authority: action.authority,
    vehicleClass:
      action.stage === 'appropriations_conference' || action.stage === 'ndaa_conference'
        ? 'conference_report'
        : 'committee_report',
    actionType: action.actionType,
    ...(action.identity != null ? { identity: action.identity } : {}),
    ...(action.packageScope != null ? { packageScope: action.packageScope } : {}),
    fiscalYear: action.fiscalYear,
    amount: absoluteMoney(action.amount),
    signedValueMillions: action.signedValueMillions,
    direction: directionFromLegacy(action),
    rationale: action.rationale,
    evidenceIds: action.evidenceIds,
    languageEvidenceIds: [],
    directOrDerived: 'direct',
  });
}

export interface StageActionComparableV1 {
  actionId: string;
  actionType: DefenseBudgetStageActionTypeV1;
  identity?: BudgetLineIdentityV1;
  fiscalYear: number;
  amount?: MoneyValueV1;
}
