import {
  buildVerificationRun,
  verifyBudgetDocument,
  type BudgetDocument,
  type BudgetVerificationResult,
} from './budget-verification.js';
import {
  persistVerificationAuditDraft,
  type BudgetExtractionCandidateRecord,
  type BudgetVerificationRepository,
  type BudgetVerificationRunRecord,
} from './budget-verification-repository.js';

export interface VerificationClock {
  now(): Date;
}

/**
 * Draft-only structural-validation orchestration. The parser/loader supplies a
 * normalized BudgetDocument; this service structurally validates it and persists
 * only draft audit rows. It accepts no approval and authorizes no canonical write.
 */
export async function structurallyValidateAndPersistAuditDraft(
  repository: BudgetVerificationRepository,
  document: BudgetDocument,
  input: {
    candidateId: string;
    runId: string;
    clock?: VerificationClock;
  },
): Promise<BudgetVerificationResult> {
  const clock = input.clock ?? { now: () => new Date() };
  const startedAt = clock.now().toISOString();
  const result = verifyBudgetDocument(document);
  const completedAt = clock.now().toISOString();
  const candidate: BudgetExtractionCandidateRecord = {
    id: input.candidateId,
    sourceDocumentId: document.sourceDocumentId,
    sourceSha256: document.sourceSha256,
    documentId: document.documentId,
    fiscalYear: document.fiscalYear,
    sourceAuthority: document.sourceAuthority,
    sourceLineKind: document.sourceLineKind,
    status: 'EXTRACTED',
  };
  const run: BudgetVerificationRunRecord = {
    id: input.runId,
    ...buildVerificationRun(result, {
      runId: input.runId,
      candidateId: input.candidateId,
      startedAt,
      completedAt,
    }),
  };
  await persistVerificationAuditDraft(repository, { candidate, result, run });
  return result;
}
