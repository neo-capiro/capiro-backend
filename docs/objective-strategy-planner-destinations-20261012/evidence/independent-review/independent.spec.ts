import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException, ParseUUIDPipe, ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLANNER_DEFAULT_TASK, PLANNER_DEFAULT_PROJECT } from '@capiro/strategy-verifier';
import { StrategyService } from '../../../../apps/api-strategy/src/strategy/strategy.service';
import { PlannerService } from '../../../../apps/api-strategy/src/planner/planner.service';
import { ObjectiveDestinationQueryDto, requireObjectiveDestinationRevision } from '../../../../apps/api-strategy/src/strategy/objective-destination';
import { requireClientObjectiveDestinationRevision, normalizeClientObjectiveDestination } from '../../../../packages/shared/src/client-objective-destination';
import { StrategyController } from '../../../../apps/api-strategy/src/strategy/strategy.controller';
import { PlannerController } from '../../../../apps/api-strategy/src/planner/planner.controller';
import { ClientObjectivesService } from '../../../../apps/api/src/clients/objectives/objectives.service';

const id = (n: number) => `abcdef12-1234-4000-8000-${n.toString().padStart(12, '0')}`;
const ctx = { tenantId: id(1), clerkUserId: 'user_independent', role: 'org:admin' };
const userId = id(2), resourceId = id(3), clientId = id(4), objectiveId = id(5), revisionId = id(6), projectId = id(7);
const binding = { clientId, objectiveId, objectiveVersion: 3 };
const now = new Date('2026-10-12T08:12:00Z');

function fixture() {
  const state = {
    tenant: ctx.tenantId, tenantStatus: 'active', memberStatus: 'active', memberRole: 'standard_user',
    userId, clerk: ctx.clerkUserId, clientId, clientStatus: 'active', clientExists: true,
    wall: true, grant: true, objectiveId, objectiveClient: clientId, objectiveExists: true,
    objectiveDeleted: false, version: 3, revisionExists: true, revisionId,
    strategyExists: true, failAt: '' as string, marker: new Error('INDEPENDENT_INFRASTRUCTURE_FAILURE'),
  };
  const strategy = { id: resourceId, tenantId: ctx.tenantId, clientId, archivedAt: null as Date | null, title: 'Live plan', nodes: [], artifacts: [] };
  const task = {
    id: resourceId, tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, assigneeId: null,
    projectIds: [] as string[], archived: false, version: 5, completedAt: null,
    data: { ...structuredClone(PLANNER_DEFAULT_TASK), name: 'Exact task', clientId } as any,
    createdAt: now, updatedAt: now,
  };
  const project = {
    id: projectId, tenantId: ctx.tenantId, ownerId: 'user_other', archived: false,
    data: { ...structuredClone(PLANNER_DEFAULT_PROJECT), name: 'Current project', privacy: 'private', members: [{ userId: ctx.clerkUserId, role: 'viewer' }] } as any,
    createdAt: now, updatedAt: now, version: 1,
  };
  const sql: Array<{ text: string; values: unknown[] }> = [];
  let taskPresent = true;
  const tx = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?'); sql.push({ text, values });
      const phase = text.includes('FROM sp_strategy') ? 'strategy' : text.includes('FROM tenants') ? 'scope' : text.includes('FROM client_memory_access') ? 'grant' : text.includes('FROM client_objectives') ? 'objective' : text.includes('FROM client_objective_revisions') ? 'revision' : 'other';
      if (state.failAt === phase) throw state.marker;
      if (phase === 'strategy') return state.strategyExists && strategy.tenantId === values[0] && strategy.id.toLowerCase() === String(values[1]).toLowerCase() && strategy.clientId.toLowerCase() === String(values[2]).toLowerCase() && !strategy.archivedAt ? [{ id: strategy.id }] : [];
      if (phase === 'scope') return values[0] === state.tenant && state.tenantStatus === 'active' && (values[1] === null || values[1] === state.userId) && values[2] === state.clerk && values[3] === state.clientId && state.memberStatus === 'active' && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.memberRole) && state.clientExists && state.clientStatus !== 'archived' ? [{ userId: state.userId, memoryWall: state.wall }] : [];
      if (phase === 'grant') return state.grant && values[0] === state.tenant && values[1] === state.clientId && values[2] === state.userId ? [{ id: id(8) }] : [];
      if (phase === 'objective') return state.objectiveExists && !state.objectiveDeleted && values[0] === state.tenant && values[1] === state.objectiveClient && values[2] === state.objectiveId ? [{ version: state.version }] : [];
      if (phase === 'revision') {
        // Model only the published SELECT/INSERT grant: locking SELECT is forbidden.
        if (/FOR\s+(?:SHARE|KEY\s+SHARE|UPDATE|NO\s+KEY\s+UPDATE)/i.test(text)) throw Object.assign(new Error('permission denied for table client_objective_revisions'), { code: '42501' });
        return state.revisionExists && values[0] === state.tenant && values[1] === state.objectiveClient && values[2] === state.objectiveId && values[3] === state.version ? [{ id: state.revisionId }] : [];
      }
      return [];
    }),
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => { sql.push({ text: parts.join('?'), values }); return 0; }),
    spStrategy: { findFirstOrThrow: jest.fn(async () => { if (state.failAt === 'projection') throw state.marker; return structuredClone(strategy); }) },
    spPlannerTask: {
      findFirst: jest.fn(async (args: any) => taskPresent && args.where.tenantId === task.tenantId && args.where.id === task.id ? structuredClone(task) : null),
      findMany: jest.fn(async () => []),
    },
    spPlannerProject: { findMany: jest.fn(async () => [structuredClone(project)]) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant, work) => work(tx)),
    withTenantUser: jest.fn(async (_tenant, _actor, work) => work(tx)),
  };
  const strategyOwner = new StrategyService(prisma as any, {} as any);
  const plannerOwner = new PlannerService(prisma as any, {} as any);
  const read = (owner: 'strategy' | 'planner', input = binding, actor = ctx, selectedResource = resourceId) => owner === 'strategy' ? strategyOwner.objectiveDestination(actor, selectedResource, input) : plannerOwner.objectiveDestination(actor, selectedResource, input);
  return { state, strategy, task, project, tx, prisma, sql, read, absentTask: () => { taskPresent = false; } };
}

describe('independent current Objective authority and resource owners', () => {
  it.each(['strategy', 'planner'] as const)('%s binds exact canonical resource and current revision without writes', async (owner) => {
    const f = fixture(); const result = await f.read(owner);
    expect(result.destination).toMatchObject({ kind: owner === 'strategy' ? 'strategy' : 'planner_task', resourceId, ...binding, objectiveRevisionId: revisionId });
    const scope = f.sql.find((q) => q.text.includes('FROM tenants'))!;
    for (const predicate of ["t.status::text='active'", "m.status::text='active'", "m.role::text IN ('standard_user','user_admin','capiro_admin')", 'u.clerk_user_id=?', "c.status::text<>'archived'", 'FOR SHARE OF t,m,u,c']) expect(scope.text).toContain(predicate);
    expect(scope.values).toEqual([ctx.tenantId, null, ctx.clerkUserId, clientId]);
    expect(f.sql.find((q) => q.text.includes('FROM client_memory_access'))!.values).toEqual([ctx.tenantId, clientId, userId]);
    expect(f.sql.find((q) => q.text.includes('FROM client_objectives'))!.text).toContain('deleted_at IS NULL FOR SHARE');
    const revision = f.sql.find((q) => q.text.includes('FROM client_objective_revisions'))!;
    expect(revision.text).not.toMatch(/FOR\s+(?:SHARE|UPDATE|KEY\s+SHARE|NO\s+KEY\s+UPDATE)/i);
    expect(revision.values).toEqual([ctx.tenantId, clientId, objectiveId, 3]);
    expect(f.sql.every((q) => !/\b(?:INSERT|UPDATE\s+\w|DELETE|TRUNCATE)\b/.test(q.text))).toBe(true);
  });
  it.each(['strategy', 'planner'] as const)('%s rechecks current tenant, member, role, client, wall and Objective on each open', async (owner) => {
    const changes: Array<[string, unknown]> = [['tenantStatus', 'suspended'], ['memberStatus', 'removed'], ['memberRole', 'client_user'], ['clerk', 'user_foreign'], ['clientExists', false], ['clientStatus', 'archived'], ['grant', false], ['objectiveExists', false], ['objectiveDeleted', true], ['objectiveClient', id(90)], ['revisionExists', false]];
    for (const [field, value] of changes) {
      const f = fixture(); await f.read(owner); (f.state as any)[field] = value;
      await expect(f.read(owner)).rejects.toBeInstanceOf(NotFoundException);
    }
  });
  it.each(['strategy', 'planner'] as const)('%s does not grant stale admin context an ethical-wall bypass', async (owner) => {
    const f = fixture(); f.state.memberRole = 'capiro_admin'; f.state.grant = false;
    await expect(f.read(owner)).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['strategy', 'planner'] as const)('%s rejects foreign actor tenant, wrong client, and foreign Objective scope', async (owner) => {
    const f = fixture();
    await expect(f.read(owner, binding, { ...ctx, tenantId: id(91) })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.read(owner, { ...binding, clientId: id(92) })).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.read(owner, { ...binding, objectiveId: id(93) })).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['strategy', 'planner'] as const)('%s returns authorized stale conflict and never reads a historical revision', async (owner) => {
    const f = fixture(); f.state.version = 4;
    await expect(f.read(owner)).rejects.toBeInstanceOf(ConflictException);
    expect(f.sql.some((q) => q.text.includes('FROM client_objective_revisions'))).toBe(false);
    f.state.grant = false;
    await expect(f.read(owner)).rejects.toBeInstanceOf(NotFoundException);
  });
  it.each(['strategy', 'planner'] as const)('%s supports current unwalled clients without requiring an invented grant', async (owner) => {
    const f = fixture(); f.state.wall = false; f.state.grant = false;
    await expect(f.read(owner)).resolves.toHaveProperty('destination.objectiveRevisionId', revisionId);
    expect(f.sql.some((q) => q.text.includes('FROM client_memory_access'))).toBe(false);
  });
  it.each(['strategy', 'planner'] as const)('%s propagates every infrastructure phase failure without rewriting it as authority', async (owner) => {
    for (const phase of ['scope', 'grant', 'objective', 'revision']) {
      const f = fixture(); f.state.failAt = phase;
      await expect(f.read(owner)).rejects.toBe(f.state.marker);
    }
  });
  it('preserves exact Core UUID/Clerk agreement while resolving non-Core callers through current membership', async () => {
    const f = fixture(); await requireClientObjectiveDestinationRevision(f.tx, { ...ctx, userId }, binding);
    expect(f.sql[0]!.values).toEqual([ctx.tenantId, userId, ctx.clerkUserId, clientId]);
    await expect(requireClientObjectiveDestinationRevision(f.tx, { ...ctx, userId: id(94) }, binding)).rejects.toMatchObject({ code: 'OBJECTIVE_DESTINATION_NOT_FOUND' });
    await expect(requireClientObjectiveDestinationRevision(f.tx, { ...ctx, clerkUserId: 'user_foreign' }, binding)).rejects.toMatchObject({ code: 'OBJECTIVE_DESTINATION_NOT_FOUND' });
  });
  it('uses the actual resolved UUID for a wall grant and never treats a Clerk subject as a UUID', async () => {
    const f = fixture(); await requireObjectiveDestinationRevision(f.tx, ctx, binding);
    expect(f.sql[0]!.text).toContain('m.user_id=COALESCE(?::uuid,u.id)');
    expect(f.sql[0]!.text).not.toContain('clerk_user_id=?::uuid');
    expect(f.sql[1]!.values[2]).toBe(userId); expect(f.sql[1]!.values[2]).not.toBe(ctx.clerkUserId);
  });
  it('keeps mutable parent/current locks while reading the immutable revision with original grants', () => {
    const sql = readFileSync(resolve(__dirname, '../../../../apps/api/prisma/migrations/20281011010000_client_objectives/migration.sql'), 'utf8');
    expect(sql).toContain('REVOKE UPDATE, DELETE ON client_objective_revisions FROM capiro_app');
    expect(sql).toContain('GRANT SELECT, INSERT ON client_objective_revisions TO capiro_app');
    expect(sql).toContain('REFERENCES client_objectives(tenant_id, client_id, id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE (tenant_id, objective_id, version)');
  });
  it('Strategy rejects archival/client mismatch before loading resource content or Objective state', async () => {
    for (const kind of ['archived', 'foreign_client', 'foreign_tenant', 'missing']) {
      const f = fixture();
      if (kind === 'archived') f.strategy.archivedAt = now;
      if (kind === 'foreign_client') f.strategy.clientId = id(95);
      if (kind === 'foreign_tenant') f.strategy.tenantId = id(96);
      if (kind === 'missing') f.state.strategyExists = false;
      await expect(f.read('strategy')).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.spStrategy.findFirstOrThrow).not.toHaveBeenCalled();
      expect(f.sql.some((q) => q.text.includes('FROM tenants'))).toBe(false);
    }
  });
  it('Strategy retains live node/artifact filtering and canonical mutation lock serialization', async () => {
    const f = fixture(); await f.read('strategy');
    const projection = f.tx.spStrategy.findFirstOrThrow.mock.calls[0]?.[0] as any;
    expect(projection.include.nodes.where).toMatchObject({ archivedAt: null });
    expect(projection.include.artifacts.where).toMatchObject({ detachedAt: null });
    expect(f.sql[0]!.text).toContain('FOR SHARE');
    const mutation = readFileSync(resolve(__dirname, '../../../../apps/api-strategy/src/strategy/mutation-lock.ts'), 'utf8');
    expect(mutation).toContain('FOR UPDATE');
    f.state.failAt = 'projection'; await expect(f.read('strategy')).rejects.toBe(f.state.marker);
  });
  it('Planner acquires the same exact tenant advisory lock before any task/project authority read', async () => {
    const f = fixture(); await f.read('planner');
    expect(f.sql[0]!).toMatchObject({ values: [`planner:${ctx.tenantId}`] });
    expect(f.sql[0]!.text).toContain('pg_advisory_xact_lock(hashtextextended');
    expect(f.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(f.tx.spPlannerTask.findFirst.mock.invocationCallOrder[0]!);
    expect(f.tx.spPlannerTask.findFirst.mock.calls[0]![0]).toEqual({ where: { tenantId: ctx.tenantId, id: resourceId } });
  });
  it('Planner refuses absent/archived/foreign-tenant task without Objective reads', async () => {
    for (const kind of ['missing', 'archived', 'foreign_tenant']) {
      const f = fixture();
      if (kind === 'missing') f.absentTask();
      if (kind === 'archived') f.task.archived = true;
      if (kind === 'foreign_tenant') f.task.tenantId = id(97);
      await expect(f.read('planner')).rejects.toBeInstanceOf(NotFoundException);
      expect(f.sql.some((q) => q.text.includes('FROM tenants'))).toBe(false);
    }
  });
  it('Planner requires explicit task client and never derives one from projects, meeting or parent', async () => {
    for (const value of [null, '', id(98), [clientId]]) {
      const f = fixture(); f.task.data.clientId = value; f.task.data.meetingId = clientId; f.task.data.parentId = clientId; f.project.data.clientId = clientId;
      await expect(f.read('planner')).rejects.toBeInstanceOf(NotFoundException);
      expect(f.sql.some((q) => q.text.includes('FROM tenants'))).toBe(false);
    }
  });
  it('Planner current project grant is authoritative even for task owner/admin context', async () => {
    const f = fixture(); f.task.projectIds = [projectId]; f.task.data.memberships = [{ projectId, sectionId: null, position: 0 }];
    await expect(f.read('planner')).resolves.toHaveProperty('task.access', 'viewer');
    f.project.data.members = [];
    await expect(f.read('planner')).rejects.toBeInstanceOf(NotFoundException);
  });
  it('Planner preserves addressed assignee and collaborator reads and revocation', async () => {
    for (const kind of ['assigneeId', 'collaborators']) {
      const f = fixture(); f.task.ownerId = 'user_other';
      f.task.data[kind] = kind === 'assigneeId' ? ctx.clerkUserId : [ctx.clerkUserId];
      await expect(f.read('planner')).resolves.toHaveProperty('destination.destinationVersion', 5);
      f.task.data[kind] = kind === 'assigneeId' ? null : [];
      await expect(f.read('planner')).rejects.toBeInstanceOf(NotFoundException);
    }
  });
  it('Planner does not expose unreadable project membership/fields or dependency references', async () => {
    const f = fixture(); const privateId = id(99); f.task.data.memberships = [{ projectId: privateId, sectionId: null, position: 0 }];
    f.task.data.collaborators = [ctx.clerkUserId]; f.task.data.customValues = { privateField: 'private value' }; f.task.data.dependencies = [privateId]; f.task.data.parentId = privateId;
    const result = await f.read('planner') as any;
    expect(result.task.memberships).toEqual([]); expect(result.task.customValues).toEqual({}); expect(result.task.dependencies).toEqual([]); expect(result.task.parentId).toBeNull();
  });
  it.each(['strategy', 'planner'] as const)('%s normalizes UUID case and rejects forged canonical revision/kind through scalar bounds', async (owner) => {
    const f = fixture(); await expect(f.read(owner, { ...binding, clientId: clientId.toUpperCase(), objectiveId: objectiveId.toUpperCase() })).resolves.toMatchObject({ destination: { ...binding } });
    for (const value of [null, [clientId], { toString: () => clientId }]) await expect(f.read(owner, { ...binding, clientId: value } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('final shared scalar guards reject arrays/coercion objects for both UUIDs before SQL', async () => {
    const f = fixture();
    for (const key of ['clientId', 'objectiveId']) for (const value of [null, [binding[key as 'clientId']], { toString: () => binding[key as 'clientId'] }]) {
      expect(() => normalizeClientObjectiveDestination({ ...binding, [key]: value } as any)).toThrow('OBJECTIVE_DESTINATION_INVALID');
      await expect(requireClientObjectiveDestinationRevision(f.tx, ctx, { ...binding, [key]: value } as any)).rejects.toMatchObject({ code: 'OBJECTIVE_DESTINATION_INVALID' });
    }
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('Strategy awaits resource authority and rechecks membership changed before its scope lock', async () => {
    const f = fixture(); const actual = f.tx.$queryRaw.getMockImplementation()!;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    f.tx.$queryRaw.mockImplementationOnce(async (...args: any[]) => { await gate; return actual(...args); });
    const read = f.read('strategy');
    expect(f.tx.spStrategy.findFirstOrThrow).not.toHaveBeenCalled();
    f.state.memberStatus = 'removed'; release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.spStrategy.findFirstOrThrow).not.toHaveBeenCalled();
  });
  it('Planner checks current project ACL after waiting for its task read', async () => {
    const f = fixture(); f.task.projectIds = [projectId]; f.task.data.memberships = [{ projectId, sectionId: null, position: 0 }];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    f.tx.spPlannerTask.findFirst.mockImplementationOnce(async () => { await gate; return structuredClone(f.task); });
    const read = f.read('planner'); f.project.data.members = []; release();
    await expect(read).rejects.toBeInstanceOf(NotFoundException);
    expect(f.sql.some((q) => q.text.includes('FROM tenants'))).toBe(false);
  });
  it.each(['strategy', 'planner'] as const)('%s refetches canonical revision/owner version on retry without a durable association', async (owner) => {
    const f = fixture(); const first = await f.read(owner);
    f.state.version = 4; f.state.revisionId = id(101); f.task.version = 6;
    await expect(f.read(owner)).rejects.toBeInstanceOf(ConflictException);
    const refreshed = await f.read(owner, { ...binding, objectiveVersion: 4 });
    expect(first.destination.objectiveRevisionId).toBe(revisionId);
    expect(refreshed.destination.objectiveRevisionId).toBe(id(101));
    if (owner === 'planner') expect(refreshed.destination).toHaveProperty('destinationVersion', 6);
  });
  it('Core delegates to this same canonical helper while preserving its exact actor UUID pin', async () => {
    const f = fixture(); const owner = new ClientObjectivesService({} as any);
    await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, { ...ctx, userId } as any, binding)).resolves.toEqual({ ...binding, objectiveRevisionId: revisionId });
    expect(f.sql[0]!.values).toEqual([ctx.tenantId, userId, ctx.clerkUserId, clientId]);
    await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, { ...ctx, userId: id(102) } as any, binding)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('Core preserves mapped invalid/stale/unavailable errors and untouched infrastructure failures', async () => {
    const f = fixture(); const owner = new ClientObjectivesService({} as any); const actor = { ...ctx, userId } as any;
    await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, actor, { ...binding, clientId: [clientId] } as any)).rejects.toBeInstanceOf(BadRequestException);
    f.state.version = 4; await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, actor, binding)).rejects.toBeInstanceOf(ConflictException);
    f.state.grant = false; await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, actor, binding)).rejects.toBeInstanceOf(NotFoundException);
    f.state.grant = true; f.state.failAt = 'scope'; await expect(owner.requireDestinationRevisionWithinTx(f.tx as any, actor, binding)).rejects.toBe(f.state.marker);
  });
});

describe('independent strict destination transport without a database or provider', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (input: unknown) => pipe.transform(input, { type: 'query', metatype: ObjectiveDestinationQueryDto });
  it('supports exact required scalar query and marks both owner responses private/no-store', async () => {
    await expect(validate({ ...binding, objectiveVersion: '3' })).resolves.toMatchObject(binding);
    for (const controller of [StrategyController, PlannerController]) expect(Reflect.getMetadata('__headers__', controller.prototype.objectiveDestination)).toContainEqual({ name: 'Cache-Control', value: 'private, no-store' });
  });
  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('refuses absent %s', async (field) => {
    const value = { ...binding } as any; delete value[field]; await expect(validate(value)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('refuses duplicate/nested scalar %s', async (field) => {
    for (const value of [[String((binding as any)[field])], [String((binding as any)[field]), String((binding as any)[field])], { nested: (binding as any)[field] }]) await expect(validate({ ...binding, [field]: value })).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each(['kind', 'url', 'resourceId', 'objectiveRevisionId', 'tenantId', 'userId', 'clerkUserId', 'snapshotHash'])('refuses browser-supplied %s claim', async (field) => {
    await expect(validate({ ...binding, [field]: resourceId })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('bounds numeric version and resource UUID independently before owner methods', async () => {
    for (const value of ['0', '-1', '1.5', '2147483648', 'NaN', 'Infinity', '']) await expect(validate({ ...binding, objectiveVersion: value })).rejects.toBeInstanceOf(BadRequestException);
    const uuid = new ParseUUIDPipe(); await expect(uuid.transform('not-an-id', { type: 'param' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
