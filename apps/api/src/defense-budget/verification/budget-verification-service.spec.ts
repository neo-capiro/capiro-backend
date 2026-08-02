import { verifyAndPersistBudgetDocument } from './budget-verification-service.js';
import type { BudgetDocument } from './budget-verification.js';
import type { BudgetVerificationRepository } from './budget-verification-repository.js';

const SHA = 'a'.repeat(64);
const evidence = {
  sourceDocumentId: 'doc-1',
  sourceSha256: SHA,
  page: 1,
  boundingBox: { left: 0, top: 0, right: 10, bottom: 10 },
  extractionMethod: 'llamaparse' as const,
};
const document = {
  sourceDocumentId: 'doc-1',
  sourceSha256: SHA,
  archiveProof: { bucket: 'bucket', key: 'incoming/doc.pdf', versionId: 'v1', sha256: SHA },
  parseProof: {
    id: 'parse-1',
    provider: 'llamaparse' as const,
    status: 'succeeded' as const,
    inputSha256: SHA,
  },
  documentId: 'doc-1',
  fiscalYear: 2027,
  sourceAuthority: 'presidents_budget_request' as const,
  sourceLineKind: 'RDTE_PE' as const,
  evidence,
  columns: [
    {
      key: 'fy27-request',
      fiscalYear: 2027,
      field: 'request' as const,
      label: 'Request',
      unit: 'thousands' as const,
      evidence,
    },
  ],
  rows: [
    {
      id: 'row-1',
      kind: 'line' as const,
      lineKind: 'RDTE_PE' as const,
      code: '0602308A',
      evidence,
      cells: [
        {
          id: 'cell-1',
          columnKey: 'fy27-request',
          lineKind: 'RDTE_PE' as const,
          code: '0602308A',
          fiscalYear: 2027,
          field: 'request' as const,
          rawValue: 1250,
          unit: 'thousands' as const,
          evidence,
        },
      ],
    },
  ],
} satisfies BudgetDocument;

describe('verifyAndPersistBudgetDocument', () => {
  it('keeps parser, verification, and audit persistence separate from canonical writes', async () => {
    const statuses: string[] = [];
    const repository: BudgetVerificationRepository = {
      async createCandidate() {},
      async createCells() {},
      async createRun() {},
      async createChecks() {},
      async updateCandidateStatus(_id, status) {
        statuses.push(status);
      },
    };
    const result = await verifyAndPersistBudgetDocument(repository, document, {
      candidateId: 'candidate-1',
      runId: 'run-1',
      approvedSha256: SHA,
      clock: { now: () => new Date('2026-08-02T00:00:00.000Z') },
    });
    expect(result.promotionReady).toBe(true);
    expect(statuses).toEqual(['VERIFIED_AUTOMATIC']);
  });
});

export {};
