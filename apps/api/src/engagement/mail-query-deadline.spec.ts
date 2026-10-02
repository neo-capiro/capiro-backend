import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import type { PrismaService } from '../prisma/prisma.service.js';
import { withMailQueryDeadline } from './mail-query-deadline.js';

jest.mock('node:perf_hooks', () => ({ performance: { now: jest.fn() } }));
const now = performance.now as jest.Mock;

function fixture() {
  const tx = { $executeRaw: jest.fn().mockResolvedValue(0), $queryRaw: jest.fn().mockResolvedValue([{ n: 1 }]) };
  const withTenant = jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown, _opts?: { timeoutMs: number }) => fn(tx));
  return { tx, withTenant, prisma: { withTenant } as unknown as PrismaService };
}
beforeEach(() => now.mockReset());

test('all scans share the remaining deadline and the same tenant transaction', async () => {
  const f = fixture(); now.mockReturnValueOnce(100).mockReturnValueOnce(110).mockReturnValueOnce(1200).mockReturnValueOnce(10000);
  const result = await withMailQueryDeadline(f.prisma, 'tenant-owned', async (query) => {
    const count = await query(Prisma.sql`SELECT 1`);
    const page = await query(Prisma.sql`SELECT 2`);
    const coverage = await query(Prisma.sql`SELECT 3`);
    return { count, page, coverage };
  });
  expect(f.withTenant).toHaveBeenCalledTimes(1); expect(f.withTenant.mock.calls[0]![0]).toBe('tenant-owned');
  expect(f.withTenant.mock.calls[0]![2]).toEqual({ timeoutMs: 12_000 });
  expect(f.tx.$executeRaw.mock.calls.map(call => call[1])).toEqual(['9990ms', '8900ms', '100ms']);
  expect(f.tx.$queryRaw).toHaveBeenCalledTimes(3); expect(result.coverage).toEqual([{ n: 1 }]);
});

test('an exhausted shared budget starts no next scan and returns no partial data', async () => {
  const f = fixture(); now.mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(10000);
  const result = withMailQueryDeadline(f.prisma, 'tenant-owned', async query => {
    await query(Prisma.sql`SELECT 1`); return query(Prisma.sql`SELECT 2`);
  });
  await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1); expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
});

test('server cancellation returns a sanitized 503 and no partial or empty result', async () => {
  const f = fixture(); now.mockReturnValue(0);
  f.tx.$queryRaw.mockRejectedValue({ code: 'P2010', meta: { code: '57014', message: 'private SQL or message body' } });
  const error = await withMailQueryDeadline(f.prisma, 'tenant-owned', query => query(Prisma.sql`SELECT 1`)).catch(e => e);
  expect((error as ServiceUnavailableException).getStatus()).toBe(503); expect((error as ServiceUnavailableException).message).toBe('Mail search is temporarily busy. Please retry.');
  expect(JSON.stringify(error)).not.toContain('private SQL');
});

test.each([
  { code: 'P2010', meta: { code: '42P01' } },
  { code: 'P2024' },
  { code: 'P2028' },
  new Error('unrelated failure'),
])('preserves unrelated errors for the existing exception filter: %p', async error => {
  const f = fixture(); now.mockReturnValue(0); f.tx.$queryRaw.mockRejectedValue(error);
  await expect(withMailQueryDeadline(f.prisma, 'tenant-owned', query => query(Prisma.sql`SELECT 1`))).rejects.toBe(error);
});
