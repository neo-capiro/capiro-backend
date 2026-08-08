/**
 * Phase 7 Gap 5, decision 1 — the one-time backfill for candidates written
 * before `family` and `extraction_method` existed.
 *
 * Deliberately pure over three narrow ports so the whole decision table is
 * unit-testable without a database or a filesystem. The CLI
 * (`scripts/backfill-budget-candidate-source-metadata-v1.ts`) supplies Prisma
 * and a `CompositeByteLocatorReader`.
 *
 * The verification chain, which is the whole point of this module — a backfill
 * that trusted the locator would be inventing metadata just as surely as a
 * default would:
 *
 *   locator bytes
 *     -> parsed through the strict artifact schema
 *     -> computeArtifactContentSha256(parsed)
 *     -> must equal the candidate row's stored extraction_artifact_sha256
 *
 * Note that `extraction_artifact_sha256` holds the artifact's *content* SHA
 * (`resolution.extractionArtifactContentSha256` in
 * `budget-verification-v1.service.ts`), not the SHA of the bytes on disk.
 * Comparing `sha256Bytes(bytes)` against it — the obvious-looking check —
 * would fail for every legitimate artifact, because the content SHA is a
 * canonical-JSON hash computed with `artifactId` and `contentSha256` removed.
 * The artifact's own self-declared `contentSha256` is checked too, matching
 * what `CompositeProofResolver` does, so a doctored artifact that recomputes
 * consistently but disagrees with its own header is still refused.
 *
 * Every refusal is per-candidate and non-fatal: one unreadable artifact does
 * not stop the run, it is reported and its row is left NULL. Nothing is ever
 * written except the two metadata columns.
 */
import {
  computeArtifactContentSha256,
  parseDefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.semantic.js';
import {
  deriveCandidateSourceMetadataV1,
  type CandidateSourceMetadataV1,
} from './candidate-source-metadata-v1.js';

export interface BackfillCandidateRowV1 {
  id: string;
  extractionArtifactSha256: string;
  extractionArtifactLocator: string | null;
}

export const BACKFILL_REFUSAL_REASON_V1_VALUES = [
  'no_locator',
  'artifact_unreadable',
  'artifact_unparseable',
  'artifact_content_sha_self_inconsistent',
  'artifact_content_sha_mismatch',
  'metadata_unresolved',
] as const;
export type BackfillRefusalReasonV1 = (typeof BACKFILL_REFUSAL_REASON_V1_VALUES)[number];

export type BackfillOutcomeV1 =
  | ({ candidateId: string; outcome: 'backfilled' | 'would_backfill' } & CandidateSourceMetadataV1)
  | {
      candidateId: string;
      outcome: 'refused';
      reason: BackfillRefusalReasonV1;
      detail: string;
    };

export interface CandidateSourceMetadataBackfillPortsV1 {
  /** Candidates with either column still NULL. Ordered deterministically. */
  listCandidatesMissingMetadata(): Promise<BackfillCandidateRowV1[]>;
  readArtifactBytes(locator: string): Promise<Buffer>;
  /** Writes ONLY the two metadata columns. */
  updateCandidateSourceMetadata(
    candidateId: string,
    metadata: CandidateSourceMetadataV1,
  ): Promise<void>;
}

export interface BackfillReportV1 {
  examined: number;
  backfilled: number;
  refused: number;
  commit: boolean;
  outcomes: BackfillOutcomeV1[];
}

export async function backfillCandidateSourceMetadataV1(
  ports: CandidateSourceMetadataBackfillPortsV1,
  options: { commit: boolean },
): Promise<BackfillReportV1> {
  const rows = await ports.listCandidatesMissingMetadata();
  const outcomes: BackfillOutcomeV1[] = [];

  for (const row of rows) {
    outcomes.push(await backfillOneV1(ports, row, options.commit));
  }

  return {
    examined: rows.length,
    backfilled: outcomes.filter((o) => o.outcome === 'backfilled').length,
    refused: outcomes.filter((o) => o.outcome === 'refused').length,
    commit: options.commit,
    outcomes,
  };
}

async function backfillOneV1(
  ports: CandidateSourceMetadataBackfillPortsV1,
  row: BackfillCandidateRowV1,
  commit: boolean,
): Promise<BackfillOutcomeV1> {
  const refuse = (reason: BackfillRefusalReasonV1, detail: string): BackfillOutcomeV1 => ({
    candidateId: row.id,
    outcome: 'refused',
    reason,
    detail,
  });

  // `extraction_artifact_locator` is nullable, and a candidate written without
  // one cannot be verified at all — there is no second place to look.
  if (row.extractionArtifactLocator == null || row.extractionArtifactLocator.trim() === '') {
    return refuse('no_locator', 'candidate row carries no extraction artifact locator');
  }

  let bytes: Buffer;
  try {
    bytes = await ports.readArtifactBytes(row.extractionArtifactLocator);
  } catch (err) {
    return refuse(
      'artifact_unreadable',
      `failed to read ${row.extractionArtifactLocator}: ${(err as Error).message}`,
    );
  }

  let artifact;
  try {
    artifact = parseDefenseBudgetExtractionArtifactV1(JSON.parse(bytes.toString('utf8')));
  } catch (err) {
    return refuse(
      'artifact_unparseable',
      `bytes at ${row.extractionArtifactLocator} are not a valid extraction artifact: ${
        (err as Error).message
      }`,
    );
  }

  const recomputed = computeArtifactContentSha256(artifact);
  if (artifact.contentSha256 !== recomputed) {
    return refuse(
      'artifact_content_sha_self_inconsistent',
      `artifact declares contentSha256 ${artifact.contentSha256} but recomputes to ${recomputed}`,
    );
  }
  if (recomputed !== row.extractionArtifactSha256) {
    return refuse(
      'artifact_content_sha_mismatch',
      `artifact at ${row.extractionArtifactLocator} recomputes to ${recomputed}, but the candidate ` +
        `is filed against ${row.extractionArtifactSha256}; this is not the artifact that was verified`,
    );
  }

  let metadata: CandidateSourceMetadataV1;
  try {
    metadata = deriveCandidateSourceMetadataV1(artifact);
  } catch (err) {
    return refuse('metadata_unresolved', (err as Error).message);
  }

  if (!commit) {
    return { candidateId: row.id, outcome: 'would_backfill', ...metadata };
  }
  await ports.updateCandidateSourceMetadata(row.id, metadata);
  return { candidateId: row.id, outcome: 'backfilled', ...metadata };
}
