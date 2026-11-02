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
import { FirmImportJobStore } from '../intelligence/firm-import-job.store.js';

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_synthetic', role: 'user_admin' } as never;
function fixture() {
  let clients: Array<Record<string, any>> = [];
  const jobs: Array<Record<string, any>> = [];
  const items: Array<Record<string, any>> = [];
  let idSeq = 0;
  let slots = 1,
    failMapping = false;
  const statements: string[] = [];
  const tenant = () => ({ billingStatus: 'active', clientSlots: slots, ldaRegistrantId: 7 });
  const jobWithItems = (job: Record<string, any>) => ({
    ...job,
    items: items.filter((item) => item.jobId === job.id),
  });
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
      if (sql.includes('FOR SHARE OF tm, u')) return [{ role: 'user_admin' }];
      if (sql.includes('FROM client_memory_access')) return [];
      if (sql.includes('FROM tenants')) return [tenant()];
      if (sql.includes('FROM clients')) return clients.filter((c) => c.id === values[1]);
      throw Error('Unexpected fixture query');
    }),
    tenantMembership: { findFirst: jest.fn(async () => ({ role: 'user_admin' })) },
    $queryRawUnsafe: jest.fn(async (sql: string) =>
      sql?.includes('memory_wall') ? [] : [{ allowed: true }],
    ),
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
        const row = { id: `33333333-3333-4333-8333-${String(clients.length).padStart(12, '0')}`, status: 'active', intakeData: {}, ...data };
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
    firmImportJob: {
      findFirst: jest.fn(async ({ where, include }: any) => {
        const job = jobs.find((j) =>
          where.requestKey ? j.requestKey === where.requestKey : j.id === where.id,
        );
        return job ? (include ? jobWithItems(job) : { ...job }) : null;
      }),
      findFirstOrThrow: jest.fn(async ({ where, include }: any) => {
        const job = jobs.find((j) => j.id === where.id);
        if (!job) throw Error('Job not found');
        return include ? jobWithItems(job) : { ...job };
      }),
      create: jest.fn(async ({ data }: any) => {
        const now = new Date();
        const job = {
          id: `77777777-7777-4777-8777-${String(idSeq++).padStart(12, '0')}`,
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        jobs.push(job);
        return { id: job.id };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const job = jobs.find((j) => j.id === where.id)!;
        Object.assign(job, data, { updatedAt: new Date() });
        return job;
      }),
    },
    firmImportJobItem: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) {
          items.push({
            id: `88888888-8888-4888-8888-${String(idSeq++).padStart(12, '0')}`,
            code: null,
            clientId: null,
            processedAt: null,
            ...row,
          });
        }
        return { count: data.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = where.tenantId_jobId_ldaClientId;
        const row = items.find(
          (item) => item.jobId === key.jobId && item.ldaClientId === key.ldaClientId,
        )!;
        Object.assign(row, data);
        return row;
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
      new FirmImportJobStore(prisma as never),
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
  h.rows().push({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Archived',
    status: 'archived',
    intakeData: {},
  });
  await expect(
    h.clients.update(ctx, '44444444-4444-4444-8444-444444444444', { status: 'active' }),
  ).rejects.toMatchObject({
    status: 402,
  });
  await h.clients.update(ctx, '33333333-3333-4333-8333-000000000000', { status: 'active' });
  await h.clients.archive(ctx, '33333333-3333-4333-8333-000000000000');
  await h.clients.update(ctx, '44444444-4444-4444-8444-444444444444', { status: 'active' });
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
