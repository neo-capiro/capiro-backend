import type { TenantContext } from '@capiro/shared';
import { queryClassicOutreachSql } from './classic-outreach-sql.js';
import { ClassicOutreachObservationIncompleteError } from './classic-outreach-authority.js';
import type { CompiledPublicSql } from '../meri/analytics/sql-query-compiler.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as TenantContext;
const input = { sql: 'SELECT COUNT(*) AS total FROM classic_outreach_records', parameters: [] };
function fixture() {
  const state = { active: true, rows: [{ id: id(10), updatedAt: new Date(1793404800000), clientId: null as string | null, meetingId: null, meeting: null }] };
  const tx = {
    tenantMembership: { findFirst: jest.fn(async () => state.active ? { id: id(3), role: 'standard_user' } : null) },
    outreachRecord: { findMany: jest.fn(async () => structuredClone(state.rows)) },
    client: { findFirst: jest.fn(async () => null) },
  };
  const prisma: any = { withTenant: jest.fn(async (tenant: string, callback: any) => {
    expect(tenant).toBe(ctx.tenantId); return callback(tx);
  }) };
  const execute = jest.fn(async (_compiled: CompiledPublicSql) => [{ total: '1' }]);
  const control = { maxCandidates: 100, assertActive: jest.fn() };
  const run = (query: unknown = input) => queryClassicOutreachSql(prisma, ctx, { kind: 'personal_classic' }, control, query, execute);
  return { state, tx, prisma, execute, control, run };
}
test('real canonical observer wraps fixed-view compilation and buffered execution in separate domain transactions', async () => {
  const f = fixture(); await expect(f.run()).resolves.toEqual([{ total: '1' }]);
  expect(f.prisma.withTenant).toHaveBeenCalledTimes(2);
  expect(f.execute.mock.calls[0]![0].params).toEqual([id(10)]);
  expect(f.execute.mock.calls[0]![0].sql).toContain('WHERE "id" IN');
});
test('a denied linked client is excluded before aggregate execution', async () => {
  const f = fixture(); f.state.rows[0]!.clientId = id(99);
  f.execute.mockImplementation(async query => {
    expect(query.sql).toContain('WHERE FALSE'); return [{ total: '0' }];
  });
  await expect(f.run()).resolves.toEqual([{ total: '0' }]);
});
test('overflow never reaches executor', async () => {
  const f = fixture(); f.state.rows = Array.from({ length: 101 }, (_, n) => ({ ...f.state.rows[0]!, id: id(n + 10) }));
  await expect(f.run()).rejects.toBeInstanceOf(ClassicOutreachObservationIncompleteError);
  expect(f.execute).not.toHaveBeenCalled();
});
test.each(['record', 'membership', 'client'])('post-query %s change withholds the entire buffered result', async change => {
  const f = fixture(); f.execute.mockImplementation(async () => {
    if (change === 'record') f.state.rows[0]!.updatedAt = new Date(1793404800001);
    else if (change === 'membership') f.state.active = false;
    else f.state.rows[0]!.clientId = id(99);
    return [{ total: 'secret-count' }];
  });
  await expect(f.run()).rejects.toThrow(); expect(f.execute).toHaveBeenCalledTimes(1);
});
test('source infrastructure failure propagates without execution or a successful empty result', async () => {
  const f = fixture(); f.tx.outreachRecord.findMany.mockRejectedValue(Error('synthetic unavailable'));
  await expect(f.run()).rejects.toThrow('synthetic unavailable'); expect(f.execute).not.toHaveBeenCalled();
});
test('executor errors propagate and mutable caller input cannot switch the validated query during authorization', async () => {
  const f = fixture(), supplied = { ...input, parameters: [] };
  f.tx.tenantMembership.findFirst.mockImplementation(async () => { supplied.sql = 'DELETE FROM outreach_records'; return { id: id(3), role: 'standard_user' }; });
  f.execute.mockRejectedValue(Error('synthetic query unavailable'));
  await expect(f.run(supplied)).rejects.toThrow('synthetic query unavailable');
  expect(f.execute.mock.calls[0]![0].sql).toContain('COUNT(*)');
});
