import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  type PlannerTaskData,
  type PlannerProjectData,
} from '@capiro/strategy-verifier';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { VersioningService } from './versioning.service.js';
import type { PlannerLinksService } from '../planner/planner-links.service.js';
import { StrategyService } from './strategy.service.js';
import { PlannerService } from '../planner/planner.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';

const ctx: AuthTenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const userId = '22222222-2222-4222-8222-222222222222';
const resourceId = '33333333-3333-4333-8333-333333333333';
const input = {
  clientId: '44444444-4444-4444-8444-444444444444',
  objectiveId: '55555555-5555-4555-8555-555555555555',
  objectiveVersion: 3,
};
const revisionId = '66666666-6666-4666-8666-666666666666';
const otherId = '77777777-7777-4777-8777-777777777777';
const projectId = '88888888-8888-4888-8888-888888888888';
const now = new Date('2026-10-12T10:00:00Z');

function fixture() {
  const state = {
    scope: true,
    grant: true,
    objective: true,
    revision: true,
    version: 3,
    strategy: true,
  };
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const strategy = {
    id: resourceId,
    tenantId: ctx.tenantId,
    clientId: input.clientId,
    archivedAt: null,
    nodes: [],
    artifacts: [],
  };
  const task = {
    id: resourceId,
    tenantId: ctx.tenantId,
    ownerId: ctx.clerkUserId,
    assigneeId: null,
    projectIds: [] as string[],
    archived: false,
    data: {
      ...PLANNER_DEFAULT_TASK,
      name: 'Synthetic task',
      clientId: input.clientId,
    } as PlannerTaskData,
    version: 5,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const project = {
    id: projectId,
    tenantId: ctx.tenantId,
    ownerId: 'other_owner',
    archived: false,
    data: {
      ...PLANNER_DEFAULT_PROJECT,
      name: 'Synthetic project',
      members: [{ userId: ctx.clerkUserId, role: 'viewer' }],
    } as PlannerProjectData,
    version: 2,
    createdAt: now,
    updatedAt: now,
  };
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      sql.push({ text, values });
      if (text.includes('FROM sp_strategy')) return state.strategy ? [{ id: resourceId }] : [];
      if (text.includes('FROM tenants')) return state.scope ? [{ userId, memoryWall: true }] : [];
      if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: 'grant' }] : [];
      if (text.includes('FROM client_objectives'))
        return state.objective ? [{ version: state.version }] : [];
      if (text.includes('FROM client_objective_revisions'))
        return state.revision ? [{ id: revisionId }] : [];
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ text: strings.join('?'), values });
      return 0;
    }),
    spStrategy: { findFirstOrThrow: jest.fn().mockResolvedValue(strategy) },
    spPlannerTask: {
      findFirst: jest.fn().mockResolvedValue(task),
      findMany: jest.fn().mockResolvedValue([]),
    },
    spPlannerProject: { findMany: jest.fn().mockResolvedValue([project]) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: (tx: unknown) => unknown) => run(tx)),
    withTenantUser: jest.fn(
      async (_tenant: string, _clerk: string, run: (tx: unknown) => unknown) => run(tx),
    ),
  };
  const strategies = new StrategyService(
    prisma as unknown as PrismaService,
    {} as VersioningService,
  );
  const planner = new PlannerService(prisma as unknown as PrismaService, {} as PlannerLinksService);
  return {
    state,
    sql,
    task,
    project,
    tx,
    prisma,
    strategies,
    planner,
    strategyRead: () => strategies.objectiveDestination(ctx, resourceId, input),
    taskRead: () => planner.objectiveDestination(ctx, resourceId, input),
  };
}

describe('Canonical Strategy and Planner Objective destination owners (synthetic tx)', () => {
  it('Strategy returns its canonical same-client live plan with the existing exact Objective revision', async () => {
    const f = fixture();
    await expect(f.strategyRead()).resolves.toMatchObject({
      destination: { kind: 'strategy', resourceId, ...input, objectiveRevisionId: revisionId },
      strategy: { id: resourceId },
    });
    expect(f.sql[0]!.text).toContain('FOR SHARE');
    expect(f.sql[0]!.text).toContain('archived_at IS NULL');
    expect(f.sql[0]!.values).toEqual([ctx.tenantId, resourceId, input.clientId]);
    expect(f.sql[1]!.values).toEqual([ctx.tenantId, null, ctx.clerkUserId, input.clientId]);
    expect(f.sql[2]!.values).toEqual([ctx.tenantId, input.clientId, userId]);
    expect(f.tx.spStrategy.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: resourceId } }),
    );
  });

  it('Planner returns an explicit same-client task under its canonical task viewer ACL and tenant lock', async () => {
    const f = fixture();
    await expect(f.taskRead()).resolves.toMatchObject({
      destination: {
        kind: 'planner_task',
        resourceId,
        ...input,
        objectiveRevisionId: revisionId,
        destinationVersion: 5,
      },
      task: { id: resourceId },
    });
    expect(f.sql[0]!.text).toContain('pg_advisory_xact_lock');
    expect(f.sql[0]!.values).toEqual([`planner:${ctx.tenantId}`]);
    expect(f.tx.spPlannerTask.findFirst).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, id: resourceId },
    });
    expect(f.tx.spPlannerProject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: ctx.tenantId } }),
    );
    expect(f.sql.find((row) => row.text.includes('FROM client_memory_access'))!.values).toContain(
      userId,
    );
    expect(f.sql.flatMap((row) => row.values).includes(ctx.clerkUserId)).toBe(true);
  });

  it.each(['scope', 'grant', 'objective', 'revision'] as const)(
    'both owners fail closed for removed %s',
    async (property) => {
      for (const owner of ['strategyRead', 'taskRead'] as const) {
        const f = fixture();
        f.state[property] = false;
        await expect(f[owner]()).rejects.toBeInstanceOf(NotFoundException);
        expect(f.tx.spStrategy.findFirstOrThrow).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['strategyRead', 'taskRead'] as const)(
    '%s conflicts on stale revision and rechecks exact retry',
    async (owner) => {
      const f = fixture();
      await f[owner]();
      f.state.version = 4;
      await expect(f[owner]()).rejects.toBeInstanceOf(ConflictException);
      f.state.version = 3;
      f.state.grant = false;
      await expect(f[owner]()).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('refuses an unavailable/mismatched/archived Strategy before reading Objective content', async () => {
    const f = fixture();
    f.state.strategy = false;
    await expect(f.strategyRead()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql).toHaveLength(1);
    expect(f.tx.spStrategy.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('refuses missing/archived Planner tasks', async () => {
    const f = fixture();
    f.task.archived = true;
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql).toHaveLength(1);
    f.tx.spPlannerTask.findFirst.mockResolvedValueOnce(null);
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses foreign explicit client and absent task client even when its project has the right client', async () => {
    const f = fixture();
    f.task.data.clientId = otherId;
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
    f.task.data.clientId = null;
    f.project.data.clientId = input.clientId;
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.every((row) => !row.text.includes('FROM tenants'))).toBe(true);
  });

  it('preserves project-granted viewer access and refuses a current grant removal despite task ownership', async () => {
    const f = fixture();
    f.task.data.memberships = [{ projectId, sectionId: null, position: 0 }];
    f.task.projectIds = [projectId];
    await expect(f.taskRead()).resolves.toMatchObject({ task: { access: 'viewer' } });
    f.project.data.members = [];
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('permits an addressed task collaborator through the existing owner ACL without a project inference', async () => {
    const f = fixture();
    f.task.ownerId = 'other_owner';
    f.task.data.collaborators = [ctx.clerkUserId];
    await expect(f.taskRead()).resolves.toMatchObject({ task: { access: 'commenter' } });
    f.task.data.collaborators = [];
    await expect(f.taskRead()).rejects.toBeInstanceOf(NotFoundException);
  });
});
