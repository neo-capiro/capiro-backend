import { Prisma } from '@prisma/client';
import { ProgramElementReadService } from './program-element-read.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
} as TenantContext;

function harness(pageRows: unknown[], catalogCount: number, countError?: Error) {
  const sql: Prisma.Sql[] = [];
  const query = jest.fn(async (statement: Prisma.Sql) => {
    sql.push(statement);
    if (statement.text.includes('COUNT(*) OVER()')) return pageRows;
    if (countError) throw countError;
    return [{ totalCount: catalogCount }];
  });
  const tenantTx = { $queryRaw: query };
  const withTenant = jest.fn(async (_tenant: string, fn: (tx: typeof tenantTx) => unknown) => fn(tenantTx));
  const service = new ProgramElementReadService({ $queryRaw: query, withTenant } as never, {} as never);
  return { service, sql, query, withTenant };
}

describe('program-element finder empty-page totals', () => {
  test.each([1, 4, 100])('retains known matching catalog count on empty page %s', async page => {
    const { service } = harness([], 3);
    await expect(service.listProgramElements({ page, limit: 1 })).resolves.toEqual({ data: [], total: 3, page, limit: 1 });
  });

  test('a truly empty catalog keeps a zero count', async () => {
    const { service } = harness([], 0);
    await expect(service.listProgramElements({ page: 1, limit: 5 })).resolves.toEqual({ data: [], total: 0, page: 1, limit: 5 });
  });

  test('nonempty page retains its window count without an additional count', async () => {
    const row = {
      peCode: 'SYNTHETIC', title: 'Synthetic aircraft', service: 'Army', budgetActivity: null,
      appropriationType: 'RDT&E', status: 'active', lastSyncedAt: null, hasData: false,
      watched: false, billCount: 0, latestRequest: null, latestRequestFy: null,
      latestEnacted: null, latestEnactedFy: null, requestAtEnactedFy: null,
      latestCurrent: null, latestCurrentFy: null, latestCurrentStage: null,
      peCurrentCycleFy: null, deltaPct: null, spark: null, signalType: null,
      signalScore: null, signalDeltaPct: null, lineType: null, maturity: null,
      appropTier: null, appropScore: null, actionSignalType: null,
      actionSignalTone: null, valleyOfDeath: null, totalCount: 3,
    };
    const { service, query } = harness([row], 999);
    const page = await service.listProgramElements({ page: 2, limit: 1 }, ctx);
    expect(page.total).toBe(3);
    expect(page.data).toEqual([expect.objectContaining({ peCode: 'SYNTHETIC' })]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('empty-page count uses the exact bound eligibility predicate in the same tenant transaction', async () => {
    const { service, sql, withTenant } = harness([], 7);
    const result = await service.listProgramElements({
      page: 9, limit: 2, q: 'aircraft', service: 'Army', budgetActivity: 'BA3',
      fy: 2026, hasData: 'true', watched: 'true', lineType: 'RDTE_PE', capability: 'synthetic-capability',
    }, ctx);
    expect(result.total).toBe(7);
    expect(withTenant).toHaveBeenCalledTimes(1);
    expect(withTenant.mock.calls[0]![0]).toBe(ctx.tenantId);
    expect(sql).toHaveLength(2);
    const bound = (statement: Prisma.Sql) => statement.text.replace(/\$(\d+)/g, (_match, index: string) => JSON.stringify(statement.values[Number(index) - 1]));
    const pageWhere = bound(sql[0]!).split('WHERE pe.retired_at IS NULL')[1]!.split('ORDER BY')[0]!.trim();
    const countWhere = bound(sql[1]!).split('WHERE pe.retired_at IS NULL')[1]!.trim();
    expect(countWhere).toBe(pageWhere);
    expect(countWhere).toContain(ctx.tenantId);
    expect(countWhere).toContain(ctx.userId);
    expect(sql[1]!.text).not.toMatch(/LIMIT|OFFSET|LATERAL/);
  });

  test('a failed fallback count remains a source failure, not fabricated zero', async () => {
    const failure = new Error('synthetic count failure');
    const { service } = harness([], 0, failure);
    await expect(service.listProgramElements({ page: 5, limit: 1 }, ctx)).rejects.toBe(failure);
  });
});
