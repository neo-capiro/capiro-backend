/** @cleanup-smoke noArgsExit=1 */
/**
 * Phase 10B-35 -- record a SCOPED review decision over one verified R-2 PE
 * total (never the whole candidate).
 *
 * Usage:
 *   pnpm --filter @capiro/api review:defense-budget-scoped-fact-v1 -- \
 *     --candidate-id <uuid> --run-id <uuid> \
 *     --pe-code <code> --fiscal-year <year> --component <ARMY|NAVY|...> \
 *     --decision approve|reject \
 *     --reviewer-id <id> \
 *     --rationale-file <path> \
 *     --expected-source-sha256 <sha> \
 *     --expected-artifact-sha256 <sha> \
 *     --expected-manifest-sha256 <sha> \
 *     [--acknowledge-revoked-review-id <exact-review-uuid>] \
 *     [--commit]
 *
 * Behavior:
 *   - Dry-run/inspect by default. Prints the full eligibility evaluation
 *     (candidate-wide gates, scope resolution, independence analysis,
 *     limitations) with ZERO writes.
 *   - --commit persists exactly one budget_scoped_fact_review_v1 row.
 *     Refuses if this candidate already has an active decision for the same
 *     scope (revoke it first via revoke:defense-budget-scoped-fact-v1).
 *     Refuses an APPROVE when ineligible; a REJECT is always recordable.
 *   - Never touches budget_review_decision_v1, the outbox, or any canonical
 *     table. Never changes candidate status.
 *
 * Exit codes: 0 success (dry-run or commit); 1 usage/execution error.
 */
import * as fs from 'node:fs';
import {
  ScopedFactReviewV1Service,
  ScopedFactReviewError,
  TrustedByteLocatorScopedFactReviewArtifactLoaderV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-v1.service.js';
import { SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-policy-v1.js';
import { PrismaScopedFactReviewRepositoryV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaScopedFactReviewCandidateLocatorReaderV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-prisma-locator-reader-v1.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../src/defense-budget/verification/trusted-proof/trusted-byte-locator-reader.js';
import { SdkS3ProofClient } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;

const KNOWN_FLAGS = new Set([
  '--candidate-id',
  '--run-id',
  '--pe-code',
  '--fiscal-year',
  '--component',
  '--decision',
  '--reviewer-id',
  '--rationale-file',
  '--expected-source-sha256',
  '--expected-artifact-sha256',
  '--expected-manifest-sha256',
  '--acknowledge-revoked-review-id',
  '--commit',
]);

interface Args {
  candidateId: string;
  runId: string;
  peCode: string;
  fiscalYear: number;
  component: string;
  decision: 'approve' | 'reject';
  reviewerId: string;
  rationaleFile: string;
  expectedSourceSha256: string;
  expectedArtifactSha256: string;
  expectedManifestSha256: string;
  acknowledgedRevokedReviewId: string | null;
  commit: boolean;
}

function parseArgs(argv: string[]): Args {
  const raw: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error('Usage: review-defense-budget-scoped-fact-v1 --candidate-id <uuid> --run-id <uuid> --pe-code <code> --fiscal-year <year> --component <component> --decision approve|reject --reviewer-id <id> --rationale-file <path> --expected-source-sha256 <sha> --expected-artifact-sha256 <sha> --expected-manifest-sha256 <sha> [--commit]');
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }
    if (arg === '--commit') {
      raw[arg] = true;
    } else {
      raw[arg] = argv[++i] ?? '';
    }
    i++;
  }
  const need = (flag: string): string => {
    const v = raw[flag];
    if (typeof v !== 'string' || v.length === 0) {
      console.error('Usage: review-defense-budget-scoped-fact-v1 --candidate-id <uuid> --run-id <uuid> --pe-code <code> --fiscal-year <year> --component <component> --decision approve|reject --reviewer-id <id> --rationale-file <path> --expected-source-sha256 <sha> --expected-artifact-sha256 <sha> --expected-manifest-sha256 <sha> [--commit]');
      console.error(`Missing ${flag}`);
      process.exit(EXIT_ERROR);
    }
    return v;
  };
  const decision = need('--decision');
  if (decision !== 'approve' && decision !== 'reject') {
    console.error(`--decision must be approve|reject, got: ${decision}`);
    process.exit(EXIT_ERROR);
  }
  const fiscalYear = Number(need('--fiscal-year'));
  if (!Number.isInteger(fiscalYear)) {
    console.error(`--fiscal-year must be an integer`);
    process.exit(EXIT_ERROR);
  }
  return {
    candidateId: need('--candidate-id'),
    runId: need('--run-id'),
    peCode: need('--pe-code'),
    fiscalYear,
    component: need('--component'),
    decision,
    reviewerId: need('--reviewer-id'),
    rationaleFile: need('--rationale-file'),
    expectedSourceSha256: need('--expected-source-sha256'),
    expectedArtifactSha256: need('--expected-artifact-sha256'),
    expectedManifestSha256: need('--expected-manifest-sha256'),
    acknowledgedRevokedReviewId:
      typeof raw['--acknowledge-revoked-review-id'] === 'string'
        ? raw['--acknowledge-revoked-review-id']
        : null,
    commit: raw['--commit'] === true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.rationaleFile)) {
    console.error(`rationale file not found: ${args.rationaleFile}`);
    process.exit(EXIT_ERROR);
  }
  const rationale = fs.readFileSync(args.rationaleFile, 'utf8');

  let prisma: import('@prisma/client').PrismaClient;
  try {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();
  } catch (err) {
    console.error(`Database connection required: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }

  // Real candidates' artifact locators are `s3://...?versionId=...` in every
  // deployed environment; `file://`/bare-path locators appear only in local
  // rehearsals. Same construction as `wireProductionProofBoundary` and
  // `backfill-budget-candidate-source-metadata-v1.ts` -- one owned S3 client,
  // destroyed in `finally`, no silent fallback between schemes or versions.
  const s3ProofClient = new SdkS3ProofClient();
  const byteReader = new CompositeByteLocatorReader(
    new FilesystemByteLocatorReader(),
    new S3ByteLocatorReader(s3ProofClient),
  );

  try {
    const { createPrismaBudgetVerificationRepository } = await import(
      '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js'
    );
    const verification = createPrismaBudgetVerificationRepository(prisma);
    const locators = new PrismaScopedFactReviewCandidateLocatorReaderV1(prisma);
    const artifacts = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(byteReader);
    const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    const service = new ScopedFactReviewV1Service(verification, locators, artifacts, reviews);

    const preview = await service.review(
      {
        candidateId: args.candidateId,
        runId: args.runId,
        scope: {
          scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
          peCode: args.peCode,
          fiscalYear: args.fiscalYear,
          fundingField: 'request',
          component: args.component,
        },
        decision: args.decision,
        reviewerId: args.reviewerId,
        rationale,
        expectedSourceSha256: args.expectedSourceSha256,
        expectedExtractionArtifactSha256: args.expectedArtifactSha256,
        expectedManifestContentSha256: args.expectedManifestSha256,
        acknowledgedRevokedReviewId: args.acknowledgedRevokedReviewId,
      },
      { commit: args.commit },
    );
    console.log(JSON.stringify(preview, null, 2));
    if (!args.commit) console.error('Dry-run complete — no writes performed.');
    else console.error('Scoped review decision committed.');
  } catch (err) {
    if (err instanceof ScopedFactReviewError) {
      console.error(`Scoped review refused: ${err.message} (code: ${err.code})`);
      if (err.eligibility) console.error(JSON.stringify(err.eligibility, null, 2));
      process.exit(EXIT_ERROR);
    }
    console.error(`Scoped review failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  } finally {
    await prisma.$disconnect().catch(() => {});
    await s3ProofClient.destroy().catch(() => {});
  }
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_ERROR);
});
