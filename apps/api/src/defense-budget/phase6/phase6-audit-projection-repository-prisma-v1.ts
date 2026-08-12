/**
 * Phase 6 → canonical promotion, the missing persistence adapter (Gap 1).
 *
 * `Phase6AuditProjectionRepository` has always existed, fully transactional,
 * with nothing wiring it to a database. This is that wiring.
 *
 * It reads/writes `phase6_audit_projection`/`phase6_cycle_certification`
 * through the MAIN application `PrismaClient`'s raw-SQL interactive
 * transaction — the same pattern `PrismaPromotionProjectionSourceV1` already
 * uses to read `om_sag`/`om_sag_year` (tables owned by a *different* Prisma
 * schema project — `prisma/non-rdte-projection/schema.prisma` — but the same
 * physical database, reached over the app's one connection pool). It
 * deliberately does not instantiate a second `PrismaClient` against
 * `.prisma/phase6-projection-client`: nothing else in this codebase runs two
 * live clients against one database, and doing so here would only add a
 * second connection pool for no benefit — the generated client's only real
 * job is `prisma generate`/`validate` type-checking the schema and driving
 * `prisma migrate` for this schema's own migration history.
 */
import type {
  Phase6AuditProjectionStore,
  Phase6AuditProjectionTransactionClient,
} from './phase6-audit-projection-repository.js';
import type { Phase6CycleCertificationV1 } from './phase6-cycle-certification-v1.js';
import type { Phase6NativeProjectionV1 } from './phase6-native-projection-v1.js';

/** The narrowest Prisma surface this adapter needs. */
export interface Phase6ProjectionTxLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface Phase6ProjectionPrismaLikeV1 {
  $transaction<T>(fn: (tx: Phase6ProjectionTxLikeV1) => Promise<T>): Promise<T>;
}

class PrismaPhase6AuditProjectionStoreV1 implements Phase6AuditProjectionStore {
  constructor(private readonly tx: Phase6ProjectionTxLikeV1) {}

  async findByIdempotencyKey(
    key: string,
  ): Promise<{ projectionId: string; naturalKey: string } | null> {
    const rows = await this.tx.$queryRawUnsafe<Array<{ projectionId: string; naturalKey: string }>>(
      `SELECT "projection_id" AS "projectionId", "natural_key" AS "naturalKey"
         FROM "phase6_audit_projection" WHERE "idempotency_key" = $1`,
      key,
    );
    return rows[0] ?? null;
  }

  async findLiveByNaturalKey(
    key: string,
  ): Promise<{ projectionId: string; idempotencyKey: string } | null> {
    // "Live" is the most recently inserted row for the natural key. This
    // repository is audit-only and never supersedes/deletes a row itself, so
    // ordering by insertion time is the same ordering a future supersession
    // pass would need; nothing here promotes on the caller's behalf.
    const rows = await this.tx.$queryRawUnsafe<
      Array<{ projectionId: string; idempotencyKey: string }>
    >(
      `SELECT "projection_id" AS "projectionId", "idempotency_key" AS "idempotencyKey"
         FROM "phase6_audit_projection" WHERE "natural_key" = $1
        ORDER BY "created_at" DESC LIMIT 1`,
      key,
    );
    return rows[0] ?? null;
  }

  async findCertificationByContentSha256(contentSha256: string): Promise<{
    cycleId: string;
    contentSha256: string;
    projectionSetSha256: string | null;
    projectionCount: number | null;
  } | null> {
    const rows = await this.tx.$queryRawUnsafe<
      Array<{
        cycleId: string;
        contentSha256: string;
        projectionSetSha256: string | null;
        projectionCount: number | null;
      }>
    >(
      `SELECT "cycle_id" AS "cycleId",
              "content_sha256" AS "contentSha256",
              "projection_set_sha256" AS "projectionSetSha256",
              "projection_count" AS "projectionCount"
         FROM "phase6_cycle_certification" WHERE "content_sha256" = $1`,
      contentSha256,
    );
    return rows[0] ?? null;
  }

  async findProjectionIdsForCertification(contentSha256: string): Promise<string[]> {
    const rows = await this.tx.$queryRawUnsafe<Array<{ projectionId: string }>>(
      `SELECT "projection_id" AS "projectionId"
         FROM "phase6_cycle_certification_projection"
        WHERE "certification_content_sha256" = $1
        ORDER BY "projection_ordinal", "projection_id"`,
      contentSha256,
    );
    return rows.map((row) => row.projectionId);
  }

  async insertProjection(projection: Phase6NativeProjectionV1): Promise<void> {
    await this.tx.$executeRawUnsafe(
      `INSERT INTO "phase6_audit_projection" (
         "projection_id", "natural_key", "idempotency_key", "projection_kind",
         "verification_candidate_id", "verification_run_id", "artifact_id",
         "artifact_content_sha256", "source_document_id", "source_pdf_sha256",
         "source_profile_hash", "native_identity_hash", "track", "stage",
         "funding_field", "original_value", "original_unit", "amount_millions",
         "direct_or_derived", "evidence_ids_jsonb", "binding_status",
         "projection_status", "enactment_proof_id", "supersedes_projection_id",
         "payload_jsonb"
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18::numeric, $19, $20::jsonb, $21, $22, $23, $24, $25::jsonb
       )`,
      projection.projectionId,
      projection.naturalKey,
      projection.idempotencyKey,
      projection.projectionKind,
      projection.verificationCandidateId,
      projection.verificationRunId,
      projection.artifactId,
      projection.artifactContentSha256,
      projection.sourceDocumentId,
      projection.sourcePdfSha256,
      projection.sourceProfileHash,
      projection.nativeIdentityHash,
      projection.track,
      projection.stage,
      projection.fundingField ?? null,
      projection.money?.originalValue ?? null,
      projection.money?.originalUnit ?? null,
      projection.money?.valueMillions ?? null,
      projection.directOrDerived,
      JSON.stringify(projection.evidenceIds),
      projection.bindingStatus,
      projection.projectionStatus,
      projection.enactmentProofId ?? null,
      projection.supersedesProjectionId ?? null,
      JSON.stringify(projection.payload),
    );
  }

  async insertCertification(certification: Phase6CycleCertificationV1): Promise<void> {
    // The report column stores the full certification, not a summary — the
    // indexed columns exist for lookup; JSON is the actual audit record. The
    // projection set columns are duplicated intentionally so a later plan can
    // prove the row bindings agree with the signed certification without
    // trusting JSON storage alone.
    await this.tx.$executeRawUnsafe(
      `INSERT INTO "phase6_cycle_certification" (
         "cycle_id", "fiscal_year", "manifest_hash", "content_sha256", "status",
         "projection_set_sha256", "projection_count", "report_jsonb"
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      certification.cycleId,
      certification.fiscalYear,
      certification.manifestHash,
      certification.contentSha256,
      certification.status,
      certification.projectionSetSha256,
      certification.projectionCount,
      JSON.stringify(certification),
    );
  }

  async insertCertificationProjectionBinding(
    certificationContentSha256: string,
    projectionId: string,
    ordinal: number,
  ): Promise<void> {
    await this.tx.$executeRawUnsafe(
      `INSERT INTO "phase6_cycle_certification_projection" (
         "certification_content_sha256", "projection_id", "projection_ordinal"
       ) VALUES ($1, $2, $3)`,
      certificationContentSha256,
      projectionId,
      ordinal,
    );
  }
}

export class PrismaPhase6AuditProjectionTransactionClientV1
  implements Phase6AuditProjectionTransactionClient
{
  constructor(private readonly prisma: Phase6ProjectionPrismaLikeV1) {}

  async transaction<T>(fn: (store: Phase6AuditProjectionStore) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(new PrismaPhase6AuditProjectionStoreV1(tx)));
  }
}
