// A datasource URL must be present for `new PrismaClient()` construction; the
// tests below mock `$transaction`, so no real connection is ever opened.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://u:p@127.0.0.1:5432/db?schema=public&sslmode=disable';

import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 1 (plan §4 S3 / S10): the RLS session helpers ported from apps/api.
 * They ship inert in Phase 1 (no read path calls them) but must issue the exact
 * GUC statements the apps/api RLS policies read: `app.current_tenant` for
 * tenant-scoped work and `app.bypass_rls` for cross-tenant/system work.
 */
describe('PrismaService RLS helpers (Phase 1 port)', () => {
  function fakeTx() {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve(1);
      },
    };
    return { tx, calls };
  }

  it('withTenant sets app.current_tenant to the given id inside the transaction', async () => {
    const svc = new PrismaService();
    const { tx, calls } = fakeTx();
    jest.spyOn(svc as unknown as { $transaction: unknown }, '$transaction').mockImplementation(
      ((fn: (t: unknown) => unknown) => fn(tx)) as never,
    );

    const result = await svc.withTenant('tenant-abc', async () => 'RESULT');

    expect(result).toBe('RESULT');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("set_config('app.current_tenant'");
    expect(calls[0].values).toContain('tenant-abc');
  });

  it('withSystem sets the app.bypass_rls flag inside the transaction', async () => {
    const svc = new PrismaService();
    const { tx, calls } = fakeTx();
    jest.spyOn(svc as unknown as { $transaction: unknown }, '$transaction').mockImplementation(
      ((fn: (t: unknown) => unknown) => fn(tx)) as never,
    );

    const result = await svc.withSystem(async () => 42);

    expect(result).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("set_config('app.bypass_rls'");
    expect(calls[0].sql).toContain("'on'");
  });
});
