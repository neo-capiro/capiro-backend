/** Durable, fenced bookkeeping for a named same-cycle REVIEW re-extraction. */
import { createHash } from 'node:crypto';
import type { CandidateIdentityV1 } from '../verification/persistence/verification-repository.js';

export interface ReextractionRequestV1 {
  operationId: string;
  outboxRowId: string;
  oldCandidateId: string;
  expectedOldVerificationRunId: string;
  expectedSourceSha256: string;
  expectedOldExtractionArtifactSha256: string;
  actor: string;
  reason: string;
  releaseRevision: string;
}

/** Include every effective parser option and stable source path in this snapshot. */
export interface ReextractionSnapshotV1 {
  cycleId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  sourcePath: string;
  [key: string]: unknown;
}

export interface ReextractionLeaseContextV1 {
  operationId: string;
  leaseToken: string;
}

export type ReextractionOperationStatusV1 = 'running' | 'failed' | 'completed' | 'blocked';

export interface ReextractionOperationV1 {
  id: string;
  requestHash: string;
  request: ReextractionRequestV1;
  snapshot: ReextractionSnapshotV1;
  oldCandidateId: string;
  cycleId: string;
  sourceDocumentId: string;
  status: ReextractionOperationStatusV1;
  leaseToken: string | null;
  leasedUntil: string | null;
  attempts: number;
  verificationCorrelations: Record<string, unknown>[];
  terminal: Record<string, unknown> | null;
  closure: { actor: string; reason: string; closedAt: string } | null;
  candidateId: string | null;
  verificationRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReextractionPrismaTransactionV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface ReextractionPrismaLikeV1 extends ReextractionPrismaTransactionV1 {
  $transaction<T>(run: (tx: ReextractionPrismaTransactionV1) => Promise<T>): Promise<T>;
}

export interface ReextractionClaimResultV1 {
  outcome: 'claimed' | 'completed' | 'busy' | 'blocked' | 'conflict' | 'ineligible';
  operation: ReextractionOperationV1 | null;
}

export interface ReextractionRepositoryV1 {
  read(operationId: string): Promise<ReextractionOperationV1 | null>;
  claim(input: {
    request: ReextractionRequestV1;
    snapshot: ReextractionSnapshotV1;
    leaseToken: string;
  }): Promise<ReextractionClaimResultV1>;
  heartbeat(context: ReextractionLeaseContextV1): Promise<boolean>;
  /** Accepts the router terminal object plus its exact persisted candidate/run IDs. */
  complete(context: ReextractionLeaseContextV1, terminal: Record<string, unknown>): Promise<boolean>;
  fail(context: ReextractionLeaseContextV1, error: string): Promise<boolean>;
  block(context: ReextractionLeaseContextV1, error: string): Promise<boolean>;
  abandonExpired(operationId: string, actor: string, reason: string, options?: { commit?: boolean }): Promise<{
    outcome: 'preview' | 'abandoned' | 'ineligible';
    operation: ReextractionOperationV1 | null;
  }>;
}

export class ReextractionLeaseLostErrorV1 extends Error {
  constructor(message = 're-extraction lease expired, was replaced, or has already finished') {
    super(message);
    this.name = 'ReextractionLeaseLostErrorV1';
  }
}

export const REEXTRACTION_LEASE_MS_V1 = 5 * 60 * 1_000;
export const REEXTRACTION_HEARTBEAT_MS_V1 = 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;

function requireUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

function validateContext(context: ReextractionLeaseContextV1): void {
  requireUuid(context.operationId, 'operationId');
  requireUuid(context.leaseToken, 'leaseToken');
}

/** Reject lossy JSON inputs so two distinct requests cannot share a snapshot hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new Error('re-extraction request/snapshot must contain only finite JSON values');
}

export function reextractionRequestHashV1(request: ReextractionRequestV1, snapshot: ReextractionSnapshotV1): string {
  return createHash('sha256').update(canonicalJson({ request, snapshot })).digest('hex');
}

function validateClaim(request: ReextractionRequestV1, snapshot: ReextractionSnapshotV1, leaseToken: string): void {
  for (const key of ['operationId', 'outboxRowId', 'oldCandidateId', 'expectedOldVerificationRunId'] as const) {
    requireUuid(request[key], key);
  }
  requireUuid(leaseToken, 'leaseToken');
  requireUuid(snapshot.cycleId, 'snapshot.cycleId');
  requireUuid(snapshot.sourceDocumentId, 'snapshot.sourceDocumentId');
  if (!SHA.test(request.expectedSourceSha256) || !SHA.test(request.expectedOldExtractionArtifactSha256)) {
    throw new Error('re-extraction requires exact lowercase source and extraction SHA-256 hashes');
  }
  if (snapshot.sourceSha256 !== request.expectedSourceSha256) throw new Error('snapshot source SHA mismatch');
  if (!snapshot.sourcePath.startsWith('/')) throw new Error('snapshot sourcePath must be a stable absolute path');
  if (!request.actor.trim() || !request.reason.trim() || !request.releaseRevision.trim()) {
    throw new Error('re-extraction requires actor, reason, and releaseRevision');
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toOperation(row: Record<string, unknown>): ReextractionOperationV1 {
  return {
    id: String(row.id),
    requestHash: String(row.request_hash),
    request: row.request_jsonb as ReextractionRequestV1,
    snapshot: row.snapshot_jsonb as ReextractionSnapshotV1,
    oldCandidateId: String(row.old_candidate_id),
    cycleId: String(row.cycle_id),
    sourceDocumentId: String(row.source_document_id),
    status: row.status as ReextractionOperationStatusV1,
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leasedUntil: row.leased_until == null ? null : iso(row.leased_until),
    attempts: Number(row.attempts),
    verificationCorrelations: row.verification_correlations_jsonb as Record<string, unknown>[],
    terminal: row.terminal_jsonb == null ? null : row.terminal_jsonb as Record<string, unknown>,
    closure: row.closure_jsonb == null ? null : row.closure_jsonb as ReextractionOperationV1['closure'],
    candidateId: row.candidate_id == null ? null : String(row.candidate_id),
    verificationRunId: row.verification_run_id == null ? null : String(row.verification_run_id),
    lastError: row.last_error == null ? null : String(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function readWith(tx: ReextractionPrismaTransactionV1, operationId: string): Promise<ReextractionOperationV1 | null> {
  const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    'SELECT * FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid', operationId,
  );
  return rows[0] ? toOperation(rows[0]) : null;
}

const ACTIVE_FENCE = '"id"=$1::uuid AND "status"=\'running\' AND "lease_token"=$2::uuid AND "leased_until">clock_timestamp()';

/** Re-read after acquiring row locks: a review committed while we waited must be visible. */
async function assertTargetUnchanged(tx: ReextractionPrismaTransactionV1, operationId: string): Promise<void> {
  await tx.$queryRawUnsafe(
    `SELECT c."id" FROM "budget_reextraction_operation_v1" op
     JOIN "budget_extraction_candidate_v1" c ON c."id"=op."old_candidate_id"
     JOIN "defense_budget_ingestion_outbox" o ON o."id"=op."outbox_row_id"
     JOIN "defense_budget_source_observation" obs ON obs."id"=o."observation_id"
     JOIN "source_document" sd ON sd."id"=op."source_document_id"
     JOIN "defense_budget_cycle" cy ON cy."id"=op."cycle_id"
     WHERE op."id"=$1::uuid FOR UPDATE OF c FOR SHARE OF o, obs, sd, cy`, operationId,
  );
  const rows = await tx.$queryRawUnsafe<unknown[]>(
    `SELECT op."id" FROM "budget_reextraction_operation_v1" op
     JOIN "budget_extraction_candidate_v1" c ON c."id"=op."old_candidate_id"
     JOIN "budget_verification_run_v1" r ON r."id"=op."old_verification_run_id" AND r."candidate_id"=c."id"
     JOIN "defense_budget_ingestion_outbox" o ON o."id"=op."outbox_row_id"
     JOIN "defense_budget_source_observation" obs ON obs."id"=o."observation_id"
     JOIN "source_document" sd ON sd."id"=op."source_document_id"
     JOIN "defense_budget_cycle" cy ON cy."id"=op."cycle_id"
     WHERE op."id"=$1::uuid AND c."status"='NEEDS_REVIEW' AND c."current_run_id"=r."id" AND r."decision"='REVIEW'
       AND r."status"='NEEDS_REVIEW' AND o."state"='dead_letter' AND o."leased_by" IS NULL AND o."leased_until" IS NULL
       AND o."metadata_jsonb"->>'governedDisposition'='review_required' AND o."metadata_jsonb"->>'verifierDecision'='REVIEW'
       AND o."metadata_jsonb"->>'sourceDocumentId'=op."source_document_id"::text
       AND c."cycle_id"=op."cycle_id"::text AND o."cycle_id"=op."cycle_id" AND obs."cycle_id"=op."cycle_id"
       AND obs."id"::text=op."snapshot_jsonb"->>'observationId'
       AND c."source_document_id"=op."source_document_id" AND obs."source_document_id"=op."source_document_id"
       AND c."source_sha256"=op."source_sha256" AND obs."content_sha256"=op."source_sha256" AND sd."sha256"=op."source_sha256"
       AND r."source_sha256"=op."source_sha256"
       AND c."extraction_artifact_sha256"=op."request_jsonb"->>'expectedOldExtractionArtifactSha256'
       AND r."extraction_artifact_sha256"=c."extraction_artifact_sha256"
       AND sd."archive_bucket"=op."snapshot_jsonb"->>'archiveBucket'
       AND sd."archive_s3_key"=op."snapshot_jsonb"->>'archiveS3Key'
       AND sd."archive_version_id" IS NOT DISTINCT FROM op."snapshot_jsonb"->>'archiveVersionId'
       AND sd."source_key"=op."snapshot_jsonb"->>'sourceKey'
       AND sd."component" IS NOT DISTINCT FROM op."snapshot_jsonb"->>'component'
       AND sd."source_url"=op."snapshot_jsonb"->>'sourceUrl'
       AND sd."fiscal_year"::text=op."snapshot_jsonb"->>'fiscalYear'
       AND obs."classified_fiscal_year"=sd."fiscal_year" AND cy."fiscal_year"=sd."fiscal_year"
       AND obs."classified_source_family"=op."snapshot_jsonb"->>'sourceFamily'
       AND obs."superseded_by_observation_id" IS NULL AND sd."superseded_by_document_id" IS NULL
       AND sd."budget_cycle"=op."snapshot_jsonb"->>'budgetCycle'
       AND sd."document_type"=op."snapshot_jsonb"->>'documentType'
       AND sd."title"=op."snapshot_jsonb"->>'title'
       AND sd."byte_size"::text IS NOT DISTINCT FROM op."snapshot_jsonb"->>'byteSize'
       AND NOT EXISTS (SELECT 1 FROM "budget_candidate_correction_v1" cc WHERE cc."old_candidate_id"=c."id")
       AND NOT EXISTS (SELECT 1 FROM "budget_review_decision_v1" rd WHERE rd."candidate_id"=c."id" AND rd."decision" IN ('accept','reject'))`,
    operationId,
  );
  if (rows.length !== 1) throw new ReextractionLeaseLostErrorV1('re-extraction target changed after its governed snapshot was recorded');
}

export function createReextractionRepositoryV1(
  prisma: ReextractionPrismaLikeV1,
  options: { leaseMs?: number } = {},
): ReextractionRepositoryV1 {
  const leaseMs = options.leaseMs ?? REEXTRACTION_LEASE_MS_V1;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer');
  async function finishFailure(context: ReextractionLeaseContextV1, error: string, status: 'failed' | 'blocked'): Promise<boolean> {
    validateContext(context);
    const rows = await prisma.$queryRawUnsafe<unknown[]>(
      `UPDATE "budget_reextraction_operation_v1" SET "status"=$3, "last_error"=$4,
       "lease_token"=NULL, "leased_until"=NULL, "updated_at"=clock_timestamp()
       WHERE ${ACTIVE_FENCE} RETURNING "id"`,
      context.operationId, context.leaseToken, status, error.slice(0, 4_000),
    );
    return rows.length === 1;
  }
  return {
    async read(operationId) {
      requireUuid(operationId, 'operationId');
      return readWith(prisma, operationId);
    },
    async claim({ request, snapshot, leaseToken }) {
      validateClaim(request, snapshot, leaseToken);
      const requestHash = reextractionRequestHashV1(request, snapshot);
      return prisma.$transaction(async (tx) => {
        // Serializes short claims for one document/cycle. No lock spans parsing.
        await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text', `${snapshot.cycleId}:${snapshot.sourceDocumentId}`);
        // Same lock order as verification/completion: operation, then target.
        await tx.$queryRawUnsafe('SELECT "id" FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid FOR UPDATE', request.operationId);
        const existing = await readWith(tx, request.operationId);
        if (existing) {
          if (existing.requestHash !== requestHash) return { outcome: 'conflict', operation: existing };
          if (existing.status === 'completed') return { outcome: 'completed', operation: existing };
          if (existing.status === 'blocked') return { outcome: 'blocked', operation: existing };
        }
        const sourceBusy = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "budget_reextraction_operation_v1" WHERE "cycle_id"=$1::uuid AND "source_document_id"=$2::uuid
           AND "status"='running' AND "id"<>$3::uuid`, snapshot.cycleId, snapshot.sourceDocumentId, request.operationId,
        );
        if (sourceBusy[0]) return { outcome: 'busy', operation: toOperation(sourceBusy[0]) };
        if (existing) {
          await assertTargetUnchanged(tx, request.operationId);
          const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
            `UPDATE "budget_reextraction_operation_v1" SET "status"='running', "lease_token"=$2::uuid,
             "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),
             "attempts"="attempts"+1, "last_error"=NULL, "updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid AND ("status"='failed' OR ("status"='running' AND "leased_until"<=clock_timestamp()))
             RETURNING *`, request.operationId, leaseToken, leaseMs,
          );
          return rows[0] ? { outcome: 'claimed', operation: toOperation(rows[0]) } : { outcome: 'busy', operation: existing };
        }
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `INSERT INTO "budget_reextraction_operation_v1" (
             "id", "outbox_row_id", "old_candidate_id", "old_verification_run_id", "cycle_id", "source_document_id", "source_sha256",
             "request_hash", "request_jsonb", "snapshot_jsonb", "status", "lease_token", "leased_until", "attempts")
           SELECT $1::uuid, o."id", c."id", r."id", o."cycle_id", c."source_document_id", c."source_sha256",
             $8, $9::jsonb, $10::jsonb, 'running', $11::uuid, clock_timestamp()+($12::bigint * INTERVAL '1 millisecond'), 1
           FROM "defense_budget_ingestion_outbox" o
           JOIN "defense_budget_source_observation" obs ON obs."id"=o."observation_id"
           JOIN "budget_extraction_candidate_v1" c ON c."id"=$3::uuid
           JOIN "budget_verification_run_v1" r ON r."id"=$4::uuid AND r."candidate_id"=c."id"
           JOIN "source_document" sd ON sd."id"=c."source_document_id"
           WHERE o."id"=$2::uuid AND o."state"='dead_letter' AND o."leased_by" IS NULL
             AND o."metadata_jsonb"->>'governedDisposition'='review_required'
             AND o."metadata_jsonb"->>'verifierDecision'='REVIEW'
             AND c."status"='NEEDS_REVIEW' AND c."current_run_id"=r."id" AND r."decision"='REVIEW'
             AND c."cycle_id"=o."cycle_id"::text AND obs."cycle_id"=o."cycle_id"
             AND c."source_document_id"=obs."source_document_id" AND c."source_document_id"=$6::uuid
             AND o."cycle_id"=$5::uuid AND c."source_sha256"=$7 AND obs."content_sha256"=$7 AND sd."sha256"=$7
             AND c."extraction_artifact_sha256"=$13 AND r."source_sha256"=$7 AND r."extraction_artifact_sha256"=$13
           FOR SHARE OF o, obs, c, r, sd
           ON CONFLICT DO NOTHING RETURNING *`,
          request.operationId, request.outboxRowId, request.oldCandidateId, request.expectedOldVerificationRunId,
          snapshot.cycleId, snapshot.sourceDocumentId, snapshot.sourceSha256, requestHash,
          canonicalJson(request), canonicalJson(snapshot), leaseToken, leaseMs, request.expectedOldExtractionArtifactSha256,
        );
        if (rows[0]) {
          await assertTargetUnchanged(tx, request.operationId);
          return { outcome: 'claimed', operation: toOperation(rows[0]) };
        }
        const concurrent = await readWith(tx, request.operationId);
        if (concurrent) return {
          outcome: concurrent.requestHash !== requestHash ? 'conflict'
            : concurrent.status === 'completed' ? 'completed'
            : concurrent.status === 'blocked' ? 'blocked' : 'busy',
          operation: concurrent,
        };
        const conflicts = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          'SELECT * FROM "budget_reextraction_operation_v1" WHERE "old_candidate_id"=$1::uuid AND "status"=\'running\'', request.oldCandidateId,
        );
        return conflicts[0]
          ? { outcome: 'busy', operation: toOperation(conflicts[0]) }
          : { outcome: 'ineligible', operation: null };
      });
    },
    async heartbeat(context) {
      validateContext(context);
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "budget_reextraction_operation_v1" SET "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),
         "updated_at"=clock_timestamp() WHERE ${ACTIVE_FENCE} RETURNING "id"`,
        context.operationId, context.leaseToken, leaseMs,
      );
      return rows.length === 1;
    },
    async complete(context, terminal) {
      validateContext(context);
      requireUuid(String(terminal.candidateId ?? ''), 'terminal.candidateId');
      requireUuid(String(terminal.verificationRunId ?? ''), 'terminal.verificationRunId');
      if (!SHA.test(String(terminal.artifactContentSha256 ?? '')) || !SHA.test(String(terminal.artifactByteSha256 ?? '')) ||
          !String(terminal.artifactLocator ?? '').trim() || !String(terminal.artifactId ?? '').trim()) {
        throw new Error('terminal extraction requires artifact identity, locator, and content/byte SHA-256');
      }
      const validState = terminal.verifierDecision === 'PASS' ? terminal.finalState === 'TERMINAL_PASSED'
        : terminal.verifierDecision === 'REVIEW' ? terminal.finalState === 'TERMINAL_REVIEW'
        : terminal.verifierDecision === 'REJECT' && ['TERMINAL_REJECTED', 'TERMINAL_REVIEW'].includes(String(terminal.finalState));
      if (!validState) throw new Error('terminal verifier decision and parser finalState disagree');
      return prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid FOR UPDATE', context.operationId);
        await assertTargetUnchanged(tx, context.operationId);
        const rows = await tx.$queryRawUnsafe<unknown[]>(
        `UPDATE "budget_reextraction_operation_v1" SET "status"='completed', "terminal_jsonb"=$3::jsonb,
         "candidate_id"=$4::uuid, "verification_run_id"=$5::uuid, "lease_token"=NULL, "leased_until"=NULL,
         "last_error"=NULL, "updated_at"=clock_timestamp()
         WHERE ${ACTIVE_FENCE}
           AND EXISTS (SELECT 1 FROM jsonb_array_elements("verification_correlations_jsonb") x
             WHERE x->>'candidateId'=$4 AND x->>'verificationRunId'=$5)
           AND EXISTS (SELECT 1 FROM "budget_extraction_candidate_v1" c JOIN "budget_verification_run_v1" r
             ON r."id"=$5::uuid AND r."candidate_id"=c."id"
             WHERE c."id"=$4::uuid AND c."extraction_artifact_id"=$3::jsonb->>'artifactId'
               AND c."extraction_artifact_sha256"=$3::jsonb->>'artifactContentSha256'
               AND r."decision"=$3::jsonb->>'verifierDecision')
         RETURNING "id"`, context.operationId, context.leaseToken, canonicalJson(terminal),
        terminal.candidateId, terminal.verificationRunId,
      );
        return rows.length === 1;
      });
    },
    fail: (context, error) => finishFailure(context, error, 'failed'),
    block: (context, error) => finishFailure(context, error, 'blocked'),
    async abandonExpired(operationId, actor, reason, { commit = false } = {}) {
      requireUuid(operationId, 'operationId');
      if (!actor.trim() || !reason.trim()) throw new Error('abandoning an expired operation requires actor and reason');
      if (!commit) {
        const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid
           AND ("status"='failed' OR ("status"='running' AND "leased_until"<=clock_timestamp()))`, operationId,
        );
        return rows[0] ? { outcome: 'preview', operation: toOperation(rows[0]) }
          : { outcome: 'ineligible', operation: await readWith(prisma, operationId) };
      }
      return prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid FOR UPDATE', operationId);
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `UPDATE "budget_reextraction_operation_v1" SET "status"='blocked', "lease_token"=NULL, "leased_until"=NULL,
           "closure_jsonb"=jsonb_build_object('actor',$2::text,'reason',$3::text,'closedAt',clock_timestamp()),
           "last_error"='Expired or failed operation closed by operator', "updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND ("status"='failed' OR ("status"='running' AND "leased_until"<=clock_timestamp()))
           RETURNING *`, operationId, actor.trim(), reason.trim(),
        );
        return rows[0] ? { outcome: 'abandoned', operation: toOperation(rows[0]) }
          : { outcome: 'ineligible', operation: await readWith(tx, operationId) };
      });
    },
  };
}

/**
 * Call INSIDE the verification persistence transaction, including its exact-replay
 * branch. A stale owner throws, rolling back that transaction's new evidence too.
 * Every association is exact; no source/cycle "newest candidate" lookup exists.
 */
export async function checkpointReextractionVerificationV1(
  tx: ReextractionPrismaTransactionV1,
  context: ReextractionLeaseContextV1,
  identity: CandidateIdentityV1,
  candidateId: string,
  verificationRunId: string,
): Promise<void> {
  validateContext(context);
  requireUuid(candidateId, 'candidateId');
  requireUuid(verificationRunId, 'verificationRunId');
  // Lock first, then check wall time after any wait; transaction-start now()
  // would let a worker whose lease expired while blocked still write.
  await tx.$queryRawUnsafe('SELECT "id" FROM "budget_reextraction_operation_v1" WHERE "id"=$1::uuid FOR UPDATE', context.operationId);
  await assertTargetUnchanged(tx, context.operationId);
  const correlation = {
    candidateId, verificationRunId,
    manifestContentSha256: identity.manifestContentSha256,
    manifestDocumentKey: identity.manifestDocumentKey,
    extractionArtifactId: identity.extractionArtifactId,
    extractionArtifactSha256: identity.extractionArtifactSha256,
    extractionArtifactLocator: identity.extractionArtifactLocator,
    verifierVersion: identity.verifierVersion,
    policyVersion: identity.policyVersion,
    policySha256: identity.policySha256,
  };
  const rows = await tx.$queryRawUnsafe<unknown[]>(
    `UPDATE "budget_reextraction_operation_v1" op SET
       "verification_correlations_jsonb"=CASE WHEN EXISTS (
         SELECT 1 FROM jsonb_array_elements(op."verification_correlations_jsonb") x
         WHERE x->>'candidateId'=$7 AND x->>'verificationRunId'=$8
       ) THEN op."verification_correlations_jsonb" ELSE op."verification_correlations_jsonb" || jsonb_build_array($6::jsonb) END,
       "updated_at"=clock_timestamp()
     WHERE op."id"=$1::uuid AND op."status"='running' AND op."lease_token"=$2::uuid AND op."leased_until">clock_timestamp()
       AND op."cycle_id"::text=$3 AND op."source_document_id"=$4::uuid AND op."source_sha256"=$5
       AND EXISTS (SELECT 1 FROM "budget_extraction_candidate_v1" c
         JOIN "budget_verification_run_v1" r ON r."id"=$8::uuid AND r."candidate_id"=c."id"
         WHERE c."id"=$7::uuid AND c."cycle_id"=$3 AND c."source_document_id"=$4::uuid AND c."source_sha256"=$5
           AND c."manifest_content_sha256"=$9 AND c."manifest_document_key"=$10 AND c."extraction_artifact_id"=$11
           AND c."extraction_artifact_sha256"=$12 AND c."verifier_version"=$13 AND c."policy_version"=$14 AND c."policy_sha256"=$15
           AND r."source_sha256"=$5 AND r."manifest_content_sha256"=$9 AND r."extraction_artifact_sha256"=$12
           AND r."verifier_version"=$13 AND r."policy_version"=$14 AND r."policy_sha256"=$15)
     RETURNING op."id"`,
    context.operationId, context.leaseToken, identity.cycleId, identity.sourceDocumentId, identity.sourceSha256,
    canonicalJson(correlation), candidateId, verificationRunId, identity.manifestContentSha256, identity.manifestDocumentKey,
    identity.extractionArtifactId, identity.extractionArtifactSha256, identity.verifierVersion, identity.policyVersion, identity.policySha256,
  );
  if (rows.length !== 1) throw new ReextractionLeaseLostErrorV1('re-extraction verification checkpoint refused: lease or immutable candidate binding mismatch');
}
