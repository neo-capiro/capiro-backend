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

/** Narrow persistence contract; implementations may be Prisma, a test fake, or a queue writer. */
export interface BudgetVerificationRepository {
  createCandidate(record: BudgetExtractionCandidateRecord): Promise<void>;
  createCells(records: BudgetExtractionCellRecord[]): Promise<void>;
  createRun(record: BudgetVerificationRunRecord): Promise<void>;
  createChecks(records: BudgetVerificationCheckRecord[]): Promise<void>;
  updateCandidateStatus(candidateId: string, status: string): Promise<void>;
}

export interface PrismaLikeVerificationClient {
  budgetExtractionCandidate: {
    create(args: { data: unknown }): Promise<unknown>;
  };
  budgetExtractionCell: {
    createMany(args: { data: unknown[] }): Promise<unknown>;
  };
  budgetVerificationRun: {
    create(args: { data: unknown }): Promise<unknown>;
  };
  budgetVerificationCheck: {
    createMany(args: { data: unknown[] }): Promise<unknown>;
  };
  budgetExtractionCandidateUpdate: {
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

/** Adapter shape for the future Prisma tables named in the PE handoff. */
export class PrismaBudgetVerificationRepository implements BudgetVerificationRepository {
  constructor(private readonly client: PrismaLikeVerificationClient) {}

  createCandidate(record: BudgetExtractionCandidateRecord): Promise<void> {
    return this.client.budgetExtractionCandidate.create({ data: record }).then(() => undefined);
  }

  createCells(records: BudgetExtractionCellRecord[]): Promise<void> {
    return this.client.budgetExtractionCell.createMany({ data: records }).then(() => undefined);
  }

  createRun(record: BudgetVerificationRunRecord): Promise<void> {
    return this.client.budgetVerificationRun.create({ data: record }).then(() => undefined);
  }

  createChecks(records: BudgetVerificationCheckRecord[]): Promise<void> {
    return this.client.budgetVerificationCheck.createMany({ data: records }).then(() => undefined);
  }

  updateCandidateStatus(candidateId: string, status: string): Promise<void> {
    return this.client.budgetExtractionCandidateUpdate
      .update({ where: { id: candidateId }, data: { status } })
      .then(() => undefined);
  }
}

/**
 * Persist only candidate/extraction/verification audit rows. This deliberately has
 * no canonical PE-year writer dependency; canonical promotion remains a separate,
 * exact-SHA-gated operation.
 */
export async function persistVerificationResult(
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
