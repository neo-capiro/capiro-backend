/**
 * Immutable Package E ingestion manifest.
 *
 * V1 is deliberately narrow: it can drain only explicitly named, already
 * archived outbox rows in capiro-dev, with one active worker and no readiness,
 * approval, correction, publication, or canonical side effects. Widening any
 * of those boundaries requires a new schema version and content hash.
 */
import { z } from 'zod';

import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

export const INGESTION_MANIFEST_SCHEMA_VERSION_V1 = 'defense_budget_ingestion_manifest_v1' as const;

export const INGESTION_MANIFEST_MAX_DOCUMENTS_V1 = 5;
export const INGESTION_MANIFEST_DEFAULT_ACTIVE_WORKERS_V1 = 1;
export const INGESTION_MANIFEST_MAX_ACTIVE_WORKERS_V1 = 1;
export const INGESTION_MANIFEST_MAX_ATTEMPTS_V1 = 5;
export const INGESTION_MANIFEST_MAX_ELAPSED_SECONDS_V1 = 24 * 60 * 60;
export const INGESTION_MANIFEST_MAX_DOCUMENT_TIMEOUT_SECONDS_V1 = 6 * 60 * 60;

const SHA256_RE = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const RELEASE_REVISION_RE = /^[a-f0-9]{40}$/;
const ECS_TASK_DEFINITION_ARN_RE =
  /^arn:aws:ecs:us-east-1:967807252336:task-definition\/(capiro-dev-defense-budget-ingestion-drain):([1-9][0-9]*)$/;
const S3_BUCKET_RE =
  /^(?!xn--)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?![0-9]+(?:\.[0-9]+){3}$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const POSITIVE_USD_RE = /^(?:0\.(?:0[1-9]|[1-9][0-9]?)|[1-9][0-9]*(?:\.[0-9]{1,2})?)$/;

const PRESIGNED_QUERY_KEYS = new Set([
  'awsaccesskeyid',
  'expires',
  'googleaccessid',
  'se',
  'sig',
  'signature',
  'sp',
  'sv',
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-algorithm',
  'x-goog-credential',
  'x-goog-expires',
  'x-goog-signature',
]);

const nonBlank = (maximum = 4_096) => z.string().trim().min(1, 'must be nonblank').max(maximum);
const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(SHA256_RE, 'must be a lowercase SHA-256');
const imageDigestSchema = z
  .string()
  .regex(IMAGE_DIGEST_RE, 'must be a lowercase sha256:<64 hex> image digest');
const positiveInteger = z.number().int().positive();

function containsUrlCredentials(value: string): boolean {
  let url: URL;
  try {
    // A base also makes protocol-relative and ordinary relative durable
    // references parseable, so `//user:pass@host/...` and
    // `evidence.json?X-Amz-Signature=...` cannot bypass the credential scan.
    url = new URL(value, 'https://package-e-reference.invalid/');
  } catch {
    return false;
  }
  if (url.username || url.password) return true;
  for (const key of url.searchParams.keys()) {
    if (PRESIGNED_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

const durableReferenceSchema = nonBlank().refine(
  (value) => !containsUrlCredentials(value),
  'durable references must not contain URL userinfo or presigned credentials',
);

const officialHttpsLocatorSchema = z
  .string()
  .trim()
  .max(8_192)
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'official locator must use HTTPS')
  .refine(
    (value) => !containsUrlCredentials(value),
    'official locator must not contain URL userinfo or presigned credentials',
  );

const runtimeIdentityV1Schema = z
  .object({
    releaseRevision: z.string().regex(RELEASE_REVISION_RE, 'must be a lowercase 40-hex revision'),
    apiImageDigest: imageDigestSchema,
    drainImageDigest: imageDigestSchema,
    runtimeConfigReference: durableReferenceSchema,
    runtimeConfigSha256: sha256Schema,
    taskDefinitionArn: z
      .string()
      .regex(ECS_TASK_DEFINITION_ARN_RE, 'must be a full revisioned ECS task-definition ARN'),
    taskDefinitionRevision: positiveInteger,
    containerName: z.literal('ingestion-drain'),
    command: z.tuple([z.literal('run-defense-budget-ingestion-manifest-v1')]),
  })
  .strict();

const sourceIdentityV1Schema = z
  .object({
    officialLocator: officialHttpsLocatorSchema,
    sourceVersion: nonBlank(1_024),
    sha256: sha256Schema,
    byteSize: positiveInteger,
  })
  .strict();

const pinnedArchiveV1Schema = z
  .object({
    bucket: z.string().regex(S3_BUCKET_RE, 'must be a valid S3 bucket name'),
    objectKey: nonBlank(1_024),
    versionId: nonBlank(1_024).refine(
      (value) => value.toLowerCase() !== 'null',
      'archive versionId must name a real immutable object version',
    ),
    sha256: sha256Schema,
    byteSize: positiveInteger,
  })
  .strict();

const lifecycleBindingV1Schema = z
  .object({
    cycleId: uuidSchema,
    sourceDocumentId: uuidSchema,
    observationId: uuidSchema,
    outboxRowId: uuidSchema,
    jobKind: z.enum(['governed_source_ingestion', 'governed_alternative_funding_ingestion']),
    expectedObservationState: z.literal('ingested'),
    expectedOutboxState: z.enum(['pending', 'failed']),
    expectedOutboxAttempts: z.number().int().nonnegative(),
    expectedOutboxUpdatedAt: z.string().datetime(),
    expectedCandidateCount: z.literal(0),
    expectedActiveApprovalCount: z.literal(0),
    expectedCorrectionCount: z.literal(0),
    intendedOperation: z.literal('drain_existing_outbox'),
  })
  .strict();

const qualificationV1Schema = z
  .object({
    status: z.literal('qualified'),
    formatProfile: nonBlank(512),
    evidenceReference: durableReferenceSchema,
    evidenceSha256: sha256Schema,
    qualifiedDrainImageDigest: imageDigestSchema,
  })
  .strict();

const retryV1Schema = z.discriminatedUnion('classification', [
  z
    .object({
      classification: z.literal('none'),
      maxAttempts: z.literal(1),
    })
    .strict(),
  z
    .object({
      classification: z.literal('transient_only'),
      maxAttempts: positiveInteger.max(INGESTION_MANIFEST_MAX_ATTEMPTS_V1),
      initialBackoffSeconds: positiveInteger,
    })
    .strict(),
]);

const memberProtectionV1Schema = z
  .object({
    baselineEvidenceReference: durableReferenceSchema,
    expectedApprovalWrites: z.literal(0),
    expectedCorrectionWrites: z.literal(0),
    expectedCanonicalWrites: z.literal(0),
  })
  .strict();

export const ingestionManifestMemberV1Schema = z
  .object({
    memberId: uuidSchema,
    ordinal: positiveInteger,
    documentKey: nonBlank(512),
    component: nonBlank(64),
    agency: nonBlank(256),
    fiscalYear: z.number().int().min(1900).max(2200),
    authorityTrack: nonBlank(128),
    lifecycleStage: nonBlank(128),
    sourceFamily: nonBlank(128),
    exhibit: nonBlank(128),
    volume: nonBlank(256),
    source: sourceIdentityV1Schema,
    archive: pinnedArchiveV1Schema,
    lifecycle: lifecycleBindingV1Schema,
    qualification: qualificationV1Schema,
    timeoutSeconds: positiveInteger.max(INGESTION_MANIFEST_MAX_DOCUMENT_TIMEOUT_SECONDS_V1),
    retry: retryV1Schema,
    protection: memberProtectionV1Schema,
  })
  .strict();

export const INGESTION_MANIFEST_EXCLUSION_REASON_VALUES_V1 = [
  'qualification_failed',
  'qualification_missing',
  'unsupported_format',
  'already_processed',
  'outbox_ineligible',
  'not_authorized',
  'source_unavailable',
  'other',
] as const;

export const ingestionManifestExclusionV1Schema = z
  .object({
    exclusionId: uuidSchema,
    documentKey: nonBlank(512),
    component: nonBlank(64),
    agency: nonBlank(256),
    officialLocator: officialHttpsLocatorSchema,
    sourceVersion: nonBlank(1_024),
    sourceSha256: sha256Schema,
    byteSize: positiveInteger,
    reasonCode: z.enum(INGESTION_MANIFEST_EXCLUSION_REASON_VALUES_V1),
    reason: nonBlank(16_000),
    evidenceReference: durableReferenceSchema,
    permittedEffects: z.literal('none'),
  })
  .strict();

const resourceShapeV1Schema = z
  .object({
    cpuUnits: z.literal(4_096),
    memoryMiB: z.literal(8_192),
    ephemeralStorageGiB: z.literal(20),
    cpuArchitecture: z.literal('ARM64'),
    operatingSystemFamily: z.literal('LINUX'),
  })
  .strict();

const limitsV1Schema = z
  .object({
    maxDocuments: positiveInteger.max(INGESTION_MANIFEST_MAX_DOCUMENTS_V1),
    activeWorkers: z.literal(INGESTION_MANIFEST_DEFAULT_ACTIVE_WORKERS_V1),
    maxAttemptsPerDocument: positiveInteger.max(INGESTION_MANIFEST_MAX_ATTEMPTS_V1),
    maxElapsedSeconds: positiveInteger.max(INGESTION_MANIFEST_MAX_ELAPSED_SECONDS_V1),
    defaultDocumentTimeoutSeconds: positiveInteger.max(
      INGESTION_MANIFEST_MAX_DOCUMENT_TIMEOUT_SECONDS_V1,
    ),
    resourceShape: resourceShapeV1Schema,
    costCeiling: z
      .object({
        currency: z.literal('USD'),
        maximumAmount: z
          .string()
          .max(18)
          .regex(POSITIVE_USD_RE, 'must be a positive USD decimal with at most two decimals'),
        enforcement: z.literal('operator_and_elapsed_limits'),
      })
      .strict(),
  })
  .strict();

const permittedEffectsV1Schema = z
  .object({
    database: z
      .object({
        manifestLedgerWrites: z.literal(true),
        outboxLeaseAndDispositionWrites: z.literal(true),
        documentParseJobWrites: z.literal(true),
        verificationEvidenceWrites: z.literal(true),
        sourceRegistrationWrites: z.literal(false),
        lifecycleObservationWrites: z.literal(false),
        readinessWrites: z.literal(false),
        approvalWrites: z.literal(false),
        correctionWrites: z.literal(false),
        canonicalWrites: z.literal(false),
        outOfManifestEnqueueWrites: z.literal(false),
      })
      .strict(),
    storage: z
      .object({
        pinnedArchiveReads: z.literal(true),
        extractionArtifactWrites: z.literal(true),
        rawArchiveWrites: z.literal(false),
        objectDeletes: z.literal(false),
        durablePresignedUrlWrites: z.literal(false),
      })
      .strict(),
  })
  .strict();

const manifestPayloadFieldsV1 = {
  schemaVersion: z.literal(INGESTION_MANIFEST_SCHEMA_VERSION_V1),
  operationId: uuidSchema,
  owner: nonBlank(256),
  environment: z.literal('capiro-dev'),
  runtime: runtimeIdentityV1Schema,
  members: z.array(ingestionManifestMemberV1Schema).min(1).max(INGESTION_MANIFEST_MAX_DOCUMENTS_V1),
  exclusions: z.array(ingestionManifestExclusionV1Schema).min(1).max(1_000),
  limits: limitsV1Schema,
  readiness: z
    .object({
      policy: z.literal('deferred'),
      expectedOutcome: z.literal('not_performed'),
    })
    .strict(),
  permittedEffects: permittedEffectsV1Schema,
};

const ingestionManifestPayloadObjectV1Schema = z.object(manifestPayloadFieldsV1).strict();

function validateManifestPayloadV1(
  manifest: z.infer<typeof ingestionManifestPayloadObjectV1Schema>,
  context: z.RefinementCtx,
): void {
  const taskDefinitionMatch = ECS_TASK_DEFINITION_ARN_RE.exec(manifest.runtime.taskDefinitionArn);
  if (
    taskDefinitionMatch != null &&
    Number(taskDefinitionMatch[2]) !== manifest.runtime.taskDefinitionRevision
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtime', 'taskDefinitionRevision'],
      message: 'taskDefinitionRevision must equal the revision in taskDefinitionArn',
    });
  }
  if (manifest.members.length > manifest.limits.maxDocuments) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['members'],
      message: 'member count must not exceed limits.maxDocuments',
    });
  }
  if (manifest.limits.defaultDocumentTimeoutSeconds > manifest.limits.maxElapsedSeconds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['limits', 'defaultDocumentTimeoutSeconds'],
      message: 'default document timeout must not exceed the manifest elapsed window',
    });
  }

  const memberIds = new Set<string>();
  const ordinals = new Set<number>();
  const outboxRowIds = new Set<string>();
  const sourceDocumentIds = new Set<string>();
  const observationIds = new Set<string>();
  const memberDocumentKeys = new Set<string>();
  const memberSourceHashes = new Set<string>();

  manifest.members.forEach((member, index) => {
    const base = ['members', index] as const;
    const duplicate = <T extends string | number>(set: Set<T>, value: T, field: string): void => {
      if (set.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...base, field],
          message: `${field} must be unique within the manifest`,
        });
      }
      set.add(value);
    };
    duplicate(memberIds, member.memberId, 'memberId');
    duplicate(ordinals, member.ordinal, 'ordinal');
    duplicate(outboxRowIds, member.lifecycle.outboxRowId, 'lifecycle.outboxRowId');
    duplicate(sourceDocumentIds, member.lifecycle.sourceDocumentId, 'lifecycle.sourceDocumentId');
    duplicate(observationIds, member.lifecycle.observationId, 'lifecycle.observationId');
    duplicate(memberDocumentKeys, member.documentKey, 'documentKey');
    memberSourceHashes.add(member.source.sha256);

    if (member.ordinal !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'ordinal'],
        message: 'ordinals must be contiguous, one-based, and agree with member array order',
      });
    }
    if (
      member.archive.sha256 !== member.source.sha256 ||
      member.archive.byteSize !== member.source.byteSize
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'archive'],
        message: 'pinned archive hash and byte size must exactly match the source identity',
      });
    }
    if (member.qualification.qualifiedDrainImageDigest !== manifest.runtime.drainImageDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'qualification', 'qualifiedDrainImageDigest'],
        message: 'qualification must bind the exact manifest drain image digest',
      });
    }
    if (member.timeoutSeconds > manifest.limits.maxElapsedSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'timeoutSeconds'],
        message: 'document timeout must not exceed the manifest elapsed window',
      });
    }
    if (member.retry.maxAttempts > manifest.limits.maxAttemptsPerDocument) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'retry', 'maxAttempts'],
        message: 'member attempts must not exceed the manifest attempt ceiling',
      });
    }
    if (member.lifecycle.expectedOutboxAttempts >= member.retry.maxAttempts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...base, 'lifecycle', 'expectedOutboxAttempts'],
        message: 'expected outbox attempts must leave at least one authorized attempt',
      });
    }
  });

  const exclusionIds = new Set<string>();
  const exclusionDocumentKeys = new Set<string>();
  for (const [index, exclusion] of manifest.exclusions.entries()) {
    if (exclusionIds.has(exclusion.exclusionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exclusions', index, 'exclusionId'],
        message: 'exclusionId must be unique within the manifest',
      });
    }
    exclusionIds.add(exclusion.exclusionId);
    if (exclusionDocumentKeys.has(exclusion.documentKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exclusions', index, 'documentKey'],
        message: 'excluded documentKey must be unique within the manifest',
      });
    }
    exclusionDocumentKeys.add(exclusion.documentKey);
    if (
      memberDocumentKeys.has(exclusion.documentKey) ||
      memberSourceHashes.has(exclusion.sourceSha256)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exclusions', index],
        message: 'the same document/source bytes cannot be both selected and excluded',
      });
    }
  }
}

export const ingestionManifestV1PayloadSchema =
  ingestionManifestPayloadObjectV1Schema.superRefine(validateManifestPayloadV1);

const ingestionManifestObjectV1Schema = ingestionManifestPayloadObjectV1Schema
  .extend({ contentSha256: sha256Schema })
  .strict();

export const ingestionManifestV1Schema = ingestionManifestObjectV1Schema.superRefine(
  (manifest, context) => {
    validateManifestPayloadV1(manifest, context);
    const { contentSha256: _contentSha256, ...payload } = manifest;
    const expected = sha256CanonicalJson(payload as unknown as JsonValue);
    if (manifest.contentSha256 !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentSha256'],
        message: `content hash mismatch: expected ${expected}`,
      });
    }
  },
);

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
export type DeepReadonly<T> = T extends Primitive | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

export type IngestionManifestV1Payload = DeepReadonly<
  z.infer<typeof ingestionManifestPayloadObjectV1Schema>
>;
export type IngestionManifestV1 = DeepReadonly<z.infer<typeof ingestionManifestObjectV1Schema>>;
export type IngestionManifestMemberV1 = DeepReadonly<
  z.infer<typeof ingestionManifestMemberV1Schema>
>;

function withoutContentSha256(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const { contentSha256: _contentSha256, ...payload } = input as Record<string, unknown>;
  return payload;
}

/** SHA-256 of the normalized canonical manifest payload, excluding its self-hash field. */
export function computeIngestionManifestContentSha256V1(input: unknown): string {
  const payload = ingestionManifestV1PayloadSchema.parse(withoutContentSha256(input));
  return sha256CanonicalJson(payload as unknown as JsonValue);
}

/** Validate a hashless payload, compute its self-hash, validate again, and deeply freeze it. */
export function sealIngestionManifestV1(input: unknown): IngestionManifestV1 {
  const payload = ingestionManifestV1PayloadSchema.parse(input);
  const manifest = ingestionManifestV1Schema.parse({
    ...payload,
    contentSha256: sha256CanonicalJson(payload as unknown as JsonValue),
  });
  return deepFreeze(manifest) as IngestionManifestV1;
}

/** Parse, cross-validate, verify the self-hash, and deeply freeze a manifest. */
export function parseIngestionManifestV1(input: unknown): IngestionManifestV1 {
  return deepFreeze(ingestionManifestV1Schema.parse(input)) as IngestionManifestV1;
}

/** Throw if a manifest's stored hash differs from its canonical payload hash. */
export function assertIngestionManifestContentSha256V1(input: unknown): void {
  ingestionManifestV1Schema.parse(input);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const item of items) deepFreeze(item);
  return Object.freeze(value);
}
