/** Phase 6 Workstream M — exact cross-stage lifecycle reconciliation. */
import { z } from 'zod';
import { budgetLineIdentityV1Schema, moneyValueV1Schema } from '../../contracts/extraction-artifact-v1.js';
import { subtractDecimals } from '../../verification/rules/arithmetic/exact-arithmetic.js';

const nonBlank = z.string().min(1);
export const lifecyclePositionV1Schema = z
  .object({
    positionId: nonBlank,
    stage: z.enum([
      'request',
      'hasc',
      'sasc',
      'ndaa_conference',
      'hac_d',
      'sac_d',
      'appropriations_conference',
      'enacted',
      'reprogrammed',
      'execution',
    ]),
    identity: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    money: moneyValueV1Schema,
    scopeKey: nonBlank.default('line'),
  })
  .strict();
export type LifecyclePositionV1 = z.infer<typeof lifecyclePositionV1Schema>;

export interface LifecycleDeltaV1 {
  schemaVersion: 'defense_budget_lifecycle_delta_v1';
  status: 'PASS' | 'NOT_RUN' | 'BLOCKED';
  fromStage?: LifecyclePositionV1['stage'];
  toStage?: LifecyclePositionV1['stage'];
  deltaMillions?: string;
  reason?: string;
  canonicalWriteAllowed: false;
  budgetActionWriteAllowed: false;
}

export function reconcileLifecyclePairV1(
  fromValue: LifecyclePositionV1 | undefined,
  toValue: LifecyclePositionV1 | undefined,
): LifecycleDeltaV1 {
  if (fromValue == null || toValue == null) {
    return {
      schemaVersion: 'defense_budget_lifecycle_delta_v1',
      status: 'NOT_RUN',
      ...(fromValue != null ? { fromStage: fromValue.stage } : {}),
      ...(toValue != null ? { toStage: toValue.stage } : {}),
      reason: 'comparison stage missing; missing is not zero',
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    };
  }
  const from = lifecyclePositionV1Schema.parse(fromValue);
  const to = lifecyclePositionV1Schema.parse(toValue);
  if (JSON.stringify(from.identity) !== JSON.stringify(to.identity)) {
    return {
      schemaVersion: 'defense_budget_lifecycle_delta_v1',
      status: 'BLOCKED',
      fromStage: from.stage,
      toStage: to.stage,
      reason: 'identity mismatch',
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    };
  }
  if (from.fiscalYear !== to.fiscalYear) {
    return {
      schemaVersion: 'defense_budget_lifecycle_delta_v1',
      status: 'BLOCKED',
      fromStage: from.stage,
      toStage: to.stage,
      reason: 'fiscal-year mismatch',
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    };
  }
  if (from.scopeKey !== to.scopeKey) {
    return {
      schemaVersion: 'defense_budget_lifecycle_delta_v1',
      status: 'BLOCKED',
      fromStage: from.stage,
      toStage: to.stage,
      reason: 'scope mismatch',
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    };
  }
  if (from.money.originalUnit !== to.money.originalUnit) {
    return {
      schemaVersion: 'defense_budget_lifecycle_delta_v1',
      status: 'BLOCKED',
      fromStage: from.stage,
      toStage: to.stage,
      reason: 'original-unit mismatch',
      canonicalWriteAllowed: false,
      budgetActionWriteAllowed: false,
    };
  }
  return {
    schemaVersion: 'defense_budget_lifecycle_delta_v1',
    status: 'PASS',
    fromStage: from.stage,
    toStage: to.stage,
    deltaMillions: subtractDecimals(to.money.valueMillions, from.money.valueMillions),
    canonicalWriteAllowed: false,
    budgetActionWriteAllowed: false,
  };
}
