import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { readPortfolioMetrics } from './portfolio-metrics.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';

jest.mock('./client-ordered-owner.access.js', () => ({ requireOwnerActor: jest.fn(async () => undefined) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2) } as TenantContext;
const now = () => new Date('2026-11-03T12:00:00Z');

// Execute the production aggregate SQL in isolated PostgreSQL/WASM. Ordinary
// PostgreSQL/RLS and current membership enforcement retain their separate gates.
describe('portfolio bill coverage follows the selected tracker owner', () => {
  let db: PGlite;
  const prisma = {
    withTenantUser: async (_tenantId: string, _userId: string, work: (tx: object) => Promise<unknown>) => work({
      $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows,
    }),
  };
  const read = (backend: 'core' | 'intelligence') => readPortfolioMetrics(prisma as never, ctx, now, backend);

  beforeEach(async () => {
    jest.mocked(requireOwnerActor).mockReset().mockResolvedValue(undefined as never);
    db = new PGlite();
    await db.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid, status text, profile_type text, memory_wall boolean DEFAULT false);
      CREATE TABLE client_memory_access (tenant_id uuid, client_id uuid, user_id uuid);
      CREATE TABLE client_objectives (tenant_id uuid, client_id uuid, status text, deleted_at timestamptz);
      CREATE TABLE client_activity (tenant_id uuid, client_id uuid, kind text, occurred_at timestamptz, due_at timestamptz, settled_at timestamptz);
      CREATE TABLE tracked_bill (tenant_id uuid, client_id uuid, bill_id text);
      CREATE TABLE intel_tracked_bill (tenant_id text, client_id text, bill_id text);
    `);
    for (const [number, tenant, status, profileType, wall] of [
      [3, ctx.tenantId, 'active', 'CLIENT', false],
      [4, ctx.tenantId, 'active', null, false],
      [5, ctx.tenantId, 'archived', 'CLIENT', false],
      [6, ctx.tenantId, 'active', 'CLIENT', true],
      [7, ctx.tenantId, 'active', ' prospect ', false],
      [8, id(9), 'active', 'CLIENT', false],
    ] as const) {
      await db.query('INSERT INTO clients VALUES ($1,$2,$3,$4,$5)', [id(number), tenant, status, profileType, wall]);
    }
    for (const [table, values] of [
      ['tracked_bill', [[3, 'bill-a'], [3, 'bill-a']]],
      ['intel_tracked_bill', [[3, 'bill-a'], [4, 'bill-a'], [4, 'bill-b'], [5, 'hidden-archived'], [6, 'hidden-wall'], [7, 'hidden-prospect'], [8, 'other-tenant']]],
    ] as const) {
      for (const [number, bill] of values) {
        // Fixed fixture table names; production uses parameterized Prisma SQL.
        await db.query(`INSERT INTO ${table} VALUES ($1,$2,$3)`, [number === 8 ? id(9) : ctx.tenantId, id(number), bill]);
      }
    }
  });
  afterEach(async () => { await db.close(); });

  test('counts only the selected board and the same active visible client denominator', async () => {
    expect(await read('core')).toMatchObject({ trackerBackend: 'core', billWatch: {
      status: 'available', counts: { activeClients: 2, clientsWithWatches: 1, clientBillWatches: 1, distinctBills: 1 },
    } });
    expect(await read('intelligence')).toMatchObject({ trackerBackend: 'intelligence', billWatch: {
      status: 'available', counts: { activeClients: 2, clientsWithWatches: 2, clientBillWatches: 3, distinctBills: 2 },
    } });
  });

  test('current wall grants govern intelligence coverage without exposing hidden or other-tenant boards', async () => {
    await db.query('INSERT INTO client_memory_access VALUES ($1,$2,$3)', [ctx.tenantId, id(6), ctx.userId]);
    expect((await read('intelligence')).billWatch).toMatchObject({
      counts: { activeClients: 3, clientsWithWatches: 3, clientBillWatches: 4, distinctBills: 3 },
    });
    await db.exec('DELETE FROM client_memory_access');
    expect((await read('intelligence')).billWatch).toMatchObject({ counts: { activeClients: 2, clientsWithWatches: 2 } });
  });

  test('a selected-owner failure is unavailable and never substitutes a different board or zero', async () => {
    await db.exec('DROP TABLE intel_tracked_bill');
    expect(await read('intelligence')).toMatchObject({
      trackerBackend: 'intelligence', clients: { status: 'available', counts: { activeClients: 2 } }, billWatch: { status: 'unavailable' },
    });
    expect((await read('core')).billWatch).toMatchObject({ status: 'available', counts: { clientsWithWatches: 1 } });
  });

  test('revoked actor authority blocks release even after all source groups were read', async () => {
    let checks = 0;
    jest.mocked(requireOwnerActor).mockImplementation(async () => {
      if (++checks === 6) throw new Error('client record access denied');
      return undefined as never;
    });
    await expect(read('intelligence')).rejects.toThrow('client record access denied');
  });
});
