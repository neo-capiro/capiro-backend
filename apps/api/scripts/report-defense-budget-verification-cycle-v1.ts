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

const KNOWN_FLAGS = new Set(['--manifest', '--offline']);

function parseArgs(argv: string[]): { manifest: string; offline: boolean } {
  let manifest = '';
  let offline = false;
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
    if (arg === '--offline') {
      offline = true;
    }
    i++;
  }
  if (!manifest) {
    console.error(
      'Usage: report-defense-budget-verification-cycle-v1 --manifest <cycle-manifest.json> [--offline]',
    );
    process.exit(EXIT_ERROR);
  }
  return { manifest, offline };
}

/* ------------------------------------------------------------------ */
/* Report generation                                                   */
/* ------------------------------------------------------------------ */

/** Map persisted candidate status to report status. */
function mapCandidateStatus(status: string): DocumentStatusEntry['status'] {
  switch (status) {
    case 'VERIFICATION_PASSED': return 'verification_passed';
    case 'NEEDS_REVIEW': return 'needs_review';
    case 'REVIEW_ACCEPTED': return 'review_accepted';
    case 'REJECTED': return 'rejected';
    case 'SUPERSEDED': return 'superseded';
    default: return 'not_verified';
  }
}

async function generateReport(manifestPath: string, offline: boolean): Promise<CycleReport> {
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

  // In offline mode, all documents are not_verified
  if (offline) {
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
    return buildReport(manifest, documents);
  }

  // Online mode: query real verification audit tables
  let prisma: any;
  try {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();

    // Query candidates by cycleId
    const candidates = await prisma.budgetExtractionCandidateV1.findMany({
      where: { cycleId: manifest.cycleId ?? '' },
    });

    const candidateByDocKey = new Map<string, any>();
    for (const c of candidates) {
      candidateByDocKey.set(c.manifestDocumentKey, c);
    }

    const documents: DocumentStatusEntry[] = [];

    for (const doc of manifest.documents) {
      const candidate = candidateByDocKey.get(doc.documentKey);

      if (!candidate) {
        documents.push({
          documentKey: doc.documentKey,
          required: doc.required ?? true,
          status: 'not_present',
          sourceSha256: null,
          extractionArtifactSha256: null,
          blockingDiscrepancyCount: 0,
          unresolvedRequiredComparisons: 0,
        });
        continue;
      }

      // Count blocking discrepancies for the candidate's current run
      let blockingDiscrepancyCount = 0;
      let unresolvedRequiredComparisons = 0;
      if (candidate.currentRunId) {
        const discrepancies = await prisma.budgetVerificationDiscrepancyV1.findMany({
          where: { runId: candidate.currentRunId },
        });
        blockingDiscrepancyCount = discrepancies.filter(
          (d: any) => d.severity === 'blocking',
        ).length;

        // Count unresolved required comparisons (NOT_RUN checks that are required)
        const checks = await prisma.budgetVerificationCheckV1.findMany({
          where: { runId: candidate.currentRunId },
        });
        unresolvedRequiredComparisons = checks.filter(
          (c: any) => c.outcome === 'NOT_RUN' && c.required,
        ).length;
      }

      documents.push({
        documentKey: doc.documentKey,
        required: doc.required ?? true,
        status: mapCandidateStatus(candidate.status),
        sourceSha256: candidate.sourceSha256,
        extractionArtifactSha256: candidate.extractionArtifactSha256,
        blockingDiscrepancyCount,
        unresolvedRequiredComparisons,
      });
    }

    return buildReport(manifest, documents);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Database query failed: ${message}`);
    console.error('Use --offline for manifest-only report without database access.');
    process.exit(EXIT_ERROR);
    return buildReport(manifest, []);
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
    return buildReport(manifest, []);
  }
}

function buildReport(
  manifest: BudgetCycleManifestV1,
  documents: DocumentStatusEntry[],
): CycleReport {
  const requiredDocs = documents.filter((d) => d.required);
  const optionalDocs = documents.filter((d) => !d.required);
  const missingRequired = requiredDocs
    .filter((d) => d.status === 'not_present' || d.status === 'not_verified')
    .map((d) => d.documentKey);

  return {
    cycleId: manifest.cycleId ?? '',
    fiscalYear: manifest.fiscalYear,
    generatedAt: new Date().toISOString(),
    totalDocuments: documents.length,
    requiredDocuments: requiredDocs.length,
    optionalDocuments: optionalDocs.length,
    documents,
    summary: {
      passed: documents.filter((d) => d.status === 'verification_passed').length,
      needsReview: documents.filter((d) => d.status === 'needs_review').length,
      reviewAccepted: documents.filter((d) => d.status === 'review_accepted').length,
      rejected: documents.filter((d) => d.status === 'rejected').length,
      notVerified: documents.filter((d) => d.status === 'not_verified').length,
      notPresent: documents.filter((d) => d.status === 'not_present').length,
      missingRequired,
      totalBlockingDiscrepancies: documents.reduce((s, d) => s + d.blockingDiscrepancyCount, 0),
      totalUnresolvedRequiredComparisons: documents.reduce(
        (s, d) => s + d.unresolvedRequiredComparisons, 0,
      ),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const { manifest, offline } = parseArgs(process.argv.slice(2));
  const report = await generateReport(manifest, offline);
  console.log(JSON.stringify(report, null, 2));
  process.exit(EXIT_OK);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(EXIT_ERROR);
});
