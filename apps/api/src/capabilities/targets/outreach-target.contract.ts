import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const OUTREACH_TARGET_SOURCES = [
  'directory_member',
  'directory_staff',
  'state_legislator',
  'client_person',
  'engagement_contact',
  'manual',
] as const;

export type OutreachTargetSource = (typeof OUTREACH_TARGET_SOURCES)[number];

export const OUTREACH_TARGET_LIMITS = Object.freeze({
  selectedTargets: 500,
  displayName: 240,
  title: 240,
  organization: 240,
  email: 320,
  phone: 80,
  note: 2_000,
  sourceId: 256,
  sourceVersion: 256,
  committees: 50,
  issueAreas: 50,
  textListItem: 240,
  recommendationRef: 80,
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
const sourceId = bounded(OUTREACH_TARGET_LIMITS.sourceId, 1);
const clientId = z.string().uuid();
const manualId = z.string().uuid();

const directoryMemberLocatorSchema = z
  .object({ source: z.literal('directory_member'), id: sourceId })
  .strict();
const directoryStaffLocatorSchema = z
  .object({ source: z.literal('directory_staff'), id: sourceId })
  .strict();
const stateLegislatorLocatorSchema = z
  .object({ source: z.literal('state_legislator'), id: sourceId })
  .strict();
const clientPersonLocatorSchema = z
  .object({ source: z.literal('client_person'), id: z.string().uuid(), clientId })
  .strict();
const engagementContactLocatorSchema = z
  .object({
    source: z.literal('engagement_contact'),
    id: z.string().uuid(),
    clientId: clientId.nullable(),
  })
  .strict();
const manualTargetLocatorSchema = z
  .object({
    source: z.literal('manual'),
    id: manualId,
    name: bounded(OUTREACH_TARGET_LIMITS.displayName, 1),
    email: z.string().email().max(OUTREACH_TARGET_LIMITS.email).nullable(),
    phone: nullable(OUTREACH_TARGET_LIMITS.phone),
    title: nullable(OUTREACH_TARGET_LIMITS.title),
    organization: nullable(OUTREACH_TARGET_LIMITS.organization),
    note: nullable(OUTREACH_TARGET_LIMITS.note),
  })
  .strict();

export const outreachTargetLocatorV1Schema = z.discriminatedUnion('source', [
  directoryMemberLocatorSchema,
  directoryStaffLocatorSchema,
  stateLegislatorLocatorSchema,
  clientPersonLocatorSchema,
  engagementContactLocatorSchema,
  manualTargetLocatorSchema,
]);

export type OutreachTargetLocatorV1 = z.infer<typeof outreachTargetLocatorV1Schema>;

export const OUTREACH_TARGET_ROLE_STATUSES = ['current', 'historical', 'unknown'] as const;
export const OUTREACH_TARGET_EMAIL_STATUSES = ['available', 'missing', 'invalid'] as const;
export const OUTREACH_TARGET_PROFILE_STATUSES = ['complete', 'limited', 'unavailable'] as const;

const targetJurisdictionSchema = z
  .object({
    governmentLevel: z
      .enum(['federal', 'state', 'local', 'agency', 'corporate', 'unknown'])
      .default('unknown'),
    chamber: nullable(80),
    state: nullable(80),
    district: nullable(80),
    committees: z.array(bounded(OUTREACH_TARGET_LIMITS.textListItem, 1)).max(
      OUTREACH_TARGET_LIMITS.committees,
    ),
    issueAreas: z.array(bounded(OUTREACH_TARGET_LIMITS.textListItem, 1)).max(
      OUTREACH_TARGET_LIMITS.issueAreas,
    ),
  })
  .strict();

const targetSourceSnapshotSchema = z
  .object({
    system: bounded(80, 1),
    version: nullable(OUTREACH_TARGET_LIMITS.sourceVersion),
    lastVerifiedAt: nullable(64),
  })
  .strict();

const resolvedTargetBaseSchema = z
  .object({
    targetKey: bounded(384, 1),
    locator: outreachTargetLocatorV1Schema,
    displayName: bounded(OUTREACH_TARGET_LIMITS.displayName, 1),
    email: z.string().email().max(OUTREACH_TARGET_LIMITS.email).nullable(),
    phone: nullable(OUTREACH_TARGET_LIMITS.phone),
    title: nullable(OUTREACH_TARGET_LIMITS.title),
    organization: nullable(OUTREACH_TARGET_LIMITS.organization),
    clientId: clientId.nullable(),
    jurisdiction: targetJurisdictionSchema,
    roleStatus: z.enum(OUTREACH_TARGET_ROLE_STATUSES),
    emailStatus: z.enum(OUTREACH_TARGET_EMAIL_STATUSES),
    profileStatus: z.enum(OUTREACH_TARGET_PROFILE_STATUSES),
    sourceSnapshot: targetSourceSnapshotSchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const outreachResolvedTargetRefV1Schema = resolvedTargetBaseSchema.superRefine(
  (value, ctx) => {
    const expectedKey = targetKeyForLocator(value.locator);
    if (value.targetKey !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetKey'],
        message: 'Target key does not match its locator.',
      });
    }
    const expectedHash = hashResolvedTargetSnapshot(value);
    if (value.snapshotHash !== expectedHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHash'],
        message: 'Target snapshot hash does not match its canonical fields.',
      });
    }
  },
);

export type OutreachResolvedTargetRefV1 = z.infer<typeof resolvedTargetBaseSchema>;

export const OUTREACH_TARGET_REJECTION_REASONS = [
  'not_relevant',
  'wrong_jurisdiction',
  'wrong_role',
  'already_covered',
  'other',
] as const;

export const outreachRejectedTargetRecommendationV1Schema = z
  .object({
    recommendationRef: z
      .string()
      .regex(/^orec_[a-f0-9]{64}$/)
      .max(OUTREACH_TARGET_LIMITS.recommendationRef),
    targetKey: bounded(384, 1),
    reason: z.enum(OUTREACH_TARGET_REJECTION_REASONS),
  })
  .strict();

export type OutreachRejectedTargetRecommendationV1 = z.infer<
  typeof outreachRejectedTargetRecommendationV1Schema
>;

export function createManualTargetLocator(input: {
  id?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  organization?: string | null;
  note?: string | null;
}): OutreachTargetLocatorV1 {
  return normalizeTargetLocatorV1({
    source: 'manual',
    id: input.id ?? randomUUID(),
    name: input.name,
    email: input.email ?? null,
    phone: input.phone ?? null,
    title: input.title ?? null,
    organization: input.organization ?? null,
    note: input.note ?? null,
  });
}

export function normalizeTargetLocatorV1(input: unknown): OutreachTargetLocatorV1 {
  const parsed = outreachTargetLocatorV1Schema.parse(input);
  if (parsed.source === 'manual') {
    return {
      ...parsed,
      name: parsed.name.trim(),
      email: parsed.email?.trim().toLowerCase() || null,
      phone: normalizeNullable(parsed.phone),
      title: normalizeNullable(parsed.title),
      organization: normalizeNullable(parsed.organization),
      note: normalizeNullable(parsed.note),
    };
  }
  if (parsed.source === 'client_person') {
    return { ...parsed, id: parsed.id.toLowerCase(), clientId: parsed.clientId.toLowerCase() };
  }
  if (parsed.source === 'engagement_contact') {
    return {
      ...parsed,
      id: parsed.id.toLowerCase(),
      clientId: parsed.clientId?.toLowerCase() ?? null,
    };
  }
  return { ...parsed, id: parsed.id.trim() };
}

export function targetKeyForLocator(input: OutreachTargetLocatorV1): string {
  const locator = normalizeTargetLocatorV1(input);
  return `${locator.source}:${locator.id}`;
}

export function normalizeResolvedTargetRefV1(input: unknown): OutreachResolvedTargetRefV1 {
  const parsed = resolvedTargetBaseSchema.parse(input);
  const locator = normalizeTargetLocatorV1(parsed.locator);
  const normalizedWithoutHash = {
    ...parsed,
    targetKey: targetKeyForLocator(locator),
    locator,
    displayName: parsed.displayName.trim(),
    email: parsed.email?.trim().toLowerCase() || null,
    phone: normalizeNullable(parsed.phone),
    title: normalizeNullable(parsed.title),
    organization: normalizeNullable(parsed.organization),
    clientId: parsed.clientId?.toLowerCase() ?? null,
    jurisdiction: {
      ...parsed.jurisdiction,
      chamber: normalizeNullable(parsed.jurisdiction.chamber),
      state: normalizeNullable(parsed.jurisdiction.state),
      district: normalizeNullable(parsed.jurisdiction.district),
      committees: normalizeSet(parsed.jurisdiction.committees),
      issueAreas: normalizeSet(parsed.jurisdiction.issueAreas),
    },
    sourceSnapshot: {
      ...parsed.sourceSnapshot,
      version: normalizeNullable(parsed.sourceSnapshot.version),
      lastVerifiedAt: normalizeNullable(parsed.sourceSnapshot.lastVerifiedAt),
    },
  };
  const result = {
    ...normalizedWithoutHash,
    snapshotHash: hashResolvedTargetSnapshot(normalizedWithoutHash),
  };
  return outreachResolvedTargetRefV1Schema.parse(result);
}

export function createResolvedTargetRefV1(
  input: Omit<OutreachResolvedTargetRefV1, 'targetKey' | 'snapshotHash'>,
): OutreachResolvedTargetRefV1 {
  return normalizeResolvedTargetRefV1({
    ...input,
    targetKey: targetKeyForLocator(input.locator),
    snapshotHash: '0'.repeat(64),
  });
}

export function normalizeResolvedTargetRefsV1(
  inputs: readonly unknown[],
): OutreachResolvedTargetRefV1[] {
  const byKey = new Map<string, OutreachResolvedTargetRefV1>();
  for (const input of inputs) {
    const resolved = normalizeResolvedTargetRefV1(input);
    if (!byKey.has(resolved.targetKey)) byKey.set(resolved.targetKey, resolved);
  }
  return [...byKey.values()].sort((a, b) => compare(a.targetKey, b.targetKey));
}

export function normalizeRejectedTargetRecommendationsV1(
  inputs: readonly unknown[],
): OutreachRejectedTargetRecommendationV1[] {
  const byRef = new Map<string, OutreachRejectedTargetRecommendationV1>();
  for (const input of inputs) {
    const parsed = outreachRejectedTargetRecommendationV1Schema.parse(input);
    if (!byRef.has(parsed.recommendationRef)) byRef.set(parsed.recommendationRef, parsed);
  }
  return [...byRef.values()].sort((a, b) => compare(a.recommendationRef, b.recommendationRef));
}

export function recommendationRefForTarget(input: {
  targetKey: string;
  criteriaHash: string;
  clientId?: string | null;
}): string {
  const digest = createHash('sha256')
    .update(
      `outreach-target-recommendation-v1|${input.targetKey}|${input.criteriaHash}|${input.clientId ?? ''}`,
      'utf8',
    )
    .digest('hex');
  return `orec_${digest}`;
}

export function emailStatusFor(email: string | null): 'available' | 'missing' | 'invalid' {
  if (!email) return 'missing';
  return z.string().email().safeParse(email).success ? 'available' : 'invalid';
}

function hashResolvedTargetSnapshot(input: {
  targetKey: string;
  locator: OutreachTargetLocatorV1;
  displayName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  organization: string | null;
  clientId: string | null;
  jurisdiction: z.infer<typeof targetJurisdictionSchema>;
  roleStatus: (typeof OUTREACH_TARGET_ROLE_STATUSES)[number];
  emailStatus: (typeof OUTREACH_TARGET_EMAIL_STATUSES)[number];
  profileStatus: (typeof OUTREACH_TARGET_PROFILE_STATUSES)[number];
  sourceSnapshot: z.infer<typeof targetSourceSnapshotSchema>;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        targetKey: input.targetKey,
        locator: input.locator,
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
        title: input.title,
        organization: input.organization,
        clientId: input.clientId,
        jurisdiction: input.jurisdiction,
        roleStatus: input.roleStatus,
        emailStatus: input.emailStatus,
        profileStatus: input.profileStatus,
        sourceSnapshot: input.sourceSnapshot,
      }),
      'utf8',
    )
    .digest('hex');
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  return normalized.length ? normalized : null;
}

function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(compare);
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
