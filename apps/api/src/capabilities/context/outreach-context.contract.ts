import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { outreachTargetLocatorV1Schema } from '../targets/outreach-target.contract.js';

export const OUTREACH_CONTEXT_CLASSES = [
  'required_policy',
  'writing_guidance',
  'campaign_fact',
  'target_specific',
  'group_safe',
] as const;
export type OutreachContextClass = (typeof OUTREACH_CONTEXT_CLASSES)[number];

export const OUTREACH_CONTEXT_VERIFICATION_CLASSES = [
  'authoritative',
  'first_party',
  'derived',
  'user_supplied',
  'unverified',
] as const;
export type OutreachContextVerificationClass =
  (typeof OUTREACH_CONTEXT_VERIFICATION_CLASSES)[number];

export const OUTREACH_CONTEXT_SENSITIVITY = ['normal', 'confidential', 'restricted'] as const;
export type OutreachContextSensitivity = (typeof OUTREACH_CONTEXT_SENSITIVITY)[number];

export const OUTREACH_CONTEXT_LIMITS = Object.freeze({
  selectedPerClass: 500,
  title: 320,
  summary: 12_000,
  text: 24_000,
  sourceLabel: 240,
  sourceId: 384,
  sourceVersion: 320,
  targetKey: 384,
  groupRef: 160,
  factCode: 120,
  contextKey: 512,
});

const forbiddenControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const bounded = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((value) => !forbiddenControlCharacters.test(value), {
      message: 'Text contains disallowed control characters.',
    });
const nullable = (max: number) => bounded(max).nullable();
const clientId = z.string().uuid();

export const outreachContextScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('campaign') }).strict(),
  z
    .object({
      kind: z.literal('target'),
      targetKey: bounded(OUTREACH_CONTEXT_LIMITS.targetKey, 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group'),
      groupRef: bounded(OUTREACH_CONTEXT_LIMITS.groupRef, 1),
    })
    .strict(),
]);
export type OutreachContextScopeV1 = z.infer<typeof outreachContextScopeV1Schema>;

const memoryItemLocatorSchema = z
  .object({
    source: z.literal('memory_item'),
    id: z.string().uuid(),
    clientId: clientId.nullable(),
  })
  .strict();

const capiroRecordLocatorSchema = z
  .object({
    source: z.literal('capiro_record'),
    recordType: z.enum(['client', 'meeting', 'engagement_task']),
    id: z.string().uuid(),
    clientId: clientId.nullable(),
  })
  .strict();

const documentLocatorSchema = z
  .object({
    source: z.literal('document'),
    id: z.string().uuid(),
    clientId: clientId.nullable(),
  })
  .strict();

export const OUTREACH_GOVERNMENT_RECORD_CATEGORIES = [
  'bill',
  'award',
  'lda_filing',
  'hearing',
  'sec_filing',
  'fara_registration',
  'gao_report',
  'crs_report',
  'regulatory_docket',
  'intel_article',
  'state_bill',
  'federal_register',
] as const;

const governmentRecordLocatorSchema = z
  .object({
    source: z.literal('government_record'),
    category: z.enum(OUTREACH_GOVERNMENT_RECORD_CATEGORIES),
    id: bounded(OUTREACH_CONTEXT_LIMITS.sourceId, 1),
  })
  .strict();

const targetProfileFactLocatorSchema = z
  .object({
    source: z.literal('target_profile_fact'),
    targetRef: outreachTargetLocatorV1Schema,
    factCode: bounded(OUTREACH_CONTEXT_LIMITS.factCode, 1),
  })
  .strict();

const manualContextLocatorSchema = z
  .object({
    source: z.literal('manual'),
    id: z.string().uuid(),
    title: bounded(OUTREACH_CONTEXT_LIMITS.title, 1),
    text: bounded(OUTREACH_CONTEXT_LIMITS.text, 1),
    sourceLabel: nullable(OUTREACH_CONTEXT_LIMITS.sourceLabel),
  })
  .strict();

export const outreachContextLocatorV1Schema = z.discriminatedUnion('source', [
  memoryItemLocatorSchema,
  capiroRecordLocatorSchema,
  documentLocatorSchema,
  governmentRecordLocatorSchema,
  targetProfileFactLocatorSchema,
  manualContextLocatorSchema,
]);
export type OutreachContextLocatorV1 = z.infer<typeof outreachContextLocatorV1Schema>;

export const outreachContextSelectionV1Schema = z
  .object({
    locator: outreachContextLocatorV1Schema,
    contextClass: z.enum(OUTREACH_CONTEXT_CLASSES),
    scope: outreachContextScopeV1Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contextClass === 'target_specific' && value.scope.kind !== 'target') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Target-specific context requires target scope.',
      });
    }
    if (value.contextClass === 'group_safe' && value.scope.kind !== 'group') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Group-safe context requires group scope.',
      });
    }
    if (
      value.locator.source === 'target_profile_fact' &&
      value.scope.kind !== 'target'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Target-profile facts require target scope.',
      });
    }
  });
export type OutreachContextSelectionV1 = z.infer<typeof outreachContextSelectionV1Schema>;

const contextSourceSnapshotSchema = z
  .object({
    system: bounded(96, 1),
    version: nullable(OUTREACH_CONTEXT_LIMITS.sourceVersion),
    lastVerifiedAt: nullable(64),
  })
  .strict();

const resolvedContextBaseSchema = z
  .object({
    contextKey: bounded(OUTREACH_CONTEXT_LIMITS.contextKey, 1),
    locator: outreachContextLocatorV1Schema,
    contextClass: z.enum(OUTREACH_CONTEXT_CLASSES),
    scope: outreachContextScopeV1Schema,
    title: bounded(OUTREACH_CONTEXT_LIMITS.title, 1),
    summary: bounded(OUTREACH_CONTEXT_LIMITS.summary, 1),
    clientId: clientId.nullable(),
    verificationClass: z.enum(OUTREACH_CONTEXT_VERIFICATION_CLASSES),
    sensitivity: z.enum(OUTREACH_CONTEXT_SENSITIVITY),
    instructionsAllowed: z.boolean(),
    usableAsEvidence: z.boolean(),
    usableAsWritingGuidance: z.boolean(),
    sourceSnapshot: contextSourceSnapshotSchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type OutreachResolvedContextRefV1 = z.infer<typeof resolvedContextBaseSchema>;

export const outreachResolvedContextRefV1Schema = resolvedContextBaseSchema.superRefine(
  (value, ctx) => {
    const expectedKey = contextKeyForSelection({
      locator: value.locator,
      contextClass: value.contextClass,
      scope: value.scope,
    });
    if (value.contextKey !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextKey'],
        message: 'Context key does not match its locator, class and scope.',
      });
    }
    const expectedHash = hashContextSnapshot(value);
    if (value.snapshotHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'Context snapshot hash does not match canonical fields.',
      });
    }
    if (value.contextClass === 'writing_guidance' && !value.usableAsWritingGuidance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['usableAsWritingGuidance'],
        message: 'Writing guidance must be explicitly usable as guidance.',
      });
    }
    if (value.contextClass === 'target_specific' && value.scope.kind !== 'target') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Target-specific context requires target scope.',
      });
    }
    if (value.contextClass === 'group_safe' && value.scope.kind !== 'group') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'Group-safe context requires group scope.',
      });
    }
  },
);

export const OUTREACH_CONTEXT_EXCLUSION_REASONS = [
  'user_excluded',
  'out_of_scope',
  'stale',
  'conflicting',
  'sensitive',
  'not_relevant',
  'superseded',
] as const;

export const outreachExcludedContextRefV1Schema = z
  .object({
    contextKey: bounded(OUTREACH_CONTEXT_LIMITS.contextKey, 1),
    reason: z.enum(OUTREACH_CONTEXT_EXCLUSION_REASONS),
  })
  .strict();
export type OutreachExcludedContextRefV1 = z.infer<
  typeof outreachExcludedContextRefV1Schema
>;

export function createManualContextLocator(input: {
  id?: string;
  title: string;
  text: string;
  sourceLabel?: string | null;
}): OutreachContextLocatorV1 {
  return normalizeContextLocatorV1({
    source: 'manual',
    id: input.id ?? randomUUID(),
    title: input.title,
    text: input.text,
    sourceLabel: input.sourceLabel ?? null,
  });
}

export function normalizeContextLocatorV1(input: unknown): OutreachContextLocatorV1 {
  const parsed = outreachContextLocatorV1Schema.parse(input);
  if (parsed.source === 'manual') {
    return {
      ...parsed,
      title: normalizeRequired(parsed.title),
      text: normalizeRequired(parsed.text),
      sourceLabel: normalizeNullable(parsed.sourceLabel),
    };
  }
  if (parsed.source === 'government_record') {
    return { ...parsed, id: parsed.id.trim() };
  }
  if (parsed.source === 'target_profile_fact') {
    return { ...parsed, factCode: parsed.factCode.trim() };
  }
  return {
    ...parsed,
    id: parsed.id.toLowerCase(),
    ...('clientId' in parsed
      ? { clientId: parsed.clientId?.toLowerCase() ?? null }
      : {}),
  } as OutreachContextLocatorV1;
}

export function normalizeContextScopeV1(input: unknown): OutreachContextScopeV1 {
  const parsed = outreachContextScopeV1Schema.parse(input);
  if (parsed.kind === 'target') return { kind: 'target', targetKey: parsed.targetKey.trim() };
  if (parsed.kind === 'group') return { kind: 'group', groupRef: parsed.groupRef.trim() };
  return parsed;
}

export function normalizeContextSelectionV1(input: unknown): OutreachContextSelectionV1 {
  const parsed = outreachContextSelectionV1Schema.parse(input);
  return outreachContextSelectionV1Schema.parse({
    locator: normalizeContextLocatorV1(parsed.locator),
    contextClass: parsed.contextClass,
    scope: normalizeContextScopeV1(parsed.scope),
  });
}

export function contextKeyForSelection(input: OutreachContextSelectionV1): string {
  const selection = normalizeContextSelectionV1(input);
  const locatorId = locatorIdentity(selection.locator);
  const scopeId =
    selection.scope.kind === 'campaign'
      ? 'campaign'
      : selection.scope.kind === 'target'
        ? `target:${selection.scope.targetKey}`
        : `group:${selection.scope.groupRef}`;
  return `${selection.contextClass}:${scopeId}:${locatorId}`;
}

export function createResolvedContextRefV1(
  input: Omit<OutreachResolvedContextRefV1, 'contextKey' | 'snapshotHash'>,
): OutreachResolvedContextRefV1 {
  return normalizeResolvedContextRefV1({
    ...input,
    contextKey: contextKeyForSelection({
      locator: input.locator,
      contextClass: input.contextClass,
      scope: input.scope,
    }),
    snapshotHash: '0'.repeat(64),
  });
}

export function normalizeResolvedContextRefV1(input: unknown): OutreachResolvedContextRefV1 {
  const parsed = resolvedContextBaseSchema.parse(input);
  const locator = normalizeContextLocatorV1(parsed.locator);
  const scope = normalizeContextScopeV1(parsed.scope);
  const normalizedWithoutHash = {
    ...parsed,
    locator,
    scope,
    contextKey: contextKeyForSelection({
      locator,
      contextClass: parsed.contextClass,
      scope,
    }),
    title: normalizeRequired(parsed.title),
    summary: normalizeRequired(parsed.summary),
    clientId: parsed.clientId?.toLowerCase() ?? null,
    sourceSnapshot: {
      ...parsed.sourceSnapshot,
      version: normalizeNullable(parsed.sourceSnapshot.version),
      lastVerifiedAt: normalizeNullable(parsed.sourceSnapshot.lastVerifiedAt),
    },
  };
  const result = {
    ...normalizedWithoutHash,
    snapshotHash: hashContextSnapshot(normalizedWithoutHash),
  };
  return outreachResolvedContextRefV1Schema.parse(result);
}

export function normalizeResolvedContextRefsV1(
  inputs: readonly unknown[],
): OutreachResolvedContextRefV1[] {
  const byKey = new Map<string, OutreachResolvedContextRefV1>();
  for (const input of inputs) {
    const value = normalizeResolvedContextRefV1(input);
    if (!byKey.has(value.contextKey)) byKey.set(value.contextKey, value);
  }
  return [...byKey.values()].sort((a, b) => compare(a.contextKey, b.contextKey));
}

export function normalizeExcludedContextRefsV1(
  inputs: readonly unknown[],
): OutreachExcludedContextRefV1[] {
  const byKey = new Map<string, OutreachExcludedContextRefV1>();
  for (const input of inputs) {
    const parsed = outreachExcludedContextRefV1Schema.parse(input);
    byKey.set(parsed.contextKey, parsed);
  }
  return [...byKey.values()].sort((a, b) => compare(a.contextKey, b.contextKey));
}

function locatorIdentity(locator: OutreachContextLocatorV1): string {
  switch (locator.source) {
    case 'memory_item':
      return `memory_item:${locator.id}`;
    case 'capiro_record':
      return `capiro_record:${locator.recordType}:${locator.id}`;
    case 'document':
      return `document:${locator.id}`;
    case 'government_record':
      return `government_record:${locator.category}:${locator.id}`;
    case 'target_profile_fact':
      return `target_profile_fact:${targetLocatorIdentity(locator.targetRef)}:${locator.factCode}`;
    case 'manual':
      return `manual:${locator.id}`;
  }
}

function targetLocatorIdentity(locator: z.infer<typeof outreachTargetLocatorV1Schema>): string {
  return `${locator.source}:${locator.id}`;
}

function hashContextSnapshot(input: Omit<OutreachResolvedContextRefV1, 'snapshotHash'>): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        contextKey: input.contextKey,
        locator: input.locator,
        contextClass: input.contextClass,
        scope: input.scope,
        title: input.title,
        summary: input.summary,
        clientId: input.clientId,
        verificationClass: input.verificationClass,
        sensitivity: input.sensitivity,
        instructionsAllowed: input.instructionsAllowed,
        usableAsEvidence: input.usableAsEvidence,
        usableAsWritingGuidance: input.usableAsWritingGuidance,
        sourceSnapshot: input.sourceSnapshot,
      }),
      'utf8',
    )
    .digest('hex');
}

function normalizeRequired(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizeRequired(value);
  return normalized.length ? normalized : null;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}
