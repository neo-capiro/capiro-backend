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
 *     [--extractor-actor-id <id>] \
 *     [--extraction-method <method>] \
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
  extractorActorId?: string;
  extractionMethod?: string;
  evidenceIds: string[];
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
  '--extractor-actor-id',
  '--extraction-method',
  '--evidence-id',
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
    evidenceIds: [],
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
      case '--extractor-actor-id':
        args.extractorActorId = argv[++i] ?? '';
        break;
      case '--extraction-method':
        args.extractionMethod = argv[++i] ?? '';
        break;
      case '--commit':
        args.commit = true;
        break;
      case '--evidence-id':
        args.evidenceIds.push(argv[++i] ?? '');
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

  // Always use real Prisma repository — dry-run reads DB, commit reads+persists
  let prisma: any;
  let repository: BudgetVerificationRepositoryV1;

  try {
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaBudgetVerificationRepository } =
      await import('../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js');
    prisma = new PrismaClient();
    repository = createPrismaBudgetVerificationRepository(prisma);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Database connection required: ${message}`);
    process.exit(EXIT_ERROR);
  }

  try {
    // Build the review input
    const reviewInput: ReviewInputV1 = {
      candidateId: args.candidateId,
      verificationRunId: args.runId,
      reviewerId: args.reviewerId,
      decision: args.decision,
      notes,
      evidenceIds: args.evidenceIds,
      expectedSourceSha256: args.expectedSourceSha256,
      expectedExtractionArtifactSha256: args.expectedArtifactSha256,
      expectedManifestContentSha256: args.expectedManifestSha256,
      ...(args.extractorActorId ? { extractorActorId: args.extractorActorId } : {}),
      ...(args.extractionMethod ? { extractionMethod: args.extractionMethod } : {}),
    };

    const service = new BudgetReviewV1Service(repository);

    if (args.commit) {
      // Commit mode: persist the review decision
      const result = await service.review(reviewInput);
      const output = {
        reviewDecisionId: result.reviewDecisionId,
        candidateId: result.candidateId,
        runId: result.runId,
        decision: result.decision,
        finalStatus: result.finalStatus,
        priorStatus: result.priorStatus,
        createdAt: result.createdAt,
        expectedSourceSha256: args.expectedSourceSha256,
        expectedExtractionArtifactSha256: args.expectedArtifactSha256,
        expectedManifestContentSha256: args.expectedManifestSha256,
        limitationFindings: result.limitationFindings,
        committed: true,
      };
      console.log(JSON.stringify(output, null, 2));
      console.error('Review committed successfully.');
    } else {
      // Dry-run mode: read real persisted data, perform eligibility checks, write nothing
      const candidate = await repository.readCandidate(args.candidateId);
      if (!candidate) {
        console.error(`candidate not found: ${args.candidateId}`);
        process.exit(EXIT_ERROR);
      }
      const run = await repository.readRun(args.runId);
      if (!run) {
        console.error(`run not found: ${args.runId}`);
        process.exit(EXIT_ERROR);
      }
      const checks = await repository.readChecks(args.runId);
      const discrepancies = await repository.readDiscrepancies(args.runId);
      const priorDecisions = await repository.readReviewDecisions(args.candidateId);

      const dryRunOutput = {
        mode: 'dry-run',
        candidateId: candidate.id,
        candidateStatus: candidate.status,
        runId: run.id,
        runDecision: run.decision,
        runStatus: run.status,
        checkCount: checks.length,
        blockingFailCount: checks.filter(c => c.outcome === 'FAIL' && c.blocking).length,
        requiredNotRunCount: checks.filter(c => c.outcome === 'NOT_RUN' && c.required).length,
        discrepancyCount: discrepancies.length,
        blockingDiscrepancyCount: discrepancies.filter(d => d.severity === 'blocking').length,
        priorReviewDecisions: priorDecisions.length,
        proposedDecision: args.decision,
        committed: false,
      };
      console.log(JSON.stringify(dryRunOutput, null, 2));
      console.error('Dry-run complete — no writes performed.');
    }
  } catch (err) {
    if (err instanceof ReviewEligibilityError) {
      console.error(`Review rejected: ${err.message} (code: ${err.code})`);
      process.exit(EXIT_ERROR);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Review failed: ${message}`);
    process.exit(EXIT_ERROR);
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }

  process.exit(EXIT_OK);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(EXIT_ERROR);
});
