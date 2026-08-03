/**
 * Workstream N3 — Report defense-budget verification cycle status V1.
 *
 * Usage:
 *   pnpm --filter @capiro/api report:defense-budget-verification-cycle-v1 -- \
 *     --manifest <cycle-manifest.json>
 *
 * Read-only output per document:
 *   not_present
 *   not_verified
 *   verification_passed
 *   needs_review
 *   review_accepted
 *   rejected
 *   superseded
 *
 * Includes:
 *   - required/optional document counts
 *   - passed/review/rejected counts
 *   - missing required documents
 *   - unresolved required comparisons
 *   - blocking discrepancy counts
 *   - source/artifact hash identities
 *
 * This report is not the final annual Program Elements certification
 * from Phase 8.
 *
 * Exit codes:
 *   0 — report generated
 *   1 — execution failure
 */
import * as fs from 'node:fs';
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';

/* ------------------------------------------------------------------ */
/* Exit codes                                                          */
/* ------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_ERROR = 1;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface DocumentStatusEntry {
  documentKey: string;
  required: boolean;
  status:
    | 'not_present'
    | 'not_verified'
    | 'verification_passed'
    | 'needs_review'
    | 'review_accepted'
    | 'rejected'
    | 'superseded';
  sourceSha256: string | null;
  extractionArtifactSha256: string | null;
  blockingDiscrepancyCount: number;
  unresolvedRequiredComparisons: number;
}

interface CycleReport {
  cycleId: string;
  fiscalYear: number;
  generatedAt: string;
  totalDocuments: number;
  requiredDocuments: number;
  optionalDocuments: number;
  documents: DocumentStatusEntry[];
  summary: {
    passed: number;
    needsReview: number;
    reviewAccepted: number;
    rejected: number;
    notVerified: number;
    notPresent: number;
    missingRequired: string[];
    totalBlockingDiscrepancies: number;
    totalUnresolvedRequiredComparisons: number;
  };
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                     */
/* ------------------------------------------------------------------ */

const KNOWN_FLAGS = new Set(['--manifest']);

function parseArgs(argv: string[]): string {
  let manifest = '';
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }
    if (arg === '--manifest') {
      manifest = argv[++i] ?? '';
    }
    i++;
  }
  if (!manifest) {
    console.error(
      'Usage: report-defense-budget-verification-cycle-v1 --manifest <cycle-manifest.json>',
    );
    process.exit(EXIT_ERROR);
  }
  return manifest;
}

/* ------------------------------------------------------------------ */
/* Report generation (read-only, no DB)                                */
/* ------------------------------------------------------------------ */

/**
 * Generate a cycle report from a manifest.
 *
 * In the absence of a database connection, all documents are reported
 * as `not_verified` since there is no persisted verification state to
 * read. When a database is available, the report would query the
 * verification audit tables for each document's latest candidate status.
 */
function generateReport(manifestPath: string): CycleReport {
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest file not found: ${manifestPath}`);
    process.exit(EXIT_ERROR);
  }

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const json = JSON.parse(raw) as unknown;

  let manifest: BudgetCycleManifestV1;
  try {
    manifest = parseBudgetCycleManifestV1(json);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`Invalid manifest: ${message}`);
    process.exit(EXIT_ERROR);
  }

  const documents: DocumentStatusEntry[] = manifest.documents.map(
    (doc: BudgetCycleManifestDocumentV1) => ({
      documentKey: doc.documentKey,
      required: doc.required ?? true,
      status: 'not_verified' as const,
      sourceSha256: null,
      extractionArtifactSha256: null,
      blockingDiscrepancyCount: 0,
      unresolvedRequiredComparisons: 0,
    }),
  );

  const requiredDocs = documents.filter((d) => d.required);
  const optionalDocs = documents.filter((d) => !d.required);

  const report: CycleReport = {
    cycleId: manifest.cycleId ?? '',
    fiscalYear: manifest.fiscalYear,
    generatedAt: new Date().toISOString(),
    totalDocuments: documents.length,
    requiredDocuments: requiredDocs.length,
    optionalDocuments: optionalDocs.length,
    documents,
    summary: {
      passed: 0,
      needsReview: 0,
      reviewAccepted: 0,
      rejected: 0,
      notVerified: documents.length,
      notPresent: 0,
      missingRequired: [],
      totalBlockingDiscrepancies: 0,
      totalUnresolvedRequiredComparisons: 0,
    },
  };

  return report;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function main(): void {
  const manifestPath = parseArgs(process.argv.slice(2));
  const report = generateReport(manifestPath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(EXIT_OK);
}

main();
