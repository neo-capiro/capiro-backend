/** Phase 6 Workstream M — strict reprogramming and execution records. */
import { z } from 'zod';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  sha256Schema,
  type BudgetLineIdentityV1,
  type MoneyValueV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  addDecimals,
  subtractDecimals,
} from '../../verification/rules/arithmetic/exact-arithmetic.js';
import {
  defenseBudgetStageActionV1Schema,
  type DefenseBudgetStageActionV1,
} from '../appropriations/actions/defense-budget-stage-action-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const REPROGRAMMING_STATUS_VALUES = [
  'requested',
  'approved',
  'denied',
  'withdrawn',
] as const;
export const reprogrammingStatusV1Schema = z.enum(REPROGRAMMING_STATUS_VALUES);

export const reprogrammingEventV1Schema = z
  .object({
    schemaVersion: z.literal('defense_budget_reprogramming_event_v1'),
    eventId: nonBlank,
    controlNumber: nonBlank,
    status: reprogrammingStatusV1Schema,
    date,
    fiscalYear: z.number().int().min(1900).max(2200),
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    sourceIdentity: budgetLineIdentityV1Schema.optional(),
    destinationIdentity: budgetLineIdentityV1Schema.optional(),
    amount: moneyValueV1Schema,
    sourceBefore: moneyValueV1Schema.optional(),
    sourceAfter: moneyValueV1Schema.optional(),
    destinationBefore: moneyValueV1Schema.optional(),
    destinationAfter: moneyValueV1Schema.optional(),
    policyAllowsDerivedRevisedTotal: z.boolean().default(false),
    purpose: z.string().optional(),
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceIdentity == null && value.destinationIdentity == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reprogramming event requires a source or destination identity',
        path: ['sourceIdentity'],
      });
    }
    if (
      value.status !== 'approved' &&
      (value.sourceAfter != null || value.destinationAfter != null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only approved reprogramming may claim a revised total',
        path: ['status'],
      });
    }
  });
export type ReprogrammingEventV1 = z.infer<typeof reprogrammingEventV1Schema>;

export interface ReprogrammedPositionV1 {
  projectionId: string;
  field: 'reprogrammed';
  identity: BudgetLineIdentityV1;
  fiscalYear: number;
  money: MoneyValueV1;
  directOrDerived: 'direct' | 'derived';
  revisedTotalBasis: 'explicit_after' | 'policy_derived';
  evidenceIds: string[];
  canonicalWriteAllowed: false;
}

export interface ReprogrammingCompositionV1 {
  schemaVersion: 'reprogramming_composition_v1';
  event: ReprogrammingEventV1;
  actions: DefenseBudgetStageActionV1[];
  revisedPositions: ReprogrammedPositionV1[];
}

function absValue(value: MoneyValueV1): MoneyValueV1 {
  const original = value.originalValue.startsWith('-')
    ? value.originalValue.slice(1)
    : value.originalValue;
  const millions = value.valueMillions.startsWith('-')
    ? value.valueMillions.slice(1)
    : value.valueMillions;
  return { ...value, originalValue: original, valueMillions: millions };
}

function transferAction(input: {
  event: ReprogrammingEventV1;
  type: 'transfer_in' | 'transfer_out';
  identity: BudgetLineIdentityV1;
}): DefenseBudgetStageActionV1 {
  const magnitude = absValue(input.event.amount);
  const signed =
    input.type === 'transfer_out' ? `-${magnitude.valueMillions}` : magnitude.valueMillions;
  return defenseBudgetStageActionV1Schema.parse({
    schemaVersion: 'defense_budget_stage_action_v1',
    actionId: `${input.event.eventId}:${input.type}`,
    track: 'post_enactment',
    stage: 'reprogramming',
    authority: 'reprogramming',
    vehicleClass: 'reprogramming_document',
    actionType: input.type,
    identity: input.identity,
    transferGroupId: input.event.eventId,
    ...(input.event.sourceIdentity != null
      ? { sourceIdentity: input.event.sourceIdentity }
      : {}),
    ...(input.event.destinationIdentity != null
      ? { destinationIdentity: input.event.destinationIdentity }
      : {}),
    fiscalYear: input.event.fiscalYear,
    amount: magnitude,
    signedValueMillions: signed,
    direction: input.type === 'transfer_out' ? 'out' : 'in',
    rationale: input.event.purpose,
    evidenceIds: input.event.evidenceIds,
    languageEvidenceIds: [],
    directOrDerived: 'direct',
  });
}

function position(
  event: ReprogrammingEventV1,
  identity: BudgetLineIdentityV1,
  money: MoneyValueV1,
  directOrDerived: 'direct' | 'derived',
): ReprogrammedPositionV1 {
  const revisedTotalBasis =
    directOrDerived === 'direct' ? ('explicit_after' as const) : ('policy_derived' as const);
  return {
    projectionId: `reprog_${sha256CanonicalJson({
      eventId: event.eventId,
      identity,
      fiscalYear: event.fiscalYear,
      money,
      directOrDerived,
      revisedTotalBasis,
    } as unknown as JsonValue)}`,
    field: 'reprogrammed',
    identity,
    fiscalYear: event.fiscalYear,
    money,
    directOrDerived,
    revisedTotalBasis,
    evidenceIds: event.evidenceIds,
    canonicalWriteAllowed: false,
  };
}

function assertDerivationUnit(before: MoneyValueV1, amount: MoneyValueV1): void {
  if (before.originalUnit !== amount.originalUnit) {
    throw new Error(
      `reprogramming derivation unit mismatch: ${before.originalUnit} versus ${amount.originalUnit}`,
    );
  }
}

export function composeReprogrammingEventV1(value: unknown): ReprogrammingCompositionV1 {
  const event = reprogrammingEventV1Schema.parse(value);
  const actions: DefenseBudgetStageActionV1[] = [];
  const revisedPositions: ReprogrammedPositionV1[] = [];

  if (event.sourceIdentity != null && event.destinationIdentity != null) {
    actions.push(transferAction({ event, type: 'transfer_out', identity: event.sourceIdentity }));
    actions.push(
      transferAction({ event, type: 'transfer_in', identity: event.destinationIdentity }),
    );
  } else if (event.sourceIdentity != null) {
    actions.push(
      defenseBudgetStageActionV1Schema.parse({
        schemaVersion: 'defense_budget_stage_action_v1',
        actionId: `${event.eventId}:realignment`,
        track: 'post_enactment',
        stage: 'reprogramming',
        authority: 'reprogramming',
        vehicleClass: 'reprogramming_document',
        actionType: 'realignment',
        identity: event.sourceIdentity,
        fiscalYear: event.fiscalYear,
        amount: absValue(event.amount),
        signedValueMillions: event.amount.valueMillions,
        direction: event.amount.valueMillions.startsWith('-') ? 'decrease' : 'increase',
        rationale: event.purpose,
        evidenceIds: event.evidenceIds,
        languageEvidenceIds: [],
        directOrDerived: 'direct',
      }),
    );
  }

  if (event.status === 'approved') {
    if (event.sourceIdentity != null && event.sourceAfter != null) {
      revisedPositions.push(position(event, event.sourceIdentity, event.sourceAfter, 'direct'));
    } else if (
      event.sourceIdentity != null &&
      event.sourceBefore != null &&
      event.policyAllowsDerivedRevisedTotal
    ) {
      assertDerivationUnit(event.sourceBefore, event.amount);
      const magnitude = absValue(event.amount);
      const derived = {
        ...event.sourceBefore,
        valueMillions: subtractDecimals(
          event.sourceBefore.valueMillions,
          magnitude.valueMillions,
        ),
        originalValue: subtractDecimals(
          event.sourceBefore.originalValue,
          magnitude.originalValue,
        ),
      };
      revisedPositions.push(position(event, event.sourceIdentity, derived, 'derived'));
    }
    if (event.destinationIdentity != null && event.destinationAfter != null) {
      revisedPositions.push(
        position(event, event.destinationIdentity, event.destinationAfter, 'direct'),
      );
    } else if (
      event.destinationIdentity != null &&
      event.destinationBefore != null &&
      event.policyAllowsDerivedRevisedTotal
    ) {
      assertDerivationUnit(event.destinationBefore, event.amount);
      const magnitude = absValue(event.amount);
      const derived = {
        ...event.destinationBefore,
        valueMillions: addDecimals(
          event.destinationBefore.valueMillions,
          magnitude.valueMillions,
        ),
        originalValue: addDecimals(
          event.destinationBefore.originalValue,
          magnitude.originalValue,
        ),
      };
      revisedPositions.push(position(event, event.destinationIdentity, derived, 'derived'));
    }
  }
  return { schemaVersion: 'reprogramming_composition_v1', event, actions, revisedPositions };
}

export const EXECUTION_METRIC_VALUES = [
  'obligations',
  'outlays',
  'expenditures',
  'disbursements',
  'commitments',
  'reviewed_other',
] as const;
export const executionMetricV1Schema = z.enum(EXECUTION_METRIC_VALUES);

export const executionSourceProfileV1Schema = z
  .object({
    schemaVersion: z.literal('execution_source_profile_v1'),
    profileId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    metric: executionMetricV1Schema,
    sourceSystem: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    mapsToExecutedField: z.boolean(),
  })
  .strict();
export type ExecutionSourceProfileV1 = z.infer<typeof executionSourceProfileV1Schema>;

export const executionRecordV1Schema = z
  .object({
    schemaVersion: z.literal('execution_record_v1'),
    recordId: nonBlank,
    identity: budgetLineIdentityV1Schema,
    metric: executionMetricV1Schema,
    asOfDate: date,
    periodStart: date.optional(),
    periodEnd: date.optional(),
    budgetFiscalYear: z.number().int().min(1900).max(2200),
    amount: moneyValueV1Schema,
    sourceSystem: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    evidenceIds: z.array(nonBlank).min(1),
    cumulative: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.periodStart != null && value.periodEnd != null && value.periodEnd < value.periodStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'execution periodEnd must not precede periodStart',
        path: ['periodEnd'],
      });
    }
  });
export type ExecutionRecordV1 = z.infer<typeof executionRecordV1Schema>;

export interface ExecutionCompositionV1 {
  schemaVersion: 'execution_composition_v1';
  record: ExecutionRecordV1;
  metricFact: ExecutionRecordV1;
  executedPosition?: {
    projectionId: string;
    field: 'executed';
    identity: BudgetLineIdentityV1;
    fiscalYear: number;
    metric: z.infer<typeof executionMetricV1Schema>;
    money: MoneyValueV1;
    asOfDate: string;
    cumulative: boolean;
    canonicalWriteAllowed: false;
  };
}

export function composeExecutionRecordV1(
  profileValue: unknown,
  recordValue: unknown,
): ExecutionCompositionV1 {
  const profile = executionSourceProfileV1Schema.parse(profileValue);
  const record = executionRecordV1Schema.parse(recordValue);
  if (record.budgetFiscalYear !== profile.fiscalYear) {
    throw new Error('execution cross-FY mismatch');
  }
  if (record.metric !== profile.metric) throw new Error('ambiguous execution metric');
  if (
    record.sourceDocumentId !== profile.sourceDocumentId ||
    record.sourceSha256 !== profile.sourceSha256 ||
    record.sourceSystem !== profile.sourceSystem
  ) {
    throw new Error('execution source proof mismatch');
  }
  const result: ExecutionCompositionV1 = {
    schemaVersion: 'execution_composition_v1',
    record,
    metricFact: record,
  };
  if (profile.mapsToExecutedField) {
    result.executedPosition = {
      projectionId: `executed_${sha256CanonicalJson(record as unknown as JsonValue)}`,
      field: 'executed',
      identity: record.identity,
      fiscalYear: record.budgetFiscalYear,
      metric: record.metric,
      money: record.amount,
      asOfDate: record.asOfDate,
      cumulative: record.cumulative,
      canonicalWriteAllowed: false,
    };
  }
  return result;
}
