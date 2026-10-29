import { PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { BILLING_STATUSES } from '@capiro/shared';
import { SAVED_RECORD_READ_SOURCES, type SavedRecordReadKind } from './saved-record-read-plan.js';

export const SAVED_RECORD_MAX_BYTES = 262_144;
const text = z.string();
const nullableText = text.nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite();
const date = z.string().datetime();
const uuid = z.string().uuid();
const sameUuid = (actual: string, expected: unknown) =>
  typeof expected === 'string' && actual.toLowerCase() === expected.toLowerCase();
const bucket = { costUsd: amount, inputTokens: count, outputTokens: count, count };
const status = z.enum(BILLING_STATUSES);
const event = z.object({
  id: uuid,
  tenantId: uuid,
  userId: uuid.nullable(),
  workflow: text,
  provider: text,
  model: text,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheCreationTokens: count,
  costUsd: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  usedTenantKey: z.boolean(),
  promptSpecVersion: nullableText,
  createdAt: date,
});
const savedItem = z.object({
  id: uuid,
  kind: text,
  hearingId: text,
  segmentId: nullableText,
  insightId: nullableText,
  clientId: uuid.nullable(),
  note: nullableText,
  createdAt: date,
  detailPath: text,
});
const schemas = {
  billing_state: z.object({
    billingEnabled: z.boolean(),
    status,
    slots: count,
    usedSlots: count,
    trialEndsAt: date.nullable(),
    onboardingFlowVersion: count.nullable(),
    locked: z.boolean(),
  }),
  billing_summary: z.object({
    billingEnabled: z.boolean(),
    status,
    slots: count,
    usedSlots: count,
    pricePerSlotUsd: amount,
    llmAllowanceUsd: amount,
    llmUsedUsd: amount,
    llmOverageUsd: amount,
    llmWarn: z.boolean(),
    llmHardCapUsd: amount.nullable(),
    currentPeriodEnd: date.nullable(),
    hasSubscription: z.boolean(),
  }),
  usage_summary: z.object({
    from: date,
    to: date,
    eventCount: count,
    totalCostUsd: amount,
    totalInputTokens: count,
    totalOutputTokens: count,
    tenantKeyEventCount: count,
    byWorkflow: z.array(z.object({ ...bucket, workflow: text })),
    byModel: z.array(z.object({ ...bucket, model: text })),
    byDay: z.array(z.object({ ...bucket, day: text })),
  }),
  usage_events: z.array(event).max(100),
  tenant_contact: z.object(
    Object.fromEntries(
      SAVED_RECORD_READ_SOURCES.tenant_contact.fields.map((key) => [key, text.optional()]),
    ),
  ),
  legiwatch_saved_items: z.object({
    rows: z.array(savedItem).max(100),
    total: count,
    page: count.min(1),
    pageSize: count.min(1).max(100),
    hasMore: z.boolean(),
  }),
  legiwatch_notification_preferences: z.object({
    committeeEmailEnabled: z.boolean(),
    emailAddress: nullableText,
  }),
} as const;

export function savedRecordUnavailable(): never {
  throw new ServiceUnavailableException('Saved-record owner response unavailable or invalid.');
}

export function boundSavedRecordResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > SAVED_RECORD_MAX_BYTES)
    throw new PayloadTooLargeException({
      code: 'SAVED_RECORD_RESULT_TOO_LARGE',
      message: 'This saved record exceeds the read limit. Open the exact record in its module.',
    });
  return value;
}

/** Streaming bound applies before JSON parsing; Content-Length is not trusted.
 * Source errors never enter the result or expose driver/authentication text. */
export async function readSavedRecordJson(response: Response): Promise<unknown> {
  if (!response.body) return savedRecordUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > SAVED_RECORD_MAX_BYTES) {
        await reader.cancel();
        throw new PayloadTooLargeException('Saved-record owner result exceeds the read limit.');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return savedRecordUnavailable();
  }
}

/** Zod object projection strips unlisted source fields, including legacy
 * contactInfo extras. Current owner permission is established by HTTP guards. */
export function receiveCoreSavedRecord(kind: SavedRecordReadKind, raw: unknown, tenantId: string) {
  const parsed = schemas[kind].safeParse(raw);
  if (!parsed.success) return savedRecordUnavailable();
  if (
    kind === 'usage_events' &&
    (parsed.data as z.infer<typeof event>[]).some((row) => row.tenantId !== tenantId)
  )
    return savedRecordUnavailable();
  return boundSavedRecordResult({
    version: '0.1.0' as const,
    kind,
    coverage: {
      basis: 'current_owner_read' as const,
      limitations: [
        SAVED_RECORD_READ_SOURCES[kind].limitation,
        ...(kind === 'tenant_contact'
          ? [
              'Only canonical contact-info string fields are returned; legacy extra keys are omitted.',
            ]
          : []),
      ],
    },
    maxOutputBytes: SAVED_RECORD_MAX_BYTES,
    data: parsed.data,
  });
}

export const WORKSPACE_SAVED_KINDS = [
  'library',
  'documents',
  'versions',
  'comments',
  'hill_day',
  'newsletter_stage',
  'newsletters',
  'newsletter',
  'saved_version',
  'outreach_revision',
] as const;
export type WorkspaceSavedKind = (typeof WORKSPACE_SAVED_KINDS)[number];

const object = z.record(z.string(), z.unknown());
const workspaceEnvelope = z
  .object({
    version: z.literal('0.1.0'),
    kind: z.enum(WORKSPACE_SAVED_KINDS),
    coverage: z
      .object({ basis: z.literal('current_owner_read'), limitations: z.array(text).max(20) })
      .strict(),
    maxOutputBytes: z.literal(SAVED_RECORD_MAX_BYTES),
    data: z.unknown(),
  })
  .strict();
const versionData = z
  .object({
    draftId: uuid,
    versionId: uuid,
    label: nullableText,
    authorId: text,
    authorKind: text,
    savedAt: date,
    snapshot: z.unknown(),
  })
  .strict();
const documentMetadata = z
  .object({ id: uuid, name: text, ordinal: count, createdAt: date, updatedAt: date })
  .strict();
const versionMetadata = z
  .object({ id: uuid, label: nullableText, authorId: text, authorKind: text, createdAt: date })
  .strict();
const displayOwner = z.object({ id: text, name: text, initials: text }).strict();
const libraryItem = z
  .object({
    id: uuid,
    kind: z.enum(['hillday', 'draft']),
    name: text,
    blueprint: text,
    clientId: uuid.nullable().optional(),
    clientAssociation: z.literal('held').optional(),
    client: nullableText,
    status: text,
    updatedAt: date,
    owner: displayOwner,
    route: text,
  })
  .strict();
const newsletter = z
  .object({
    id: uuid,
    name: text,
    revision: count,
    status: z.enum(['draft', 'staged']),
    ownerId: text,
    updatedAt: date,
    config: object,
    design: object,
  })
  .strict();
const outreach = z
  .object({
    draftId: uuid,
    versionId: uuid,
    authorId: text,
    authorKind: text,
    savedAt: date,
    snapshot: z.unknown(),
    clientId: uuid.nullable(),
    contentSkeleton: z.object({ subject: text, body: text, slots: z.array(z.unknown()) }).strict(),
    projectionVersion: text,
    snapshotHash: text.regex(/^[0-9a-f]{64}$/),
    projectionHash: text.regex(/^[0-9a-f]{64}$/),
    hashFormat: z.literal('workspace-snapshot-canonical-json-v1'),
  })
  .strict();

/** Workspace owns rich saved JSON, not a Core reinterpretation of its editor
 * schema. Validate envelope, selected identity and structural read shape; keep
 * exact snapshots and owner coverage intact under the full UTF-8 bound. */
export function receiveWorkspaceSavedRecord(
  kind: WorkspaceSavedKind,
  input: Record<string, unknown>,
  raw: unknown,
) {
  const parsed = workspaceEnvelope.safeParse(raw);
  if (!parsed.success || parsed.data.kind !== kind) return savedRecordUnavailable();
  const value = parsed.data;
  if (kind === 'saved_version') {
    const data = versionData.safeParse(value.data);
    if (
      !data.success ||
      !sameUuid(data.data.draftId, input.draftId) ||
      !sameUuid(data.data.versionId, input.versionId) ||
      data.data.snapshot === undefined
    )
      return savedRecordUnavailable();
  } else if (kind === 'documents' || kind === 'versions') {
    const data = z
      .object({
        draftId: uuid,
        items: z.array(kind === 'documents' ? documentMetadata : versionMetadata),
      })
      .strict()
      .safeParse(value.data);
    if (!data.success || !sameUuid(data.data.draftId, input.draftId))
      return savedRecordUnavailable();
  } else if (kind === 'comments') {
    const data = z
      .object({ documentId: uuid, threads: z.array(object) })
      .strict()
      .safeParse(value.data);
    if (!data.success || !sameUuid(data.data.documentId, input.documentId))
      return savedRecordUnavailable();
  } else if (kind === 'newsletters') {
    if (
      !z
        .object({ items: z.array(newsletter).max(100) })
        .strict()
        .safeParse(value.data).success
    )
      return savedRecordUnavailable();
  } else if (kind === 'newsletter') {
    const data = newsletter.safeParse(value.data);
    if (!data.success || !sameUuid(data.data.id, input.documentId)) return savedRecordUnavailable();
  } else if (kind === 'hill_day') {
    const data = z
      .object({
        id: uuid,
        name: text,
        sections: z.array(object),
        summary: z.array(object),
        provenance: object,
        generation: object,
        updatedAt: date,
        createdAt: date,
      })
      .passthrough()
      .safeParse(value.data);
    if (!data.success || !sameUuid(data.data.id, input.documentId)) return savedRecordUnavailable();
  } else if (kind === 'newsletter_stage' && value.data !== null) {
    const data = z
      .object({
        id: uuid,
        documentId: uuid,
        revision: count,
        name: text,
        createdAt: date,
        route: text,
      })
      .strict()
      .safeParse(value.data);
    if (
      !data.success ||
      !sameUuid(data.data.documentId, input.documentId) ||
      data.data.revision !== input.revision
    )
      return savedRecordUnavailable();
  } else if (kind === 'library') {
    if (
      !z
        .object({ items: z.array(libraryItem).max(50), nextCursor: nullableText })
        .strict()
        .safeParse(value.data).success
    )
      return savedRecordUnavailable();
  } else if (kind === 'outreach_revision') {
    const data = outreach.safeParse(value.data);
    if (
      !data.success ||
      data.data.draftId !== String(input.draftId).toLowerCase() ||
      data.data.versionId !== String(input.versionId).toLowerCase()
    )
      return savedRecordUnavailable();
  } else if (
    !(kind === 'newsletter_stage' && value.data === null) &&
    !object.safeParse(value.data).success
  ) {
    return savedRecordUnavailable();
  }
  return boundSavedRecordResult(value);
}
