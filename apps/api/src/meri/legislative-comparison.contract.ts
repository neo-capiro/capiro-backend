import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

const id = z.string().min(1).max(250);
const text = z.string();
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const pair = {
  clientId: uuid.nullable(),
  folderId: z.string().min(1).max(100).nullable().default(null),
  leftId: id,
  leftRevision: id,
  rightId: id,
  rightRevision: id,
};
const budgetRequest = z
  .object({
    ...pair,
    jurisdiction: z.literal('FL').default('FL'),
    sessionKey: z.string().max(60).default(''),
  })
  .strict();
const versionRequest = z
  .object({
    ...pair,
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    sessionKey: z.string().min(1).max(60),
    allowCrossBill: z.boolean().default(false),
    rightSessionKey: z.string().min(1).max(60).optional(),
  })
  .strict()
  .refine((value) => value.rightSessionKey === undefined || value.allowCrossBill);
export type BudgetComparisonRequest = z.infer<typeof budgetRequest>;
export type VersionComparisonRequest = z.infer<typeof versionRequest>;

const amount = z
  .object({
    id,
    projectId: text,
    fiscalYear: text,
    periodStart: text,
    periodEnd: text,
    currency: z.literal('USD'),
    fund: text,
    basis: z.enum(['recurring', 'nonrecurring', 'total']),
    measure: z.enum(['money', 'positions', 'percentage']),
    minorUnits: text.nullable(),
    state: z.enum(['amount', 'blank', 'omitted', 'embedded', 'unpublished']),
    stage: text,
    chamber: text,
    offer: text.nullable(),
    sourceRevision: id,
    documentId: text,
    locator: text,
    unitMultiplier: text,
    allocationBasis: text,
    qualified: z.boolean(),
    valueRole: z.enum(['allocation_amount', 'vetoed_amount']).optional(),
  })
  .strict();
const budgetResult = z
  .object({
    left: amount,
    right: amount,
    comparable: z.boolean(),
    reasons: z.array(text),
    deltaMinorUnits: z
      .string()
      .regex(/^-?\d+$/)
      .nullable(),
    percentage: z
      .string()
      .regex(/^-?\d+\.\d{2}%$/)
      .nullable(),
  })
  .strict();
const source = z
  .object({
    id,
    billId: text,
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    sessionKey: text,
    revision: id,
    contentHash: text,
    extractorVersion: text,
    sourceUrl: text.nullable(),
    kind: text,
    publishedDate: text.nullable(),
    observedAt: z.string().datetime(),
    complete: z.literal(true),
  })
  .strict();
// The canonical producer includes text in each range, as well as on the line.
// Offsets count UTF-16 code units in its exact extraction, not Unicode characters.
const range = z
  .object({
    text,
    locator: text,
    start: z.number().int().min(0).max(2000000),
    end: z.number().int().min(0).max(2000000),
  })
  .strict();
const warning =
  'Text comparison does not establish adoption, enactment or legal effect. Original legislative underline/strike-through may be absent from extracted text.';
const versionResult = z
  .object({
    version: z.literal('exact-line-lcs-v1'),
    left: source,
    right: source,
    changes: z
      .array(
        z
          .object({
            kind: z.enum(['unchanged', 'removed', 'added']),
            text,
            left: range.nullable(),
            right: range.nullable(),
          })
          .strict(),
      )
      .max(20000),
    classification: z.enum([
      'identical_bytes',
      'reextraction_only',
      'layout_only',
      'textual_change',
    ]),
    warning: z.literal(warning),
    scope: z
      .object({
        clientId: uuid.nullable(),
        folderId: text.nullable(),
        jurisdiction: z.string().regex(/^[A-Z]{2}$/),
        sessionKey: text,
      })
      .strict(),
  })
  .strict();
const invalid = () => new ServiceUnavailableException('Comparison owner response invalid');
function request<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException('Choose an exact comparison source pair');
  return result.data;
}
function response<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid();
  return result.data;
}
export const parseBudgetComparison = (raw: unknown) => request(budgetRequest, raw);
export const parseVersionComparison = (raw: unknown) => request(versionRequest, raw);
function envelope<T>(
  tool: string,
  selection: BudgetComparisonRequest | VersionComparisonRequest,
  data: T,
) {
  return {
    version: '0.1.0' as const,
    tool,
    generatedAt: new Date().toISOString(),
    selection,
    data,
    effects: [],
    coverage: {
      basis: 'exact_source_pair' as const,
      sourceUniverseComplete: false,
      maxOutputBytes: 262144,
      limitations: [
        'Selected immutable source revisions only; no missing, truncated or cross-pair results are synthesized.',
      ],
    },
  };
}
export function receiveBudgetComparison(input: BudgetComparisonRequest, raw: unknown) {
  const data = response(budgetResult, raw);
  if (
    data.left.id !== input.leftId ||
    data.right.id !== input.rightId ||
    data.left.sourceRevision !== input.leftRevision ||
    data.right.sourceRevision !== input.rightRevision ||
    (data.comparable
      ? data.deltaMinorUnits === null
      : data.deltaMinorUnits !== null || data.percentage !== null || !data.reasons.length)
  )
    throw invalid();
  return envelope('compare_florida_budget_amounts', input, data);
}
export function receiveVersionComparison(input: VersionComparisonRequest, raw: unknown) {
  const data = response(versionResult, raw);
  if (
    data.left.id !== input.leftId ||
    data.right.id !== input.rightId ||
    data.left.revision !== input.leftRevision ||
    data.right.revision !== input.rightRevision ||
    data.left.jurisdiction !== input.jurisdiction ||
    data.right.jurisdiction !== input.jurisdiction ||
    data.left.sessionKey !== input.sessionKey ||
    data.right.sessionKey !== (input.rightSessionKey ?? input.sessionKey) ||
    (!input.allowCrossBill && data.left.billId !== data.right.billId) ||
    data.scope.jurisdiction !== input.jurisdiction ||
    data.scope.sessionKey !== input.sessionKey ||
    data.scope.folderId !== input.folderId ||
    (input.clientId !== null && data.scope.clientId !== input.clientId)
  )
    throw invalid();
  for (const line of data.changes) {
    if (
      (line.kind !== 'added') !== (line.left !== null) ||
      (line.kind !== 'removed') !== (line.right !== null)
    )
      throw invalid();
    for (const span of [line.left, line.right])
      if (span && (span.text !== line.text || span.end - span.start !== line.text.length))
        throw invalid();
  }
  return envelope('compare_legislative_versions', input, data);
}
