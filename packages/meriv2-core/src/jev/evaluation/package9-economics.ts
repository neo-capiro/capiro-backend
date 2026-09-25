import { createHash } from 'node:crypto';
import { z } from 'zod';

const costSchema = z.object({
  modelUsd: z.number().finite().nonnegative(),
  humanReviewUsd: z.number().finite().nonnegative(),
  rescueUsd: z.number().finite().nonnegative(),
});
const workSchema = z.object({
  completed: z.boolean(),
  correct: z.boolean(),
  covered: z.boolean(),
  cost: costSchema.optional(),
});

export const jevPackage9EconomicsSchema = z
  .object({
    version: z.literal('jev_package9_economics_v1'),
    evaluationSet: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(['proposed', 'approved']),
      frozen: z.boolean(),
      independentAdjudication: z.object({
        status: z.enum(['proposed', 'complete']),
        recordId: z.string().min(1).optional(),
      }),
    }),
    priceSchedule: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      status: z.enum(['proposed', 'approved']),
      currency: z.literal('USD'),
      approvalRecordId: z.string().min(1).optional(),
      contentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    cases: z
      .array(z.object({ id: z.string().min(1), jev: workSchema, baseline: workSchema }))
      .min(1),
  })
  .superRefine((data, context) => {
    const ids = new Set<string>();
    data.cases.forEach((item, index) => {
      if (ids.has(item.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cases', index, 'id'],
          message: 'case ids must be unique',
        });
      ids.add(item.id);
    });
  });

export type JevPackage9EconomicsInput = z.infer<typeof jevPackage9EconomicsSchema>;
export type JevPackage9EconomicsReport = ReturnType<typeof runJevPackage9Economics>;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sum<T>(items: readonly T[], selector: (item: T) => number): number {
  return Number(items.reduce((total, item) => total + selector(item), 0).toFixed(8));
}

export function runJevPackage9Economics(raw: unknown) {
  const input = jevPackage9EconomicsSchema.parse(raw);
  const blockers: string[] = [];
  if (input.evaluationSet.status !== 'approved') blockers.push('evaluation_set_not_approved');
  if (!input.evaluationSet.frozen) blockers.push('evaluation_set_not_frozen');
  if (
    input.evaluationSet.independentAdjudication.status !== 'complete' ||
    !input.evaluationSet.independentAdjudication.recordId
  )
    blockers.push('independent_adjudication_incomplete');
  if (digest(input.cases) !== input.evaluationSet.contentHash)
    blockers.push('evaluation_set_hash_mismatch');
  if (input.priceSchedule.status !== 'approved') blockers.push('price_schedule_not_approved');
  if (!input.priceSchedule.approvalRecordId || !input.priceSchedule.contentHash)
    blockers.push('price_schedule_approval_binding_missing');
  const matchedCompleted = input.cases.filter(
    (item) => item.jev.completed && item.baseline.completed,
  );
  const accuracy = (side: 'jev' | 'baseline') =>
    matchedCompleted.length
      ? matchedCompleted.filter((item) => item[side].correct).length / matchedCompleted.length
      : null;
  const completionRate = (side: 'jev' | 'baseline') =>
    input.cases.length
      ? input.cases.filter((item) => item[side].completed).length / input.cases.length
      : null;
  const coverage = (side: 'jev' | 'baseline') =>
    input.cases.length
      ? input.cases.filter((item) => item[side].completed && item[side].covered).length /
        input.cases.length
      : null;
  const totals = (side: 'jev' | 'baseline') => {
    const selected = input.cases.map((item) => item[side]);
    if (selected.some((item) => item.cost === undefined)) return null;
    return {
      modelUsd: sum(selected, (item) => item.cost!.modelUsd),
      humanReviewUsd: sum(selected, (item) => item.cost!.humanReviewUsd),
      rescueUsd: sum(selected, (item) => item.cost!.rescueUsd),
      totalUsd: sum(
        selected,
        (item) => item.cost!.modelUsd + item.cost!.humanReviewUsd + item.cost!.rescueUsd,
      ),
    };
  };
  const jevAccuracy = accuracy('jev');
  const baselineAccuracy = accuracy('baseline');
  const jevCompletionRate = completionRate('jev');
  const baselineCompletionRate = completionRate('baseline');
  const jevCoverage = coverage('jev');
  const baselineCoverage = coverage('baseline');
  const jevCosts = totals('jev');
  const baselineCosts = totals('baseline');
  const baselineCost = baselineCosts?.totalUsd ?? null;
  const jevCost = jevCosts?.totalUsd ?? null;
  if (jevCosts === null || baselineCosts === null) blockers.push('work_cost_unpriced');
  const reduction =
    baselineCost !== null && jevCost !== null && baselineCost > 0
      ? (baselineCost - jevCost) / baselineCost
      : null;
  if (!matchedCompleted.length) blockers.push('no_matched_completed_work');
  if (
    jevCompletionRate === null ||
    baselineCompletionRate === null ||
    jevCompletionRate < baselineCompletionRate
  )
    blockers.push('completion_rate_not_maintained');
  if (jevAccuracy === null || baselineAccuracy === null || jevAccuracy < baselineAccuracy)
    blockers.push('accuracy_not_maintained');
  if (jevCoverage === null || baselineCoverage === null || jevCoverage < baselineCoverage)
    blockers.push('coverage_not_maintained');
  if (baselineCost === null || baselineCost <= 0) blockers.push('baseline_total_cost_not_positive');
  if (reduction === null || reduction < 0.3) blockers.push('total_cost_reduction_below_30_percent');
  const result = {
    version: 'jev_package9_economics_report_v1',
    decision: blockers.length ? ('NO_GO' as const) : ('GO' as const),
    blockers,
    evaluationSet: input.evaluationSet,
    priceSchedule: input.priceSchedule,
    cases: input.cases.length,
    matchedCompletedCases: matchedCompleted.length,
    jev: {
      completionRate: jevCompletionRate,
      accuracy: jevAccuracy,
      coverage: jevCoverage,
      costs: jevCosts,
    },
    baseline: {
      completionRate: baselineCompletionRate,
      accuracy: baselineAccuracy,
      coverage: baselineCoverage,
      costs: baselineCosts,
    },
    totalCostReduction: reduction,
  };
  return { ...result, hash: digest(result) };
}
