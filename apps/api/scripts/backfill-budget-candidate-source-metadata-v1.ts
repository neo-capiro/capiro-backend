/**
 * backfill-budget-candidate-source-metadata-v1 (Phase 7 Gap 5, decision 1) —
 * the one-time repair for candidates written before `budget_extraction_
 * candidate_v1` had `family` and `extraction_method`.
 *
 * Runs under the serve role. It writes two metadata columns on an audit table
 * and touches nothing canonical: no snapshot, no promotion ledger, no
 * projection. There is no `--promote` mode and no way to reach one from here.
 *
 *   backfill-budget-candidate-source-metadata-v1                # dry run
 *   backfill-budget-candidate-source-metadata-v1 --commit       # writes
 *
 * Dry run by default, matching every other verb added in Phase 7. The dry run
 * performs the *entire* verification chain — reads each artifact, reparses it,
 * recomputes its content SHA, compares it against the candidate's stored SHA,
 * and derives the metadata — and only skips the UPDATE. So a clean dry run is
 * real evidence, not an optimistic plan.
 *
 * Fails closed per candidate, never globally: an unreadable artifact, a hash
 * mismatch, a missing locator, or an artifact that cannot answer the question
 * leaves that row NULL and is reported with a reason. A NULL row is refused by
 * promotion eligibility, so the safe outcome of a partial backfill is "fewer
 * promotable candidates", never "a candidate promoted on guessed metadata".
 *
 * Exit codes: 0 all examined rows resolved (or nothing to do), 3 at least one
 * candidate was refused, 2 usage, 1 error.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  backfillCandidateSourceMetadataV1,
  type BackfillCandidateRowV1,
  type CandidateSourceMetadataBackfillPortsV1,
} from '../src/defense-budget/verification/candidate-source-metadata-backfill-v1.js';
import type { CandidateSourceMetadataV1 } from '../src/defense-budget/verification/candidate-source-metadata-v1.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../src/defense-budget/verification/trusted-proof/trusted-byte-locator-reader.js';
import { SdkS3ProofClient } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  if (flag('promote')) {
    throw new Error(
      'this command has no promote mode; it writes two audit-table metadata columns and nothing else',
    );
  }
  const commit = flag('commit');

  const prisma = new PrismaClient();
  // Both readers are offered because artifact locators are `file://` in
  // rehearsals and `s3://` in deployed environments, and
  // `CompositeByteLocatorReader` refuses an unsupported scheme rather than
  // falling back between them. Same construction as
  // `wireProductionProofBoundary`, including owning the S3 client so it can be
  // destroyed in `finally`.
  const s3ProofClient = new SdkS3ProofClient();
  const reader = new CompositeByteLocatorReader(
    new FilesystemByteLocatorReader(),
    new S3ByteLocatorReader(s3ProofClient),
  );

  try {
    const ports: CandidateSourceMetadataBackfillPortsV1 = {
      async listCandidatesMissingMetadata(): Promise<BackfillCandidateRowV1[]> {
        const rows = await prisma.budgetExtractionCandidateV1.findMany({
          where: { OR: [{ family: null }, { extractionMethod: null }] },
          select: { id: true, extractionArtifactSha256: true, extractionArtifactLocator: true },
          orderBy: { id: 'asc' },
        });
        return rows.map((row) => ({
          id: row.id,
          extractionArtifactSha256: row.extractionArtifactSha256,
          extractionArtifactLocator: row.extractionArtifactLocator,
        }));
      },
      async readArtifactBytes(locator: string): Promise<Buffer> {
        return (await reader.read(locator)).bytes;
      },
      async updateCandidateSourceMetadata(
        candidateId: string,
        metadata: CandidateSourceMetadataV1,
      ): Promise<void> {
        // Scoped to the two metadata columns, and guarded on them still being
        // NULL so a concurrent verification that already self-healed the row
        // wins rather than being overwritten by this slower path.
        await prisma.budgetExtractionCandidateV1.updateMany({
          where: { id: candidateId, OR: [{ family: null }, { extractionMethod: null }] },
          data: { family: metadata.family, extractionMethod: metadata.extractionMethod },
        });
      },
    };

    const report = await backfillCandidateSourceMetadataV1(ports, { commit });
    console.log(
      JSON.stringify(
        {
          mode: commit ? 'committed' : 'dry_run',
          ...(commit ? {} : { reason: 'pass --commit to write the two metadata columns' }),
          examined: report.examined,
          backfilled: report.backfilled,
          refused: report.refused,
          outcomes: report.outcomes,
        },
        null,
        2,
      ),
    );
    return report.refused > 0 ? 3 : 0;
  } finally {
    await s3ProofClient.destroy();
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
