/**
 * Workstream N2 — Review defense-budget verification V1.
 *
 * Usage:
 *   pnpm --filter @capiro/api review:defense-budget-verification-v1 -- \
 *     --candidate-id <uuid> \
 *     --run-id <uuid> \
 *     --reviewer-id <id> \
 *     --decision accept|reject \
 *     --notes-file <path> \
 *     --expected-source-sha256 <sha> \
 *     --expected-artifact-sha256 <sha> \
 *     --expected-manifest-sha256 <sha> \
 *     [--commit]
 *
 * Behavior:
 *   - Dry-run/inspect by default.
 *   - --commit writes audit decision only (requires DB).
 *   - No inline notes argument containing sensitive content; use file input.
 *   - Rejects blank notes.
 *   - Prints exact decision and hashes.
 *   - No canonical write.
 *   - Refuses unknown arguments.
 *
 * Exit codes:
 *   0 — review accepted/rejected successfully
 *   1 — execution failure (bad arguments, file not found, eligibility error)
 */
import * as fs from 'node:fs';
import {
  BudgetReviewV1Service,
  ReviewEligibilityError,
} from '../src/defense-budget/verification/services/budget-review-v1.service.js';
import type {
  ReviewInputV1,
  ReviewResultV1,
} from '../src/defense-budget/verification/services/budget-review-v1.service.js';
import type { BudgetVerificationRepositoryV1 } from '../src/defense-budget/verification/persistence/verification-repository.js';

/* ------------------------------------------------------------------ */
/* Exit codes                                                          */
/* ------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_ERROR = 1;

/* ------------------------------------------------------------------ */
/* Dry-run fake repository (inspect mode)                              */
/* ------------------------------------------------------------------ */

/**
 * A read-only fake repository for dry-run/inspect mode.
 * It does NOT persist anything — it only validates eligibility
 * using the provided candidate/run data (which the operator supplies
 * via the CLI arguments). In --commit mode, the real Prisma repository
 * is used instead.
 */
class DryRunReviewRepo implements BudgetVerificationRepositoryV1 {
  constructor(
    private readonly candidateId: string,
    private readonly runId: string,
    private readonly expectedSourceSha256: string,
    private readonly expectedArtifactSha256: string,
    private readonly expectedManifestSha256: string,
  ) {}

  async findTerminalRunByIdentity(): Promise<null> {
    return null;
  }

  async persistCompletedVerification(): Promise<never> {
    throw new Error('persistCompletedVerification not available in dry-run mode');
  }

  async persistReviewDecision(input: {
    candidateId: string;
    verificationRunId: string;
    reviewerId: string;
    decision: 'accept' | 'reject';
    notes: string;
    evidenceIds: string[];
    expectedSourceSha256: string;
    expectedExtractionArtifactSha256: string;
    expectedManifestContentSha256: string;
  }): Promise<{
    id: string;
    candidateId: string;
    runId: string;
    decision: string;
    createdAt: string;
  }> {
    return {
      id: `dryrun_review_${Date.now()}`,
      candidateId: input.candidateId,
      runId: input.verificationRunId,
      decision: input.decision,
      createdAt: new Date().toISOString(),
    };
  }

  async readCandidate(candidateId: string) {
    if (candidateId !== this.candidateId) return null;
    return {
      id: this.candidateId,
      cycleId: 'dry-run',
      manifestContentSha256: this.expectedManifestSha256,
      manifestDocumentKey: 'dry-run',
      extractionArtifactId: 'dry-run',
      extractionArtifactSha256: this.expectedArtifactSha256,
      sourceDocumentId: 'dry-run',
      sourceSha256: this.expectedSourceSha256,
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: 'dry-run',
      status: 'NEEDS_REVIEW' as const,
      currentRunId: this.runId,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  async readRun(runId: string) {
    if (runId !== this.runId) return null;
    return {
      id: this.runId,
      candidateId: this.candidateId,
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: 'dry-run',
      decision: 'REVIEW' as const,
      status: 'NEEDS_REVIEW' as const,
      route: 'human_review' as const,
      riskScore: 50,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      manifestContentSha256: this.expectedManifestSha256,
      extractionArtifactSha256: this.expectedArtifactSha256,
      sourceSha256: this.expectedSourceSha256,
      createdAt: '2026-01-01T00:00:00Z',
    };
  }

  async readChecks(): Promise<[]> {
    return [];
  }

  async readDiscrepancies(): Promise<[]> {
    return [];
  }

  async readProofSnapshots(): Promise<[]> {
    return [];
  }

  async readReviewDecisions(): Promise<[]> {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                     */
/* ------------------------------------------------------------------ */

interface ReviewArgs {
  candidateId: string;
  runId: string;
  reviewerId: string;
  decision: 'accept' | 'reject';
  notesFile: string;
  expectedSourceSha256: string;
  expectedArtifactSha256: string;
  expectedManifestSha256: string;
  commit: boolean;
}

const KNOWN_FLAGS = new Set([
  '--candidate-id',
  '--run-id',
  '--reviewer-id',
  '--decision',
  '--notes-file',
  '--expected-source-sha256',
  '--expected-artifact-sha256',
  '--expected-manifest-sha256',
  '--commit',
]);

function parseArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    candidateId: '',
    runId: '',
    reviewerId: '',
    decision: 'accept',
    notesFile: '',
    expectedSourceSha256: '',
    expectedArtifactSha256: '',
    expectedManifestSha256: '',
    commit: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }

    switch (arg) {
      case '--candidate-id':
        args.candidateId = argv[++i] ?? '';
        break;
      case '--run-id':
        args.runId = argv[++i] ?? '';
        break;
      case '--reviewer-id':
        args.reviewerId = argv[++i] ?? '';
        break;
      case '--decision': {
        const val = argv[++i] ?? '';
        if (val !== 'accept' && val !== 'reject') {
          console.error(`--decision must be accept|reject, got: ${val}`);
          process.exit(EXIT_ERROR);
        }
        args.decision = val;
        break;
      }
      case '--notes-file':
        args.notesFile = argv[++i] ?? '';
        break;
      case '--expected-source-sha256':
        args.expectedSourceSha256 = argv[++i] ?? '';
        break;
      case '--expected-artifact-sha256':
        args.expectedArtifactSha256 = argv[++i] ?? '';
        break;
      case '--expected-manifest-sha256':
        args.expectedManifestSha256 = argv[++i] ?? '';
        break;
      case '--commit':
        args.commit = true;
        break;
    }
    i++;
  }

  // Validate required args
  if (!args.candidateId) {
    console.error('Missing --candidate-id');
    process.exit(EXIT_ERROR);
  }
  if (!args.runId) {
    console.error('Missing --run-id');
    process.exit(EXIT_ERROR);
  }
  if (!args.reviewerId) {
    console.error('Missing --reviewer-id');
    process.exit(EXIT_ERROR);
  }
  if (!args.notesFile) {
    console.error('Missing --notes-file');
    process.exit(EXIT_ERROR);
  }
  if (!args.expectedSourceSha256) {
    console.error('Missing --expected-source-sha256');
    process.exit(EXIT_ERROR);
  }
  if (!args.expectedArtifactSha256) {
    console.error('Missing --expected-artifact-sha256');
    process.exit(EXIT_ERROR);
  }
  if (!args.expectedManifestSha256) {
    console.error('Missing --expected-manifest-sha256');
    process.exit(EXIT_ERROR);
  }

  return args;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Read notes from file (no inline sensitive content in process listings)
  if (!fs.existsSync(args.notesFile)) {
    console.error(`notes file not found: ${args.notesFile}`);
    process.exit(EXIT_ERROR);
  }
  const notes = fs.readFileSync(args.notesFile, 'utf8');

  // Build the review input
  const reviewInput: ReviewInputV1 = {
    candidateId: args.candidateId,
    verificationRunId: args.runId,
    reviewerId: args.reviewerId,
    decision: args.decision,
    notes,
    evidenceIds: [],
    expectedSourceSha256: args.expectedSourceSha256,
    expectedExtractionArtifactSha256: args.expectedArtifactSha256,
    expectedManifestContentSha256: args.expectedManifestSha256,
  };

  // In dry-run mode, use the fake repository
  // In --commit mode, we'd use the real Prisma repository, but that requires
  // a running database. For now, we support dry-run and document that
  // --commit requires a configured database.
  let repository: BudgetVerificationRepositoryV1;

  if (args.commit) {
    // In --commit mode, dynamically import Prisma and create the real repository.
    // This is only available when a database is configured.
    try {
      const { PrismaClient } = await import('@prisma/client');
      const { createPrismaBudgetVerificationRepository } =
        await import('../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js');
      const prisma = new PrismaClient();
      repository = createPrismaBudgetVerificationRepository(prisma);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`--commit requires a configured database: ${message}`);
      process.exit(EXIT_ERROR);
    }
  } else {
    repository = new DryRunReviewRepo(
      args.candidateId,
      args.runId,
      args.expectedSourceSha256,
      args.expectedArtifactSha256,
      args.expectedManifestSha256,
    );
  }

  const service = new BudgetReviewV1Service(repository);

  let result: ReviewResultV1;
  try {
    result = await service.review(reviewInput);
  } catch (err) {
    if (err instanceof ReviewEligibilityError) {
      console.error(`Review rejected: ${err.message} (code: ${err.code})`);
      process.exit(EXIT_ERROR);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Review failed: ${message}`);
    process.exit(EXIT_ERROR);
  }

  // Print exact decision and hashes
  const output = {
    reviewDecisionId: result.reviewDecisionId,
    candidateId: result.candidateId,
    runId: result.runId,
    decision: result.decision,
    finalStatus: result.finalStatus,
    createdAt: result.createdAt,
    expectedSourceSha256: args.expectedSourceSha256,
    expectedExtractionArtifactSha256: args.expectedArtifactSha256,
    expectedManifestContentSha256: args.expectedManifestSha256,
    committed: args.commit,
  };
  console.log(JSON.stringify(output, null, 2));

  process.exit(EXIT_OK);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(EXIT_ERROR);
});
