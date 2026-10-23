import { expect, it, jest } from '@jest/globals';
jest.mock('sanitize-html', () => () => {
  throw new Error('Unexpected HTML processing');
});
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../intelligence/entity-resolution.service.js', () => ({
  EntityResolutionService: class {},
}));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('../intelligence/sam-entity.service.js', () => ({
  SamEntityEnrichmentService: class {},
}));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
import { ClientsService } from './clients.service.js';
import { FirmOnboardingService } from '../intelligence/firm-onboarding.service.js';

const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-actor' } as never;
function fixture() {
  let clients: Array<Record<string, any>> = [];
  let slots = 1,
    failMapping = false;
  const statements: string[] = [];
  const tenant = () => ({ billingStatus: 'active', clientSlots: slots, ldaRegistrantId: 7 });
  const tx = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray) => {
      statements.push(parts.join('?'));
      return 1;
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      statements.push(sql);
      return 1;
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      statements.push(sql);
      if (sql.includes('FROM tenants')) return [tenant()];
      if (sql.includes('FROM clients')) return clients.filter((c) => c.id === values[1]);
      throw Error('Unexpected fixture query');
    }),
    tenant: { findUnique: jest.fn(async () => tenant()) },
    client: {
      count: jest.fn(async () => clients.filter((c) => c.status !== 'archived').length),
      findMany: jest.fn(async () => clients),
      findFirst: jest.fn(async ({ where }: any) =>
        clients.find((c) =>
          where.id ? c.id === where.id : c.ldaClientIds?.includes(where.ldaClientIds.has),
        ),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `client-${clients.length}`, status: 'active', intakeData: {}, ...data };
        clients.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = clients.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    clientIntelMapping: {
      create: jest.fn(async () => {
        if (failMapping) throw Error('Synthetic mapping failure');
        return {};
      }),
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => {
      const before = structuredClone(clients);
      try {
        return await run(tx);
      } catch (error) {
        clients = before;
        throw error;
      }
    },
    ldaFiling: { findMany: async () => [{ clientId: 10 }, { clientId: 11 }] },
    ldaClient: {
      findMany: async () => [
        { id: 10, name: 'Ten' },
        { id: 11, name: 'Eleven' },
      ],
    },
  };
  const config = { get: (key: string) => (key === 'BILLING_ENFORCED' ? true : undefined) };
  const entity = { resolveClient: jest.fn(async () => ({})) },
    prepopulation = { prepopulate: jest.fn(async () => ({})) };
  const sam = { enrichGovIds: jest.fn(async () => ({})) },
    kb = { indexClientProfileFireAndForget: jest.fn() };
  return {
    tx,
    statements,
    rows: () => clients,
    slots: (value: number) => {
      slots = value;
    },
    failMapping: () => {
      failMapping = true;
    },
    clients: new ClientsService(
      prisma as never,
      config as never,
      entity as never,
      prepopulation as never,
      sam as never,
      kb as never,
    ),
    firm: new FirmOnboardingService(
      prisma as never,
      prepopulation as never,
      sam as never,
      config as never,
    ),
  };
}
it('canonical create consumes the last slot, and the next create fails before insertion', async () => {
  const h = fixture();
  await h.clients.createInTransaction(ctx, h.tx as never, { name: 'First' });
  await expect(
    h.clients.createInTransaction(ctx, h.tx as never, { name: 'Second' }),
  ).rejects.toMatchObject({ status: 402 });
  expect(h.rows()).toHaveLength(1);
});
it('CSV import rechecks capacity inside each row and preserves per-row outcomes', async () => {
  const h = fixture();
  const result = await h.clients.bulkImport(ctx, [{ name: 'First' }, { name: 'Second' }]);
  expect(result.created).toBe(1);
  expect(result.errors).toEqual([{ row: 1, message: expect.stringContaining('client slots') }]);
  expect(h.tx.client.count).toHaveBeenCalledTimes(2);
});
it('restore needs capacity, duplicate active status consumes none, and archive releases the slot', async () => {
  const h = fixture();
  await h.clients.createInTransaction(ctx, h.tx as never, { name: 'First' });
  h.rows().push({ id: 'archived', name: 'Archived', status: 'archived', intakeData: {} });
  await expect(h.clients.update(ctx, 'archived', { status: 'active' })).rejects.toMatchObject({
    status: 402,
  });
  await h.clients.update(ctx, 'client-0', { status: 'active' });
  await h.clients.archive(ctx, 'client-0');
  await h.clients.update(ctx, 'archived', { status: 'active' });
  expect(h.rows().map((c) => c.status)).toEqual(['archived', 'active']);
});
it('LDA import retains identity-lock-first, fresh per-row cap and mapping rollback', async () => {
  const h = fixture();
  const result = await h.firm.importClients(ctx, [10, 11]);
  expect(result.created).toBe(1);
  expect(result.skipped).toEqual([
    { ldaClientId: 11, reason: expect.stringContaining('CLIENT_SLOT_LIMIT') },
  ]);
  const firstLda = h.statements.findIndex((s) => s.includes('$1'));
  expect(firstLda).toBeGreaterThan(0);
  expect(h.statements[firstLda + 1]).toContain('pg_advisory_xact_lock');
  const failed = fixture();
  failed.failMapping();
  expect((await failed.firm.importClients(ctx, [10])).created).toBe(0);
  expect(failed.rows()).toHaveLength(0);
});
