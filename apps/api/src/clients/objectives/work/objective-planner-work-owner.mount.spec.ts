import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../../tenant/tenant-context.middleware.js';
import { ObjectiveWorkModule } from './objective-work.module.js';
import { OBJECTIVE_WORK_OWNER, ObjectiveWorkService } from './objective-work.service.js';
import { ObjectivePlannerWorkOwner } from './objective-planner-work-owner.js';
import { ObjectiveStrategyWorkOwner } from './objective-strategy-work-owner.js';
import { ObjectiveWorkOwnerRouter } from './objective-work-owner.router.js';
import type { WorkAuthority, WorkState } from './objective-work-command.js';

// Compile the actual module/factory and its controller/service. Global local
// providers supply dependencies without constructing live Prisma/Clerk clients.
// No application init, HTTP listener or native transaction is started here.
const databaseIO = jest.fn(() => { throw Error('Unexpected database call in mount-only regression'); });
const identityIO = jest.fn(() => { throw Error('Unexpected identity call in mount-only regression'); });
const prisma = { withTenant: databaseIO, withSystem: databaseIO, $queryRaw: databaseIO, $executeRaw: databaseIO };
const tenant = { readApplicationAuthority: identityIO };

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prisma }, { provide: TenantContextMiddleware, useValue: tenant }],
  exports: [PrismaService, TenantContextMiddleware],
})
class ObjectivePlannerMountDependencies {}

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const authority: WorkAuthority = { tenantId: id(1), actorUserId: id(2), actorMembershipId: id(3), clerkUserId: 'user_mount',
  clientId: id(4), objectiveId: id(5), objectiveRevisionId: id(6), objectiveVersion: 1, objectiveStatus: 'ready' };
const state: WorkState = { source: { canonicalPlanId: id(7), canonicalEpoch: 1, canonicalStrategyId: id(8), canonicalProjectId: id(9),
  canonicalBindingVersion: 1, rootIntentId: id(10), sourceRevisionId: id(6), sourceObjectiveVersion: 1,
  sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(2) }, control: null, consent: null };
const keys = ['OBJECTIVE_PLANNER_CONTINUATION_ENABLED', 'OBJECTIVE_PLANNER_CONSENT_DURATION_MS',
  'OBJECTIVE_STRATEGY_INTAKE_ENABLED', 'OBJECTIVE_STRATEGY_CONSENT_DURATION_MS'] as const;

describe('Objective Planner Core owner module mount', () => {
  let module: TestingModule | undefined;
  let prior: Array<string | undefined>;
  beforeEach(() => {
    prior = keys.map(key => process.env[key]);
    for (const key of keys) delete process.env[key];
    databaseIO.mockClear(); identityIO.mockClear();
  });
  afterEach(async () => {
    try { await module?.close(); }
    finally {
      module = undefined;
      keys.forEach((key, index) => { if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index]; });
    }
  });
  const compile = async () => {
    module = await Test.createTestingModule({ imports: [ObjectivePlannerMountDependencies, ObjectiveWorkModule] }).compile();
    return module.get<ObjectiveWorkOwnerRouter>(OBJECTIVE_WORK_OWNER);
  };
  it('resolves the actual module factory as the concrete owner with local dependencies', async () => {
    const owner = await compile();
    expect(owner).toBeInstanceOf(ObjectiveWorkOwnerRouter);
    expect(owner.planner).toBeInstanceOf(ObjectivePlannerWorkOwner);
    expect(owner.strategy).toBeInstanceOf(ObjectiveStrategyWorkOwner);
    expect(module!.get(ObjectiveWorkService)).toBeInstanceOf(ObjectiveWorkService);
    expect(module!.get(PrismaService)).toBe(prisma);
    expect(module!.get(TenantContextMiddleware)).toBe(tenant);
    expect(databaseIO).not.toHaveBeenCalled(); expect(identityIO).not.toHaveBeenCalled();
  });
  it('process default-off exposes no eligible Planner reconciliation or policy and performs no IO', async () => {
    const owner = await compile(), tx = prisma as any;
    expect((await owner.reconcileWithinTx(tx, authority, 'objective.plan.prepare', state)).state).toBe('unavailable');
    await expect(owner.policyWithinTx(tx, authority, 'objective.plan.prepare', state)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(databaseIO).not.toHaveBeenCalled(); expect(identityIO).not.toHaveBeenCalled();
  });
  it('keeps Strategy action unavailable even when the Planner operator settings are enabled', async () => {
    process.env.OBJECTIVE_PLANNER_CONTINUATION_ENABLED = 'true';
    process.env.OBJECTIVE_PLANNER_CONSENT_DURATION_MS = '600000';
    const owner = await compile(), tx = prisma as any;
    await owner.lockWithinTx(tx, { tenantId: authority.tenantId } as any, { command: { workAction: 'objective.strategy.draft' } } as any);
    expect((await owner.reconcileWithinTx(tx, authority, 'objective.strategy.draft', state)).state).toBe('unavailable');
    await expect(owner.policyWithinTx(tx, authority, 'objective.strategy.draft', state)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(databaseIO).not.toHaveBeenCalled(); expect(identityIO).not.toHaveBeenCalled();
  });
});
