import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Prisma, SpPlannerProject, SpPlannerResource } from '../../generated/prisma-client/index.js';
import { AppModule } from '../app.module.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ObjectiveCanonicalApplicationService } from './objective-canonical-application.service.js';
import { ObjectivePlannerContinuationRuntime } from './objective-planner-continuation.runtime.js';
import { PLANNER_CONTINUATION_OPERATION } from './objective-planner-continuation.store.js';
import { ObjectivePlannerContinuationWorker } from './objective-planner-continuation.worker.js';
import type { PlannerLinksService } from './planner-links.service.js';
import { PlannerModule } from './planner.module.js';
import { PlannerService } from './planner.service.js';

// Actual module metadata, Nest container, runtime/worker and Planner service.
// Only database/transaction ports are fake. compile() deliberately never calls
// application init, Prisma lifecycle hooks, SQL or any native/provider endpoint.
describe('Planner continuation mount and default-disabled lifecycle', () => {
  const previousEnabled = process.env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let moduleRef: TestingModule | undefined;
  const forbidden = jest.fn(() => { throw new Error('Mount qualification must not open a database'); });
  const database = { withTenant: forbidden, withSystem: forbidden, $connect: forbidden, $disconnect: forbidden };

  beforeAll(async () => {
    delete process.env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED;
    if (!process.env.DATABASE_URL)
      process.env.DATABASE_URL = 'postgresql://jest:jest@localhost:5432/jest_continuation_mount_only';
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(database)
      .overrideProvider(ConfigService).useValue(new ConfigService())
      .compile();
  }, 60_000);

  afterAll(async () => {
    await moduleRef?.close();
    if (previousEnabled === undefined) delete process.env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED;
    else process.env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED = previousEnabled;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('resolves the actual runtime, worker and application owner through the actual PlannerModule in AppModule', () => {
    const planner = moduleRef!.select(PlannerModule);
    expect(planner.get(ObjectivePlannerContinuationRuntime, { strict: true })).toBeInstanceOf(ObjectivePlannerContinuationRuntime);
    expect(planner.get(ObjectivePlannerContinuationWorker, { strict: true })).toBeInstanceOf(ObjectivePlannerContinuationWorker);
    expect(planner.get(ObjectiveCanonicalApplicationService, { strict: true })).toBeInstanceOf(ObjectiveCanonicalApplicationService);
    expect(planner.get(PlannerService, { strict: true })).toBeInstanceOf(PlannerService);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('keeps manually invoked default-disabled worker hooks and runtime entry points free of timers and database access', async () => {
    const runtime = moduleRef!.get(ObjectivePlannerContinuationRuntime);
    const worker = moduleRef!.get(ObjectivePlannerContinuationWorker);
    const interval = jest.spyOn(globalThis, 'setInterval');
    try {
      expect(runtime.enabled).toBe(false);
      worker.onModuleInit();
      await worker.tick();
      worker.onModuleDestroy();
      await expect(runtime.consumeJob({ tenantId: TENANT, clerkUserId: OWNER, generationJobId: RESOURCE }))
        .resolves.toEqual({ outcome: 'disabled' });
      await runtime.consumeTenant(TENANT);
      expect(interval).not.toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    } finally { interval.mockRestore(); }
  });
});

const TENANT = '10000000-0000-4000-8000-000000000001';
const RESOURCE = '20000000-0000-4000-8000-000000000001';
const OWNER = 'user_continuation_owner';
const at = new Date('2026-10-17T01:00:00.000Z');
const owner: AuthTenantContext = { tenantId: TENANT, clerkUserId: OWNER, role: 'org:admin' };

function privateRow(): SpPlannerResource {
  return { id: RESOURCE, tenantId: TENANT, ownerId: OWNER, projectId: null,
    kind: PLANNER_CONTINUATION_OPERATION, name: 'Private continuation operation',
    data: { lease: { token: 'private-test-evidence' } }, version: 2,
    archived: false, shareTokenHash: null, createdAt: at, updatedAt: at } as SpPlannerResource;
}
type PrivateResourceProjection = {
  resourceAccess(row: SpPlannerResource, projects: SpPlannerProject[], ctx: AuthTenantContext): string | null;
  resourceView(row: SpPlannerResource, projects: SpPlannerProject[], ctx: AuthTenantContext): unknown;
};
function resourceFixture() {
  const row = privateRow();
  const write = jest.fn(() => { throw new Error('Private continuation rows must never reach a generic writer'); });
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    spPlannerProject: { findMany: jest.fn(async () => []) },
    spPlannerResource: {
      // Deliberately include the private row in a list result to exercise the
      // service's defense even if a storage adapter returns an overbroad list.
      findMany: jest.fn(async () => [row]),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        Object.entries(where).every(([key, value]) => row[key as keyof SpPlannerResource] === value) ? row : null),
      create: write, update: write, updateMany: write,
    },
  };
  const withTenant = jest.fn(async (tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    expect(tenantId).toBe(TENANT);return run(tx as unknown as Prisma.TransactionClient);
  });
  const planner = new PlannerService({ withTenant } as unknown as PrismaService, {} as PlannerLinksService);
  return { planner, projection: planner as unknown as PrivateResourceProjection, row, tx, write, withTenant };
}

describe('Planner continuation private-kind generic-access refusal', () => {
  it.each([
    { clerkUserId: OWNER, role: 'org:admin' },
    { clerkUserId: OWNER, role: 'standard_user' },
    { clerkUserId: 'user_admin', role: 'user_admin' },
    { clerkUserId: 'user_platform_admin', role: 'capiro_admin' },
  ])('returns no resource access for private kind with actor $clerkUserId and role $role', actor => {
    const f = resourceFixture(), ctx = { ...owner, ...actor };
    expect(f.projection.resourceAccess(f.row, [], ctx)).toBeNull();
    // Positive control: the actual normal owner gate can grant admin access.
    expect(f.projection.resourceAccess({ ...f.row, kind: 'portfolio' }, [], owner)).toBe('admin');
  });

  it('refuses a direct generic read projection before inspecting private operation data', () => {
    const f = resourceFixture(), data = jest.fn(() => { throw new Error('Private data must not be read'); });
    Object.defineProperty(f.row, 'data', { enumerable: true, get: data });
    expect(() => f.projection.resourceView(f.row, [], owner)).toThrow(NotFoundException);
    expect(data).not.toHaveBeenCalled();
  });

  it('filters private rows from the actual public resource-list path even for their owner', async () => {
    const f = resourceFixture();
    await expect(f.planner.resources(owner)).resolves.toEqual([]);
    expect(f.tx.spPlannerResource.findMany).toHaveBeenCalled();expect(f.write).not.toHaveBeenCalled();
  });

  it.each([
    ['save', { version: 2, name: 'Attempted generic edit' }],
    ['archive', { version: 2, archived: true }],
  ])('refuses the actual generic %s path before mutation', async (_action, raw) => {
    const f = resourceFixture();
    await expect(f.planner.saveResource(owner, RESOURCE, raw)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.spPlannerResource.findFirst).toHaveBeenCalledWith({ where: { id: RESOURCE, tenantId: TENANT } });
    expect(f.write).not.toHaveBeenCalled();expect(f.row.version).toBe(2);expect(f.row.archived).toBe(false);
  });

  it('keeps the actual sharing path scoped to a public resource kind and refuses the private operation ID', async () => {
    const f = resourceFixture();
    await expect(f.planner.shareForm(owner, RESOURCE, { version: 2, enabled: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.spPlannerResource.findFirst).toHaveBeenCalledWith({
      where: { id: RESOURCE, tenantId: TENANT, kind: 'form', archived: false },
    });
    expect(f.write).not.toHaveBeenCalled();expect(f.row.shareTokenHash).toBeNull();
  });
});
