import {
  persistVerificationResult,
  type BudgetVerificationRepository,
} from './budget-verification-repository.js';
import { verifyBudgetDocument } from './budget-verification.js';
import type { BudgetDocument } from './budget-verification.js';

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

describe('persistVerificationResult', () => {
  it('writes only audit records and preserves the exact-SHA status boundary', async () => {
    const calls: string[] = [];
    const repository: BudgetVerificationRepository = {
      async createCandidate() {
        calls.push('candidate');
      },
      async createCells(records) {
        calls.push(`cells:${records.length}`);
      },
      async createRun() {
        calls.push('run');
      },
      async createChecks(records) {
        calls.push(`checks:${records.length}`);
      },
      async updateCandidateStatus(_id, status) {
        calls.push(`status:${status}`);
      },
    };

    const result = verifyBudgetDocument(document);
    await persistVerificationResult(repository, {
      candidate: {
        id: 'candidate-1',
        sourceDocumentId: 'doc-1',
        sourceSha256: SHA,
        documentId: 'doc-1',
        fiscalYear: 2027,
        sourceAuthority: 'presidents_budget_request',
        sourceLineKind: 'RDTE_PE',
        status: 'EXTRACTED',
      },
      result,
      run: {
        id: 'run-1',
        candidateId: 'candidate-1',
        status: result.status,
        route: result.route,
        riskScore: result.riskScore,
        startedAt: '2026-08-02T00:00:00.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
      },
    });

    expect(calls).toEqual([
      'candidate',
      'cells:1',
      'run',
      'checks:14',
      'status:VERIFIED_AUTOMATIC',
    ]);
  });
});
export {};
