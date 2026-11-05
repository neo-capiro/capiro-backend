import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(180);
const canonicalOfficeTerm = (value: { sourceDirectory?: string; officeTerm?: string }) =>
  value.sourceDirectory !== 'congress' || /^congress:[1-9]\d{0,2}$/.test(value.officeTerm ?? '');
const date = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) <= Date.now(), 'Date must not be in the future');
const sourceUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  }, 'A public HTTP source URL is required');
export const evidenceSchema = z
  .object({
    url: sourceUrl.optional(),
    attachmentId: z.string().uuid().optional(),
    title: short,
    excerpt: text,
    observedAt: date,
    sourceType: z.enum(['official', 'company', 'document', 'person']),
  })
  .strict()
  .refine(
    (value) => value.sourceType === 'person' || !!value.url || !!value.attachmentId,
    'A source URL, attachment, or explicit person provenance is required',
  );
export const evidenceListSchema = z.array(evidenceSchema).min(1).max(24);
export type PortfolioEvidence = z.infer<typeof evidenceSchema>;

export const capabilityPayloadSchema = z
  .object({
    name: short,
    type: z.enum(['product', 'platform', 'service', 'program', 'component']),
    lifecycle: z.enum(['in_service', 'in_development', 'planned', 'unspecified']),
    description: z.string().trim().max(4000).default(''),
    tags: z.array(short).max(40).default([]),
    businessUnitId: z.string().uuid().optional(),
    expectedCapabilityVersion: z.number().int().positive().optional(),
    classification: z.literal('capability').default('capability'),
  })
  .strict();
export const alignmentPayloadSchema = z
  .object({
    targetType: z.enum(['keyword', 'tag', 'pe', 'program', 'naics', 'psc']),
    value: short,
    rationale: text,
    score: z.number().min(0).max(100).optional(),
  })
  .strict();
export const officePayloadSchema = z
  .object({
    memberId: short,
    sourceDirectory: z.enum(['congress', 'state']),
    officeTerm: short,
    rationale: text,
    entryPoint: text,
    whyNot: text,
    suggestedOwnerUserId: z.string().uuid().optional(),
    fitRating: z.enum(['strong', 'moderate', 'limited']).optional(),
    stance: z
      .enum(['unknown', 'interested', 'supportive', 'champion', 'declined'])
      .default('unknown'),
  })
  .strict()
  .refine(canonicalOfficeTerm, 'Congress office terms must use canonical congress:N identity');
export const statementPayloadSchema = z
  .object({
    memberId: short,
    sourceDirectory: z.enum(['congress', 'state']),
    officeTerm: short,
    statementDate: date,
    summary: text,
    tags: z.array(short).max(40).default([]),
    // Existing member press is the canonical source when available.
    pressItemId: z.string().uuid().optional(),
  })
  .strict()
  .refine(canonicalOfficeTerm, 'Congress office terms must use canonical congress:N identity');
export const CASE_FIELDS = [
  'impact',
  'priorities',
  'government_need',
  'readiness',
  'cost',
  'backing',
  'timing',
  'jobs',
  'payroll',
  'investment',
  'facility_size',
  'suppliers',
] as const;
export const casePayloadSchema = z
  .object({
    field: z.enum(CASE_FIELDS),
    text,
    memberId: short.optional(),
    sourceDirectory: z.enum(['congress', 'state']).optional(),
    officeTerm: short.optional(),
    supersedesProposalId: z.string().uuid().optional(),
    facilityId: z.string().uuid().optional(),
    value: z.number().nonnegative().optional(),
    unit: short.optional(),
  })
  .strict()
  .refine(
    (value) => !value.memberId || (!!value.sourceDirectory && !!value.officeTerm),
    'Member-specific fields require directory and term',
  )
  .refine(canonicalOfficeTerm, 'Congress office terms must use canonical congress:N identity');
const maturity = z
  .object({ current: short, steps: z.array(short).min(1).max(12) })
  .strict()
  .refine((value) => value.steps.includes(value.current), 'Maturity must occur in its step chain');
export const sectorPayloadSchema = z.discriminatedUnion('sector', [
  z
    .object({ sector: z.literal('defense'), pe: z.string().regex(/^\d{7}[A-Z]$/), maturity })
    .strict(),
  z
    .object({
      sector: z.literal('health'),
      agency: short,
      account: short,
      program: short,
      maturity,
    })
    .strict(),
  z
    .object({
      sector: z.literal('agriculture'),
      agency: z.literal('USDA'),
      program: short,
      farmBillTitle: short,
      maturity,
    })
    .strict(),
]);
export const businessUnitPayloadSchema = z
  .object({
    name: short,
    annualReportYear: z.number().int().min(2000).max(new Date().getUTCFullYear()),
  })
  .strict();
const base = { evidence: evidenceListSchema, capabilityId: z.string().uuid().optional() };
export const proposalSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('capability'), payload: capabilityPayloadSchema }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('alignment'),
      payload: alignmentPayloadSchema,
      capabilityId: z.string().uuid(),
    })
    .strict(),
  z
    .object({ ...base, kind: z.literal('office_recommendation'), payload: officePayloadSchema })
    .strict(),
  z.object({ ...base, kind: z.literal('statement'), payload: statementPayloadSchema }).strict(),
  z.object({ ...base, kind: z.literal('case_field'), payload: casePayloadSchema }).strict(),
  z.object({ ...base, kind: z.literal('sector_anchor'), payload: sectorPayloadSchema }).strict(),
  z
    .object({ ...base, kind: z.literal('business_unit'), payload: businessUnitPayloadSchema })
    .strict(),
]);
export type PortfolioProposalInput = z.infer<typeof proposalSchema>;
export const reviewSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(['approve', 'reject', 'restore']),
    reason: text.optional(),
  })
  .strict();
export type PortfolioReview = z.infer<typeof reviewSchema>;
export const editSchema = z
  .object({ expectedVersion: z.number().int().positive(), proposal: proposalSchema })
  .strict();
export const mergeSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(2).max(12),
    expectedVersions: z.array(z.number().int().positive()).min(2).max(12),
    name: short,
  })
  .strict()
  .refine(
    (v) => v.ids.length === v.expectedVersions.length && new Set(v.ids).size === v.ids.length,
    'One version per distinct proposal is required',
  );
export const splitSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    parts: z.array(capabilityPayloadSchema).min(2).max(12),
  })
  .strict();
export const bulkAlignmentSchema = z
  .object({
    items: z
      .array(
        z.object({ id: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export const relationshipSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    relationshipStatus: z
      .enum([
        'planned',
        'introduced',
        'in_discussion',
        'supportive',
        'champion',
        'declined',
        'uncontacted',
      ])
      .optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    lastContactAt: date.nullable().optional(),
    nextStep: z.string().trim().max(4000).nullable().optional(),
    officeTerm: short.optional(),
    termEvidence: evidenceListSchema.optional(),
    stance: z.enum(['unknown', 'interested', 'supportive', 'champion', 'declined']).optional(),
  })
  .strict()
  .refine(
    (value) => !value.officeTerm || !!value.termEvidence?.length,
    'Office term changes require reviewed official evidence',
  );
export const trackingSchema = z
  .object({
    itemKind: z.enum(['bill', 'hearing', 'budget', 'grant', 'news', 'statement']),
    itemId: short,
    action: z.enum(['track', 'dismiss', 'restore']),
    termIds: z.array(z.string().uuid()).max(40),
  })
  .strict();
export const discoverySchema = z
  .object({
    requestId: z.string().uuid(),
    businessUnitId: z.string().uuid().optional(),
    purpose: z.enum(['capabilities', 'alignment', 'business_units']).optional(),
    capabilityId: z.string().uuid().optional(),
    sources: z.array(z.literal('public_web')).max(1).optional(),
    attachmentIds: z.array(z.string().uuid()).max(10).optional(),
    website: sourceUrl.optional(),
  })
  .strict()
  .refine(
    (value) => value.sources?.length !== 0 || !!value.attachmentIds?.length,
    'Document-only discovery requires an attachment',
  );
export const discoveryResultsSchema = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(12).default(12),
    businessUnitId: z.string().uuid().optional(),
  })
  .strict();

export function parsePortfolio<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new BadRequestException({
      message: 'Invalid portfolio request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  return parsed.data;
}
export const normalized = (value: string) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function proposalKey(input: PortfolioProposalInput): string {
  // Identity remains stable when evidence is refreshed: rejected proposals cannot reappear through a new URL.
  const p = input.payload;
  const identity =
    input.kind === 'capability' || input.kind === 'business_unit'
      ? `${normalized((p as { name: string }).name)}${input.kind === 'capability' && input.capabilityId ? `:version:${input.payload.expectedCapabilityVersion ?? 'missing'}` : ''}`
      : input.kind === 'alignment'
        ? `${(p as z.infer<typeof alignmentPayloadSchema>).targetType}:${normalized((p as z.infer<typeof alignmentPayloadSchema>).value)}`
        : input.kind === 'office_recommendation'
          ? `${(p as z.infer<typeof officePayloadSchema>).sourceDirectory}:${(p as z.infer<typeof officePayloadSchema>).memberId}:${(p as z.infer<typeof officePayloadSchema>).officeTerm}`
          : JSON.stringify(p);
  return createHash('sha256')
    .update(`${input.kind}:${input.capabilityId ?? ''}:${identity}`)
    .digest('hex');
}
export function hasOfficialEvidence(evidence: PortfolioEvidence[]): boolean {
  return evidence.some(
    (item) =>
      item.sourceType === 'official' &&
      !!item.url &&
      /(^|\.)gov$/i.test(new URL(item.url).hostname),
  );
}

export const supportSchema = z
  .object({
    capabilityId: z.string().uuid(),
    stance: z.enum(['unknown', 'interested', 'supportive', 'champion', 'declined']),
    evidence: evidenceListSchema,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export const recommendSchema = z.object({ capabilityId: z.string().uuid().optional() }).strict();
