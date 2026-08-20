import { persistVerificationAuditDraft } from './budget-verification-repository.js';
import type { BudgetVerificationRepository } from './budget-verification-repository.js';
import { verifyBudgetDocument } from './budget-verification.js';
import type { BudgetDocument } from './budget-verification.js';

const SHA = 'c'.repeat(64);
const evidence = {
  sourceDocumentId: 'doc-1',
  sourceSha256: SHA,
  page: 1,
  granularity: 'page_only' as const,
  extractionMethod: 'llamaparse' as const,
};

function document(): BudgetDocument {
  return {
    sourceDocumentId: 'doc-1',
    sourceSha256: SHA,
    archiveProof: { bucket: 'b', key: 'k', versionId: 'v', sha256: SHA },
    parseProof: {
      id: 'p',
      provider: 'llamaparse',
      status: 'succeeded',
      inputSha256: SHA,
    },
    documentId: 'doc-1',
    fiscalYear: 2027,
    sourceAuthority: 'presidents_budget_request',
    sourceLineKind: 'RDTE_PE',
    evidence,
    extractionDiagnostics: {
      sourceYearValueCount: 1,
      sourceMoneyAssertionCount: 1,
      acceptedMoneyAssertionCount: 1,
      droppedMoneyAssertions: [],
      parserWarnings: [],
    },
    columns: [
      {
        key: 'c1',
        fiscalYear: 2027,
        field: 'request',
        label: 'Request',
        unit: 'thousands',
        evidence,
      },
    ],
    rows: [
      {
        id: 'r1',
        kind: 'line',
        lineKind: 'RDTE_PE',
        code: '0602308A',
        evidence,
        cells: [
          {
            id: 'cell1',
            columnKey: 'c1',
            lineKind: 'RDTE_PE',
            code: '0602308A',
            fiscalYear: 2027,
            field: 'request',
            rawValue: 100,
            unit: 'thousands',
            evidence,
          },
        ],
      },
    ],
  };
}

describe('persistVerificationAuditDraft', () => {
  it('persists candidate, cells, run, checks, and final scaffold status', async () => {
    const calls: string[] = [];
    const statuses: string[] = [];
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
        statuses.push(status);
      },
    };
    const result = verifyBudgetDocument(document());
    await persistVerificationAuditDraft(repository, {
      candidate: {
        id: 'cand-1',
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
        candidateId: 'cand-1',
        status: result.status,
        route: result.route,
        riskScore: result.riskScore,
        startedAt: '2026-08-02T00:00:00.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
      },
    });
    expect(calls[0]).toBe('candidate');
    expect(calls).toContain('cells:1');
    expect(calls).toContain('run');
    expect(calls.some((c) => c.startsWith('checks:'))).toBe(true);
    expect(statuses).toEqual(['STRUCTURALLY_VALIDATED']);
  });

  it('persists zero cells for a rejected result (fail closed)', async () => {
    let cellCount = -1;
    const repository: BudgetVerificationRepository = {
      async createCandidate() {},
      async createCells(records) {
        cellCount = records.length;
      },
      async createRun() {},
      async createChecks() {},
      async updateCandidateStatus() {},
    };
    const rejected = verifyBudgetDocument({ ...document(), rows: [], columns: [] });
    expect(rejected.status).toBe('REJECTED');
    await persistVerificationAuditDraft(repository, {
      candidate: {
        id: 'cand-2',
        sourceDocumentId: 'doc-1',
        sourceSha256: SHA,
        documentId: 'doc-1',
        fiscalYear: 2027,
        sourceAuthority: 'presidents_budget_request',
        sourceLineKind: 'RDTE_PE',
        status: 'EXTRACTED',
      },
      result: rejected,
      run: {
        id: 'run-2',
        candidateId: 'cand-2',
        status: rejected.status,
        route: rejected.route,
        riskScore: rejected.riskScore,
        startedAt: '2026-08-02T00:00:00.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
      },
    });
    expect(cellCount).toBe(0);
  });
});
