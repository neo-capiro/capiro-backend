/**
 * Phase 10B-2D — real thin adapter for `MaterializationArtifactSourcePortV1`.
 *
 * Reads exactly the durable rows the Phase A audit identified as sufficient:
 *   - latest terminal (non-VALIDATING) `budget_extraction_candidate_v1` row
 *     per (cycleId, manifestDocumentKey), joined to its current run's decision
 *     via `current_run_id` -> `budget_verification_run_v1.status`;
 *   - the artifact bytes at `extraction_artifact_locator`, re-verified byte-
 *     for-byte against `extraction_artifact_sha256` before use — storage is
 *     never trusted without a hash check, same stance as every other reader
 *     in this tree (`PrismaProjectionPlanRepositoryV1.loadVerified`, etc.);
 *   - the exact same accepted-assertion filter the original verification
 *     already decided, applied here as a restatement (never a re-run) of
 *     `acceptedArtifact` in `scripts/certify-defense-budget-non-rdte.ts`.
 *
 * A locator may be a bare filesystem path (`FilesystemProofResolver`'s own
 * convention) or an `s3://` URI. This adapter reads either directly via
 * `node:fs` / a supplied S3 byte reader — it does not depend on the
 * verification proof-resolution stack, because that stack is designed to
 * prove NEW verification results, not to reload an artifact whose
 * verification has already completed and been durably recorded.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type {
  MaterializationArtifactSourcePortV1,
  MaterializationCandidateArtifactRefV1,
} from './family-certification-materialization-v1.js';

export interface S3ByteReaderPortV1 {
  readObject(locator: string): Promise<Buffer>;
}

export interface MaterializationArtifactPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

interface CandidateRowV1 {
  manifestDocumentKey: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  extractionArtifactLocator: string | null;
  sourceDocumentId: string;
  sourceSha256: string;
  candidateId: string;
  manifestContentSha256: string;
  currentRunId: string | null;
  runDecision: string | null;
  runStatus: string | null;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Real Prisma-backed implementation. Kept narrow (one raw-SQL query per
 * method, matching this repo's own adapter idiom) so it is independently
 * testable against a table-routed fake without pulling in the full Prisma
 * client type.
 */
export class PrismaMaterializationArtifactSourceV1 implements MaterializationArtifactSourcePortV1 {
  constructor(
    private readonly prisma: MaterializationArtifactPrismaLikeV1,
    private readonly s3Reader?: S3ByteReaderPortV1,
  ) {}

  async loadCandidateRefs(input: {
    cycleId: string;
    manifestDocumentKeys: readonly string[];
  }): Promise<ReadonlyMap<string, MaterializationCandidateArtifactRefV1>> {
    if (input.manifestDocumentKeys.length === 0) return new Map();
    const placeholders = input.manifestDocumentKeys.map((_, index) => `$${index + 2}`).join(', ');
    const rows = await this.prisma.$queryRawUnsafe<CandidateRowV1[]>(
      `SELECT DISTINCT ON (c."manifest_document_key")
              c."manifest_document_key"     AS "manifestDocumentKey",
              c."extraction_artifact_id"    AS "extractionArtifactId",
              c."extraction_artifact_sha256" AS "extractionArtifactSha256",
              c."extraction_artifact_locator" AS "extractionArtifactLocator",
              c."source_document_id"        AS "sourceDocumentId",
              c."source_sha256"             AS "sourceSha256",
              c."id"::text                  AS "candidateId",
              c."manifest_content_sha256"   AS "manifestContentSha256",
              c."current_run_id"::text      AS "currentRunId",
              r."decision"                  AS "runDecision",
              r."status"                    AS "runStatus"
         FROM "budget_extraction_candidate_v1" c
         LEFT JOIN "budget_verification_run_v1" r ON r."id" = c."current_run_id"
        WHERE c."cycle_id" = $1
          AND c."manifest_document_key" IN (${placeholders})
          AND c."status" != 'VALIDATING'
        ORDER BY c."manifest_document_key", c."created_at" DESC`,
      input.cycleId,
      ...input.manifestDocumentKeys,
    );

    const output = new Map<string, MaterializationCandidateArtifactRefV1>();
    for (const row of rows) {
      if (row.currentRunId == null || row.runDecision == null || row.runStatus == null) {
        // A candidate with no resolvable current run has no terminal decision
        // to trust yet; omit it rather than guessing a status.
        continue;
      }
      if (row.extractionArtifactLocator == null) {
        // Pre-Phase-10B-2C row written before this column was backfilled.
        // Refuse to guess a locator rather than treating the document as
        // absent.
        throw new Error(
          `candidate ${row.candidateId} for ${row.manifestDocumentKey} has no ` +
            `extraction_artifact_locator; cannot materialize from this row`,
        );
      }
      output.set(row.manifestDocumentKey, {
        manifestDocumentKey: row.manifestDocumentKey,
        extractionArtifactId: row.extractionArtifactId,
        extractionArtifactSha256: row.extractionArtifactSha256,
        extractionArtifactLocator: row.extractionArtifactLocator,
        sourceDocumentId: row.sourceDocumentId,
        sourceSha256: row.sourceSha256,
        candidateId: row.candidateId,
        verificationRunId: row.currentRunId,
        decision: row.runDecision as 'PASS' | 'REVIEW' | 'REJECT',
        status: row.runStatus as
          | 'VERIFICATION_PASSED'
          | 'REVIEW_ACCEPTED'
          | 'NEEDS_REVIEW'
          | 'REJECTED',
        manifestContentSha256: row.manifestContentSha256,
        acceptedAssertionIds: await this.loadAcceptedAssertionIds(row.currentRunId),
      });
    }
    return output;
  }

  private async loadAcceptedAssertionIds(runId: string): Promise<readonly string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ resultSnapshot: unknown }>>(
      `SELECT "result_snapshot_jsonb" AS "resultSnapshot"
         FROM "budget_verification_run_v1"
        WHERE "id" = $1`,
      runId,
    );
    const snapshot = rows[0]?.resultSnapshot;
    if (snapshot == null || typeof snapshot !== 'object') return [];
    const accepted = (snapshot as Record<string, unknown>).acceptedAssertionIds;
    return Array.isArray(accepted)
      ? accepted.filter((value): value is string => typeof value === 'string')
      : [];
  }

  async loadVerifiedArtifact(
    ref: MaterializationCandidateArtifactRefV1,
  ): Promise<DefenseBudgetExtractionArtifactV1> {
    const bytes = ref.extractionArtifactLocator.startsWith('s3://')
      ? await this.readS3(ref.extractionArtifactLocator)
      : await readFile(ref.extractionArtifactLocator);

    const byteSha256 = sha256Hex(bytes);
    if (byteSha256 !== ref.extractionArtifactSha256) {
      throw new Error(
        `artifact byte SHA mismatch for candidate ${ref.candidateId} (${ref.manifestDocumentKey}): ` +
          `expected ${ref.extractionArtifactSha256}, got ${byteSha256}; refusing to materialize from tampered/stale storage`,
      );
    }

    const parsed = parseDefenseBudgetExtractionArtifactV1(JSON.parse(bytes.toString('utf8')));
    if (parsed.contentSha256 !== ref.extractionArtifactSha256 && parsed.artifactId !== ref.extractionArtifactId) {
      throw new Error(
        `reloaded artifact for candidate ${ref.candidateId} does not match the candidate's recorded artifact identity`,
      );
    }

    // Apply the EXACT same accepted-assertion filter the original
    // verification already decided -- restated, never re-run. REJECT
    // decisions are never reached here (the caller refuses before loading),
    // but the empty-set behavior is preserved defensively.
    if (ref.decision === 'REJECT') {
      return { ...parsed, assertions: [] };
    }
    const accepted = new Set(ref.acceptedAssertionIds);
    return {
      ...parsed,
      assertions: parsed.assertions.filter((assertion) => accepted.has(assertion.assertionId)),
    };
  }

  private async readS3(locator: string): Promise<Buffer> {
    if (this.s3Reader == null) {
      throw new Error(`S3 artifact locator ${locator} requested but no S3 reader was configured`);
    }
    return this.s3Reader.readObject(locator);
  }
}
