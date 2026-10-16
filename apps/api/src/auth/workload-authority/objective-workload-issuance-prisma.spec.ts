import type { PrismaService } from '../../prisma/prisma.service.js';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';
import { createPrismaObjectiveIssuancePort } from './objective-workload-issuance-prisma.js';
import type {
  ObjectiveWorkloadIssueDecisionRecord,
  ObjectiveWorkloadIssuanceRecord,
  ObjectiveWorkloadProofUseRecord,
} from './objective-workload-issuance.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const SHA = 'a'.repeat(64);
const issuance: ObjectiveWorkloadIssuanceRecord = {
  operationId: id(2), tenantId: TENANT, clientId: id(3), objectiveId: id(4),
  workAction: 'objective.strategy.draft', controlId: id(5), consentId: id(6),
  generationJobId: id(7), delegationRef: id(8), callerIssuer: 'urn:capiro:worker:test:v1',
  callerSubject: 'capiro-objective-generation-worker:v1', issuanceRequestSha256: SHA,
  authorizationJti: id(9), tokenIssuer: 'urn:capiro:core:test:v1',
  tokenSubject: 'capiro-objective-generation-worker:v1',
  tokenAudience: 'capiro:objective-strategy-api:v1', signerKeyId: 'core-test-1',
  phase: 'admit', targetMethod: 'POST',
  targetPath: '/strategy-api/internal/objective-canonical/generation-admissions',
  targetQuery: '', targetBodySha256: SHA, attemptId: null, runId: null,
  acceptedBindingSha256: null, iatSeconds: 1_800_000_000n,
  nbfSeconds: 1_800_000_000n, expSeconds: 1_800_000_060n,
};
const proofUse: ObjectiveWorkloadProofUseRecord = {
  tenantId: TENANT, callerIssuer: issuance.callerIssuer, callerSubject: issuance.callerSubject,
  callerKeyId: 'worker-test-1', proofJti: id(10), operationId: issuance.operationId,
  operationDecision: 'issued', proofOutcome: 'issued',
  proofRequestSha256: SHA, proofIatSeconds: 1_800_000_000n,
  proofNbfSeconds: 1_800_000_000n, proofExpSeconds: 1_800_000_030n,
};
const decision: ObjectiveWorkloadIssueDecisionRecord = {
  operationId: issuance.operationId, callerIssuer: issuance.callerIssuer,
  callerSubject: issuance.callerSubject, issuanceRequestSha256: SHA,
  decision: 'issued', tenantId: TENANT,
  generationJobId: issuance.generationJobId, phase: 'admit',
};

function fakePrisma() {
  const statements: Array<{ kind: 'query' | 'execute'; sql: string; values: unknown[] }> = [];
  let transactions = 0;
  const native = {
    $queryRaw: async <T>(parts: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const sql = parts.join('?');
      statements.push({ kind: 'query', sql, values });
      return (sql.includes('pg_advisory_xact_lock') ? [{ locked: '' }] : []) as T;
    },
    $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ kind: 'execute', sql: parts.join('?'), values });
      return 1;
    },
  };
  const prisma = {
    withTenant: async <T>(_tenantId: string, run: (tx: typeof native) => Promise<T>) => {
      transactions += 1;
      return run(native);
    },
  } as unknown as PrismaService;
  return { prisma, statements, transactions: () => transactions };
}

describe('unmounted Prisma Objective issuance port', () => {
  test('one tenant transaction orders advisory lock, explicit tenant reads, then immutable inserts', async () => {
    const h = fakePrisma();
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await port.withTenantTransaction(TENANT, async (tx) => {
      await tx.lockOperation(issuance.operationId);
      expect(await tx.findDecision(decision.operationId)).toBeNull();
      await tx.insertDecision(decision);
      expect(await tx.findIssuance(issuance.operationId)).toBeNull();
      await tx.insertIssuance(issuance);
      expect(await tx.findProofUse(proofUse.callerIssuer, proofUse.proofJti)).toBeNull();
      await tx.insertProofUse(proofUse);
    });

    expect(h.transactions()).toBe(1);
    expect(h.statements.map((statement) => statement.kind)).toEqual([
      'query', 'query', 'execute', 'query', 'execute', 'query', 'execute',
    ]);
    expect(h.statements[0]?.sql.trimStart()).toMatch(/^SELECT pg_advisory_xact_lock\(/);
    for (const statement of h.statements.slice(1)) {
      expect(statement.sql).toMatch(/tenant_id|resolved_tenant_id/);
      expect(statement.values).toContain(TENANT);
    }
    expect(h.statements[1]?.sql).toContain('client_objective_workload_issue_decisions');
    expect(h.statements[2]?.sql).toContain('INSERT INTO client_objective_workload_issue_decisions');
    expect(h.statements[5]?.sql).toContain('proof_jti');
    expect(h.statements[6]?.sql).toContain('proof_outcome');
  });

  test('disabled current facts deny before ledger or SQL access', async () => {
    const h = fakePrisma();
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await expect(port.withTenantTransaction(TENANT, (tx) => port.loadCurrent(tx, {
      tenantId: TENANT, delegationRef: issuance.delegationRef,
      consentId: issuance.consentId, generationJobId: issuance.generationJobId,
      phase: 'admit',
    }))).rejects.toBeInstanceOf(ObjectiveCurrentSourceUnavailable);
    expect(h.transactions()).toBe(1);
    expect(h.statements).toHaveLength(0);
  });

  test('current selector cannot escape the tenant of its transaction', async () => {
    const h = fakePrisma();
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: true, policyRevision: SHA });
    await expect(port.withTenantTransaction(TENANT, (tx) => port.loadCurrent(tx, {
      tenantId: id(11), delegationRef: issuance.delegationRef,
      consentId: issuance.consentId, generationJobId: issuance.generationJobId,
      phase: 'admit',
    }))).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.statements).toHaveLength(0);
  });

  test('an insert with another tenant is refused before SQL', async () => {
    const h = fakePrisma();
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await expect(port.withTenantTransaction(TENANT, (tx) =>
      tx.insertIssuance({ ...issuance, tenantId: id(11) }),
    )).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.statements).toHaveLength(0);
  });
});
