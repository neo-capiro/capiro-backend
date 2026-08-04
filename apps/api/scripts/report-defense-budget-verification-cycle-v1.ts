/**
 * Report defense-budget verification cycle status V1.
 *
 * The report is bound to the exact supplied manifest bytes. A candidate from
 * another version of the same cycle can never be selected.
 */
import * as fs from 'node:fs';
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
  type BudgetCycleManifestDocumentV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { sha256Bytes } from '../src/defense-budget/contracts/canonical-json.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;

export interface DocumentStatusEntry {
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
  candidateId: string | null;
  verificationRunId: string | null;
  candidateCount: number;
  selectionWarning?: string;
  manifestContentSha256: string;
  policySha256: string | null;
  verifierVersion: string | null;
  sourceSha256: string | null;
  extractionArtifactSha256: string | null;
  blockingDiscrepancyCount: number;
  unresolvedRequiredComparisons: number;
}

export interface CycleReport {
  cycleId: string;
  fiscalYear: number;
  manifestContentSha256: string;
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
    selectionWarnings: number;
  };
}

interface CandidateLike {
  id: string;
  manifestDocumentKey: string;
  manifestContentSha256: string;
  status: string;
  currentRunId: string | null;
  policySha256: string;
  verifierVersion: string;
  sourceSha256: string;
  extractionArtifactSha256: string;
  updatedAt: Date | string;
}

const COMPARISON_CHECK_CODES = new Set([
  'cross_document_summary_detail',
  'committee_request_reference',
  'historical_consistency',
  'rdte_summary_detail',
  'project_rollup',
  'procurement_rollup',
  'committee_adjustment',
  'page_only_reconciliation',
]);

const STATUS_PRIORITY: Readonly<Record<string, number>> = {
  REVIEW_ACCEPTED: 0,
  VERIFICATION_PASSED: 1,
  NEEDS_REVIEW: 2,
  REJECTED: 3,
  VALIDATING: 4,
  STRUCTURALLY_VALIDATED: 5,
  EXTRACTED: 6,
  SUPERSEDED: 7,
};

const KNOWN_FLAGS = new Set(['--manifest', '--offline']);

function parseArgs(argv: string[]): { manifest: string; offline: boolean } {
  let manifest = '';
  let offline = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }
    if (arg === '--manifest') manifest = argv[++index] ?? '';
    if (arg === '--offline') offline = true;
    index++;
  }
  if (!manifest) {
    console.error(
      'Usage: report-defense-budget-verification-cycle-v1 --manifest <cycle-manifest.json> [--offline]',
    );
    process.exit(EXIT_ERROR);
  }
  return { manifest, offline };
}

function mapCandidateStatus(status: string): DocumentStatusEntry['status'] {
  switch (status) {
    case 'VERIFICATION_PASSED':
      return 'verification_passed';
    case 'NEEDS_REVIEW':
      return 'needs_review';
    case 'REVIEW_ACCEPTED':
      return 'review_accepted';
    case 'REJECTED':
      return 'rejected';
    case 'SUPERSEDED':
      return 'superseded';
    default:
      return 'not_verified';
  }
}

function candidateSort(left: CandidateLike, right: CandidateLike): number {
  const leftPriority = STATUS_PRIORITY[left.status] ?? 99;
  const rightPriority = STATUS_PRIORITY[right.status] ?? 99;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftHasRun = left.currentRunId ? 0 : 1;
  const rightHasRun = right.currentRunId ? 0 : 1;
  if (leftHasRun !== rightHasRun) return leftHasRun - rightHasRun;
  const updatedDifference =
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  if (updatedDifference !== 0) return updatedDifference;
  return left.id.localeCompare(right.id);
}

/** Deterministically select the current exact-manifest candidate. */
export function selectCandidateForDocument(
  candidates: readonly CandidateLike[],
): { candidate: CandidateLike | null; warning?: string } {
  if (candidates.length === 0) return { candidate: null };
  const sorted = [...candidates].sort(candidateSort);
  return {
    candidate: sorted[0]!,
    ...(sorted.length > 1
      ? {
          warning:
            `${sorted.length} candidates exist for the same exact manifest/document; ` +
            `selected ${sorted[0]!.id} deterministically`,
        }
      : {}),
  };
}

export function isUnresolvedComparisonCheck(check: {
  code: string;
  outcome: string;
  required: boolean;
}): boolean {
  return check.required && check.outcome === 'NOT_RUN' && COMPARISON_CHECK_CODES.has(check.code);
}

export async function generateReport(
  manifestPath: string,
  offline: boolean,
): Promise<CycleReport> {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest file not found: ${manifestPath}`);
  }

  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestContentSha256 = sha256Bytes(manifestBytes);
  let manifest: BudgetCycleManifestV1;
  try {
    manifest = parseBudgetCycleManifestV1(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  } catch (cause) {
    throw new Error(`Invalid manifest: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (offline) {
    const documents: DocumentStatusEntry[] = manifest.documents.map(
      (document: BudgetCycleManifestDocumentV1) => ({
        documentKey: document.documentKey,
        required: document.required ?? true,
        status: 'not_verified',
        candidateId: null,
        verificationRunId: null,
        candidateCount: 0,
        manifestContentSha256,
        policySha256: null,
        verifierVersion: null,
        sourceSha256: null,
        extractionArtifactSha256: null,
        blockingDiscrepancyCount: 0,
        unresolvedRequiredComparisons: 0,
      }),
    );
    return buildReport(manifest, manifestContentSha256, documents);
  }

  let prisma: any;
  try {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();
    const documentKeys = manifest.documents.map((document) => document.documentKey);
    const candidates: CandidateLike[] = await prisma.budgetExtractionCandidateV1.findMany({
      where: {
        cycleId: manifest.cycleId ?? '',
        manifestContentSha256,
        manifestDocumentKey: { in: documentKeys },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });

    const candidatesByDocument = new Map<string, CandidateLike[]>();
    for (const candidate of candidates) {
      const group = candidatesByDocument.get(candidate.manifestDocumentKey) ?? [];
      group.push(candidate);
      candidatesByDocument.set(candidate.manifestDocumentKey, group);
    }

    const documents: DocumentStatusEntry[] = [];
    for (const document of manifest.documents) {
      const exactCandidates = candidatesByDocument.get(document.documentKey) ?? [];
      const selection = selectCandidateForDocument(exactCandidates);
      const candidate = selection.candidate;
      if (!candidate) {
        documents.push({
          documentKey: document.documentKey,
          required: document.required ?? true,
          status: 'not_verified',
          candidateId: null,
          verificationRunId: null,
          candidateCount: 0,
          manifestContentSha256,
          policySha256: null,
          verifierVersion: null,
          sourceSha256: null,
          extractionArtifactSha256: null,
          blockingDiscrepancyCount: 0,
          unresolvedRequiredComparisons: 0,
        });
        continue;
      }

      let blockingDiscrepancyCount = 0;
      let unresolvedRequiredComparisons = 0;
      if (candidate.currentRunId) {
        const [discrepancies, checks] = await Promise.all([
          prisma.budgetVerificationDiscrepancyV1.findMany({
            where: { runId: candidate.currentRunId },
          }),
          prisma.budgetVerificationCheckV1.findMany({
            where: { runId: candidate.currentRunId },
          }),
        ]);
        blockingDiscrepancyCount = discrepancies.filter(
          (discrepancy: any) => discrepancy.severity === 'blocking',
        ).length;
        unresolvedRequiredComparisons = checks.filter(isUnresolvedComparisonCheck).length;
      }

      documents.push({
        documentKey: document.documentKey,
        required: document.required ?? true,
        status: mapCandidateStatus(candidate.status),
        candidateId: candidate.id,
        verificationRunId: candidate.currentRunId,
        candidateCount: exactCandidates.length,
        ...(selection.warning ? { selectionWarning: selection.warning } : {}),
        manifestContentSha256,
        policySha256: candidate.policySha256,
        verifierVersion: candidate.verifierVersion,
        sourceSha256: candidate.sourceSha256,
        extractionArtifactSha256: candidate.extractionArtifactSha256,
        blockingDiscrepancyCount,
        unresolvedRequiredComparisons,
      });
    }

    return buildReport(manifest, manifestContentSha256, documents);
  } catch (error) {
    throw new Error(
      `Database query failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Use --offline for a manifest-only report.',
    );
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

function buildReport(
  manifest: BudgetCycleManifestV1,
  manifestContentSha256: string,
  documents: DocumentStatusEntry[],
): CycleReport {
  const requiredDocuments = documents.filter((document) => document.required);
  const optionalDocuments = documents.filter((document) => !document.required);
  const missingRequired = requiredDocuments
    .filter(
      (document) => document.status === 'not_present' || document.status === 'not_verified',
    )
    .map((document) => document.documentKey);

  return {
    cycleId: manifest.cycleId ?? '',
    fiscalYear: manifest.fiscalYear,
    manifestContentSha256,
    generatedAt: new Date().toISOString(),
    totalDocuments: documents.length,
    requiredDocuments: requiredDocuments.length,
    optionalDocuments: optionalDocuments.length,
    documents,
    summary: {
      passed: documents.filter((document) => document.status === 'verification_passed').length,
      needsReview: documents.filter((document) => document.status === 'needs_review').length,
      reviewAccepted: documents.filter((document) => document.status === 'review_accepted').length,
      rejected: documents.filter((document) => document.status === 'rejected').length,
      notVerified: documents.filter((document) => document.status === 'not_verified').length,
      notPresent: documents.filter((document) => document.status === 'not_present').length,
      missingRequired,
      totalBlockingDiscrepancies: documents.reduce(
        (sum, document) => sum + document.blockingDiscrepancyCount,
        0,
      ),
      totalUnresolvedRequiredComparisons: documents.reduce(
        (sum, document) => sum + document.unresolvedRequiredComparisons,
        0,
      ),
      selectionWarnings: documents.filter((document) => document.selectionWarning).length,
    },
  };
}

async function main(): Promise<void> {
  const { manifest, offline } = parseArgs(process.argv.slice(2));
  const report = await generateReport(manifest, offline);
  console.log(JSON.stringify(report, null, 2));
}

const invokedDirectly = process.argv[1]?.includes('report-defense-budget-verification-cycle-v1');
if (invokedDirectly) {
  main()
    .then(() => process.exit(EXIT_OK))
    .catch((error) => {
      console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(EXIT_ERROR);
    });
}
