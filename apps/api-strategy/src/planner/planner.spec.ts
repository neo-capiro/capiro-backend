import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  nextPlannerDate,
  plannerDependencyCycle,
} from '@capiro/strategy-verifier';
import { plannerProjectAccess, plannerTaskAccess, PlannerService } from './planner.service.js';
import { validateProject, validateTask } from './planner.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PlannerLinksService } from './planner-links.service.js';
import type { SpPlannerProject, SpPlannerTask } from '../../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TENANT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const PROJECT = '20000000-0000-4000-8000-000000000001';
const TASK = '30000000-0000-4000-8000-000000000001';
const SECTION = '40000000-0000-4000-8000-000000000001';
const now = new Date('2026-10-06T12:00:00Z');
const ctx: AuthTenantContext = { tenantId: TENANT, clerkUserId: 'user_owner', role: 'org:admin' };
function project(patch: Record<string, unknown> = {}): SpPlannerProject {
  return {
    id: PROJECT,
    tenantId: TENANT,
    ownerId: 'user_owner',
    version: 1,
    archived: false,
    createdAt: now,
    updatedAt: now,
    data: {
      ...PLANNER_DEFAULT_PROJECT,
      name: 'Launch',
      sections: [{ id: SECTION, name: 'Work' }],
      ...patch,
    },
  } as unknown as SpPlannerProject;
}
function task(patch: Record<string, unknown> = {}): SpPlannerTask {
  const data = {
    ...PLANNER_DEFAULT_TASK,
    name: 'Plan launch',
    memberships: [{ projectId: PROJECT, sectionId: SECTION, position: 0 }],
    ...patch,
  };
  return {
    id: TASK,
    tenantId: TENANT,
    ownerId: 'user_owner',
    version: 1,
    archived: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    projectIds: data.memberships.map((m) => m.projectId),
    assigneeId: data.assigneeId,
    parentId: data.parentId,
    data,
  } as SpPlannerTask;
}
function fixture(projects = [project()], tasks = [task()]) {
  const writes: unknown[] = [];
  const events: unknown[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => [
      { id: 'user_owner', name: 'Owner' },
      { id: 'user_editor', name: 'Editor' },
      { id: 'user_outsider', name: 'Outsider' },
    ]),
    spPlannerProject: {
      findMany: jest.fn(async () => projects.filter((p) => p.tenantId === ctx.tenantId)),
      findFirst: jest.fn(
        async ({ where }) =>
          projects.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
      ),
      update: jest.fn(async ({ where, data }) => {
        const p = projects.find((p) => p.id === where.id)!;
        Object.assign(p, { ...data, version: p.version + 1 });
        writes.push(data);
        return p;
      }),
    },
    spPlannerTask: {
      findMany: jest.fn(async () => tasks.filter((t) => t.tenantId === ctx.tenantId)),
      findFirst: jest.fn(
        async ({ where }) =>
          tasks.find((t) => t.id === where.id && t.tenantId === where.tenantId) ?? null,
      ),
      update: jest.fn(async ({ where, data }) => {
        const t = tasks.find((t) => t.id === where.id)!;
        Object.assign(t, { ...data, version: t.version + 1 });
        writes.push(data);
        return t;
      }),
      create: jest.fn(async ({ data }) => {
        const t = { ...task(), id: data.id ?? '30000000-0000-4000-8000-000000000009', ...data };
        tasks.push(t);
        writes.push(data);
        return t;
      }),
    },
    spPlannerEvent: {
      create: jest.fn(async ({ data }) => {
        events.push(data);
        return {
          id: '50000000-0000-4000-8000-000000000001',
          createdAt: now,
          minutes: null,
          taskId: null,
          projectId: null,
          ...data,
        };
      }),
      aggregate: jest.fn(async () => ({ _sum: { minutes: null } })),
      findMany: jest.fn(async () => []),
    },
    spPlannerInbox: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    spPlannerResource: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    withTenant: jest.fn(async (tenantId, fn) => {
      expect(tenantId).toBe(TENANT);
      return fn(tx);
    }),
  };
  const links = { validate: jest.fn(async () => undefined) };
  return {
    service: new PlannerService(
      prisma as unknown as PrismaService,
      links as unknown as PlannerLinksService,
    ),
    tx,
    writes,
    events,
    links,
  };
}

describe('Planner project and task access', () => {
  it('private projects hide records from outsiders', () =>
    expect(plannerProjectAccess(project(), 'user_outsider')).toBeNull());
  it('team projects allow editors, and explicit viewer grants override team defaults', () => {
    expect(plannerProjectAccess(project({ privacy: 'team' }), 'user_editor')).toBe('editor');
    expect(
      plannerProjectAccess(
        project({ privacy: 'team', members: [{ userId: 'user_editor', role: 'viewer' }] }),
        'user_editor',
      ),
    ).toBe('viewer');
  });
  it('the project owner retains administration', () =>
    expect(
      plannerProjectAccess(
        project({ members: [{ userId: 'user_owner', role: 'viewer' }] }),
        'user_owner',
      ),
    ).toBe('admin'));
  it('a task creator cannot read a revoked private project through creation alone', () =>
    expect(plannerTaskAccess(task(), [project()], 'user_outsider')).toBeNull());
  it('task assignees can access their assignment without a project-wide grant', () =>
    expect(
      plannerTaskAccess(task({ assigneeId: 'user_outsider' }), [project()], 'user_outsider'),
    ).toBe('editor'));
  it('collaborators can comment without editing', () =>
    expect(
      plannerTaskAccess(task({ collaborators: ['user_outsider'] }), [project()], 'user_outsider'),
    ).toBe('commenter'));
  it('personal tasks stay private to their owner, assignee and collaborators', () => {
    expect(plannerTaskAccess(task({ memberships: [] }), [], 'user_owner')).toBe('editor');
    expect(plannerTaskAccess(task({ memberships: [] }), [], 'user_outsider')).toBeNull();
  });
});
describe('Planner input and calendar validation', () => {
  it.each(['2026-02-30', '2026-13-01', '10/06/2026'])(
    'rejects impossible or ambiguous date %s',
    (dueOn) =>
      expect(() => validateTask({ ...PLANNER_DEFAULT_TASK, name: 'Task', dueOn })).toThrow(
        BadRequestException,
      ),
  );
  it('rejects inverted date ranges', () =>
    expect(() =>
      validateProject({
        ...PLANNER_DEFAULT_PROJECT,
        name: 'Project',
        startOn: '2026-10-07',
        dueOn: '2026-10-06',
      }),
    ).toThrow(BadRequestException));
  it('rejects unknown nested properties', () =>
    expect(() =>
      validateTask({
        ...PLANNER_DEFAULT_TASK,
        name: 'Task',
        recurrence: { frequency: 'daily', interval: 1, secret: true },
        dueOn: '2026-10-06',
      }),
    ).toThrow(BadRequestException));
  it('rejects repeated memberships', () =>
    expect(() =>
      validateTask({
        ...PLANNER_DEFAULT_TASK,
        name: 'Task',
        memberships: [
          { projectId: PROJECT, sectionId: null, position: 0 },
          { projectId: PROJECT, sectionId: null, position: 1 },
        ],
      }),
    ).toThrow(BadRequestException));
  it('clamps month-end recurring dates', () =>
    expect(nextPlannerDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28'));
  it('handles leap years and year boundaries', () => {
    expect(nextPlannerDate('2028-01-31', 'monthly', 1)).toBe('2028-02-29');
    expect(nextPlannerDate('2026-12-31', 'daily', 1)).toBe('2027-01-01');
  });
  it('detects indirect dependency cycles without rejecting converging paths', () => {
    expect(
      plannerDependencyCycle([
        { id: 'a', dependencies: ['b'] },
        { id: 'b', dependencies: ['c'] },
        { id: 'c', dependencies: ['a'] },
      ]),
    ).toBe(true);
    expect(
      plannerDependencyCycle([
        { id: 'a', dependencies: ['b', 'c'] },
        { id: 'b', dependencies: ['c'] },
        { id: 'c', dependencies: [] },
      ]),
    ).toBe(false);
  });
});
describe('Planner service mutation boundaries', () => {
  it('rejects an expected-version conflict before writing', async () => {
    const f = fixture();
    await expect(
      f.service.saveTask(ctx, TASK, { version: 2, data: { name: 'Overwrite' } }),
    ).rejects.toThrow(ConflictException);
    expect(f.writes).toHaveLength(0);
  });
  it('requires a version when patching', async () => {
    const f = fixture();
    await expect(
      f.service.saveProject(ctx, PROJECT, { data: { name: 'Overwrite' } }),
    ).rejects.toThrow(BadRequestException);
    expect(f.writes).toHaveLength(0);
  });
  it('does not return an existing task belonging to another tenant', async () => {
    const foreign = { ...task(), tenantId: OTHER };
    const f = fixture([project()], [foreign]);
    await expect(f.service.task(ctx, TASK)).rejects.toThrow(NotFoundException);
  });
  it('viewers cannot mutate tasks', async () => {
    const f = fixture([project({ members: [{ userId: 'user_editor', role: 'viewer' }] })]);
    await expect(
      f.service.saveTask({ ...ctx, clerkUserId: 'user_editor' }, TASK, {
        version: 1,
        data: { name: 'Overwrite' },
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(f.writes).toHaveLength(0);
  });
  it('editors cannot change project grants', async () => {
    const f = fixture([project({ privacy: 'team' })]);
    await expect(
      f.service.saveProject({ ...ctx, clerkUserId: 'user_editor' }, PROJECT, {
        version: 1,
        data: { members: [] },
      }),
    ).rejects.toThrow(ForbiddenException);
  });
  it('rejects assigning a person outside the active tenant roster', async () => {
    const f = fixture();
    await expect(
      f.service.saveTask(ctx, TASK, { version: 1, data: { assigneeId: 'user_foreign' } }),
    ).rejects.toThrow(BadRequestException);
  });
  it('rejects a section from another project', async () => {
    const f = fixture();
    await expect(
      f.service.saveTask(ctx, TASK, {
        version: 1,
        data: { memberships: [{ projectId: PROJECT, sectionId: TASK, position: 0 }] },
      }),
    ).rejects.toThrow(BadRequestException);
  });
  it('does not permit a self-dependency', async () => {
    const f = fixture();
    await expect(
      f.service.saveTask(ctx, TASK, { version: 1, data: { dependencies: [TASK] } }),
    ).rejects.toThrow(BadRequestException);
  });
  it('does not permit a subtask to be its own parent', async () => {
    const f = fixture();
    await expect(
      f.service.saveTask(ctx, TASK, { version: 1, data: { parentId: TASK } }),
    ).rejects.toThrow(BadRequestException);
  });
  it('creates the next recurrence exactly on transition to completed', async () => {
    const f = fixture(
      [project()],
      [task({ dueOn: '2026-10-06', recurrence: { frequency: 'weekly', interval: 2 } })],
    );
    await f.service.saveTask(ctx, TASK, { version: 1, data: { status: 'done' } });
    expect(f.tx.spPlannerTask.create).toHaveBeenCalledTimes(1);
    expect(f.tx.spPlannerTask.create.mock.calls[0]![0].data.data).toMatchObject({
      status: 'todo',
      dueOn: '2026-10-20',
    });
    await f.service.saveTask(ctx, TASK, { version: 2, data: { status: 'done' } });
    expect(f.tx.spPlannerTask.create).toHaveBeenCalledTimes(1);
  });
  it('serializes graph writes and forwards only user authorization for links', async () => {
    const f = fixture();
    await f.service.saveTask(
      ctx,
      TASK,
      { version: 1, data: { clientId: OTHER } },
      'Bearer user-token',
    );
    expect(f.tx.$executeRaw).toHaveBeenCalled();
    expect(f.links.validate).toHaveBeenCalledWith(
      { clientId: OTHER, meetingId: null },
      'Bearer user-token',
    );
    expect(JSON.stringify(f.writes)).not.toContain('user-token');
  });
  it('rechecks task grants when reading its activity', async () => {
    const f = fixture();
    await expect(
      f.service.events({ ...ctx, clerkUserId: 'user_outsider' }, { taskId: TASK }),
    ).rejects.toThrow(NotFoundException);
    expect(f.tx.spPlannerEvent.findMany).not.toHaveBeenCalled();
  });
});
describe('Planner migration', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20261006000000_planner/migration.sql'),
    'utf8',
  );
  it('adds tenant-scoped tables without destructive migration statements', () => {
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
      /\b(DROP|TRUNCATE|DELETE)\s+(TABLE|COLUMN|FROM)/i,
    );
  });
  it('covers every new table with RLS and keeps inbox event references tenant-bound', () => {
    for (const name of ['projects', 'tasks', 'events', 'inbox', 'resources'])
      expect(sql).toContain(`ALTER TABLE "sp_planner_${name}" ENABLE ROW LEVEL SECURITY`);
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "event_id")');
    expect(sql).toContain('Planner activity is append-only');
  });
});
