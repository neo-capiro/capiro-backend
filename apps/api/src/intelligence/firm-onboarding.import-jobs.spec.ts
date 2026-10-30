import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientPrepopulationService } from './client-prepopulation.service.js';
import type { SamEntityEnrichmentService } from './sam-entity.service.js';
import { FirmImportJobStore } from './firm-import-job.store.js';
import { FirmOnboardingService } from './firm-onboarding.service.js';

/**
 * Repository-style coverage of the durable job view over the EXISTING firm LDA
 * importer. The harness is an in-memory transactional double: it is NOT a SQL
 * engine and makes no claim about Postgres/RLS or migration correctness (those
 * remain the database owner's qualification). It does pin the behaviours the
 * importer must guarantee: request reconciliation/conflict, item identity
 * before work, same-transaction item+Client effect, truthful partial/crash
 * state, tenant scoping, exact cursors and full-population counts.
 */

interface TenantRow {
  id: string;
  billingStatus: string;
  clientSlots: number;
  ldaRegistrantId: number | null;
  ldaRegistrantName: string | null;
}
interface FilingRow {
  registrantId: number;
  clientId: number | null;
}
interface LdaClientRow {
  id: number;
  name: string;
  state: string | null;
  generalDescription: string | null;
  issueCodes: string[] | null;
}
interface ClientRow {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  issueCodes: string[];
  ldaClientIds: number[];
  intakeData: object;
  createdByUserId: string | null;
  status: string;
  memoryWall: boolean;
  memoryGrants: string[];
}
interface MappingRow {
  tenantId: string;
  clientId: string;
  source: string;
  externalId: string;
  externalName: string;
  confidence: number;
  confirmed: boolean;
}
interface JobRow {
  id: string;
  tenantId: string;
  requestedByUserId: string;
  requestKey: string;
  requestSha256: string;
  ldaRegistrantId: number;
  requestedIds: number[];
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface ItemRow {
  id: string;
  tenantId: string;
  jobId: string;
  ldaClientId: number;
  outcome: string;
  code: string | null;
  clientId: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type Where = Record<string, unknown>;

const tenantIdA = randomUUID();
const tenantIdB = randomUUID();
const ctxA = {
  tenantId: tenantIdA,
  tenantSlug: 'firm-a',
  userId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'clerk-a',
  role: 'user_admin',
} as TenantContext;
const ctxB = {
  tenantId: tenantIdB,
  tenantSlug: 'firm-b',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'clerk-b',
  role: 'user_admin',
} as TenantContext;

function matches(where: Where | undefined, row: Record<string, unknown>): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR' && Array.isArray(value)) {
      if (!value.some((branch) => matches(branch as Where, row))) return false;
      continue;
    }
    const rowValue = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const condition = value as { in?: unknown[]; has?: unknown; lt?: unknown };
      if (condition.in) {
        if (!condition.in.includes(rowValue)) return false;
        continue;
      }
      if ('has' in condition) {
        if (!Array.isArray(rowValue) || !rowValue.includes(condition.has)) return false;
        continue;
      }
      if ('lt' in condition) {
        const left = rowValue;
        const right = condition.lt;
        if (left instanceof Date && right instanceof Date) {
          if (!(left.getTime() < right.getTime())) return false;
        } else if (!(String(left) < String(right))) {
          return false;
        }
        continue;
      }
      continue;
    }
    if (rowValue !== value) return false;
  }
  return true;
}

const withItems = (job: JobRow, items: ItemRow[]) => ({
  ...job,
  items: items.filter((item) => item.jobId === job.id).map((item) => ({ ...item })),
});

const makeHarness = () => {
  const rows = {
    tenants: [
      {
        id: tenantIdA,
        billingStatus: 'active',
        clientSlots: 50,
        ldaRegistrantId: 7001,
        ldaRegistrantName: 'Firm A',
      },
      {
        id: tenantIdB,
        billingStatus: 'active',
        clientSlots: 50,
        ldaRegistrantId: 7002,
        ldaRegistrantName: 'Firm B',
      },
    ] as TenantRow[],
    filings: [
      { registrantId: 7001, clientId: 10 },
      { registrantId: 7001, clientId: 11 },
      { registrantId: 7001, clientId: 12 },
      { registrantId: 7001, clientId: 30 },
      { registrantId: 7001, clientId: 31 },
      { registrantId: 7001, clientId: 42 },
    ] as FilingRow[],
    ldaClients: [
      { id: 10, name: 'Ten Alpha', state: 'VA', generalDescription: null, issueCodes: ['TAX'] },
      { id: 11, name: 'Ten Beta', state: 'DC', generalDescription: null, issueCodes: [] },
      { id: 12, name: 'Ten Gamma', state: null, generalDescription: null, issueCodes: null },
      { id: 30, name: 'Thirty', state: null, generalDescription: null, issueCodes: [] },
      { id: 31, name: 'Thirty One', state: null, generalDescription: null, issueCodes: [] },
      { id: 42, name: 'Forty Two', state: null, generalDescription: null, issueCodes: [] },
    ] as LdaClientRow[],
    clients: [] as ClientRow[],
    mappings: [] as MappingRow[],
    jobs: [] as JobRow[],
    items: [] as ItemRow[],
    memberships: [
      { tenantId: tenantIdA, userId: ctxA.userId, role: 'user_admin', status: 'active' },
      { tenantId: tenantIdB, userId: ctxB.userId, role: 'user_admin', status: 'active' },
    ] as Array<{ tenantId: string; userId: string; role: string; status: string }>,
  };

  /** userId -> clerkUserId, for the current-actor membership check. */
  const users = new Map([
    [ctxA.userId, ctxA.clerkUserId],
    [ctxB.userId, ctxB.clerkUserId],
  ]);

  const state = {
    failCreatedItemUpdateOnce: false,
    /** Set to a requestKey to make the next create abort with a committed winner. */
    raceKey: null as string | null,
    raceWinnerSha: null as string | null,
    pendingWinner: null as { job: JobRow; items: ItemRow[] } | null,
    abortViolations: 0,
  };

  const revokeMembership = (ctx: TenantContext) => {
    rows.memberships = rows.memberships.filter(
      (membership) => !(membership.tenantId === ctx.tenantId && membership.userId === ctx.userId),
    );
  };

  const wallClient = (clientId: string) => {
    const client = rows.clients.find((row) => row.id === clientId)!;
    client.memoryWall = true;
  };

  const grantWall = (clientId: string, userId: string) => {
    rows.clients.find((row) => row.id === clientId)!.memoryGrants.push(userId);
  };

  const snapshot = () => structuredClone(rows);
  const restore = (snap: ReturnType<typeof snapshot>) => {
    Object.assign(rows, snap);
  };

  const makeTx = (scopeTenantId: string, aborted: { value: boolean }) => {
    const tenantJobs = (where?: Where) => {
      const itemsFilter = where?.items as { none?: { clientId?: { in?: string[] } } } | undefined;
      const denied = itemsFilter?.none?.clientId?.in;
      return rows.jobs.filter((job) => {
        if (job.tenantId !== scopeTenantId) return false;
        if (!matches(where, job as unknown as Record<string, unknown>)) return false;
        if (denied && denied.length > 0) {
          const hidden = rows.items.some(
            (item) => item.jobId === job.id && item.clientId && denied.includes(item.clientId),
          );
          if (hidden) return false;
        }
        return true;
      });
    };
    const tenantItems = (where?: Where) =>
      rows.items.filter(
        (item) =>
          item.tenantId === scopeTenantId &&
          matches(where, item as unknown as Record<string, unknown>),
      );

    const tx = {
      tenant: {
        findUnique: jest.fn(
          async ({ where }: { where: { id: string } }) =>
            rows.tenants.find((tenant) => tenant.id === where.id) ?? null,
        ),
        update: jest.fn(async () => undefined),
      },
      tenantMembership: {
        findFirst: jest.fn(async ({ where }: { where: Where }) => {
          const user = where.user as { clerkUserId?: string } | undefined;
          const tenant = where.tenant as { status?: string } | undefined;
          const membership = rows.memberships.find(
            (row) =>
              row.tenantId === where.tenantId &&
              row.userId === where.userId &&
              row.status === 'active' &&
              users.get(row.userId) === user?.clerkUserId &&
              (!tenant?.status ||
                rows.tenants.find((t) => t.id === row.tenantId)?.id === row.tenantId),
          );
          return membership ? { role: membership.role } : null;
        }),
      },
      firmImportJob: {
        findFirst: jest.fn(async ({ where, include }: { where?: Where; include?: unknown }) => {
          if (aborted.value) {
            state.abortViolations += 1;
            throw new Error(
              'current transaction is aborted, commands ignored until end of transaction block',
            );
          }
          const row = tenantJobs(where)[0];
          if (!row) return null;
          return include ? withItems(row, rows.items) : { ...row };
        }),
        findFirstOrThrow: jest.fn(
          async ({ where, include }: { where?: Where; include?: unknown }) => {
            const row = tenantJobs(where)[0];
            if (!row) throw new Error('not found');
            return include ? withItems(row, rows.items) : { ...row };
          },
        ),
        create: jest.fn(async ({ data }: { data: Partial<JobRow> }) => {
          const now = new Date();
          if (state.raceKey && data.requestKey === state.raceKey) {
            // A concurrent writer committed this (tenant, requestKey) first.
            // PostgreSQL aborts THIS transaction; nothing else here may run.
            const winnerId = randomUUID();
            state.pendingWinner = {
              job: {
                id: winnerId,
                tenantId: data.tenantId as string,
                requestedByUserId: data.requestedByUserId as string,
                requestKey: data.requestKey as string,
                requestSha256: state.raceWinnerSha ?? (data.requestSha256 as string),
                ldaRegistrantId: data.ldaRegistrantId as number,
                requestedIds: data.requestedIds as number[],
                status: 'queued',
                startedAt: null,
                finishedAt: null,
                createdAt: now,
                updatedAt: now,
              },
              items: (data.requestedIds as number[]).map((ldaClientId) => ({
                id: randomUUID(),
                tenantId: data.tenantId as string,
                jobId: winnerId,
                ldaClientId,
                outcome: 'pending',
                code: null,
                clientId: null,
                processedAt: null,
                createdAt: now,
                updatedAt: now,
              })),
            };
            state.raceKey = null;
            aborted.value = true;
            throw new Prisma.PrismaClientKnownRequestError('unique constraint', {
              clientVersion: '5.22.0',
              code: 'P2002',
              meta: { target: ['tenant_id', 'request_key'] },
            });
          }
          const row: JobRow = {
            id: randomUUID(),
            tenantId: data.tenantId as string,
            requestedByUserId: data.requestedByUserId as string,
            requestKey: data.requestKey as string,
            requestSha256: data.requestSha256 as string,
            ldaRegistrantId: data.ldaRegistrantId as number,
            requestedIds: data.requestedIds as number[],
            status: (data.status as string) ?? 'queued',
            startedAt: null,
            finishedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          if (
            rows.jobs.some(
              (job) => job.tenantId === row.tenantId && job.requestKey === row.requestKey,
            )
          ) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          rows.jobs.push(row);
          return { id: row.id };
        }),
        update: jest.fn(
          async ({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
            const row = tenantJobs({ id: where.id })[0];
            if (!row) throw new Error('not found');
            Object.assign(row, data, { updatedAt: new Date() });
            return { ...row };
          },
        ),
        findMany: jest.fn(
          async ({
            where,
            orderBy,
            take,
            include,
          }: {
            where?: Where;
            orderBy?: unknown;
            take?: number;
            include?: unknown;
          }) => {
            const ordered = tenantJobs(where)
              .slice()
              .sort((a, b) => {
                const byDate = b.createdAt.getTime() - a.createdAt.getTime();
                return byDate !== 0 ? byDate : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
              });
            const page = typeof take === 'number' ? ordered.slice(0, take) : ordered;
            return page.map((row) => (include ? withItems(row, rows.items) : { ...row }));
          },
        ),
        groupBy: jest.fn(
          async ({ where }: { where?: Where; by: string[]; _count: { _all: true } }) => {
            const counts = new Map<string, number>();
            for (const job of tenantJobs(where))
              counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
            return [...counts.entries()].map(([status, count]) => ({
              status,
              _count: { _all: count },
            }));
          },
        ),
        count: jest.fn(async ({ where }: { where?: Where }) => tenantJobs(where).length),
      },
      firmImportJobItem: {
        findFirst: jest.fn(async ({ where }: { where?: Where }) => {
          const row = tenantItems(where)[0];
          return row ? { id: row.id } : null;
        }),
        createMany: jest.fn(async ({ data }: { data: Array<Partial<ItemRow>> }) => {
          const now = new Date();
          for (const item of data) {
            rows.items.push({
              id: randomUUID(),
              tenantId: item.tenantId as string,
              jobId: item.jobId as string,
              ldaClientId: item.ldaClientId as number,
              outcome: (item.outcome as string) ?? 'pending',
              code: null,
              clientId: null,
              processedAt: null,
              createdAt: now,
              updatedAt: now,
            });
          }
          return { count: data.length };
        }),
        update: jest.fn(
          async ({
            where,
            data,
          }: {
            where: {
              tenantId_jobId_ldaClientId: { tenantId: string; jobId: string; ldaClientId: number };
            };
            data: Partial<ItemRow>;
          }) => {
            const key = where.tenantId_jobId_ldaClientId;
            const row = tenantItems({
              jobId: key.jobId,
              ldaClientId: key.ldaClientId,
            })[0];
            if (!row) throw new Error('item not found');
            if (data.outcome === 'created' && state.failCreatedItemUpdateOnce) {
              state.failCreatedItemUpdateOnce = false;
              throw new Error('simulated item write failure');
            }
            Object.assign(row, data, { updatedAt: new Date() });
            return { ...row };
          },
        ),
      },
      client: {
        findFirst: jest.fn(
          async ({ where }: { where?: Where }) =>
            rows.clients.find(
              (client) =>
                client.tenantId === scopeTenantId &&
                matches(where, client as unknown as Record<string, unknown>),
            ) ?? null,
        ),
        findMany: jest.fn(async ({ where }: { where?: Where }) =>
          rows.clients.filter(
            (client) =>
              client.tenantId === scopeTenantId &&
              matches(where, client as unknown as Record<string, unknown>),
          ),
        ),
        create: jest.fn(async ({ data }: { data: Partial<ClientRow> }) => {
          const row: ClientRow = {
            id: randomUUID(),
            tenantId: data.tenantId as string,
            name: data.name as string,
            description: (data.description as string | null) ?? null,
            issueCodes: (data.issueCodes as string[]) ?? [],
            ldaClientIds: (data.ldaClientIds as number[]) ?? [],
            intakeData: (data.intakeData as object) ?? {},
            createdByUserId: (data.createdByUserId as string | null) ?? null,
            status: 'active',
            memoryWall: false,
            memoryGrants: [],
          };
          rows.clients.push(row);
          return { id: row.id, name: row.name };
        }),
        count: jest.fn(
          async ({ where }: { where?: Where }) =>
            rows.clients.filter(
              (client) =>
                client.tenantId === scopeTenantId &&
                (!(where?.status as { not?: string } | undefined)?.not ||
                  client.status !== (where?.status as { not: string }).not),
            ).length,
        ),
      },
      clientIntelMapping: {
        create: jest.fn(async ({ data }: { data: MappingRow }) => {
          rows.mappings.push({ ...data });
          return data;
        }),
      },
      $executeRawUnsafe: jest.fn(async () => 0),
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async () => [rows.tenants.find((tenant) => tenant.id === scopeTenantId)]),
      $queryRawUnsafe: jest.fn(async (sql: string, tenantId: string, userId: string | null) => {
        if (!sql.includes('c.memory_wall')) throw new Error('Unexpected fixture raw query');
        return rows.clients
          .filter(
            (client) =>
              client.tenantId === tenantId &&
              client.memoryWall &&
              (userId === null || !client.memoryGrants.includes(userId)),
          )
          .map((client) => ({ id: client.id }));
      }),
    };

    return tx;
  };

  const prisma = {
    withTenant: jest.fn(
      async <T>(scopeTenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const snap = snapshot();
        const aborted = { value: false };
        try {
          return await fn(makeTx(scopeTenantId, aborted));
        } catch (error) {
          // Roll back this transaction, then let an independently committed
          // unique-key winner become visible to the caller's NEW transaction.
          restore(snap);
          if (state.pendingWinner) {
            rows.jobs.push(state.pendingWinner.job);
            rows.items.push(...state.pendingWinner.items);
            state.pendingWinner = null;
          }
          throw error;
        }
      },
    ),
    ldaFiling: {
      findMany: jest.fn(async ({ where }: { where?: Where }) =>
        rows.filings.filter((filing) =>
          matches(where, filing as unknown as Record<string, unknown>),
        ),
      ),
    },
    ldaClient: {
      findMany: jest.fn(async ({ where }: { where?: Where }) =>
        rows.ldaClients.filter((client) =>
          matches(where, client as unknown as Record<string, unknown>),
        ),
      ),
    },
  };

  return { rows, prisma, state, revokeMembership, wallClient, grantWall };
};

type Harness = ReturnType<typeof makeHarness>;

const makeService = (harness: Harness, billingEnforced = false) => {
  const prepopulation = { prepopulate: jest.fn().mockResolvedValue(undefined) };
  const samEntity = { enrichGovIds: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue(billingEnforced) };
  const prisma = harness.prisma as unknown as PrismaService;
  const store = new FirmImportJobStore(prisma);
  const service = new FirmOnboardingService(
    prisma,
    prepopulation as unknown as ClientPrepopulationService,
    samEntity as unknown as SamEntityEnrichmentService,
    store,
    config as never,
  );
  return { service, store, prepopulation, samEntity };
};

describe('firm LDA importer durable job view', () => {
  it('creates clients and a completed job whose counts come from item rows', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);
    const requestId = randomUUID();

    const result = await service.importClients(ctxA, [12, 10, 11], { requestId });

    expect(result.created).toBe(3);
    expect(result.items.map((item) => item.ldaClientId).sort()).toEqual([10, 11, 12]);
    expect(result.skipped).toEqual([]);
    expect(result.job).toMatchObject({
      requestId,
      status: 'completed',
      counts: {
        total: 3,
        processed: 3,
        successful: 3,
        rejected: 0,
        outstanding: 0,
        created: 3,
        alreadyPresent: 0,
      },
    });
    expect(harness.rows.jobs).toHaveLength(1);
    expect(harness.rows.items.every((item) => item.outcome === 'created')).toBe(true);
    expect(harness.rows.items.every((item) => !!item.clientId && !!item.processedAt)).toBe(true);
    expect(harness.rows.mappings).toHaveLength(3);
    expect(
      harness.rows.mappings.every((mapping) => mapping.source === 'lda' && mapping.confirmed),
    ).toBe(true);
  });

  it('reconciles the same request identity without importing again', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);
    const requestId = randomUUID();

    const first = await service.importClients(ctxA, [10, 11], { requestId });
    const replay = await service.importClients(ctxA, [11, 10], { requestId });

    expect(replay.job.id).toBe(first.job.id);
    expect(replay.created).toBe(2);
    expect(replay.job.counts).toEqual(first.job.counts);
    expect(harness.rows.jobs).toHaveLength(1);
    expect(harness.rows.clients).toHaveLength(2);
  });

  it('conflicts when the same identity is reused for a changed selection', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);
    const requestId = randomUUID();

    await service.importClients(ctxA, [10], { requestId });

    await expect(service.importClients(ctxA, [10, 11], { requestId })).rejects.toMatchObject({
      response: { code: 'IMPORT_REQUEST_CONFLICT' },
    });
    await expect(service.importClients(ctxA, [10, 11], { requestId })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(harness.rows.jobs).toHaveLength(1);
    expect(harness.rows.clients).toHaveLength(1);
  });

  it('serialises two different requests importing the same LDA id', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);

    const first = await service.importClients(ctxA, [30], { requestId: randomUUID() });
    const second = await service.importClients(ctxA, [30, 31], { requestId: randomUUID() });

    expect(first.job.counts.created).toBe(1);
    expect(second.job.counts.created).toBe(1);
    expect(second.job.counts.alreadyPresent).toBe(1);
    expect(second.skipped).toEqual([{ ldaClientId: 30, reason: 'already onboarded' }]);
    expect(harness.rows.clients.filter((client) => client.ldaClientIds.includes(30))).toHaveLength(
      1,
    );
    expect(second.job.status).toBe('completed');
  });

  it('keeps a Client and its success item atomic when the item write fails', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);
    harness.state.failCreatedItemUpdateOnce = true;

    const result = await service.importClients(ctxA, [42], { requestId: randomUUID() });

    // The Client/mapping created in the failed transaction is rolled back with
    // its item write; the job records a safe rejected outcome instead.
    expect(harness.rows.clients).toHaveLength(0);
    expect(harness.rows.mappings).toHaveLength(0);
    expect(result.created).toBe(0);
    expect(result.skipped).toEqual([{ ldaClientId: 42, reason: 'import_failed' }]);
    expect(harness.rows.items[0]).toMatchObject({ outcome: 'rejected', code: 'INTERNAL_ERROR' });
    expect(result.job.status).toBe('failed');
  });

  it('records partial results with closed, actionable codes and no raw messages', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);
    harness.rows.filings = harness.rows.filings.filter((filing) => filing.clientId !== 11);

    const result = await service.importClients(ctxA, [10, 11, 12, 99], { requestId: randomUUID() });

    expect(result.created).toBe(2);
    expect(result.job.status).toBe('partially_completed');
    expect(result.job.counts).toMatchObject({
      total: 4,
      processed: 4,
      successful: 2,
      rejected: 2,
      outstanding: 0,
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { ldaClientId: 11, reason: 'not a client of your firm' },
        { ldaClientId: 99, reason: 'not a client of your firm' },
      ]),
    );
    expect(result.skipped.every((skip) => /^[a-z_ ]+$/.test(skip.reason))).toBe(true);
    expect(harness.rows.items.map((item) => item.code)).toEqual(
      expect.arrayContaining(['NOT_OWN_CLIENT', 'NOT_OWN_CLIENT']),
    );
  });

  it('marks a job failed when every item is rejected', async () => {
    const harness = makeHarness();
    const { service } = makeService(harness);

    const result = await service.importClients(ctxA, [99], { requestId: randomUUID() });

    expect(result.job.status).toBe('failed');
    expect(result.job.counts.rejected).toBe(1);
    expect(harness.rows.clients).toHaveLength(0);
  });

  it('reports a mid-batch capacity rejection without losing earlier successes', async () => {
    const harness = makeHarness();
    harness.rows.tenants[0]!.clientSlots = 2;
    const { service } = makeService(harness, true);

    const result = await service.importClients(ctxA, [10, 11, 12], { requestId: randomUUID() });

    expect(result.created).toBe(2);
    expect(result.job.status).toBe('partially_completed');
    expect(result.skipped).toEqual([
      { ldaClientId: 12, reason: 'CLIENT_SLOT_LIMIT: client slot limit reached' },
    ]);
    const rejected = harness.rows.items.find((item) => item.ldaClientId === 12);
    expect(rejected).toMatchObject({ outcome: 'rejected', code: 'CLIENT_SLOT_LIMIT' });
  });

  it('exposes a crashed/unfinished job as non-terminal, outstanding and stale', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const requestId = randomUUID();

    const admitted = await store.createOrReconcile(ctxA, {
      requestKey: requestId,
      ldaRegistrantId: 7001,
      ids: [10, 11],
    });
    await store.markRunning(ctxA, admitted.job.id);
    // Simulate a lost ACK/process end: no item progressed, no finalize call.
    const job = harness.rows.jobs[0]!;
    job.updatedAt = new Date(Date.now() - 60 * 60 * 1000);

    const status = await service.getImportJobStatus(ctxA, admitted.job.id);
    expect(status).toMatchObject({
      status: 'running',
      terminal: false,
      stale: true,
      finishedAt: null,
    });
    expect(status.counts).toMatchObject({ total: 2, processed: 0, outstanding: 2 });
    expect(status.unresolved).toEqual([10, 11]);

    const replay = await service.importClients(ctxA, [10, 11], { requestId });
    expect(replay.job.id).toBe(admitted.job.id);
    expect(replay.job.status).toBe('running');
    expect(replay.job.counts.outstanding).toBe(2);
    expect(replay.created).toBe(0);
  });

  it('scopes job reads to the current tenant', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const { job } = await store.createOrReconcile(ctxA, {
      requestKey: randomUUID(),
      ldaRegistrantId: 7001,
      ids: [10],
    });

    await expect(service.getImportJob(ctxB, job.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await store.getJobByRequest(ctxB, job.requestId)).toBeNull();
    expect(await service.listImportJobs(ctxB)).toMatchObject({
      jobs: [],
      population: { total: 0 },
    });
  });

  it('pages deterministically across created_at ties with full-population counts', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const sameInstant = new Date('2026-10-30T09:00:00.000Z');
    for (const ids of [[10], [11], [12]]) {
      const { job } = await store.createOrReconcile(ctxA, {
        requestKey: randomUUID(),
        ldaRegistrantId: 7001,
        ids,
      });
      harness.rows.jobs.find((row) => row.id === job.id)!.createdAt = sameInstant;
    }
    const expected = harness.rows.jobs
      .map((job) => job.id)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const firstPage = await service.listImportJobs(ctxA, { limit: 2 });
    expect(firstPage.jobs.map((job) => job.id)).toEqual(expected.slice(0, 2));
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.population).toMatchObject({ total: 3, queued: 3 });

    const secondPage = await service.listImportJobs(ctxA, {
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    expect(secondPage.jobs.map((job) => job.id)).toEqual(expected.slice(2));
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.population.total).toBe(3);
  });
});

describe('firm import job visibility and transaction corrections', () => {
  it('hides a whole job whose outcome references an inaccessible walled client, and restores it on grant', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const requestId = randomUUID();
    const imported = await service.importClients(ctxA, [10, 11], { requestId });
    const clientId = imported.items.find((item) => item.ldaClientId === 10)!.id;

    harness.wallClient(clientId);

    const list = await service.listImportJobs(ctxA);
    expect(list.jobs).toEqual([]);
    expect(list.population.total).toBe(0);
    await expect(service.getImportJob(ctxA, imported.job.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.getImportJobStatus(ctxA, imported.job.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await store.getJobByRequest(ctxA, requestId)).toBeNull();
    // POST replay of the same identity must not leak or re-import.
    await expect(service.importClients(ctxA, [10, 11], { requestId })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(harness.rows.clients).toHaveLength(2);

    harness.grantWall(clientId, ctxA.userId);
    const visible = await service.getImportJob(ctxA, imported.job.id);
    expect(visible.id).toBe(imported.job.id);
    expect(visible.items.map((item) => item.ldaClientId)).toEqual([10, 11]);
  });

  it('denies a revoked membership/current actor before any job or client read', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const requestId = randomUUID();
    const imported = await service.importClients(ctxA, [10], { requestId });

    harness.revokeMembership(ctxA);

    await expect(service.listImportJobs(ctxA)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getImportJob(ctxA, imported.job.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.getImportJobStatus(ctxA, imported.job.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      store.createOrReconcile(ctxA, { requestKey: randomUUID(), ldaRegistrantId: 7001, ids: [10] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('writes the terminal projection atomically with the last item, with no finalize step', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);
    const { job } = await store.createOrReconcile(ctxA, {
      requestKey: randomUUID(),
      ldaRegistrantId: 7001,
      ids: [10, 11],
    });
    await store.markRunning(ctxA, job.id);

    await harness.prisma.withTenant(ctxA.tenantId, async (tx) => {
      const scoped = tx as Parameters<typeof store.markItemOutcome>[0];
      await store.markItemOutcome(scoped, {
        tenantId: ctxA.tenantId,
        jobId: job.id,
        ldaClientId: 10,
        outcome: 'created',
        clientId: randomUUID(),
      });
    });
    // Not terminal yet: the second item is still pending.
    expect(harness.rows.jobs[0]!.status).toBe('running');

    await harness.prisma.withTenant(ctxA.tenantId, async (tx) => {
      const scoped = tx as Parameters<typeof store.markItemOutcome>[0];
      await store.markItemOutcome(scoped, {
        tenantId: ctxA.tenantId,
        jobId: job.id,
        ldaClientId: 11,
        outcome: 'rejected',
        code: 'NOT_OWN_CLIENT',
      });
    });

    // The same transaction that committed the last outcome already wrote the
    // terminal status; no finalize call exists or is needed.
    const persisted = harness.rows.jobs[0]!;
    expect(persisted.status).toBe('partially_completed');
    expect(persisted.finishedAt).not.toBeNull();
    expect((store as unknown as { finalize?: unknown }).finalize).toBeUndefined();

    const partial = await service.listImportJobs(ctxA, { status: 'partially_completed' });
    expect(partial.jobs.map((entry) => entry.id)).toEqual([job.id]);
    expect(partial.population).toMatchObject({ total: 1, partially_completed: 1, running: 0 });
    const completed = await service.listImportJobs(ctxA, { status: 'completed' });
    expect(completed.jobs).toEqual([]);
    expect(completed.population.total).toBe(0);
    const detail = await service.getImportJob(ctxA, job.id);
    expect(detail.status).toBe('partially_completed');
  });

  it('uses the same atomic projection for all-rejected and completed jobs, and excludes hidden ones from counts', async () => {
    const harness = makeHarness();
    const { service, store } = makeService(harness);

    const failed = await store.createOrReconcile(ctxA, {
      requestKey: randomUUID(),
      ldaRegistrantId: 7001,
      ids: [99],
    });
    await harness.prisma.withTenant(ctxA.tenantId, async (tx) => {
      const scoped = tx as Parameters<typeof store.markItemOutcome>[0];
      await store.markItemOutcome(scoped, {
        tenantId: ctxA.tenantId,
        jobId: failed.job.id,
        ldaClientId: 99,
        outcome: 'rejected',
        code: 'NOT_OWN_CLIENT',
      });
    });
    expect(harness.rows.jobs[0]!.status).toBe('failed');

    const completed = await service.importClients(ctxA, [10], { requestId: randomUUID() });
    expect(harness.rows.jobs.find((row) => row.id === completed.job.id)!.status).toBe('completed');

    const all = await service.listImportJobs(ctxA);
    expect(all.population).toMatchObject({ total: 2, failed: 1, completed: 1 });
    expect(
      (await service.listImportJobs(ctxA, { status: 'failed' })).jobs.map((j) => j.id),
    ).toEqual([failed.job.id]);

    harness.wallClient(completed.items[0]!.id);
    const hidden = await service.listImportJobs(ctxA);
    expect(hidden.population).toMatchObject({ total: 1, failed: 1, completed: 0 });
    expect((await service.listImportJobs(ctxA, { status: 'completed' })).population.total).toBe(0);
  });

  it('reconciles a simultaneous same-request key winner in a NEW transaction after the create aborts', async () => {
    const harness = makeHarness();
    const { store } = makeService(harness);
    const requestId = randomUUID();
    harness.state.raceKey = requestId;

    const result = await store.createOrReconcile(ctxA, {
      requestKey: requestId,
      ldaRegistrantId: 7001,
      ids: [10, 11],
    });

    expect(result.created).toBe(false);
    expect(harness.state.abortViolations).toBe(0);
    expect(harness.rows.jobs).toHaveLength(1);
    expect(harness.rows.items).toHaveLength(2);
    expect(result.job.id).toBe(harness.rows.jobs[0]!.id);
    expect(result.job.items.map((item) => item.outcome)).toEqual(['pending', 'pending']);
    expect(harness.rows.clients).toHaveLength(0);
  });

  it('keeps a changed request on the same identity a conflict even when it loses the unique race', async () => {
    const harness = makeHarness();
    const { store } = makeService(harness);
    const requestId = randomUUID();
    harness.state.raceKey = requestId;
    harness.state.raceWinnerSha = 'a'.repeat(64);

    await expect(
      store.createOrReconcile(ctxA, { requestKey: requestId, ldaRegistrantId: 7001, ids: [10] }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(harness.state.abortViolations).toBe(0);
    expect(harness.rows.jobs).toHaveLength(1);
    expect(harness.rows.items).toHaveLength(1);
  });
});
