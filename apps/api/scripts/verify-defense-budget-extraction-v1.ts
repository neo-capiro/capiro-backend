/**
 * Workstream N1 — Verify defense-budget extraction artifact V1.
 *
 * Usage:
 *   pnpm --filter @capiro/api verify:defense-budget-artifact-v1 -- \
 *     --manifest <cycle-manifest.json> \
 *     --document <document-key> \
 *     --artifact <artifact.extraction-v1.json> \
 *     --source-document-id <uuid> \
 *     [--reference-artifact <path>]... \
 *     [--expected-source-sha256 <sha>] \
 *     [--expected-artifact-sha256 <sha>] \
 *     [--persist-audit]
 *
 * Behavior:
 *   - Default is inspect/read-only.
 *   - Resolves proof from actual bytes (filesystem resolver).
 *   - Prints deterministic JSON result.
 *   - Exit 0 for VERIFICATION_PASSED.
 *   - Exit 2 for NEEDS_REVIEW.
 *   - Exit 3 for REJECTED.
 *   - Exit 4 for execution/configuration failure (bad arguments, file not found, etc.).
 *   - --persist-audit writes only verification audit tables (requires DB).
 *   - No canonical writes.
 *   - Refuses unknown arguments.
 */
import * as fs from 'node:fs';
import { FilesystemProofResolver } from '../src/defense-budget/verification/trusted-proof/filesystem-proof-resolver.js';
import { BudgetVerificationV1Service } from '../src/defense-budget/verification/services/budget-verification-v1.service.js';
import type { BudgetVerificationRepositoryV1 } from '../src/defense-budget/verification/persistence/verification-repository.js';
import { verificationRequestV1Schema } from '../src/defense-budget/verification/verification-contract-v1.js';
import type { DefenseBudgetVerificationResultV1 } from '../src/defense-budget/verification/verification-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Exit codes                                                          */
/* ------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_NEEDS_REVIEW = 2;
const EXIT_REJECTED = 3;
const EXIT_ERROR = 4;

/* ------------------------------------------------------------------ */
/* Argument parsing (refuses unknown arguments)                        */
/* ------------------------------------------------------------------ */

interface VerifyArgs {
  manifest: string;
  document: string;
  artifact: string;
  sourceDocumentId: string;
  referenceArtifacts: string[];
  expectedSourceSha256?: string;
  expectedExtractionArtifactSha256?: string;
  persistAudit: boolean;
}

const KNOWN_FLAGS = new Set([
  '--manifest',
  '--document',
  '--artifact',
  '--source-document-id',
  '--reference-artifact',
  '--expected-source-sha256',
  '--expected-artifact-sha256',
  '--persist-audit',
]);

function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = {
    manifest: '',
    document: '',
    artifact: '',
    sourceDocumentId: '',
    referenceArtifacts: [],
    persistAudit: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (!KNOWN_FLAGS.has(arg) && !arg.startsWith('--')) {
      console.error(`Unknown argument: ${arg}`);
      process.exit(EXIT_ERROR);
    }
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }

    switch (arg) {
      case '--manifest':
        args.manifest = argv[++i] ?? '';
        break;
      case '--document':
        args.document = argv[++i] ?? '';
        break;
      case '--artifact':
        args.artifact = argv[++i] ?? '';
        break;
      case '--source-document-id':
        args.sourceDocumentId = argv[++i] ?? '';
        break;
      case '--reference-artifact':
        args.referenceArtifacts.push(argv[++i] ?? '');
        break;
      case '--expected-source-sha256':
        args.expectedSourceSha256 = argv[++i];
        break;
      case '--expected-artifact-sha256':
        args.expectedExtractionArtifactSha256 = argv[++i];
        break;
      case '--persist-audit':
        args.persistAudit = true;
        break;
    }
    i++;
  }

  // Validate required args
  if (!args.manifest) {
    console.error('Missing --manifest');
    process.exit(EXIT_ERROR);
  }
  if (!args.document) {
    console.error('Missing --document');
    process.exit(EXIT_ERROR);
  }
  if (!args.artifact) {
    console.error('Missing --artifact');
    process.exit(EXIT_ERROR);
  }
  if (!args.sourceDocumentId) {
    console.error('Missing --source-document-id');
    process.exit(EXIT_ERROR);
  }

  return args;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Verify files exist
  for (const [label, path] of [
    ['manifest', args.manifest],
    ['artifact', args.artifact],
  ] as const) {
    if (!fs.existsSync(path)) {
      console.error(`${label} file not found: ${path}`);
      process.exit(EXIT_ERROR);
    }
  }
  for (const ref of args.referenceArtifacts) {
    if (!fs.existsSync(ref)) {
      console.error(`reference artifact file not found: ${ref}`);
      process.exit(EXIT_ERROR);
    }
  }

  // Build the verification request
  const requestInput: Record<string, unknown> = {
    manifestLocator: args.manifest,
    manifestDocumentKey: args.document,
    extractionArtifactLocator: args.artifact,
    sourceDocumentId: args.sourceDocumentId,
    mode: args.persistAudit ? 'persist_audit' : 'inspect',
  };
  if (args.expectedSourceSha256) {
    requestInput.expectedSourcePdfSha256 = args.expectedSourceSha256;
  }
  if (args.expectedExtractionArtifactSha256) {
    requestInput.expectedExtractionArtifactSha256 = args.expectedExtractionArtifactSha256;
  }
  if (args.referenceArtifacts.length > 0) {
    requestInput.referenceArtifactLocators = args.referenceArtifacts;
  }

  // Validate with Zod
  const parsed = verificationRequestV1Schema.safeParse(requestInput);
  if (!parsed.success) {
    console.error('Invalid request:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(EXIT_ERROR);
  }

  // Create the proof resolver and repository based on mode
  let repository: BudgetVerificationRepositoryV1 | null = null;

  if (args.persistAudit) {
    // Persist mode: create real Prisma repository
    try {
      const { PrismaClient } = await import('@prisma/client');
      const { createPrismaBudgetVerificationRepository } =
        await import('../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js');
      const prisma = new PrismaClient();
      repository = createPrismaBudgetVerificationRepository(prisma);
      console.error('--persist-audit enabled: verification result will be persisted to the database');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`--persist-audit requires a configured database: ${message}`);
      process.exit(EXIT_ERROR);
    }
  } else {
    // Inspect mode: filesystem resolver, no repository
    repository = null;
  }

  // Create filesystem proof resolver for local-only operation
  const proofResolver = new FilesystemProofResolver();

  const service = new BudgetVerificationV1Service(proofResolver, repository);

  let result: DefenseBudgetVerificationResultV1;
  try {
    result = await service.verify(parsed.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Verification failed: ${message}`);
    process.exit(EXIT_ERROR);
  }

  // Print deterministic JSON result
  console.log(JSON.stringify(result, null, 2));

  // Exit codes
  if (result.decision === 'PASS') {
    process.exit(EXIT_OK);
  } else if (result.decision === 'REVIEW') {
    process.exit(EXIT_NEEDS_REVIEW);
  } else {
    process.exit(EXIT_REJECTED);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(EXIT_ERROR);
});
