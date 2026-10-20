import type { PrismaService } from '../../prisma/prisma.service.js';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';
import { createPrismaObjectiveIssuancePort } from './objective-workload-issuance-prisma.js';
import type {
  ObjectiveWorkloadIssueDecisionRecord,
  ObjectiveWorkloadIssuanceRecord,
  ObjectiveWorkloadProofUseRecord,
  ObjectiveWorkloadDeliveryRecord,
  ObjectiveIssuanceTransaction,
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
  acceptedBindingSha256: null, sourceSha256: null, iatSeconds: 1_800_000_000n,
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
const delivery: ObjectiveWorkloadDeliveryRecord = {
  operationId: issuance.operationId, tenantId: TENANT,
  authorizationJti: issuance.authorizationJti, state: 'claimed', tokenSha256: null,
};

const immutableReads = [
  { table: 'client_objective_workload_issue_decisions', row: decision,
    values: [TENANT, decision.operationId],
    read: (tx: ObjectiveIssuanceTransaction) => tx.findDecision(decision.operationId) },
  { table: 'client_objective_workload_issuances', row: issuance,
    values: [TENANT, issuance.operationId],
    read: (tx: ObjectiveIssuanceTransaction) => tx.findIssuance(issuance.operationId) },
  { table: 'client_objective_workload_proof_uses', row: proofUse,
    values: [TENANT, proofUse.callerIssuer, proofUse.proofJti],
    read: (tx: ObjectiveIssuanceTransaction) => tx.findProofUse(proofUse.callerIssuer, proofUse.proofJti) },
];

function fakePrisma(options: { rows?: Record<string, unknown>; failedTable?: string; fault?: Error } = {}) {
  const statements: Array<{ kind: 'query' | 'execute'; sql: string; values: unknown[] }> = [];
  let transactions = 0;
  const native = {
    $queryRaw: async <T>(parts: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const sql = parts.join('?');
      statements.push({ kind: 'query', sql, values });
      const table = immutableReads.find(read => sql.includes(`FROM ${read.table}`))?.table;
      // Model the migration's SELECT-only immutable ledgers. This is an
      // offline SQL-port regression, not native PostgreSQL privilege proof.
      if (table && /\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)\b/i.test(sql))
        throw new Error(`permission denied for table ${table}`);
      if (table && table === options.failedTable) throw options.fault;
      if (table && options.rows && Object.hasOwn(options.rows, table)) return options.rows[table] as T;
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
  test.each(immutableReads)('$table reads its original row without UPDATE privileges', async ({ table, row, values, read }) => {
    const original = Object.freeze({ ...row });
    const h = fakePrisma({ rows: { [table]: [original] } });
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await port.withTenantTransaction(TENANT, async tx => {
      await tx.lockOperation(issuance.operationId);
      expect(await read(tx)).toBe(original);
    });
    expect(h.transactions()).toBe(1);
    expect(h.statements).toHaveLength(2);
    expect(h.statements[0]!.sql).toContain('pg_advisory_xact_lock');
    expect(h.statements[0]!.values).toEqual([issuance.operationId]);
    const query = h.statements[1]!;
    expect(query.kind).toBe('query');
    expect(query.sql).toContain(`FROM ${table}`);
    expect(query.sql).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE|UPDATE)\b/i);
    expect(query.values).toEqual(values);
    expect(query.sql).toMatch(table.endsWith('issue_decisions') ?
      /WHERE resolved_tenant_id=\?::uuid AND operation_id=\?::uuid/ :
      table.endsWith('proof_uses') ? /WHERE tenant_id=\?::uuid AND caller_issuer=\?\s+AND proof_jti=\?::uuid/ :
        /WHERE tenant_id=\?::uuid AND operation_id=\?::uuid/);
  });

  test.each(immutableReads)('$table absence remains null without any write', async ({ table, read }) => {
    const h = fakePrisma({ rows: { [table]: [] } });
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await port.withTenantTransaction(TENANT, async tx => {
      await tx.lockOperation(issuance.operationId);
      expect(await read(tx)).toBeNull();
    });
    expect(h.statements.every(statement => statement.kind === 'query')).toBe(true);
  });

  test.each(immutableReads)('$table duplicate rows are unavailable rather than absence', async ({ table, row, read }) => {
    const h = fakePrisma({ rows: { [table]: [row, { ...row }] } });
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await expect(port.withTenantTransaction(TENANT, async tx => {
      await tx.lockOperation(issuance.operationId);
      return read(tx);
    })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(h.statements.every(statement => statement.kind === 'query')).toBe(true);
  });

  test.each(immutableReads)('$table SQL faults propagate for transaction rollback', async ({ table, read }) => {
    const fault = new Error('native query failed');
    const h = fakePrisma({ failedTable: table, fault });
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await expect(port.withTenantTransaction(TENANT, async tx => {
      await tx.lockOperation(issuance.operationId);
      return read(tx);
    })).rejects.toBe(fault);
    expect(h.statements.every(statement => statement.kind === 'query')).toBe(true);
  });

  test('one tenant transaction orders advisory lock, explicit tenant reads, then immutable inserts', async () => {
    const h = fakePrisma();
    const port = createPrismaObjectiveIssuancePort(h.prisma, { enabled: false, policyRevision: SHA });
    await port.withTenantTransaction(TENANT, async (tx) => {
      await tx.lockOperation(issuance.operationId);
      expect(await tx.findDecision(decision.operationId)).toBeNull();
      await tx.insertDecision(decision);
      expect(await tx.findIssuance(issuance.operationId)).toBeNull();
      await tx.insertIssuance(issuance);
      expect(await tx.findDelivery(issuance.operationId)).toBeNull();
      await tx.insertDelivery(delivery);
      expect(await tx.findProofUse(proofUse.callerIssuer, proofUse.proofJti)).toBeNull();
      await tx.insertProofUse(proofUse);
      await tx.finalizeDelivery(issuance.operationId, 'issued', SHA);
    });

    expect(h.transactions()).toBe(1);
    expect(h.statements.map((statement) => statement.kind)).toEqual([
      'query', 'query', 'execute', 'query', 'execute', 'query', 'execute',
      'query', 'execute', 'execute',
    ]);
    expect(h.statements[0]?.sql.trimStart()).toMatch(/^SELECT pg_advisory_xact_lock\(/);
    for (const statement of h.statements.slice(1)) {
      expect(statement.sql).toMatch(/tenant_id|resolved_tenant_id/);
      expect(statement.values).toContain(TENANT);
    }
    expect(h.statements[1]?.sql).toContain('client_objective_workload_issue_decisions');
    expect(h.statements[2]?.sql).toContain('INSERT INTO client_objective_workload_issue_decisions');
    expect(h.statements[5]?.sql).toContain('client_objective_workload_deliveries');
    expect(h.statements[5]?.sql).toContain('FOR SHARE');
    expect(h.statements[6]?.sql).toContain('INSERT INTO client_objective_workload_deliveries');
    expect(h.statements[7]?.sql).toContain('proof_jti');
    expect(h.statements[8]?.sql).toContain('proof_outcome');
    expect(h.statements[9]?.sql).toContain('UPDATE client_objective_workload_deliveries');
    expect(h.statements[9]?.sql).toMatch(/WHERE tenant_id=\?::uuid AND operation_id=\?::uuid\s+AND state='claimed'/);
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
