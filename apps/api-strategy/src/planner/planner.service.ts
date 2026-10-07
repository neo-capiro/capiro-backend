import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  nextPlannerSchedule,
  plannerDueTimestamp,
  plannerDependencyCycle,
  type PlannerBootstrap,
  type PlannerProject,
  type PlannerProjectData,
  type PlannerTask,
  type PlannerTaskData,
  type PlannerRole,
  type PlannerPerson,
  type PlannerEvent,
  type PlannerInboxItem,
  type PlannerActivityPage,
  type PlannerResource,
  type PlannerResourceKind,
  type PlannerRuleData,
  type PlannerFormData,
  type PlannerTemplateData,
  type PlannerPublicForm,
} from '@capiro/strategy-verifier';
import {
  Prisma,
  type SpPlannerProject,
  type SpPlannerTask,
  type SpPlannerEvent,
  type SpPlannerResource,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PlannerLinksService } from './planner-links.service.js';
import {
  fail,
  keys,
  object,
  uuid,
  validateMutation,
  validateProject,
  validateTask,
  validatePlannerFieldValue,
} from './planner.validation.js';
import { RESOURCE_KINDS, validateResource, applyPlannerRule } from './planner-resources.js';

type Tx = Prisma.TransactionClient;
type ActivityQuery = { paged?: string; cursor?: string; archived?: string };
function activityQuery(query: ActivityQuery, inbox = false) {
  keys(query, inbox ? ['paged', 'cursor', 'archived'] : ['paged', 'cursor']);
  if (query.paged !== undefined && !['true', 'false'].includes(query.paged))
    fail('Invalid activity pagination');
  if (query.cursor !== undefined) {
    uuid(query.cursor);
    if (query.paged !== 'true') fail('A cursor requires paginated activity');
  }
  if (query.archived !== undefined && !['true', 'false'].includes(query.archived))
    fail('Invalid inbox filter');
  return query.paged === 'true';
}
const RANK: Record<PlannerRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };
const json = (data: unknown) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
const projectData = (row: SpPlannerProject) => row.data as unknown as PlannerProjectData;
const taskData = (row: SpPlannerTask): PlannerTaskData => {
  const {
    recurrenceSuccessorId: _successor,
    deadlineAt: _deadline,
    ...data
  } = row.data as Record<string, unknown>;
  return { ...PLANNER_DEFAULT_TASK, ...data } as unknown as PlannerTaskData;
};
const missing = () => new NotFoundException('Planner record not found');
const storedTaskData = (data: PlannerTaskData, previous?: SpPlannerTask, successorId?: string) => {
  const previousSuccessor = previous
    ? (previous.data as Record<string, unknown>).recurrenceSuccessorId
    : undefined;
  return json({
    ...data,
    ...(data.dueOn ? { deadlineAt: new Date(plannerDueTimestamp(data)).toISOString() } : {}),
    ...(successorId || previousSuccessor
      ? { recurrenceSuccessorId: successorId ?? previousSuccessor }
      : {}),
  });
};
export function plannerProjectAccess(
  project: Pick<SpPlannerProject, 'ownerId' | 'data'>,
  userId: string,
): PlannerRole | null {
  const data = projectData(project as SpPlannerProject);
  if (project.ownerId === userId) return 'admin';
  const grant = data.members.find((m) => m.userId === userId);
  return grant?.role ?? (data.privacy === 'team' ? 'editor' : null);
}
export function plannerTaskAccess(
  task: Pick<SpPlannerTask, 'ownerId' | 'data'>,
  projects: SpPlannerProject[],
  userId: string,
): PlannerRole | null {
  const data = taskData(task as SpPlannerTask);
  const roles = data.memberships.flatMap((m) => {
    const p = projects.find((p) => p.id === m.projectId);
    const role = p && plannerProjectAccess(p, userId);
    return role ? [role] : [];
  });
  if ((!data.memberships.length && task.ownerId === userId) || data.assigneeId === userId)
    roles.push('editor');
  if (data.collaborators.includes(userId)) roles.push('commenter');
  return roles.sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
}
function requireRole(role: PlannerRole | null, minimum: PlannerRole) {
  if (!role) throw missing();
  if (RANK[role] < RANK[minimum])
    throw new ForbiddenException(`Planner ${minimum} access is required`);
}
function version(current: number, expected: number | undefined) {
  if (expected === undefined) fail('An expected version is required');
  if (current !== expected)
    throw new ConflictException('This record changed. Refresh before saving again.');
}

@Injectable()
export class PlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: PlannerLinksService,
  ) {}

  private scope<T>(ctx: AuthTenantContext, run: (tx: Tx) => Promise<T>, write = false): Promise<T> {
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        // Serialize graph/config mutations. Project grants cannot race task writes,
        // and concurrent dependency changes cannot jointly introduce a cycle.
        if (write)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${ctx.tenantId}`}, 0))`;
        return run(tx);
      },
      { timeoutMs: 15_000 },
    );
  }
  private async people(tx: Tx, ctx: AuthTenantContext): Promise<PlannerPerson[]> {
    return tx.$queryRaw<PlannerPerson[]>`
      SELECT u.clerk_user_id AS id,
        COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email::text) AS name
      FROM users u JOIN tenant_memberships m ON m.user_id = u.id
      WHERE m.tenant_id = ${ctx.tenantId}::uuid AND m.status = 'active'
      ORDER BY name`;
  }
  private projects(tx: Tx, ctx: AuthTenantContext) {
    return tx.spPlannerProject.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }
  private projectView(row: SpPlannerProject, ctx: AuthTenantContext): PlannerProject {
    const access = plannerProjectAccess(row, ctx.clerkUserId);
    requireRole(access, 'viewer');
    return {
      ...projectData(row),
      id: row.id,
      ownerId: row.ownerId,
      version: row.version,
      archived: row.archived,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      access: access!,
    };
  }
  private async taskView(
    tx: Tx,
    row: SpPlannerTask,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
    batch?: { minutes: Map<string, number>; references: SpPlannerTask[] },
  ): Promise<PlannerTask> {
    const access = plannerTaskAccess(row, projects, ctx.clerkUserId);
    requireRole(access, 'viewer');
    const data = taskData(row);
    const memberships = data.memberships.filter((m) =>
      projects.some((p) => p.id === m.projectId && plannerProjectAccess(p, ctx.clerkUserId)),
    );
    const visibleFieldIds = new Set(
      memberships.flatMap((m) =>
        projectData(projects.find((p) => p.id === m.projectId)!).fields.map((f) => f.id),
      ),
    );
    const customValues = Object.fromEntries(
      Object.entries(data.customValues).filter(([id]) => visibleFieldIds.has(id)),
    );
    const actualMinutes = batch
      ? (batch.minutes.get(row.id) ?? 0)
      : ((
          await tx.spPlannerEvent.aggregate({
            where: { tenantId: ctx.tenantId, taskId: row.id, kind: 'time' },
            _sum: { minutes: true },
          })
        )._sum.minutes ?? 0);
    // Dependency references are subject to their own task grants.
    const references =
      batch?.references ??
      (await tx.spPlannerTask.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: [...data.dependencies, ...(data.parentId ? [data.parentId] : [])] },
        },
      }));
    const visible = new Set(
      references.filter((t) => plannerTaskAccess(t, projects, ctx.clerkUserId)).map((t) => t.id),
    );
    return {
      ...data,
      memberships,
      customValues,
      dependencies: data.dependencies.filter((id) => visible.has(id)),
      parentId: data.parentId && visible.has(data.parentId) ? data.parentId : null,
      id: row.id,
      ownerId: row.ownerId,
      version: row.version,
      archived: row.archived,
      completedAt: row.completedAt?.toISOString() ?? null,
      actualMinutes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      access: access!,
    };
  }
  async bootstrap(ctx: AuthTenantContext): Promise<PlannerBootstrap> {
    return this.scope(ctx, async (tx) => {
      const people = await this.people(tx, ctx);
      const me = people.find((p) => p.id === ctx.clerkUserId);
      if (!me) throw new ForbiddenException('Active Capiro membership is required');
      const projects = (await this.projects(tx, ctx))
        .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
        .map((p) => this.projectView(p, ctx));
      return { me, people, projects };
    });
  }
  async saveProject(
    ctx: AuthTenantContext,
    id: string | null,
    raw: unknown,
    authorization?: string,
  ) {
    const dto = validateMutation(raw);
    if (id) uuid(id);
    // Verify link access before entering a transaction. No external request is
    // made under the DB lock, and the user bearer is never stored.
    if (Object.hasOwn(dto.data, 'clientId') && dto.data.clientId) {
      uuid(dto.data.clientId);
      await this.links.validate({ clientId: String(dto.data.clientId) }, authorization);
    }
    return this.scope(
      ctx,
      async (tx) => {
        const old = id
          ? await tx.spPlannerProject.findFirst({ where: { tenantId: ctx.tenantId, id } })
          : null;
        if (id && !old) throw missing();
        if (old) {
          requireRole(plannerProjectAccess(old, ctx.clerkUserId), 'editor');
          version(old.version, dto.version);
          if (
            ['members', 'privacy'].some((k) => Object.hasOwn(dto.data, k)) ||
            dto.archived !== undefined
          )
            requireRole(plannerProjectAccess(old, ctx.clerkUserId), 'admin');
        }
        const data = validateProject({
          ...(old ? projectData(old) : PLANNER_DEFAULT_PROJECT),
          ...dto.data,
        });
        const activePeople = await this.people(tx, ctx);
        const people = new Set(activePeople.map((p) => p.id));
        if (!people.has(ctx.clerkUserId) || data.members.some((m) => !people.has(m.userId)))
          fail('Project members must belong to your active Capiro team');
        // Deleting a section/field leaves no dangling task configuration.
        if (old) {
          const tasks = await tx.spPlannerTask.findMany({
            where: { tenantId: ctx.tenantId, projectIds: { has: old.id } },
          });
          const fields = new Set(data.fields.map((f) => f.id));
          const sections = new Set(data.sections.map((s) => s.id));
          for (const task of tasks) {
            const td = taskData(task);
            for (const [fieldId, value] of Object.entries(td.customValues)) {
              const field = data.fields.find((f) => f.id === fieldId);
              if (field)
                try {
                  validatePlannerFieldValue(field, value);
                } catch {
                  fail(`Update existing task values before changing the field ${field.name}`);
                }
            }
            const next = {
              ...td,
              memberships: td.memberships.map((m) =>
                m.projectId === old.id && m.sectionId && !sections.has(m.sectionId)
                  ? { ...m, sectionId: null }
                  : m,
              ),
              customValues: Object.fromEntries(
                Object.entries(td.customValues).filter(
                  ([key]) => !projectData(old).fields.some((f) => f.id === key) || fields.has(key),
                ),
              ),
            };
            if (JSON.stringify(next) !== JSON.stringify(td))
              await tx.spPlannerTask.update({
                where: { id: task.id, tenantId: ctx.tenantId },
                data: { data: storedTaskData(next, task), version: { increment: 1 } },
              });
          }
        }
        const row = old
          ? await tx.spPlannerProject.update({
              where: { id: old.id, tenantId: ctx.tenantId },
              data: {
                data: json(data),
                version: { increment: 1 },
                ...(dto.archived === undefined ? {} : { archived: dto.archived }),
              },
            })
          : await tx.spPlannerProject.create({
              data: { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, data: json(data) },
            });
        await this.event(
          tx,
          ctx,
          {
            projectId: row.id,
            kind: old
              ? dto.archived === undefined
                ? 'updated'
                : dto.archived
                  ? 'archived'
                  : 'restored'
              : 'created',
            text: old ? 'Updated project' : 'Created project',
          },
          data.members.map((m) => m.userId),
        );
        return this.projectView(row, ctx);
      },
      true,
    );
  }
  async tasks(
    ctx: AuthTenantContext,
    query: {
      projectId?: string;
      mine?: string;
      cursor?: string;
      search?: string;
      archived?: string;
      parentId?: string;
    },
  ) {
    if (query.projectId) uuid(query.projectId);
    if (query.parentId) uuid(query.parentId);
    if (query.cursor) uuid(query.cursor);
    if ((query.search?.length ?? 0) > 200) fail('Search is too long');
    return this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const visible = projects.filter((p) => plannerProjectAccess(p, ctx.clerkUserId));
      if (query.projectId && !visible.some((p) => p.id === query.projectId)) throw missing();
      const where: Prisma.SpPlannerTaskWhereInput = {
        tenantId: ctx.tenantId,
        archived: query.archived === 'true',
        ...(query.projectId ? { projectIds: { has: query.projectId } } : {}),
        ...(query.parentId ? { parentId: query.parentId } : {}),
        ...(query.mine === 'true' ? { assigneeId: ctx.clerkUserId } : {}),
        ...(query.search ? { data: { path: ['name'], string_contains: query.search } } : {}),
        AND: [
          {
            OR: [
              { projectIds: { hasSome: visible.map((p) => p.id) } },
              { projectIds: { isEmpty: true }, ownerId: ctx.clerkUserId },
              { assigneeId: ctx.clerkUserId },
              { data: { path: ['collaborators'], array_contains: [ctx.clerkUserId] } },
            ],
          },
        ],
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      };
      const rows = await tx.spPlannerTask.findMany({ where, orderBy: { id: 'asc' }, take: 101 });
      const selected = rows.slice(0, 100);
      const sums = await tx.spPlannerEvent.groupBy({
        by: ['taskId'],
        where: { tenantId: ctx.tenantId, taskId: { in: selected.map((t) => t.id) }, kind: 'time' },
        _sum: { minutes: true },
      });
      const referenceIds = [
        ...new Set(
          selected.flatMap((row) => [
            ...taskData(row).dependencies,
            ...(row.parentId ? [row.parentId] : []),
          ]),
        ),
      ];
      const references = referenceIds.length
        ? await tx.spPlannerTask.findMany({
            where: { tenantId: ctx.tenantId, id: { in: referenceIds } },
          })
        : [];
      const batch = {
        minutes: new Map(sums.map((s) => [s.taskId!, s._sum.minutes ?? 0])),
        references,
      };
      return {
        items: await Promise.all(
          selected.map((row) => this.taskView(tx, row, projects, ctx, batch)),
        ),
        nextCursor: rows.length > 100 ? selected.at(-1)!.id : null,
      };
    });
  }
  async task(ctx: AuthTenantContext, id: string) {
    uuid(id);
    return this.scope(ctx, async (tx) => {
      const row = await tx.spPlannerTask.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!row) throw missing();
      return this.taskView(tx, row, await this.projects(tx, ctx), ctx);
    });
  }
  async queue(ctx: AuthTenantContext): Promise<PlannerTask[]> {
    return this.scope(ctx, async (tx) => {
      // Sort in storage before limiting; a UUID page cannot determine which
      // assigned tasks are actually due next on the Dashboard.
      const ids = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM sp_planner_tasks
        WHERE tenant_id = ${ctx.tenantId}::uuid AND assignee_id = ${ctx.clerkUserId}
          AND archived = false AND data->>'status' <> 'done'
        ORDER BY COALESCE(NULLIF(data->>'deadlineAt', '')::timestamptz,
          (NULLIF(data->>'dueOn', '')::date +
          COALESCE(NULLIF(data->>'dueTime', ''), '23:59:59.999')::time)
          AT TIME ZONE COALESCE(NULLIF(data->>'timeZone', ''), 'UTC')) ASC NULLS LAST,
          created_at ASC LIMIT 5`;
      const rows = await tx.spPlannerTask.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ids.map((t) => t.id) } },
      });
      const projects = await this.projects(tx, ctx);
      return Promise.all(
        ids.map((item) =>
          this.taskView(
            tx,
            rows.find((t) => t.id === item.id)!,
            projects,
            ctx,
          ),
        ),
      );
    });
  }
  async saveTask(ctx: AuthTenantContext, id: string | null, raw: unknown, authorization?: string) {
    if (id) uuid(id);
    const dto = validateMutation(raw);
    const linkData = { clientId: dto.data.clientId ?? null, meetingId: dto.data.meetingId ?? null };
    if (linkData.clientId) uuid(linkData.clientId);
    if (linkData.meetingId) uuid(linkData.meetingId);
    if (linkData.clientId || linkData.meetingId)
      await this.links.validate(
        linkData as { clientId: string | null; meetingId: string | null },
        authorization,
      );
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const old = id
          ? await tx.spPlannerTask.findFirst({ where: { tenantId: ctx.tenantId, id } })
          : null;
        if (id && !old) throw missing();
        if (old) {
          requireRole(plannerTaskAccess(old, projects, ctx.clerkUserId), 'editor');
          version(old.version, dto.version);
        }
        const candidate = { ...(old ? taskData(old) : PLANNER_DEFAULT_TASK), ...dto.data };
        if (
          old &&
          Object.hasOwn(dto.data, 'dueOn') &&
          candidate.dueOn &&
          candidate.dueOn !== taskData(old).dueOn &&
          candidate.recurrence
        ) {
          candidate.recurrence = {
            ...object(candidate.recurrence),
            anchorOn: candidate.dueOn,
          } as unknown as PlannerTaskData['recurrence'];
        }
        let data = validateTask(candidate);
        if (old) {
          const previous = taskData(old);
          // Preserve properties omitted from an ACL-redacted response. A caller
          // can only change memberships and field values for projects they see.
          if (Object.hasOwn(dto.data, 'memberships')) {
            const hidden = previous.memberships.filter((m) => {
              const p = projects.find((p) => p.id === m.projectId);
              return p && !plannerProjectAccess(p, ctx.clerkUserId);
            });
            data = {
              ...data,
              memberships: [
                ...data.memberships,
                ...hidden.filter((m) => !data.memberships.some((n) => n.projectId === m.projectId)),
              ],
            };
          }
          if (Object.hasOwn(dto.data, 'customValues'))
            data = { ...data, customValues: { ...previous.customValues, ...data.customValues } };
        }
        const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
        if (
          !people.has(ctx.clerkUserId) ||
          [data.assigneeId, ...data.collaborators].some((p) => p && !people.has(p))
        )
          fail('Assign tasks only to active members of your Capiro team');
        const all = await tx.spPlannerTask.findMany({ where: { tenantId: ctx.tenantId } });
        if (data.parentId && (!old || data.parentId !== taskData(old).parentId)) {
          const parent = all.find((t) => t.id === data.parentId && !t.archived);
          if (!parent) throw missing();
          requireRole(plannerTaskAccess(parent, projects, ctx.clerkUserId), 'editor');
          if (!data.memberships.length)
            data = {
              ...data,
              memberships: taskData(parent).memberships.filter((m) => {
                const p = projects.find((p) => p.id === m.projectId);
                return (
                  p && ['admin', 'editor'].includes(plannerProjectAccess(p, ctx.clerkUserId) ?? '')
                );
              }),
            };
          const ancestors = new Set<string>(id ? [id] : []);
          let ancestor: SpPlannerTask | undefined = parent;
          while (ancestor) {
            if (ancestors.has(ancestor.id)) fail('Subtasks cannot form a cycle');
            ancestors.add(ancestor.id);
            ancestor = all.find((t) => t.id === taskData(ancestor!).parentId);
          }
        }
        // A caller cannot remove a private project they cannot administer by
        // round-tripping a redacted task. Patch only the visible fields instead.
        if (old && Object.hasOwn(dto.data, 'memberships')) {
          for (const m of taskData(old).memberships)
            if (!data.memberships.some((n) => n.projectId === m.projectId)) {
              const p = projects.find((p) => p.id === m.projectId);
              requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'editor');
            }
        }
        for (const m of data.memberships) {
          const p = projects.find((p) => p.id === m.projectId);
          if (!p || p.archived) fail('Project is unavailable');
          // Edits in one authorized project are allowed, but adding/moving a task
          // into a project requires edit access to that destination.
          if (
            !old ||
            !taskData(old).memberships.some(
              (n) =>
                n.projectId === m.projectId &&
                n.sectionId === m.sectionId &&
                n.position === m.position,
            )
          )
            requireRole(plannerProjectAccess(p, ctx.clerkUserId), 'editor');
          if (m.sectionId && !projectData(p).sections.some((s) => s.id === m.sectionId))
            fail('Section does not belong to the project');
        }
        const fieldDefinitions = data.memberships.flatMap(
          (m) => projectData(projects.find((p) => p.id === m.projectId)!).fields,
        );
        if (old && Object.hasOwn(dto.data, 'memberships'))
          data = {
            ...data,
            customValues: Object.fromEntries(
              Object.entries(data.customValues).filter(([id]) =>
                fieldDefinitions.some((f) => f.id === id),
              ),
            ),
          };
        for (const [fieldId, value] of Object.entries(data.customValues)) {
          const field = fieldDefinitions.find((f) => f.id === fieldId);
          if (!field) fail('Unknown custom field');
          if (
            Object.hasOwn(object(dto.data.customValues ?? {}), fieldId) &&
            (!old || JSON.stringify(taskData(old).customValues[fieldId]) !== JSON.stringify(value))
          ) {
            const p = projects.find((p) => projectData(p).fields.some((f) => f.id === fieldId));
            requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'editor');
          }
          validatePlannerFieldValue(field, value);
        }
        const newId = id ?? randomUUID();
        if (old && Object.hasOwn(dto.data, 'dependencies')) {
          const hidden = taskData(old).dependencies.filter((id) => {
            const dependency = all.find((t) => t.id === id);
            return dependency && !plannerTaskAccess(dependency, projects, ctx.clerkUserId);
          });
          data = { ...data, dependencies: [...new Set([...data.dependencies, ...hidden])] };
        }
        for (const dependencyId of data.dependencies) {
          if (old && taskData(old).dependencies.includes(dependencyId)) continue;
          const dependency = all.find((t) => t.id === dependencyId && !t.archived);
          if (!dependency) throw missing();
          requireRole(plannerTaskAccess(dependency, projects, ctx.clerkUserId), 'viewer');
        }
        const graph = all
          .filter((t) => t.id !== newId)
          .map((t) => ({ id: t.id, dependencies: taskData(t).dependencies }));
        if (plannerDependencyCycle([...graph, { id: newId, dependencies: data.dependencies }]))
          fail('Dependencies cannot form a cycle');
        data = await this.runRules(tx, ctx, data, old ? taskData(old) : null, projects, people);
        if (data.subtype === 'approval') {
          if (
            Object.hasOwn(dto.data, 'status') &&
            data.status !== 'done' &&
            !Object.hasOwn(dto.data, 'approval')
          )
            data.approval = 'pending';
          else if (data.approval !== 'pending') data.status = 'done';
          else if (data.status === 'done') data.approval = 'approved';
        }
        const completedAt = data.status === 'done' ? (old?.completedAt ?? new Date()) : null;
        const createNextRecurrence =
          data.status === 'done' &&
          Boolean(old) &&
          taskData(old!).status !== 'done' &&
          !old!.archived &&
          dto.archived !== true &&
          !(old!.data as Record<string, unknown>).recurrenceSuccessorId;
        const nextSchedule = createNextRecurrence ? nextPlannerSchedule(data, completedAt!) : null;
        const successorId = nextSchedule ? randomUUID() : undefined;
        const stored = {
          data: storedTaskData(data, old ?? undefined, successorId),
          projectIds: data.memberships.map((m) => m.projectId),
          assigneeId: data.assigneeId,
          parentId: data.parentId,
          completedAt,
        };
        const row = old
          ? await tx.spPlannerTask.update({
              where: { id: old.id, tenantId: ctx.tenantId },
              data: {
                ...stored,
                version: { increment: 1 },
                ...(dto.archived === undefined ? {} : { archived: dto.archived }),
              },
            })
          : await tx.spPlannerTask.create({
              data: { ...stored, id: newId, tenantId: ctx.tenantId, ownerId: ctx.clerkUserId },
            });
        await this.event(
          tx,
          ctx,
          {
            taskId: row.id,
            kind: old
              ? dto.archived === undefined
                ? 'updated'
                : dto.archived
                  ? 'archived'
                  : 'restored'
              : 'created',
            text: old ? 'Updated task' : 'Created task',
          },
          [data.assigneeId, ...data.collaborators].filter((p): p is string => Boolean(p)),
        );
        if (nextSchedule && successorId) {
          const next = validateTask({
            ...data,
            ...nextSchedule,
            status: 'todo' as const,
            approval: 'pending' as const,
            dependencies: [],
          });
          const recurring = await tx.spPlannerTask.create({
            data: {
              id: successorId,
              tenantId: ctx.tenantId,
              ownerId: row.ownerId,
              data: storedTaskData(next),
              projectIds: row.projectIds,
              assigneeId: data.assigneeId,
              parentId: data.parentId,
            },
          });
          await this.event(
            tx,
            ctx,
            { taskId: recurring.id, kind: 'created', text: 'Created next recurring task' },
            data.assigneeId ? [data.assigneeId] : [],
          );
        }
        return this.taskView(tx, row, projects, ctx);
      },
      true,
    );
  }
  private eventView(row: SpPlannerEvent): PlannerEvent {
    return {
      id: row.id,
      taskId: row.taskId,
      projectId: row.projectId,
      actorId: row.actorId,
      kind: row.kind as PlannerEvent['kind'],
      text: row.text,
      minutes: row.minutes,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private async runRules(
    tx: Tx,
    ctx: AuthTenantContext,
    input: PlannerTaskData,
    before: PlannerTaskData | null,
    projects: SpPlannerProject[],
    people: Set<string>,
  ) {
    let data = input;
    const rules = await tx.spPlannerResource.findMany({
      where: {
        tenantId: ctx.tenantId,
        kind: 'rule',
        archived: false,
        projectId: { in: data.memberships.map((m) => m.projectId) },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const rule of rules) {
      const p = projects.find((p) => p.id === rule.projectId);
      if (
        !p ||
        p.archived ||
        !people.has(rule.ownerId) ||
        !['editor', 'admin'].includes(plannerProjectAccess(p, rule.ownerId) ?? '')
      )
        continue;
      const config = rule.data as unknown as PlannerRuleData;
      if (
        (config.actions.assigneeId && !people.has(config.actions.assigneeId)) ||
        (config.actions.sectionId &&
          !projectData(p).sections.some((s) => s.id === config.actions.sectionId))
      )
        continue;
      data = applyPlannerRule(data, before, p.id, config);
    }
    return validateTask(data);
  }
  private async event(
    tx: Tx,
    ctx: AuthTenantContext,
    input: {
      taskId?: string;
      projectId?: string;
      kind: PlannerEvent['kind'];
      text: string;
      minutes?: number;
    },
    recipients: string[],
  ) {
    const event = await tx.spPlannerEvent.create({
      data: { tenantId: ctx.tenantId, actorId: ctx.clerkUserId, ...input },
    });
    const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
    for (const userId of new Set(recipients))
      if (userId !== ctx.clerkUserId && people.has(userId))
        await tx.spPlannerInbox.create({
          data: { tenantId: ctx.tenantId, userId, eventId: event.id },
        });
    return this.eventView(event);
  }
  async events(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string },
  ): Promise<PlannerEvent[]>;
  async events(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string },
    query: ActivityQuery,
  ): Promise<PlannerEvent[] | PlannerActivityPage<PlannerEvent>>;
  async events(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string },
    query: ActivityQuery = {},
  ) {
    const paged = activityQuery(query);
    if (Boolean(target.taskId) === Boolean(target.projectId))
      fail('One activity target is required');
    return this.scope(ctx, async (tx) => {
      if (target.taskId) {
        uuid(target.taskId);
        const task = await tx.spPlannerTask.findFirst({
          where: { id: target.taskId, tenantId: ctx.tenantId },
        });
        if (!task) throw missing();
        requireRole(
          plannerTaskAccess(task, await this.projects(tx, ctx), ctx.clerkUserId),
          'viewer',
        );
      }
      if (target.projectId) {
        uuid(target.projectId);
        const p = await tx.spPlannerProject.findFirst({
          where: { id: target.projectId, tenantId: ctx.tenantId },
        });
        if (!p) throw missing();
        requireRole(plannerProjectAccess(p, ctx.clerkUserId), 'viewer');
      }
      const where = { tenantId: ctx.tenantId, ...target };
      if (
        query.cursor &&
        !(await tx.spPlannerEvent.findFirst({ where: { ...where, id: query.cursor } }))
      )
        fail('Activity cursor is no longer available');
      const rows = await tx.spPlannerEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        take: paged ? 101 : 100,
      });
      const items = rows.slice(0, 100).map((row) => this.eventView(row));
      return paged ? { items, nextCursor: rows.length > 100 ? rows[99]!.id : null } : items;
    });
  }
  async addEvent(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string },
    raw: unknown,
  ) {
    const dto = object(raw);
    keys(dto, ['kind', 'text', 'minutes', 'mentions']);
    const mentions = dto.mentions ?? [];
    if (
      !Array.isArray(mentions) ||
      mentions.length > 20 ||
      mentions.some((id) => typeof id !== 'string' || id.length > 200)
    )
      fail('Invalid mentions');
    if (!['comment', 'time', 'status'].includes(String(dto.kind))) fail('Invalid activity kind');
    if (typeof dto.text !== 'string' || !dto.text.trim() || dto.text.length > 20_000)
      fail('Activity text is required');
    if (
      dto.kind === 'time' &&
      (!target.taskId ||
        !Number.isInteger(dto.minutes) ||
        Number(dto.minutes) < 1 ||
        Number(dto.minutes) > 1440)
    )
      fail('Time entries require 1–1440 minutes');
    if (dto.kind !== 'time' && dto.minutes !== undefined)
      fail('Only time entries can contain minutes');
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        let recipients: string[] = [];
        let mentionAccess: (id: string) => boolean = () => false;
        if (target.taskId) {
          uuid(target.taskId);
          const task = await tx.spPlannerTask.findFirst({
            where: { id: target.taskId, tenantId: ctx.tenantId },
          });
          if (!task) throw missing();
          requireRole(
            plannerTaskAccess(task, projects, ctx.clerkUserId),
            dto.kind === 'time' ? 'editor' : 'commenter',
          );
          const data = taskData(task);
          recipients = [data.assigneeId, task.ownerId, ...data.collaborators].filter(
            (p): p is string => Boolean(p),
          );
          mentionAccess = (id) => Boolean(plannerTaskAccess(task, projects, id));
        } else if (target.projectId) {
          uuid(target.projectId);
          const p = projects.find((p) => p.id === target.projectId);
          if (!p) throw missing();
          requireRole(
            plannerProjectAccess(p, ctx.clerkUserId),
            dto.kind === 'status' ? 'editor' : 'commenter',
          );
          recipients = [p.ownerId, ...projectData(p).members.map((m) => m.userId)];
          mentionAccess = (id) => Boolean(plannerProjectAccess(p, id));
        } else fail('An activity target is required');
        return this.event(
          tx,
          ctx,
          {
            ...target,
            kind: dto.kind as PlannerEvent['kind'],
            text: dto.text as string,
            ...(dto.kind === 'time' ? { minutes: Number(dto.minutes) } : {}),
          },
          [...recipients, ...mentions.filter((id) => mentionAccess(String(id))).map(String)],
        );
      },
      true,
    );
  }
  async inbox(ctx: AuthTenantContext): Promise<PlannerInboxItem[]>;
  async inbox(
    ctx: AuthTenantContext,
    query: ActivityQuery,
  ): Promise<PlannerInboxItem[] | PlannerActivityPage<PlannerInboxItem>>;
  async inbox(ctx: AuthTenantContext, query: ActivityQuery = {}) {
    const paged = activityQuery(query, true);
    return this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const where = {
        tenantId: ctx.tenantId,
        userId: ctx.clerkUserId,
        ...(query.archived !== undefined ? { archived: query.archived === 'true' } : {}),
      };
      // Cursors contain only this user's opaque notification ID. The event and
      // target are never serialized into a cursor for a revoked project grant.
      if (
        query.cursor &&
        !(await tx.spPlannerInbox.findFirst({ where: { ...where, id: query.cursor } }))
      )
        fail('Inbox cursor is no longer available');
      const rows = await tx.spPlannerInbox.findMany({
        where,
        include: { event: true },
        orderBy: [{ event: { createdAt: 'desc' } }, { id: 'desc' }],
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        take: paged ? 101 : 100,
      });
      const result: PlannerInboxItem[] = [];
      const scanned = rows.slice(0, 100);
      const tasks = await tx.spPlannerTask.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: {
            in: [
              ...new Set(scanned.flatMap((row) => (row.event.taskId ? [row.event.taskId] : []))),
            ],
          },
        },
      });
      const allowedTasks = new Set(
        tasks
          .filter((task) => plannerTaskAccess(task, projects, ctx.clerkUserId))
          .map((task) => task.id),
      );
      for (const row of scanned) {
        if (row.event.taskId) {
          if (!allowedTasks.has(row.event.taskId)) continue;
        }
        if (row.event.projectId) {
          const p = projects.find((p) => p.id === row.event.projectId);
          if (!p || !plannerProjectAccess(p, ctx.clerkUserId)) continue;
        }
        result.push({
          id: row.id,
          event: this.eventView(row.event),
          read: row.read,
          archived: row.archived,
        });
      }
      // Advance by scanned rows even when every visible grant on this page was
      // revoked. A later authorized update must still be reachable.
      return paged
        ? { items: result, nextCursor: rows.length > 100 ? rows[99]!.id : null }
        : result;
    });
  }
  async updateInbox(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['read', 'archived']);
    for (const value of Object.values(dto))
      if (typeof value !== 'boolean') fail('Invalid inbox state');
    return this.scope(
      ctx,
      async (tx) => {
        const row = await tx.spPlannerInbox.findFirst({
          where: { id, tenantId: ctx.tenantId, userId: ctx.clerkUserId },
        });
        if (!row) throw missing();
        await tx.spPlannerInbox.update({
          where: { id, tenantId: ctx.tenantId, userId: ctx.clerkUserId },
          data: dto as { read?: boolean; archived?: boolean },
        });
        return { ok: true };
      },
      true,
    );
  }

  private resourceAccess(
    row: SpPlannerResource,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
  ): PlannerRole | null {
    if (row.kind === 'my_tasks' || row.kind === 'saved_view')
      return row.ownerId === ctx.clerkUserId ? 'admin' : null;
    if (row.projectId) {
      const project = projects.find((p) => p.id === row.projectId);
      return project ? plannerProjectAccess(project, ctx.clerkUserId) : null;
    }
    if (row.ownerId === ctx.clerkUserId) return 'admin';
    if (row.kind === 'capacity') return ctx.role === 'org:admin' ? 'admin' : 'viewer';
    const data = row.data as {
      privacy?: string;
      members?: { userId: string; role: PlannerRole }[];
    };
    return (
      data.members?.find((m) => m.userId === ctx.clerkUserId)?.role ??
      (data.privacy === 'team' ? 'editor' : null)
    );
  }
  private resourceView(
    row: SpPlannerResource,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
  ): PlannerResource {
    const access = this.resourceAccess(row, projects, ctx);
    requireRole(access, 'viewer');
    const data = structuredClone(row.data) as Record<string, unknown>;
    if (Array.isArray(data.projectIds))
      data.projectIds = data.projectIds.filter((id) =>
        projects.some((p) => p.id === id && plannerProjectAccess(p, ctx.clerkUserId)),
      );
    return {
      id: row.id,
      kind: row.kind as PlannerResourceKind,
      projectId: row.projectId,
      ownerId: row.ownerId,
      name: row.name,
      data,
      version: row.version,
      archived: row.archived,
      access: access!,
      ...(row.kind === 'form' ? { publicShared: Boolean(row.shareTokenHash) } : {}),
    };
  }
  async resources(ctx: AuthTenantContext) {
    return this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const rows = await tx.spPlannerResource.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const own = rows.filter((row) => row.kind === 'my_tasks' && row.ownerId === ctx.clerkUserId);
      const assigned = own.length
        ? await tx.spPlannerTask.findMany({
            where: { tenantId: ctx.tenantId, assigneeId: ctx.clerkUserId },
          })
        : [];
      const visible = new Set(
        assigned
          .filter((task) => plannerTaskAccess(task, projects, ctx.clerkUserId))
          .map((task) => task.id),
      );
      return rows
        .filter((row) => this.resourceAccess(row, projects, ctx))
        .map((row) => {
          const result = this.resourceView(row, projects, ctx);
          if (row.kind === 'my_tasks')
            result.data.placements = (result.data.placements as { taskId: string }[]).filter((p) =>
              visible.has(p.taskId),
            );
          return result;
        });
    });
  }
  async saveResource(ctx: AuthTenantContext, id: string | null, raw: unknown) {
    if (id) uuid(id);
    const dto = object(raw);
    keys(dto, ['kind', 'projectId', 'name', 'data', 'version', 'archived']);
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const old = id
          ? await tx.spPlannerResource.findFirst({ where: { id, tenantId: ctx.tenantId } })
          : null;
        if (id && !old) throw missing();
        if (old) {
          requireRole(this.resourceAccess(old, projects, ctx), 'editor');
          version(old.version, dto.version as number | undefined);
        }
        const kind = (dto.kind ?? old?.kind) as PlannerResourceKind;
        if (!RESOURCE_KINDS.includes(kind) || (old && old.kind !== kind))
          fail('Invalid resource kind');
        const projectId = (
          dto.projectId === undefined ? (old?.projectId ?? null) : dto.projectId
        ) as string | null;
        if (projectId) uuid(projectId);
        if (old && old.projectId !== projectId) fail('Resource project cannot change');
        if (['my_tasks', 'saved_view'].includes(kind) && projectId)
          fail('Personal settings cannot belong to a shared project');
        if (kind === 'my_tasks') {
          if (dto.archived !== undefined) fail('Personal settings cannot be archived');
          if (
            !old &&
            (await tx.spPlannerResource.findFirst({
              where: {
                tenantId: ctx.tenantId,
                ownerId: ctx.clerkUserId,
                kind: 'my_tasks',
                archived: false,
              },
            }))
          )
            throw new ConflictException('My tasks settings already exist. Refresh before saving.');
        }
        if (['rule', 'form'].includes(kind) && !projectId)
          fail('Rules and forms require a project');
        if (projectId) {
          const p = projects.find((p) => p.id === projectId && !p.archived);
          requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'editor');
        }
        const name = dto.name ?? old?.name;
        if (typeof name !== 'string' || !name.trim() || name.length > 500)
          fail('Resource name is required');
        const data = validateResource(kind, {
          ...(old ? object(old.data) : {}),
          ...object(dto.data ?? {}),
        });
        const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
        if (!people.has(ctx.clerkUserId))
          throw new ForbiddenException('Active membership is required');
        for (const rawMember of (data.members ?? []) as { userId: string }[])
          if (!people.has(rawMember.userId)) fail('Resource members must be active team members');
        if (
          old &&
          (['privacy', 'members'].some((k) => Object.hasOwn(object(dto.data ?? {}), k)) ||
            dto.archived !== undefined)
        )
          requireRole(this.resourceAccess(old, projects, ctx), 'admin');
        if (dto.archived !== undefined && typeof dto.archived !== 'boolean')
          fail('Invalid archive flag');
        for (const requestedId of (object(dto.data ?? {}).projectIds ?? []) as string[]) {
          const p = projects.find((p) => p.id === requestedId);
          requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'viewer');
        }
        if (old && Array.isArray(data.projectIds)) {
          const hidden = ((old.data as Record<string, unknown>).projectIds ?? []) as string[];
          data.projectIds = [
            ...new Set([
              ...(data.projectIds as string[]),
              ...hidden.filter(
                (id) =>
                  !projects.some((p) => p.id === id && plannerProjectAccess(p, ctx.clerkUserId)),
              ),
            ]),
          ];
        }
        for (const referencedId of (data.projectIds ?? []) as string[]) {
          if (
            old &&
            ((old.data as Record<string, unknown>).projectIds as string[] | undefined)?.includes(
              referencedId,
            )
          )
            continue;
          const p = projects.find((p) => p.id === referencedId);
          requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'viewer');
        }
        if (kind === 'saved_view' && data.projectId) {
          const p = projects.find((p) => p.id === data.projectId);
          requireRole(p ? plannerProjectAccess(p, ctx.clerkUserId) : null, 'viewer');
        }
        if (kind === 'capacity') {
          if (!people.has(String(data.userId))) fail('Capacity belongs to an active team member');
          if (data.userId !== ctx.clerkUserId && ctx.role !== 'org:admin')
            throw new ForbiddenException('Only team admins can set another person’s capacity');
        }
        if (kind === 'my_tasks') {
          const placements = data.placements as { taskId: string }[];
          const assigned = await tx.spPlannerTask.findMany({
            where: {
              tenantId: ctx.tenantId,
              assigneeId: ctx.clerkUserId,
              id: { in: placements.map((p) => p.taskId) },
            },
          });
          const visible = new Set(
            assigned
              .filter((task) => plannerTaskAccess(task, projects, ctx.clerkUserId))
              .map((task) => task.id),
          );
          if (placements.some((p) => !visible.has(p.taskId)))
            fail('My tasks sections can contain only your assigned work');
        }
        if (kind === 'goal' && data.ownerId && !people.has(String(data.ownerId)))
          fail('Goal owner must be an active team member');
        if (kind === 'rule' || kind === 'form') {
          const p = projects.find((p) => p.id === projectId)!;
          const config = kind === 'rule' ? object(data.actions) : object(data.defaults);
          if (config.assigneeId && !people.has(String(config.assigneeId)))
            fail('Assignee must be an active team member');
          for (const sectionId of [
            config.sectionId,
            kind === 'rule' ? object(data.conditions).sectionId : undefined,
          ])
            if (sectionId && !projectData(p).sections.some((s) => s.id === sectionId))
              fail('Rule section must belong to the project');
        }
        if (kind === 'template') {
          const template = data as unknown as PlannerTemplateData;
          for (const principal of [
            ...template.project.members.map((m) => m.userId),
            ...template.tasks
              .flatMap((t) => [t.assigneeId, ...t.collaborators])
              .filter((p): p is string => !!p),
          ])
            if (!people.has(principal)) fail('Template members must be active');
        }
        const row = old
          ? await tx.spPlannerResource.update({
              where: { id: old.id, tenantId: ctx.tenantId },
              data: {
                name,
                data: json(data),
                version: { increment: 1 },
                ...(dto.archived === undefined ? {} : { archived: dto.archived as boolean }),
              },
            })
          : await tx.spPlannerResource.create({
              data: {
                tenantId: ctx.tenantId,
                ownerId: ctx.clerkUserId,
                kind,
                projectId,
                name,
                data: json(data),
              },
            });
        return this.resourceView(row, projects, ctx);
      },
      true,
    );
  }
  async instantiateTemplate(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['name']);
    if (typeof dto.name !== 'string' || !dto.name.trim() || dto.name.length > 500)
      fail('Project name is required');
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const template = await tx.spPlannerResource.findFirst({
          where: { id, tenantId: ctx.tenantId, kind: 'template', archived: false },
        });
        if (!template) throw missing();
        requireRole(this.resourceAccess(template, projects, ctx), 'viewer');
        const config = validateResource(
          'template',
          template.data,
        ) as unknown as PlannerTemplateData;
        return this.copyProject(
          tx,
          ctx,
          config,
          dto.name as string,
          `Created project from ${template.name}`,
        );
      },
      true,
    );
  }
  async duplicateProject(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['name']);
    if (typeof dto.name !== 'string' || !dto.name.trim() || dto.name.length > 500)
      fail('Project name is required');
    return this.scope(
      ctx,
      async (tx) => {
        const source = await tx.spPlannerProject.findFirst({
          where: { tenantId: ctx.tenantId, id },
        });
        if (!source) throw missing();
        requireRole(plannerProjectAccess(source, ctx.clerkUserId), 'viewer');
        const rows = await tx.spPlannerTask.findMany({
          where: { tenantId: ctx.tenantId, projectIds: { has: id }, archived: false },
          orderBy: { createdAt: 'asc' },
          take: 1001,
        });
        if (rows.length > 1000)
          fail('Project duplication supports up to 1000 tasks. Use CSV for larger projects.');
        rows.sort(
          (a, b) =>
            (taskData(a).memberships.find((m) => m.projectId === id)?.position ?? 0) -
              (taskData(b).memberships.find((m) => m.projectId === id)?.position ?? 0) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
        const indices = new Map(rows.map((t, i) => [t.id, i]));
        const fieldIds = new Set(projectData(source).fields.map((f) => f.id));
        const config: PlannerTemplateData = {
          description: '',
          privacy: 'private',
          members: [],
          project: { ...projectData(source), privacy: 'private', members: [], clientId: null },
          tasks: rows.map((t) => ({
            ...taskData(t),
            memberships: [],
            parentId: null,
            dependencies: [],
            clientId: null,
            meetingId: null,
            customValues: Object.fromEntries(
              Object.entries(taskData(t).customValues).filter(([key]) => fieldIds.has(key)),
            ),
          })),
          layout: rows.map((t) => ({
            sectionId: taskData(t).memberships.find((m) => m.projectId === id)?.sectionId ?? null,
            parentIndex: t.parentId ? (indices.get(t.parentId) ?? null) : null,
            dependencyIndices: taskData(t).dependencies.flatMap((key) =>
              indices.has(key) ? [indices.get(key)!] : [],
            ),
          })),
        };
        return this.copyProject(
          tx,
          ctx,
          config,
          dto.name as string,
          `Duplicated ${projectData(source).name}`,
        );
      },
      true,
    );
  }
  async reorderTasks(ctx: AuthTenantContext, projectId: string, raw: unknown) {
    uuid(projectId);
    const dto = object(raw);
    keys(dto, ['tasks']);
    if (!Array.isArray(dto.tasks) || !dto.tasks.length || dto.tasks.length > 1000)
      fail('Choose 1–1000 tasks to reorder');
    const requested = dto.tasks.map((value) => {
      const t = object(value);
      keys(t, ['id', 'version']);
      uuid(t.id);
      if (!Number.isInteger(t.version) || Number(t.version) < 1)
        fail('An expected version is required');
      return { id: String(t.id), version: Number(t.version) };
    });
    if (new Set(requested.map((t) => t.id)).size !== requested.length) fail('Duplicate task ids');
    return this.scope(
      ctx,
      async (tx) => {
        const project = await tx.spPlannerProject.findFirst({
          where: { id: projectId, tenantId: ctx.tenantId, archived: false },
        });
        requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'editor');
        const rows = await tx.spPlannerTask.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: requested.map((t) => t.id) },
            projectIds: { has: projectId },
          },
        });
        for (const item of requested) {
          const row = rows.find((t) => t.id === item.id);
          if (!row) throw missing();
          version(row.version, item.version);
        }
        // Validate every version before writing; a conflict rolls back the entire reorder.
        for (const [i, item] of requested.entries()) {
          const row = rows.find((t) => t.id === item.id)!;
          await tx.spPlannerTask.update({
            where: { id: row.id, tenantId: ctx.tenantId },
            data: {
              data: storedTaskData(
                {
                  ...taskData(row),
                  memberships: taskData(row).memberships.map((m) =>
                    m.projectId === projectId ? { ...m, position: i * 1000 } : m,
                  ),
                },
                row,
              ),
              version: { increment: 1 },
            },
          });
        }
        await this.event(tx, ctx, { projectId, kind: 'updated', text: 'Reordered tasks' }, []);
        return { ok: true };
      },
      true,
    );
  }
  private async copyProject(
    tx: Tx,
    ctx: AuthTenantContext,
    config: PlannerTemplateData,
    name: string,
    activity: string,
  ) {
    const sectionIds = new Map(config.project.sections.map((s) => [s.id, randomUUID()]));
    const fieldIds = new Map(config.project.fields.map((f) => [f.id, randomUUID()]));
    const project = await tx.spPlannerProject.create({
      data: {
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        data: json({
          ...config.project,
          name,
          members: [],
          clientId: null,
          sections: config.project.sections.map((s) => ({ ...s, id: sectionIds.get(s.id) })),
          fields: config.project.fields.map((f) => ({ ...f, id: fieldIds.get(f.id) })),
        }),
      },
    });
    const activePeople = new Set((await this.people(tx, ctx)).map((p) => p.id));
    const taskIds = config.tasks.map(() => randomUUID());
    const taskRows = config.tasks.map((task, i) => {
      const layout = config.layout?.[i];
      const data = validateTask({
        ...task,
        assigneeId: task.assigneeId && activePeople.has(task.assigneeId) ? task.assigneeId : null,
        collaborators: task.collaborators.filter((p) => activePeople.has(p)),
        status: 'todo',
        approval: 'pending',
        parentId:
          layout?.parentIndex === undefined || layout.parentIndex === null
            ? null
            : taskIds[layout.parentIndex],
        dependencies: layout?.dependencyIndices.map((index) => taskIds[index]) ?? [],
        memberships: [
          {
            projectId: project.id,
            sectionId: layout?.sectionId ? sectionIds.get(layout.sectionId) : null,
            position: i * 1024,
          },
        ],
        customValues: Object.fromEntries(
          Object.entries(task.customValues).map(([id, value]) => [fieldIds.get(id), value]),
        ),
      });
      return {
        tenantId: ctx.tenantId,
        id: taskIds[i],
        ownerId: ctx.clerkUserId,
        projectIds: [project.id],
        assigneeId: data.assigneeId,
        parentId: data.parentId,
        data: storedTaskData(data),
      };
    });
    if (taskRows.length) await tx.spPlannerTask.createMany({ data: taskRows });
    await this.event(tx, ctx, { projectId: project.id, kind: 'created', text: activity }, []);
    return this.projectView(project, ctx);
  }
  /** Publishing is explicit and rotates the capability. The raw token is never persisted. */
  async shareForm(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'enabled']);
    if (typeof dto.enabled !== 'boolean') fail('Invalid sharing flag');
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const form = await tx.spPlannerResource.findFirst({
          where: { id, tenantId: ctx.tenantId, kind: 'form', archived: false },
        });
        if (!form) throw missing();
        requireRole(this.resourceAccess(form, projects, ctx), 'editor');
        version(form.version, dto.version as number | undefined);
        const token = dto.enabled ? `${ctx.tenantId}.${randomBytes(32).toString('hex')}` : null;
        await tx.spPlannerResource.update({
          where: { id, tenantId: ctx.tenantId },
          data: {
            shareTokenHash: token ? createHash('sha256').update(token).digest('hex') : null,
            version: { increment: 1 },
          },
        });
        return { token };
      },
      true,
    );
  }
  private publicFormScope(token: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/.test(token))
      throw missing();
    const tenantId = token.slice(0, 36);
    uuid(tenantId);
    return {
      ctx: { tenantId, clerkUserId: 'public_form', role: null } as AuthTenantContext,
      hash: createHash('sha256').update(token).digest('hex'),
    };
  }
  private async publicFormRecord(
    tx: Tx,
    ctx: AuthTenantContext,
    hash: string,
    projects: SpPlannerProject[],
  ) {
    const form = await tx.spPlannerResource.findFirst({
      where: { tenantId: ctx.tenantId, kind: 'form', archived: false, shareTokenHash: hash },
    });
    const project = projects.find((p) => p.id === form?.projectId && !p.archived);
    const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
    if (
      !form ||
      !project ||
      !people.has(form.ownerId) ||
      !['admin', 'editor'].includes(plannerProjectAccess(project, form.ownerId) ?? '') ||
      !(form.data as unknown as PlannerFormData).enabled
    )
      throw missing();
    return form;
  }
  async publicForm(token: string): Promise<PlannerPublicForm> {
    const { ctx, hash } = this.publicFormScope(token);
    return this.scope(ctx, async (tx) => {
      const form = await this.publicFormRecord(tx, ctx, hash, await this.projects(tx, ctx));
      const config = validateResource('form', form.data) as unknown as PlannerFormData;
      // Public reads contain only the intake questions. No project or person identity.
      return { name: form.name, description: config.description, fields: config.fields };
    });
  }
  async submitPublicForm(token: string, raw: unknown) {
    const { ctx, hash } = this.publicFormScope(token);
    const answers = object(raw);
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const form = await this.publicFormRecord(tx, ctx, hash, projects);
        const actorId = `public_form:${form.id}`;
        // A durable per-form quota works across all ECS instances. Private request
        // payloads and client IPs are not retained for rate limiting.
        const recent = await tx.spPlannerEvent.count({
          where: {
            tenantId: ctx.tenantId,
            actorId,
            createdAt: { gte: new Date(Date.now() - 60_000) },
          },
        });
        if (recent >= 10)
          throw new HttpException('This form is receiving many requests. Try again shortly.', 429);
        await this.createFormTask(
          tx,
          { ...ctx, clerkUserId: actorId },
          form,
          projects,
          answers,
          true,
        );
        return { received: true };
      },
      true,
    );
  }
  async submitForm(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const answers = object(raw);
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const form = await tx.spPlannerResource.findFirst({
          where: { id, tenantId: ctx.tenantId, kind: 'form', archived: false },
        });
        if (!form) throw missing();
        requireRole(this.resourceAccess(form, projects, ctx), 'viewer');
        const row = await this.createFormTask(tx, ctx, form, projects, answers, false);
        return this.taskView(tx, row, projects, ctx);
      },
      true,
    );
  }
  private async createFormTask(
    tx: Tx,
    ctx: AuthTenantContext,
    form: SpPlannerResource,
    projects: SpPlannerProject[],
    answers: Record<string, unknown>,
    isPublic: boolean,
  ) {
    const config = validateResource('form', form.data) as unknown as PlannerFormData;
    if (!config.enabled) fail('This form is closed');
    keys(
      answers,
      config.fields.map((f) => f.id),
    );
    const project = projects.find((p) => p.id === form.projectId && !p.archived);
    if (!project) throw missing();
    requireRole(plannerProjectAccess(project, form.ownerId), 'editor');
    const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
    if (!people.has(form.ownerId) || (!isPublic && !people.has(ctx.clerkUserId)))
      throw new ForbiddenException('Active membership is required');
    if (config.defaults.assigneeId && !people.has(config.defaults.assigneeId))
      fail('The form’s default assignee is no longer active');
    const values: Record<string, unknown> = {};
    for (const field of config.fields) {
      const value = answers[field.id];
      if (value === undefined || value === null || value === '') {
        if (field.required) fail(`${field.label} is required`);
        continue;
      }
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
        fail('Expected a numeric answer');
      if (field.type !== 'number' && (typeof value !== 'string' || value.length > 50000))
        fail('Expected a text answer');
      if (field.type === 'select' && !field.options.includes(String(value)))
        fail('Invalid form choice');
      values[field.taskField] = value;
    }
    let data = validateTask({
      ...PLANNER_DEFAULT_TASK,
      ...config.defaults,
      ...values,
      memberships: [
        {
          projectId: project.id,
          sectionId: projectData(project).sections[0]?.id ?? null,
          position: 0,
        },
      ],
    });
    data = await this.runRules(tx, ctx, data, null, projects, people);
    const row = await tx.spPlannerTask.create({
      data: {
        tenantId: ctx.tenantId,
        ownerId: isPublic ? form.ownerId : ctx.clerkUserId,
        assigneeId: data.assigneeId,
        projectIds: [project.id],
        data: storedTaskData(data),
        completedAt: data.status === 'done' ? new Date() : null,
      },
    });
    await this.event(tx, ctx, { taskId: row.id, kind: 'created', text: `Submitted ${form.name}` }, [
      project.ownerId,
      ...(data.assigneeId ? [data.assigneeId] : []),
    ]);
    return row;
  }
}
