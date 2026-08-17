/**
 * Narrow audit-persistence contract for the structural-validation scaffold.
 *
 * No concrete production repository exists in Phase 0. The concrete Prisma adapter
 * class was deliberately removed: it referenced an invalid accessor and was not a
 * real generated-Prisma integration. A transactional production repository is
 * Phase 2 work, gated on approved Prisma models.
 */
import type {
  BudgetVerificationResult,
  NormalizedBudgetRecord,
  VerificationCheck,
} from './budget-verification.js';

export interface BudgetExtractionCandidateRecord {
  id: string;
  sourceDocumentId: string;
  sourceSha256: string;
  documentId: string;
  fiscalYear: number;
  sourceAuthority: string;
  sourceLineKind: string;
  status: string;
}

export interface BudgetExtractionCellRecord extends NormalizedBudgetRecord {
  candidateId: string;
  rowKind: string;
}

export interface BudgetVerificationRunRecord {
  id: string;
  candidateId: string;
  status: string;
  route: string;
  riskScore: number;
  startedAt: string;
  completedAt: string;
}

export interface BudgetVerificationCheckRecord extends VerificationCheck {
  runId: string;
}

/** Narrow persistence contract; implementations may be a test fake or a queue writer. */
export interface BudgetVerificationRepository {
  createCandidate(record: BudgetExtractionCandidateRecord): Promise<void>;
  createCells(records: BudgetExtractionCellRecord[]): Promise<void>;
  createRun(record: BudgetVerificationRunRecord): Promise<void>;
  createChecks(records: BudgetVerificationCheckRecord[]): Promise<void>;
  updateCandidateStatus(candidateId: string, status: string): Promise<void>;
}

/**
 * Persist only draft candidate/extraction/validation audit rows. This deliberately has
 * no canonical PE-year writer dependency and records no approval.
 */
export async function persistVerificationAuditDraft(
  repository: BudgetVerificationRepository,
  input: {
    candidate: BudgetExtractionCandidateRecord;
    result: BudgetVerificationResult;
    run: BudgetVerificationRunRecord;
  },
): Promise<void> {
  await repository.createCandidate(input.candidate);
  await repository.createCells(
    input.result.normalizedRecords.map((record) => ({
      ...record,
      candidateId: input.candidate.id,
      rowKind: 'line',
    })),
  );
  await repository.createRun(input.run);
  await repository.createChecks(
    input.result.checks.map((record) => ({ ...record, runId: input.run.id })),
  );
  await repository.updateCandidateStatus(input.candidate.id, input.result.status);
}
