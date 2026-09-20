/** Durable, fenced bookkeeping for one immutable Package E manifest. */
import type { CandidateIdentityV1 } from '../verification/persistence/verification-repository.js';
import type { VerificationPersistenceFenceV1 } from '../verification/persistence/verification-persistence-fence-v1.js';
import type {
  IngestionManifestMemberV1,
  IngestionManifestV1,
} from './ingestion-manifest-contract-v1.js';

export type IngestionManifestOperationStatusV1 =
  | 'running'
  | 'stop_requested'
  | 'paused'
  | 'completed';
export type IngestionManifestItemStatusV1 =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'evidence_ready'
  | 'completed'
  | 'quarantined'
  | 'uncertain';

export interface IngestionManifestLeaseContextV1 {
  operationId: string;
  itemId: string;
  leaseToken: string;
}

export interface IngestionManifestItemRecordV1 {
  id: string;
  operationId: string;
  ordinal: number;
  outboxRowId: string;
  observationId: string;
  cycleId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  sourceByteSize: number;
  expectedOutboxState: string;
  member: IngestionManifestMemberV1;
  status: IngestionManifestItemStatusV1;
  leaseToken: string | null;
  leaseGeneration: number;
  leasedUntil: string | null;
  lastHeartbeatAt: string | null;
  taskJobId: string | null;
  attempts: number;
  nextAttemptAt: string;
  executionHistory: Record<string, unknown>[];
  verificationCorrelations: Record<string, unknown>[];
  reconciliations: Record<string, unknown>[];
  terminal: Record<string, unknown> | null;
  candidateId: string | null;
  verificationRunId: string | null;
  parserDisposition: 'PASS' | 'REVIEW' | 'REJECT' | null;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface IngestionManifestOperationRecordV1 {
  id: string;
  manifestSha256: string;
  manifest: IngestionManifestV1;
  status: IngestionManifestOperationStatusV1;
  stopRequestedAt: string | null;
  startedAt: string;
  deadlineAt: string;
  completedAt: string | null;
  items: IngestionManifestItemRecordV1[];
}

export interface IngestionManifestPreflightV1 {
  eligible: boolean;
  issues: Array<{ memberId: string; code: string; detail: string }>;
}

export interface IngestionManifestPrismaTransactionV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface IngestionManifestPrismaLikeV1 extends IngestionManifestPrismaTransactionV1 {
  $transaction<T>(run: (tx: IngestionManifestPrismaTransactionV1) => Promise<T>): Promise<T>;
}

export interface IngestionManifestRepositoryV1 {
  preflight(manifest: IngestionManifestV1): Promise<IngestionManifestPreflightV1>;
  register(manifest: IngestionManifestV1): Promise<{
    outcome: 'registered' | 'existing' | 'conflict' | 'ineligible';
    operation: IngestionManifestOperationRecordV1 | null;
    issues: IngestionManifestPreflightV1['issues'];
  }>;
  read(operationId: string): Promise<IngestionManifestOperationRecordV1 | null>;
  requestStop(operationId: string): Promise<IngestionManifestOperationRecordV1 | null>;
  resume(operationId: string): Promise<'resumed' | 'completed' | 'uncertain' | 'not_found'>;
  claimNext(input: {
    operationId: string;
    leaseToken: string;
    taskJobId: string;
  }): Promise<{
    outcome: 'claimed' | 'evidence_ready' | 'busy' | 'stopped' | 'complete' | 'uncertain' | 'none';
    item: IngestionManifestItemRecordV1 | null;
  }>;
  heartbeat(context: IngestionManifestLeaseContextV1): Promise<boolean>;
  markUncertain(input: IngestionManifestLeaseContextV1 & {
    errorClass: string;
    detail: string;
  }): Promise<boolean>;
  checkpointTerminal(
    context: IngestionManifestLeaseContextV1,
    terminal: Record<string, unknown>,
  ): Promise<boolean>;
  finalizeEvidence(context: IngestionManifestLeaseContextV1): Promise<boolean>;
  recordTransientFailure(input: IngestionManifestLeaseContextV1 & {
    errorClass: string;
    detail: string;
    backoffMs: number;
  }): Promise<'retry_wait' | 'uncertain' | 'quarantined' | 'lease_lost'>;
  quarantineFailure(input: IngestionManifestLeaseContextV1 & {
    errorClass: string;
    detail: string;
  }): Promise<boolean>;
  reconcileUncertain(input: {
    operationId: string;
    itemId: string;
    expectedTaskJobId: string;
    actor: string;
    reason: string;
  }): Promise<'retry_wait' | 'evidence_ready' | 'ineligible'>;
  persistenceFence(context: IngestionManifestLeaseContextV1): VerificationPersistenceFenceV1;
}

export class IngestionManifestLeaseLostErrorV1 extends Error {
  constructor(message = 'manifest item lease expired, was replaced, or is no longer running') {
    super(message);
    this.name = 'IngestionManifestLeaseLostErrorV1';
  }
}

export const INGESTION_MANIFEST_LEASE_MS_V1 = 15 * 60 * 1_000;
export const INGESTION_MANIFEST_HEARTBEAT_MS_V1 = 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set(['completed', 'quarantined']);
const ACTIVE_ITEM_STATES = "('pending','running','retry_wait','evidence_ready','uncertain')";

function requireUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function toItem(row: Record<string, unknown>): IngestionManifestItemRecordV1 {
  return {
    id: String(row.id), operationId: String(row.manifest_id), ordinal: Number(row.ordinal),
    outboxRowId: String(row.outbox_row_id), observationId: String(row.observation_id),
    cycleId: String(row.cycle_id), sourceDocumentId: String(row.source_document_id),
    sourceSha256: String(row.source_sha256), sourceByteSize: Number(row.source_byte_size),
    expectedOutboxState: String(row.expected_outbox_state),
    member: row.member_jsonb as IngestionManifestMemberV1,
    status: row.status as IngestionManifestItemStatusV1,
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseGeneration: Number(row.lease_generation),
    leasedUntil: row.leased_until == null ? null : iso(row.leased_until),
    lastHeartbeatAt: row.last_heartbeat_at == null ? null : iso(row.last_heartbeat_at),
    taskJobId: row.task_job_id == null ? null : String(row.task_job_id),
    attempts: Number(row.attempts), nextAttemptAt: iso(row.next_attempt_at),
    executionHistory: asRecords(row.execution_history_jsonb),
    verificationCorrelations: asRecords(row.verification_correlations_jsonb),
    reconciliations: asRecords(row.reconciliations_jsonb),
    terminal: row.terminal_jsonb == null ? null : row.terminal_jsonb as Record<string, unknown>,
    candidateId: row.candidate_id == null ? null : String(row.candidate_id),
    verificationRunId: row.verification_run_id == null ? null : String(row.verification_run_id),
    parserDisposition: row.parser_disposition == null ? null : row.parser_disposition as 'PASS' | 'REVIEW' | 'REJECT',
    lastErrorClass: row.last_error_class == null ? null : String(row.last_error_class),
    lastErrorMessage: row.last_error_message == null ? null : String(row.last_error_message),
    startedAt: row.started_at == null ? null : iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  };
}

async function readWith(
  tx: IngestionManifestPrismaTransactionV1,
  operationId: string,
): Promise<IngestionManifestOperationRecordV1 | null> {
  const operations = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    'SELECT * FROM "defense_budget_ingestion_manifest_v1" WHERE "id"=$1::uuid', operationId,
  );
  if (!operations[0]) return null;
  const row = operations[0];
  const items = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
    'SELECT * FROM "defense_budget_ingestion_manifest_item_v1" WHERE "manifest_id"=$1::uuid ORDER BY "ordinal"',
    operationId,
  );
  return {
    id: String(row.id), manifestSha256: String(row.manifest_sha256),
    manifest: row.manifest_jsonb as IngestionManifestV1,
    status: row.status as IngestionManifestOperationStatusV1,
    stopRequestedAt: row.stop_requested_at == null ? null : iso(row.stop_requested_at),
    startedAt: iso(row.started_at), deadlineAt: iso(row.deadline_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
    items: items.map(toItem),
  };
}

interface BoundMemberRow extends Record<string, unknown> {
  outbox_id: string;
}

async function loadBoundMember(
  tx: IngestionManifestPrismaTransactionV1,
  outboxRowId: string,
  lock: boolean,
): Promise<BoundMemberRow | null> {
  const rows = await tx.$queryRawUnsafe<BoundMemberRow[]>(
    `SELECT o."id" AS outbox_id, o."observation_id", o."cycle_id", o."job_kind", o."state" AS outbox_state,
       o."attempts" AS outbox_attempts, o."updated_at" AS outbox_updated_at, o."available_at",
       (o."available_at"<=clock_timestamp()) AS outbox_due, o."leased_by", o."leased_until",
       obs."observation_state", obs."source_document_id", obs."content_sha256", obs."byte_size" AS observation_byte_size,
       obs."classified_fiscal_year", obs."classified_authority_track", obs."classified_stage", obs."classified_source_family",
       obs."discovered_url", obs."superseded_by_observation_id",
       cy."fiscal_year" AS cycle_fiscal_year, cy."authority_track" AS cycle_authority_track,
       sd."source_key", sd."fiscal_year" AS source_fiscal_year, sd."component", sd."source_url", sd."sha256" AS source_sha256,
       sd."byte_size" AS source_byte_size, sd."archive_bucket", sd."archive_s3_key", sd."archive_version_id",
       sd."superseded_by_document_id",
       (SELECT count(*)::int FROM "budget_extraction_candidate_v1" c
          WHERE c."cycle_id"=o."cycle_id"::text AND c."source_document_id"=sd."id") AS candidate_count,
       (SELECT count(*)::int FROM "budget_scoped_fact_review_v1" review
          JOIN "budget_extraction_candidate_v1" c ON c."id"=review."candidate_id"
          WHERE c."cycle_id"=o."cycle_id"::text AND c."source_document_id"=sd."id"
            AND review."status"='active' AND review."decision"='approve') AS active_approval_count,
       (SELECT count(*)::int FROM "budget_candidate_correction_v1" correction
          WHERE EXISTS (SELECT 1 FROM "budget_extraction_candidate_v1" c
            WHERE c."cycle_id"=o."cycle_id"::text AND c."source_document_id"=sd."id"
              AND c."id" IN (correction."old_candidate_id",correction."new_candidate_id"))) AS correction_count
     FROM "defense_budget_ingestion_outbox" o
     JOIN "defense_budget_source_observation" obs ON obs."id"=o."observation_id"
     JOIN "defense_budget_cycle" cy ON cy."id"=o."cycle_id"
     JOIN "source_document" sd ON sd."id"=obs."source_document_id"
     WHERE o."id"=$1::uuid${lock ? ' FOR UPDATE OF o, obs, sd' : ''}`,
    outboxRowId,
  );
  return rows[0] ?? null;
}

function memberIssues(member: IngestionManifestMemberV1, row: BoundMemberRow | null): Array<{ code: string; detail: string }> {
  const issues: Array<{ code: string; detail: string }> = [];
  const add = (code: string, detail: string) => issues.push({ code, detail });
  if (!row) return [{ code: 'ROW_NOT_FOUND', detail: 'exact outbox row or its required source binding does not exist' }];
  const lifecycle = member.lifecycle;
  const expectedUpdatedAt = new Date(lifecycle.expectedOutboxUpdatedAt).toISOString();
  if (String(row.observation_id) !== lifecycle.observationId) add('OBSERVATION_CHANGED', 'outbox observation binding differs from manifest');
  if (String(row.cycle_id) !== lifecycle.cycleId) add('CYCLE_CHANGED', 'outbox cycle binding differs from manifest');
  if (String(row.source_document_id) !== lifecycle.sourceDocumentId) add('SOURCE_CHANGED', 'observation source binding differs from manifest');
  if (String(row.job_kind) !== lifecycle.jobKind) add('JOB_KIND_CHANGED', 'outbox job kind differs from manifest');
  if (String(row.outbox_state) !== lifecycle.expectedOutboxState) add('OUTBOX_STATE_CHANGED', 'outbox state differs from manifest');
  if (Number(row.outbox_attempts) !== lifecycle.expectedOutboxAttempts) add('OUTBOX_ATTEMPTS_CHANGED', 'outbox attempt count differs from manifest');
  if (iso(row.outbox_updated_at) !== expectedUpdatedAt) add('OUTBOX_VERSION_CHANGED', 'outbox updated_at differs from manifest');
  if (row.outbox_due !== true) add('OUTBOX_NOT_DUE', 'outbox retry backoff has not elapsed');
  if (row.leased_by != null || row.leased_until != null) add('OUTBOX_BUSY', 'outbox row is already leased');
  if (String(row.observation_state) !== lifecycle.expectedObservationState) add('OBSERVATION_STATE_CHANGED', 'observation state differs from manifest');
  if (row.superseded_by_observation_id != null || row.superseded_by_document_id != null) add('SOURCE_SUPERSEDED', 'observation or source is superseded');
  if (String(row.content_sha256) !== member.source.sha256 || String(row.source_sha256) !== member.source.sha256) add('SOURCE_HASH_CHANGED', 'source/observation hash differs from manifest');
  if (Number(row.source_byte_size) !== member.source.byteSize || Number(row.observation_byte_size) !== member.source.byteSize) add('SOURCE_SIZE_CHANGED', 'source/observation byte size differs from manifest');
  if (String(row.source_url) !== member.source.officialLocator || String(row.discovered_url) !== member.source.officialLocator) add('SOURCE_LOCATOR_CHANGED', 'official source locator differs from persisted bindings');
  if (String(row.archive_bucket) !== member.archive.bucket || String(row.archive_s3_key) !== member.archive.objectKey || String(row.archive_version_id) !== member.archive.versionId) add('ARCHIVE_CHANGED', 'versioned archive locator differs from manifest');
  if (Number(row.source_fiscal_year) !== member.fiscalYear || Number(row.cycle_fiscal_year) !== member.fiscalYear || Number(row.classified_fiscal_year) !== member.fiscalYear) add('FISCAL_YEAR_CHANGED', 'fiscal year does not agree across manifest/source/cycle/observation');
  if (String(row.cycle_authority_track) !== member.authorityTrack || String(row.classified_authority_track) !== member.authorityTrack) add('AUTHORITY_CHANGED', 'authority track differs from manifest');
  if (String(row.classified_stage) !== member.lifecycleStage) add('STAGE_CHANGED', 'lifecycle stage differs from manifest');
  if (String(row.classified_source_family) !== member.sourceFamily) add('FAMILY_CHANGED', 'source family differs from manifest');
  const component = row.component == null ? 'MULTI' : String(row.component);
  if (component !== member.component) add('COMPONENT_CHANGED', 'source component differs from manifest');
  if (Number(row.candidate_count) !== lifecycle.expectedCandidateCount) add('CANDIDATE_APPEARED', 'candidate count differs from manifest; automatic re-extraction/supersession is forbidden');
  if (Number(row.active_approval_count) !== lifecycle.expectedActiveApprovalCount) add('APPROVAL_COUNT_CHANGED', 'active scoped approval count differs from manifest; approval replacement is forbidden');
  if (Number(row.correction_count) !== lifecycle.expectedCorrectionCount) add('CORRECTION_COUNT_CHANGED', 'candidate correction count differs from manifest; correction is out of scope');
  return issues;
}

function terminalFields(terminal: Record<string, unknown>): {
  candidateId: string;
  verificationRunId: string;
  decision: 'PASS' | 'REVIEW' | 'REJECT';
} {
  const candidateId = String(terminal.candidateId ?? '');
  const verificationRunId = String(terminal.verificationRunId ?? '');
  requireUuid(candidateId, 'terminal.candidateId');
  requireUuid(verificationRunId, 'terminal.verificationRunId');
  const decision = terminal.verifierDecision;
  if (decision !== 'PASS' && decision !== 'REVIEW' && decision !== 'REJECT') {
    throw new Error('terminal.verifierDecision must be PASS, REVIEW, or REJECT');
  }
  if (!String(terminal.artifactId ?? '').trim() || !SHA.test(String(terminal.artifactContentSha256 ?? '')) ||
      !String(terminal.artifactLocator ?? '').trim()) {
    throw new Error('terminal requires exact artifact identity, content hash, and locator');
  }
  return { candidateId, verificationRunId, decision };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function uniqueConflict(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'P2002' || code === '23505' || /unique constraint|duplicate key/i.test(message);
}

export function createIngestionManifestRepositoryV1(
  prisma: IngestionManifestPrismaLikeV1,
  options: { leaseMs?: number } = {},
): IngestionManifestRepositoryV1 {
  const leaseMs = options.leaseMs ?? INGESTION_MANIFEST_LEASE_MS_V1;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive integer');

  const runPreflight = async (
    tx: IngestionManifestPrismaTransactionV1,
    manifest: IngestionManifestV1,
    lock: boolean,
  ): Promise<IngestionManifestPreflightV1> => {
    const issues: IngestionManifestPreflightV1['issues'] = [];
    for (const member of manifest.members) {
      const row = await loadBoundMember(tx, member.lifecycle.outboxRowId, lock);
      issues.push(...memberIssues(member, row).map(issue => ({ memberId: member.memberId, ...issue })));
    }
    return { eligible: issues.length === 0, issues };
  };

  async function refreshOperationStatus(tx: IngestionManifestPrismaTransactionV1, operationId: string): Promise<void> {
    await tx.$queryRawUnsafe(
      `UPDATE "defense_budget_ingestion_manifest_v1" op SET
         "status"=CASE
           WHEN NOT EXISTS (SELECT 1 FROM "defense_budget_ingestion_manifest_item_v1" i
             WHERE i."manifest_id"=op."id" AND i."status" NOT IN ('completed','quarantined')) THEN 'completed'
           WHEN op."status"='stop_requested' AND NOT EXISTS (
             SELECT 1 FROM "defense_budget_ingestion_manifest_item_v1" i
             WHERE i."manifest_id"=op."id" AND i."status" IN ('running','evidence_ready')) THEN 'paused'
           ELSE op."status" END,
         "completed_at"=CASE WHEN NOT EXISTS (
           SELECT 1 FROM "defense_budget_ingestion_manifest_item_v1" i
           WHERE i."manifest_id"=op."id" AND i."status" NOT IN ('completed','quarantined'))
           THEN COALESCE(op."completed_at",clock_timestamp()) ELSE op."completed_at" END,
         "updated_at"=clock_timestamp()
       WHERE op."id"=$1::uuid AND op."status"<>'completed' RETURNING op."id"`, operationId,
    );
  }

  async function checkpointVerification(
    tx: IngestionManifestPrismaTransactionV1,
    context: IngestionManifestLeaseContextV1,
    identity: CandidateIdentityV1,
    candidateId: string,
    verificationRunId: string,
  ): Promise<void> {
    requireUuid(context.operationId, 'operationId');
    requireUuid(context.itemId, 'itemId');
    requireUuid(context.leaseToken, 'leaseToken');
    requireUuid(candidateId, 'candidateId');
    requireUuid(verificationRunId, 'verificationRunId');
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid FOR UPDATE',
      context.itemId,
    );
    const correlation = {
      candidateId, verificationRunId, manifestContentSha256: identity.manifestContentSha256,
      manifestDocumentKey: identity.manifestDocumentKey, extractionArtifactId: identity.extractionArtifactId,
      extractionArtifactSha256: identity.extractionArtifactSha256,
      extractionArtifactLocator: identity.extractionArtifactLocator,
      verifierVersion: identity.verifierVersion, policyVersion: identity.policyVersion,
      policySha256: identity.policySha256,
    };
    const rows = await tx.$queryRawUnsafe<unknown[]>(
      `UPDATE "defense_budget_ingestion_manifest_item_v1" i SET
         "verification_correlations_jsonb"=CASE WHEN EXISTS (
           SELECT 1 FROM jsonb_array_elements(i."verification_correlations_jsonb") x
           WHERE x->>'candidateId'=$9 AND x->>'verificationRunId'=$10
         ) THEN i."verification_correlations_jsonb" ELSE i."verification_correlations_jsonb" || jsonb_build_array($8::jsonb) END,
         "updated_at"=clock_timestamp()
       WHERE i."id"=$1::uuid AND i."manifest_id"=$2::uuid AND i."status"='running'
         AND i."lease_token"=$3::uuid AND i."leased_until">clock_timestamp()
         AND i."started_at"+((i."member_jsonb"->>'timeoutSeconds')::bigint * INTERVAL '1 second')>clock_timestamp()
         AND EXISTS (SELECT 1 FROM "defense_budget_ingestion_manifest_v1" op
           WHERE op."id"=i."manifest_id" AND op."status" IN ('running','stop_requested')
             AND op."deadline_at">clock_timestamp())
         AND i."cycle_id"::text=$4 AND i."source_document_id"=$5::uuid AND i."source_sha256"=$6
         AND EXISTS (SELECT 1 FROM "defense_budget_ingestion_outbox" o WHERE o."id"=i."outbox_row_id"
           AND o."state"='leased' AND o."leased_by"=$7 AND o."leased_until">clock_timestamp())
         AND EXISTS (SELECT 1 FROM "budget_extraction_candidate_v1" c
           JOIN "budget_verification_run_v1" r ON r."id"=$10::uuid AND r."candidate_id"=c."id"
           WHERE c."id"=$9::uuid AND c."cycle_id"=$4 AND c."source_document_id"=$5::uuid
             AND c."source_sha256"=$6 AND c."manifest_content_sha256"=$11
             AND c."manifest_document_key"=$12 AND c."extraction_artifact_id"=$13
             AND c."extraction_artifact_sha256"=$14 AND c."verifier_version"=$15
             AND c."policy_version"=$16 AND c."policy_sha256"=$17)
       RETURNING i."id"`,
      context.itemId, context.operationId, context.leaseToken, identity.cycleId,
      identity.sourceDocumentId, identity.sourceSha256, context.leaseToken,
      json(correlation), candidateId, verificationRunId, identity.manifestContentSha256,
      identity.manifestDocumentKey, identity.extractionArtifactId, identity.extractionArtifactSha256,
      identity.verifierVersion, identity.policyVersion, identity.policySha256,
    );
    if (rows.length !== 1) throw new IngestionManifestLeaseLostErrorV1('verification checkpoint refused by manifest lease/source fence');
  }

  return {
    async preflight(manifest) {
      return runPreflight(prisma, manifest, false);
    },

    async register(manifest) {
      requireUuid(manifest.operationId, 'operationId');
      try {
        return await prisma.$transaction(async tx => {
          await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))::text', manifest.operationId);
          const existing = await readWith(tx, manifest.operationId);
          if (existing) return {
            outcome: existing.manifestSha256 === manifest.contentSha256 ? 'existing' as const : 'conflict' as const,
            operation: existing, issues: [],
          };
          for (const member of manifest.members) {
            const reservations = await tx.$queryRawUnsafe<unknown[]>(
              `SELECT "id" FROM "defense_budget_ingestion_manifest_item_v1"
               WHERE "status" IN ${ACTIVE_ITEM_STATES}
                 AND ("outbox_row_id"=$1::uuid OR
                   ("cycle_id"=$2::uuid AND "source_document_id"=$3::uuid))
               LIMIT 1`,
              member.lifecycle.outboxRowId, member.lifecycle.cycleId, member.lifecycle.sourceDocumentId,
            );
            if (reservations.length > 0) return {
              outcome: 'conflict' as const, operation: null, issues: [{
                memberId: member.memberId, code: 'ACTIVE_RESERVATION_CONFLICT',
                detail: 'another active manifest already reserves this outbox row or cycle/source',
              }],
            };
          }
          const preflight = await runPreflight(tx, manifest, true);
          if (!preflight.eligible) return { outcome: 'ineligible' as const, operation: null, issues: preflight.issues };
          await tx.$queryRawUnsafe(
            `INSERT INTO "defense_budget_ingestion_manifest_v1" (
               "id","schema_version","manifest_sha256","manifest_jsonb","owner","environment",
               "release_revision","runtime_image_digest","task_definition_arn","runtime_config_sha256","deadline_at")
             VALUES ($1::uuid,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,
               clock_timestamp()+($11::bigint * INTERVAL '1 second'))`,
            manifest.operationId, manifest.schemaVersion, manifest.contentSha256, json(manifest),
            manifest.owner, manifest.environment, manifest.runtime.releaseRevision,
            manifest.runtime.drainImageDigest, manifest.runtime.taskDefinitionArn,
            manifest.runtime.runtimeConfigSha256, manifest.limits.maxElapsedSeconds,
          );
          for (const member of manifest.members) {
            await tx.$queryRawUnsafe(
              `INSERT INTO "defense_budget_ingestion_manifest_item_v1" (
                 "id","manifest_id","ordinal","outbox_row_id","observation_id","cycle_id","source_document_id",
                 "source_sha256","source_byte_size","expected_outbox_state","member_jsonb","attempts")
               VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11::jsonb,$12)`,
              member.memberId, manifest.operationId, member.ordinal, member.lifecycle.outboxRowId,
              member.lifecycle.observationId, member.lifecycle.cycleId, member.lifecycle.sourceDocumentId,
              member.source.sha256, member.source.byteSize, member.lifecycle.expectedOutboxState, json(member),
              member.lifecycle.expectedOutboxAttempts,
            );
          }
          return { outcome: 'registered' as const, operation: await readWith(tx, manifest.operationId), issues: [] };
        });
      } catch (error) {
        if (!uniqueConflict(error)) throw error;
        return { outcome: 'conflict', operation: await readWith(prisma, manifest.operationId), issues: [{
          memberId: manifest.operationId, code: 'ACTIVE_RESERVATION_CONFLICT',
          detail: 'another active manifest already reserves an outbox row or source',
        }] };
      }
    },

    async read(operationId) {
      requireUuid(operationId, 'operationId');
      return readWith(prisma, operationId);
    },

    async requestStop(operationId) {
      requireUuid(operationId, 'operationId');
      await prisma.$queryRawUnsafe(
        `UPDATE "defense_budget_ingestion_manifest_v1" SET "status"='stop_requested',
           "stop_requested_at"=COALESCE("stop_requested_at",clock_timestamp()),"updated_at"=clock_timestamp()
         WHERE "id"=$1::uuid AND "status"='running' RETURNING "id"`, operationId,
      );
      await prisma.$transaction(tx => refreshOperationStatus(tx, operationId));
      return readWith(prisma, operationId);
    },

    async resume(operationId) {
      requireUuid(operationId, 'operationId');
      const operation = await readWith(prisma, operationId);
      if (!operation) return 'not_found';
      if (operation.status === 'completed') return 'completed';
      if (operation.items.some(item => item.status === 'uncertain')) return 'uncertain';
      await prisma.$queryRawUnsafe(
        `UPDATE "defense_budget_ingestion_manifest_v1" SET "status"='running',"stop_requested_at"=NULL,
           "updated_at"=clock_timestamp() WHERE "id"=$1::uuid AND "status" IN ('paused','stop_requested')
           AND "deadline_at">clock_timestamp() RETURNING "id"`, operationId,
      );
      return 'resumed';
    },

    async claimNext(input) {
      requireUuid(input.operationId, 'operationId');
      requireUuid(input.leaseToken, 'leaseToken');
      if (!input.taskJobId.trim()) throw new Error('taskJobId is required');
      return prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "defense_budget_ingestion_manifest_v1" WHERE "id"=$1::uuid FOR UPDATE', input.operationId);
        await tx.$queryRawUnsafe(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='uncertain',
             "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
             "last_error_class"='LEASE_EXPIRED_WITHOUT_CHECKPOINT',
             "last_error_message"='Prior task outcome must be reconciled before retry',"updated_at"=clock_timestamp()
           WHERE "manifest_id"=$1::uuid AND "status"='running' AND "leased_until"<=clock_timestamp()
             AND jsonb_array_length("verification_correlations_jsonb")=0 RETURNING "id"`, input.operationId,
        );
        const operation = await readWith(tx, input.operationId);
        if (!operation) return { outcome: 'none' as const, item: null };
        if (operation.status === 'completed') return { outcome: 'complete' as const, item: null };
        if (operation.status !== 'running' || new Date(operation.deadlineAt).getTime() <= Date.now()) {
          if (operation.status === 'running') await tx.$queryRawUnsafe(
            `UPDATE "defense_budget_ingestion_manifest_v1" SET "status"='paused',"updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid AND "status"='running'`, input.operationId,
          );
          return { outcome: 'stopped' as const, item: null };
        }
        if (operation.items.some(item => item.status === 'uncertain')) return { outcome: 'uncertain' as const, item: null };
        if (operation.items.some(item => (item.status === 'running' || item.status === 'evidence_ready') &&
          item.leasedUntil != null && new Date(item.leasedUntil).getTime() > Date.now())) {
          return { outcome: 'busy' as const, item: null };
        }

        // A committed verification checkpoint is authoritative. Adopt it
        // before considering another parse, even when onTerminal never ran.
        const recoverable = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT i.*, c."extraction_artifact_id",c."extraction_artifact_sha256",c."extraction_artifact_locator",
             r."decision",r."status" AS run_status,r."route",r."result_snapshot_jsonb"
           FROM "defense_budget_ingestion_manifest_item_v1" i
           JOIN LATERAL jsonb_array_elements(i."verification_correlations_jsonb") WITH ORDINALITY x(value,n) ON true
           JOIN "budget_extraction_candidate_v1" c ON c."id"=(x.value->>'candidateId')::uuid
           JOIN "budget_verification_run_v1" r ON r."id"=(x.value->>'verificationRunId')::uuid AND r."candidate_id"=c."id"
           WHERE i."manifest_id"=$1::uuid AND i."status"='running' AND i."leased_until"<=clock_timestamp()
           ORDER BY i."ordinal",x.n DESC LIMIT 1 FOR UPDATE OF i`, input.operationId,
        );
        if (recoverable[0]) {
          const row = recoverable[0];
          const correlations = asRecords(row.verification_correlations_jsonb);
          const latest = correlations[correlations.length - 1]!;
          const decision = String(row.decision) as 'PASS' | 'REVIEW' | 'REJECT';
          const terminal = {
            recoveredFromPersistenceFence: true,
            candidateId: String(latest.candidateId), verificationRunId: String(latest.verificationRunId),
            artifactId: String(row.extraction_artifact_id), artifactLocator: String(row.extraction_artifact_locator),
            artifactContentSha256: String(row.extraction_artifact_sha256), artifactByteSha256: null,
            verifierDecision: decision,
            finalState: decision === 'PASS' ? 'TERMINAL_PASSED' : decision === 'REVIEW' ? 'TERMINAL_REVIEW' : 'TERMINAL_REJECTED',
            verificationResultSnapshot: row.result_snapshot_jsonb,
          };
          const recoveredOutbox = await tx.$queryRawUnsafe<unknown[]>(
            `UPDATE "defense_budget_ingestion_outbox" SET "state"='leased',"leased_by"=$2,
               "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),"updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid AND "state"='leased' AND "leased_until"<=clock_timestamp()
             RETURNING "id"`,
            String(row.outbox_row_id), input.leaseToken, leaseMs,
          );
          if (recoveredOutbox.length !== 1) {
            const uncertain = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
              `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='uncertain',
                 "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
                 "last_error_class"='CHECKPOINT_OUTBOX_OWNERSHIP_LOST',
                 "last_error_message"='Persisted verification exists but the exact outbox lease could not be recovered',
                 "updated_at"=clock_timestamp() WHERE "id"=$1::uuid RETURNING *`,
              String(row.id),
            );
            return { outcome: 'uncertain' as const, item: toItem(uncertain[0]!) };
          }
          const adopted = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
            `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='evidence_ready',"lease_token"=$2::uuid,
               "lease_generation"="lease_generation"+1,"leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),
               "last_heartbeat_at"=clock_timestamp(),"task_job_id"=$4,"terminal_jsonb"=$5::jsonb,
               "candidate_id"=$6::uuid,"verification_run_id"=$7::uuid,"parser_disposition"=$8,
               "reconciliations_jsonb"="reconciliations_jsonb" || jsonb_build_array(jsonb_build_object(
                 'kind','adopt_persisted_checkpoint','taskJobId',$4::text,'at',clock_timestamp())),"updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid RETURNING *`, String(row.id), input.leaseToken, leaseMs, input.taskJobId,
            json(terminal), String(latest.candidateId), String(latest.verificationRunId), decision,
          );
          return { outcome: 'evidence_ready' as const, item: toItem(adopted[0]!) };
        }

        const candidates = operation.items.filter(item =>
          (item.status === 'pending' || item.status === 'retry_wait' ||
            (item.status === 'evidence_ready' && item.leasedUntil != null && new Date(item.leasedUntil).getTime() <= Date.now())) &&
          new Date(item.nextAttemptAt).getTime() <= Date.now(),
        );
        const candidate = candidates[0];
        if (!candidate) {
          await refreshOperationStatus(tx, input.operationId);
          await tx.$queryRawUnsafe(
            `UPDATE "defense_budget_ingestion_manifest_v1" SET "status"='paused',"updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid AND "status"='running'
               AND EXISTS (SELECT 1 FROM "defense_budget_ingestion_manifest_item_v1" i
                 WHERE i."manifest_id"=$1::uuid AND i."status" NOT IN ('completed','quarantined'))
               AND NOT EXISTS (SELECT 1 FROM "defense_budget_ingestion_manifest_item_v1" i
                 WHERE i."manifest_id"=$1::uuid AND i."status" IN ('running','evidence_ready','uncertain'))`,
            input.operationId,
          );
          return { outcome: 'none' as const, item: null };
        }
        const isEvidence = candidate.status === 'evidence_ready';
        if (!isEvidence) {
          const current = await loadBoundMember(tx, candidate.outboxRowId, true);
          const issues = memberIssues(candidate.member, current).filter(issue =>
            // Once registered, updated_at naturally changes only when this
            // controller leases/retries the row. Active reservation prevents
            // a legacy worker from consuming these ignored version counters.
            issue.code !== 'OUTBOX_VERSION_CHANGED' && issue.code !== 'OUTBOX_ATTEMPTS_CHANGED',
          );
          if (issues.length > 0) {
            const stale = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
              `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='uncertain',
                 "last_error_class"='STALE_MANIFEST_MEMBER',"last_error_message"=$2,
                 "updated_at"=clock_timestamp() WHERE "id"=$1::uuid RETURNING *`,
              candidate.id, issues.map(i => `${i.code}: ${i.detail}`).join('; ').slice(0, 4000),
            );
            return { outcome: 'uncertain' as const, item: toItem(stale[0]!) };
          }
        }
        const outboxRows = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET "state"='leased',"leased_by"=$2,
             "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND (("state" IN ('pending','failed') AND "leased_by" IS NULL) OR
             ("state"='leased' AND "leased_until"<=clock_timestamp()))
             AND "available_at"<=clock_timestamp() RETURNING "id"`,
          candidate.outboxRowId, input.leaseToken, leaseMs,
        );
        if (outboxRows.length !== 1) return { outcome: 'busy' as const, item: null };
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"=$5,
             "lease_token"=$2::uuid,"lease_generation"="lease_generation"+1,
             "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),
             "last_heartbeat_at"=clock_timestamp(),"task_job_id"=$4,
             "attempts"="attempts"+CASE WHEN $5='running' THEN 1 ELSE 0 END,
             "started_at"=COALESCE("started_at",clock_timestamp()),"last_error_class"=NULL,"last_error_message"=NULL,
             "execution_history_jsonb"="execution_history_jsonb" || jsonb_build_array(jsonb_build_object(
               'leaseToken',$2::text,'leaseGeneration',"lease_generation"+1,'taskJobId',$4::text,
               'kind',CASE WHEN $5='running' THEN 'parse' ELSE 'finalize' END,'claimedAt',clock_timestamp())),
             "updated_at"=clock_timestamp() WHERE "id"=$1::uuid RETURNING *`,
          candidate.id, input.leaseToken, leaseMs, input.taskJobId, isEvidence ? 'evidence_ready' : 'running',
        );
        return { outcome: isEvidence ? 'evidence_ready' as const : 'claimed' as const, item: toItem(rows[0]!) };
      });
    },

    async heartbeat(context) {
      return prisma.$transaction(async tx => {
        const item = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" i SET
             "leased_until"=clock_timestamp()+($4::bigint * INTERVAL '1 millisecond'),
             "last_heartbeat_at"=clock_timestamp(),"updated_at"=clock_timestamp()
           WHERE i."id"=$1::uuid AND i."manifest_id"=$2::uuid AND i."lease_token"=$3::uuid
             AND i."status" IN ('running','evidence_ready') AND i."leased_until">clock_timestamp()
             AND i."started_at"+((i."member_jsonb"->>'timeoutSeconds')::bigint * INTERVAL '1 second')>clock_timestamp()
             AND EXISTS (SELECT 1 FROM "defense_budget_ingestion_manifest_v1" op
               WHERE op."id"=i."manifest_id" AND op."status" IN ('running','stop_requested')
                 AND op."deadline_at">clock_timestamp())
           RETURNING i."outbox_row_id"`,
          context.itemId, context.operationId, context.leaseToken, leaseMs,
        );
        if (!item[0]) return false;
        const outbox = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET
             "leased_until"=clock_timestamp()+($3::bigint * INTERVAL '1 millisecond'),"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "state"='leased' AND "leased_by"=$2
             AND "leased_until">clock_timestamp() RETURNING "id"`,
          String(item[0].outbox_row_id), context.leaseToken, leaseMs,
        );
        if (outbox.length !== 1) {
          throw new IngestionManifestLeaseLostErrorV1('outbox ownership was lost while renewing the manifest lease');
        }
        return true;
      });
    },

    async markUncertain(input) {
      return prisma.$transaction(async tx => {
        const rows = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='uncertain',
             "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
             "last_error_class"=$4,"last_error_message"=$5,"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid AND "status"='running'
             AND "lease_token"=$3::uuid
           RETURNING "id"`,
          input.itemId, input.operationId, input.leaseToken,
          input.errorClass.slice(0, 200), input.detail.slice(0, 4000),
        );
        if (rows.length === 1) await refreshOperationStatus(tx, input.operationId);
        return rows.length === 1;
      });
    },

    async checkpointTerminal(context, terminal) {
      const fields = terminalFields(terminal);
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `UPDATE "defense_budget_ingestion_manifest_item_v1" i SET "status"='evidence_ready',
           "terminal_jsonb"=$4::jsonb,"candidate_id"=$5::uuid,"verification_run_id"=$6::uuid,
           "parser_disposition"=$7,"updated_at"=clock_timestamp()
         WHERE i."id"=$1::uuid AND i."manifest_id"=$2::uuid AND i."status"='running'
           AND i."lease_token"=$3::uuid AND i."leased_until">clock_timestamp()
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(i."verification_correlations_jsonb") x
             WHERE x->>'candidateId'=$5 AND x->>'verificationRunId'=$6)
           AND EXISTS (SELECT 1 FROM "budget_verification_run_v1" r
             WHERE r."id"=$6::uuid AND r."candidate_id"=$5::uuid AND r."decision"=$7)
         RETURNING i."id"`, context.itemId, context.operationId, context.leaseToken,
        json(terminal), fields.candidateId, fields.verificationRunId, fields.decision,
      );
      return rows.length === 1;
    },

    async finalizeEvidence(context) {
      return prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid FOR UPDATE', context.itemId);
        const items = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid
             AND "status"='evidence_ready' AND "lease_token"=$3::uuid AND "leased_until">clock_timestamp()`,
          context.itemId, context.operationId, context.leaseToken,
        );
        if (!items[0]) return false;
        const item = toItem(items[0]);
        const disposition = item.parserDisposition!;
        const metadata = {
          manifestOperationId: context.operationId, manifestItemId: item.id,
          manifestSha256: (await readWith(tx, context.operationId))!.manifestSha256,
          sourceDocumentId: item.sourceDocumentId, verifierDecision: disposition,
          governedDisposition: disposition === 'REVIEW' ? 'review_required' : disposition === 'REJECT' ? 'verification_rejected' : 'passed',
          readinessPhase: 'not_requested_manifest_ingestion_only',
          readinessInvoked: false, approvalWrites: 0, correctionWrites: 0, canonicalWrites: 0,
          candidateId: item.candidateId, verificationRunId: item.verificationRunId,
        };
        const outbox = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET "state"=$3,
             "metadata_jsonb"="metadata_jsonb" || $4::jsonb,
             "last_error"=$5,"leased_by"=NULL,"leased_until"=NULL,"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "state"='leased' AND "leased_by"=$2
             AND "leased_until">clock_timestamp() RETURNING "id"`,
          item.outboxRowId, context.leaseToken, disposition === 'PASS' ? 'succeeded' : 'dead_letter',
          json(metadata), disposition === 'PASS' ? null : disposition === 'REVIEW'
            ? 'Verification requires governed human review' : 'Verification deterministically rejected',
        );
        if (outbox.length !== 1) return false;
        const status = disposition === 'REJECT' ? 'quarantined' : 'completed';
        await tx.$queryRawUnsafe(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"=$4,
             "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
             "finished_at"=clock_timestamp(),"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid AND "lease_token"=$3::uuid`,
          context.itemId, context.operationId, context.leaseToken, status,
        );
        await refreshOperationStatus(tx, context.operationId);
        return true;
      });
    },

    async recordTransientFailure(input) {
      if (!Number.isSafeInteger(input.backoffMs) || input.backoffMs < 0) throw new Error('backoffMs must be a nonnegative integer');
      return prisma.$transaction(async tx => {
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid
             AND "status"='running' AND "lease_token"=$3::uuid AND "leased_until">clock_timestamp() FOR UPDATE`,
          input.itemId, input.operationId, input.leaseToken,
        );
        if (!rows[0]) return 'lease_lost' as const;
        const item = toItem(rows[0]);
        if (item.verificationCorrelations.length > 0) {
          await tx.$queryRawUnsafe(
            `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='uncertain',
               "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
               "last_error_class"=$4,"last_error_message"=$5,"updated_at"=clock_timestamp()
             WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid AND "lease_token"=$3::uuid`,
            input.itemId, input.operationId, input.leaseToken,
            'PERSISTED_RESULT_REQUIRES_RECONCILIATION', input.detail.slice(0, 4000),
          );
          return 'uncertain' as const;
        }
        const maxAttempts = item.member.retry.maxAttempts;
        const retry = item.member.retry.classification === 'transient_only' && item.attempts < maxAttempts;
        const next = retry ? 'retry_wait' : 'quarantined';
        const outbox = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET "state"=$3,"leased_by"=NULL,"leased_until"=NULL,
             "attempts"="attempts"+1,"available_at"=clock_timestamp()+($4::bigint * INTERVAL '1 millisecond'),
             "last_error"=$5,"metadata_jsonb"="metadata_jsonb" || $6::jsonb,"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "state"='leased' AND "leased_by"=$2
             AND "leased_until">clock_timestamp() RETURNING "id"`,
          item.outboxRowId, input.leaseToken, retry ? item.expectedOutboxState : 'dead_letter', input.backoffMs,
          input.detail.slice(0, 4000), json(retry ? {} : {
            manifestOperationId: input.operationId, manifestItemId: input.itemId,
            governedDisposition: 'parser_failure_quarantined', readinessPhase: 'not_requested_manifest_ingestion_only',
          }),
        );
        if (outbox.length !== 1) return 'lease_lost' as const;
        await tx.$queryRawUnsafe(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"=$4,
             "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
             "next_attempt_at"=clock_timestamp()+($5::bigint * INTERVAL '1 millisecond'),
             "last_error_class"=$6,"last_error_message"=$7,
             "terminal_jsonb"=CASE WHEN $4='quarantined' THEN jsonb_build_object(
               'kind','parser_failure','errorClass',$6::text,'detail',$7::text,'retryEligible',false) ELSE NULL END,
             "finished_at"=CASE WHEN $4='quarantined' THEN clock_timestamp() ELSE NULL END,
             "updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid AND "lease_token"=$3::uuid`,
          input.itemId, input.operationId, input.leaseToken, next, input.backoffMs,
          input.errorClass.slice(0, 200), input.detail.slice(0, 4000),
        );
        await refreshOperationStatus(tx, input.operationId);
        return next;
      });
    },

    async quarantineFailure(input) {
      return prisma.$transaction(async tx => {
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid
             AND "status"='running' AND "lease_token"=$3::uuid AND "leased_until">clock_timestamp() FOR UPDATE`,
          input.itemId, input.operationId, input.leaseToken,
        );
        if (!rows[0]) return false;
        const item = toItem(rows[0]);
        if (item.verificationCorrelations.length > 0) return false;
        const outbox = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET "state"='dead_letter',"leased_by"=NULL,"leased_until"=NULL,
             "last_error"=$3,"metadata_jsonb"="metadata_jsonb" || $4::jsonb,"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "state"='leased' AND "leased_by"=$2
             AND "leased_until">clock_timestamp() RETURNING "id"`,
          item.outboxRowId, input.leaseToken, input.detail.slice(0, 4000), json({
            manifestOperationId: input.operationId, manifestItemId: input.itemId,
            governedDisposition: 'parser_failure_quarantined', readinessPhase: 'not_requested_manifest_ingestion_only',
          }),
        );
        if (outbox.length !== 1) return false;
        await tx.$queryRawUnsafe(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='quarantined',
             "lease_token"=NULL,"leased_until"=NULL,"last_heartbeat_at"=NULL,
             "last_error_class"=$4,"last_error_message"=$5,
             "terminal_jsonb"=jsonb_build_object('kind','parser_failure','errorClass',$4::text,
               'detail',$5::text,'retryEligible',false),"finished_at"=clock_timestamp(),"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid AND "lease_token"=$3::uuid`,
          input.itemId, input.operationId, input.leaseToken,
          input.errorClass.slice(0, 200), input.detail.slice(0, 4000),
        );
        await refreshOperationStatus(tx, input.operationId);
        return true;
      });
    },

    async reconcileUncertain(input) {
      requireUuid(input.operationId, 'operationId');
      requireUuid(input.itemId, 'itemId');
      if (!input.actor.trim() || !input.reason.trim() || !input.expectedTaskJobId.trim()) throw new Error('uncertain reconciliation requires task, actor, and reason');
      return prisma.$transaction(async tx => {
        const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM "defense_budget_ingestion_manifest_item_v1" WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid
             AND "status"='uncertain' AND "task_job_id"=$3 FOR UPDATE`,
          input.itemId, input.operationId, input.expectedTaskJobId,
        );
        if (!rows[0]) return 'ineligible' as const;
        const item = toItem(rows[0]);
        if (item.verificationCorrelations.length > 0) {
          // A correlated result is adopted by claimNext, never selected by
          // "newest candidate". Move back to expired-running to enter that path.
          await tx.$queryRawUnsafe(
            `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='running',
               "lease_token"=gen_random_uuid(),"leased_until"=clock_timestamp()-INTERVAL '1 second',
               "last_heartbeat_at"=clock_timestamp()-INTERVAL '1 second',
               "reconciliations_jsonb"="reconciliations_jsonb" || jsonb_build_array(jsonb_build_object(
                 'kind','task_confirmed_ended_with_checkpoint','taskJobId',$3::text,'actor',$4::text,'reason',$5::text,'at',clock_timestamp())),
               "updated_at"=clock_timestamp() WHERE "id"=$1::uuid`,
            input.itemId, input.operationId, input.expectedTaskJobId, input.actor.trim(), input.reason.trim(),
          );
          return 'evidence_ready' as const;
        }
        const resetOutbox = await tx.$queryRawUnsafe<unknown[]>(
          `UPDATE "defense_budget_ingestion_outbox" SET "state"=$2,"leased_by"=NULL,"leased_until"=NULL,
             "available_at"=clock_timestamp(),"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND (
             ("state"=$2 AND "leased_by" IS NULL AND "leased_until" IS NULL) OR
             ("state"='leased' AND "leased_until"<=clock_timestamp())
           ) RETURNING "id"`,
          item.outboxRowId, item.expectedOutboxState,
        );
        if (resetOutbox.length !== 1) return 'ineligible' as const;
        await tx.$queryRawUnsafe(
          `UPDATE "defense_budget_ingestion_manifest_item_v1" SET "status"='retry_wait',"next_attempt_at"=clock_timestamp(),
             "reconciliations_jsonb"="reconciliations_jsonb" || jsonb_build_array(jsonb_build_object(
               'kind','task_confirmed_ended_without_checkpoint','taskJobId',$3::text,'actor',$4::text,'reason',$5::text,'at',clock_timestamp())),
             "last_error_class"=NULL,"last_error_message"=NULL,"updated_at"=clock_timestamp()
           WHERE "id"=$1::uuid AND "manifest_id"=$2::uuid`,
          input.itemId, input.operationId, input.expectedTaskJobId, input.actor.trim(), input.reason.trim(),
        );
        return 'retry_wait' as const;
      });
    },

    persistenceFence: context => (tx, identity, candidateId, verificationRunId) =>
      checkpointVerification(tx, context, identity, candidateId, verificationRunId),
  };
}
