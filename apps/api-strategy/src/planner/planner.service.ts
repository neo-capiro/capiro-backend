import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  HttpException,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  nextPlannerSchedule,
  plannerDueTimestamp,
  plannerCalendarDate,
  plannerTemplateSchedule,
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
  type PlannerBellFeed,
  type PlannerActivityPage,
  type PlannerResource,
  type PlannerResourceKind,
  type PlannerRuleData,
  type PlannerGoalData,
  type PlannerMyTasksData,
  type PlannerPersonalRule,
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
import { plannerActualMinutes, plannerEventView, plannerReadActivity } from './planner-activity.js';
import { plannerDateRuleReady, plannerScheduleHash } from './planner-date-rules.js';
import {
  plannerGoalCycle,
  plannerGoalProgress,
  plannerGoalSourceIds,
  plannerGoalWeights,
} from './planner-goals.js';
import {
  plannerPublicForm,
  plannerFormTaskValues,
  validatePlannerFormProject,
} from './planner-form.js';
import { plannerFormAnswers, plannerFormFiles } from './planner-form-upload.js';
import { plannerAttachmentName, type PlannerFormUpload } from './planner-files.js';
import {
  PlannerFormFilesService,
  type PlannerPreparedFormFile,
} from './planner-form-files.service.js';

type Tx = Prisma.TransactionClient;
type GoalTaskRecord = Pick<
  SpPlannerTask,
  'id' | 'ownerId' | 'assigneeId' | 'projectIds' | 'archived' | 'data'
>;
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
const taskData = (row: Pick<SpPlannerTask, 'data'>): PlannerTaskData => {
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
  private readonly logger = new Logger(PlannerService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: PlannerLinksService,
    @Optional() private readonly formFiles?: PlannerFormFilesService,
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
      : ((await plannerActualMinutes(tx, ctx, [row.id])).get(row.id) ?? 0);
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
      const minutes = await plannerActualMinutes(
        tx,
        ctx,
        selected.map((t) => t.id),
      );
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
        minutes,
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
        const row = await this.persistTask(tx, ctx, newId, old, data, projects, all, dto);
        return this.taskView(tx, row, projects, ctx);
      },
      true,
    );
  }
  private async persistTask(
    tx: Tx,
    ctx: AuthTenantContext,
    newId: string,
    old: SpPlannerTask | null,
    data: PlannerTaskData,
    projects: SpPlannerProject[],
    all: SpPlannerTask[],
    dto: { archived?: boolean },
    auditText?: string,
    notifyChanges = true,
    now = new Date(),
  ) {
    const completedAt = data.status === 'done' ? (old?.completedAt ?? now) : null;
    const createNextRecurrence =
      data.status === 'done' &&
      Boolean(old) &&
      taskData(old!).status !== 'done' &&
      !old!.archived &&
      dto.archived !== true &&
      !(old!.data as Record<string, unknown>).recurrenceSuccessorId;
    const nextSchedule = createNextRecurrence ? nextPlannerSchedule(data, completedAt!) : null;
    const successorId = nextSchedule ? randomUUID() : undefined;
    const recurrenceCopies = successorId
      ? this.recurrenceCopies(all, newId, successorId, projects, ctx)
      : new Map<string, string>();
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
        text: auditText ?? (old ? 'Updated task' : 'Created task'),
      },
      notifyChanges
        ? [data.assigneeId, ...data.collaborators].filter((p): p is string => Boolean(p))
        : [],
    );
    if (nextSchedule && successorId) {
      const activePeople = new Set((await this.people(tx, ctx)).map((p) => p.id));
      const next = validateTask({
        ...data,
        ...nextSchedule,
        status: 'todo' as const,
        approval: 'pending' as const,
        assigneeId: data.assigneeId && activePeople.has(data.assigneeId) ? data.assigneeId : null,
        collaborators: data.collaborators.filter((id) => activePeople.has(id)),
        dependencies: data.dependencies.map((id) => recurrenceCopies.get(id) ?? id),
      });
      const recurring = await tx.spPlannerTask.create({
        data: {
          id: successorId,
          tenantId: ctx.tenantId,
          ownerId: row.ownerId,
          data: storedTaskData(next),
          projectIds: row.projectIds,
          assigneeId: next.assigneeId,
          parentId: data.parentId,
        },
      });
      await this.event(
        tx,
        ctx,
        { taskId: recurring.id, kind: 'created', text: 'Created next recurring task' },
        notifyChanges && next.assigneeId ? [next.assigneeId] : [],
      );
      await this.copyRecurringContents(tx, ctx, all, recurrenceCopies);
    }
    return row;
  }
  private eventView(row: SpPlannerEvent): PlannerEvent {
    return plannerEventView(row);
  }
  private recurrenceCopies(
    all: SpPlannerTask[],
    sourceId: string,
    nextId: string,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
  ) {
    const ids = new Map([[sourceId, nextId]]);
    const children = new Map<string, SpPlannerTask[]>();
    for (const task of all) {
      if (task.archived || !task.parentId) continue;
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
    for (const parentId of ids.keys()) {
      for (const child of children.get(parentId) ?? []) {
        requireRole(plannerTaskAccess(child, projects, ctx.clerkUserId), 'viewer');
        if (ids.has(child.id)) fail('Subtasks cannot form a cycle');
        if (ids.size >= 1000) fail('A recurring task can copy up to 1,000 tasks at once');
        ids.set(child.id, randomUUID());
      }
    }
    return ids;
  }
  private async copyRecurringContents(
    tx: Tx,
    ctx: AuthTenantContext,
    all: SpPlannerTask[],
    ids: Map<string, string>,
  ) {
    const activePeople = new Set((await this.people(tx, ctx)).map((p) => p.id));
    const sources = all.filter((task) => ids.has(task.id));
    const rootId = ids.keys().next().value!;
    const children = sources
      .filter((task) => task.id !== rootId)
      .map((task) => {
        const original = taskData(task);
        const data = validateTask({
          ...original,
          status: 'todo',
          approval: 'pending',
          parentId: ids.get(task.parentId!),
          dependencies: original.dependencies.map((id) => ids.get(id) ?? id),
          assigneeId:
            original.assigneeId && activePeople.has(original.assigneeId)
              ? original.assigneeId
              : null,
          collaborators: original.collaborators.filter((id) => activePeople.has(id)),
        });
        return {
          id: ids.get(task.id)!,
          tenantId: ctx.tenantId,
          ownerId: task.ownerId,
          parentId: data.parentId,
          projectIds: task.projectIds,
          assigneeId: data.assigneeId,
          data: storedTaskData(data),
        };
      });
    if (children.length) await tx.spPlannerTask.createMany({ data: children });
    const attachments = await tx.spPlannerAttachment.findMany({
      where: { tenantId: ctx.tenantId, taskId: { in: [...ids.keys()] }, archived: false },
    });
    if (attachments.length)
      await tx.spPlannerAttachment.createMany({
        data: attachments.map((file) => ({
          id: randomUUID(),
          tenantId: ctx.tenantId,
          taskId: ids.get(file.taskId)!,
          uploadedBy: file.uploadedBy,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          // Immutable payloads are shared within the same tenant. Each occurrence
          // has independent metadata, permission checks and recoverable archive state.
          objectKey: file.objectKey,
        })),
      });
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
    includeActor = false,
  ) {
    const event = await tx.spPlannerEvent.create({
      data: { tenantId: ctx.tenantId, actorId: ctx.clerkUserId, ...input },
    });
    const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
    for (const userId of new Set(recipients))
      if ((includeActor || userId !== ctx.clerkUserId) && people.has(userId))
        await tx.spPlannerInbox.create({
          data: { tenantId: ctx.tenantId, userId, eventId: event.id },
        });
    return this.eventView(event);
  }
  /** Internal scheduler entry point. Every Planner read/write stays tenant-scoped;
   * one failed task rolls back its claim/actions/delivery without blocking others. */
  async runScheduledWork(tenantId: string, now = new Date(), afterTaskId?: string) {
    uuid(tenantId);
    if (afterTaskId) uuid(afterTaskId);
    const scope = { tenantId, clerkUserId: '', role: null };
    const page = await this.scope(scope, async (tx) => {
      const resources = await tx.spPlannerResource.findMany({
        where: { tenantId, archived: false, kind: { in: ['rule', 'my_tasks'] } },
      });
      const projectIds: string[] = [],
        owners: string[] = [];
      for (const resource of resources) {
        try {
          const config = validateResource(resource.kind as PlannerResourceKind, resource.data);
          if (
            resource.kind === 'rule' &&
            resource.projectId &&
            config.enabled &&
            ['due_approaching', 'overdue'].includes(String(config.trigger))
          )
            projectIds.push(resource.projectId);
          if (
            resource.kind === 'my_tasks' &&
            !resource.projectId &&
            (config.rules as PlannerPersonalRule[] | undefined)?.some((r) => r.enabled)
          )
            owners.push(resource.ownerId);
        } catch {
          /* A malformed configuration cannot block other configured work. */
        }
      }
      if (!projectIds.length && !owners.length) return [];
      return tx.spPlannerTask.findMany({
        where: {
          tenantId,
          archived: false,
          completedAt: null,
          data: { path: ['dueOn'], not: Prisma.JsonNull },
          OR: [
            { parentId: null, projectIds: { hasSome: projectIds } },
            { assigneeId: { in: owners } },
          ],
          ...(afterTaskId ? { id: { gt: afterTaskId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
      });
    });
    let executed = 0,
      failed = 0;
    for (const task of page.slice(0, 50)) {
      try {
        executed += await this.scope(
          scope,
          async (tx) => {
            let row = await tx.spPlannerTask.findFirst({
              where: { tenantId, id: task.id, archived: false },
            });
            if (!row || taskData(row).status === 'done' || !taskData(row).dueOn) return 0;
            const projects = await this.projects(tx, scope);
            const people = new Set((await this.people(tx, scope)).map((p) => p.id));
            const resources = await tx.spPlannerResource.findMany({
              where: { tenantId, archived: false, kind: { in: ['rule', 'my_tasks'] } },
              orderBy: { createdAt: 'asc' },
            });
            let count = 0;
            for (const resource of resources) {
              if (!people.has(resource.ownerId)) continue;
              let config: Record<string, unknown>;
              try {
                config = validateResource(resource.kind as PlannerResourceKind, resource.data);
              } catch {
                continue;
              }
              const author = { tenantId, clerkUserId: resource.ownerId, role: null };
              const personal = resource.kind === 'my_tasks';
              const project = projects.find((p) => p.id === resource.projectId);
              if (personal) {
                if (resource.projectId || taskData(row).assigneeId !== resource.ownerId) continue;
              } else if (
                !project ||
                project.archived ||
                row.parentId ||
                !['editor', 'admin'].includes(
                  plannerProjectAccess(project, resource.ownerId) ?? '',
                ) ||
                !taskData(row).memberships.some((m) => m.projectId === project.id)
              )
                continue;
              const rules = personal
                ? ((config as unknown as PlannerMyTasksData).rules ?? [])
                : [config as unknown as PlannerRuleData];
              for (const rule of rules) {
                const before = taskData(row);
                if (
                  !rule.enabled ||
                  !['due_approaching', 'overdue'].includes(rule.trigger) ||
                  !rule.schedule ||
                  !plannerDateRuleReady(before, rule as PlannerPersonalRule, now)
                )
                  continue;
                const personalRule = rule as PlannerPersonalRule;
                const projectRule = rule as PlannerRuleData;
                if (
                  !['editor', 'admin'].includes(
                    plannerTaskAccess(row, projects, resource.ownerId) ?? '',
                  )
                )
                  continue;
                if (!personal) {
                  const c = projectRule.conditions;
                  const section = before.memberships.find(
                    (m) => m.projectId === project!.id,
                  )?.sectionId;
                  if (
                    (c.status !== undefined && c.status !== before.status) ||
                    (c.priority !== undefined && c.priority !== before.priority) ||
                    (c.sectionId !== undefined && c.sectionId !== section) ||
                    (projectRule.actions.assigneeId &&
                      !people.has(projectRule.actions.assigneeId)) ||
                    (projectRule.actions.sectionId &&
                      !projectData(project!).sections.some(
                        (s) => s.id === projectRule.actions.sectionId,
                      ))
                  )
                    continue;
                }
                const fingerprint = plannerScheduleHash(
                  personal
                    ? [
                        personalRule.id,
                        rule.trigger,
                        rule.schedule,
                        personalRule.sectionId,
                        personalRule.notify,
                      ]
                    : [rule.trigger, rule.schedule, projectRule.conditions, projectRule.actions],
                );
                const deadlineKey = plannerScheduleHash([
                  before.dueOn,
                  before.dueTime,
                  before.timeZone ?? 'UTC',
                ]);
                const claim = await tx.spPlannerScheduleClaim.createMany({
                  data: [
                    { tenantId, resourceId: resource.id, taskId: row.id, fingerprint, deadlineKey },
                  ],
                  skipDuplicates: true,
                });
                if (!claim.count) continue;
                count++;
                if (personal && personalRule.sectionId !== undefined) {
                  const settings = config as unknown as PlannerMyTasksData;
                  const previous = settings.placements.find((p) => p.taskId === row!.id);
                  if (previous?.sectionId !== personalRule.sectionId) {
                    settings.placements = [
                      ...settings.placements.filter((p) => p.taskId !== row!.id),
                      {
                        taskId: row.id,
                        sectionId: personalRule.sectionId,
                        position:
                          previous?.position ??
                          Math.max(-1, ...settings.placements.map((p) => p.position)) + 1,
                      },
                    ];
                    await tx.spPlannerResource.update({
                      where: { tenantId, id: resource.id },
                      data: { data: json(settings), version: { increment: 1 } },
                    });
                  }
                } else if (!personal) {
                  const { sectionId, notify: _notify, ...patch } = projectRule.actions;
                  const next = validateTask({
                    ...before,
                    ...patch,
                    ...(sectionId === undefined
                      ? {}
                      : {
                          memberships: before.memberships.map((m) =>
                            m.projectId === project!.id ? { ...m, sectionId } : m,
                          ),
                        }),
                  });
                  if (
                    next.subtype === 'approval' &&
                    next.status === 'done' &&
                    next.approval === 'pending'
                  )
                    next.approval = 'approved';
                  if (JSON.stringify(next) !== JSON.stringify(before)) {
                    const all =
                      next.status === 'done' && before.recurrence
                        ? await tx.spPlannerTask.findMany({ where: { tenantId } })
                        : [];
                    row = await this.persistTask(
                      tx,
                      author,
                      row.id,
                      row,
                      next,
                      projects,
                      all,
                      {},
                      `Applied rule: ${resource.name}`,
                      false,
                      now,
                    );
                  }
                }
                const notify = personal ? personalRule.notify : projectRule.actions.notify;
                if (notify) {
                  const current = taskData(row);
                  const recipients = personal
                    ? [resource.ownerId]
                    : [current.assigneeId ?? row.ownerId, ...current.collaborators];
                  await this.event(
                    tx,
                    author,
                    {
                      taskId: row.id,
                      kind: 'reminder',
                      text:
                        rule.trigger === 'overdue'
                          ? 'Task is overdue'
                          : rule.schedule.amount === 0
                            ? 'Task is due'
                            : 'Task due date is approaching',
                    },
                    recipients.filter(
                      (id) => people.has(id) && Boolean(plannerTaskAccess(row!, projects, id)),
                    ),
                    true,
                  );
                }
              }
            }
            return count;
          },
          true,
        );
      } catch {
        failed++;
        this.logger.warn(`Planner scheduled task ${task.id} rolled back; next cycle will retry`);
      }
    }
    return { executed, failed, nextCursor: page.length > 50 ? page[49]!.id : null };
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
      const items = await plannerReadActivity(tx, ctx, rows.slice(0, 100));
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
      const allowedInbox = new Set(result.map((item) => item.id));
      const projected = await plannerReadActivity(
        tx,
        ctx,
        scanned.filter((row) => allowedInbox.has(row.id)).map((row) => row.event),
      );
      const revised = new Map(projected.map((event) => [event.id, event]));
      const items = result.map((item) => ({ ...item, event: revised.get(item.event.id)! }));
      // Advance by scanned rows even when every visible grant on this page was
      // revoked. A later authorized update must still be reachable.
      return paged ? { items, nextCursor: rows.length > 100 ? rows[99]!.id : null } : items;
    });
  }
  async reviseEvent(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'text', 'minutes', 'removed']);
    if (
      !Number.isInteger(dto.version) ||
      Number(dto.version) < 0 ||
      Number(dto.version) > 1_000_000
    )
      fail('An expected activity version is required');
    if (dto.removed !== undefined && typeof dto.removed !== 'boolean')
      fail('Invalid activity removal');
    if (
      dto.text !== undefined &&
      (typeof dto.text !== 'string' || !dto.text.trim() || dto.text.length > 20_000)
    )
      fail('Activity text is required');
    if (
      dto.minutes !== undefined &&
      (!Number.isInteger(dto.minutes) || Number(dto.minutes) < 1 || Number(dto.minutes) > 1440)
    )
      fail('Time entries require 1–1440 minutes');
    if (dto.removed === true && (dto.text !== undefined || dto.minutes !== undefined))
      fail('Remove activity separately from editing it');
    return this.scope(
      ctx,
      async (tx) => {
        const original = await tx.spPlannerEvent.findFirst({
          where: { tenantId: ctx.tenantId, id, actorId: ctx.clerkUserId },
        });
        if (!original) throw missing();
        if (!['comment', 'time'].includes(original.kind))
          fail('Only comments and time entries can be corrected');
        const projects = await this.projects(tx, ctx);
        if (original.taskId) {
          const task = await tx.spPlannerTask.findFirst({
            where: { tenantId: ctx.tenantId, id: original.taskId },
          });
          if (!task) throw missing();
          requireRole(
            plannerTaskAccess(task, projects, ctx.clerkUserId),
            original.kind === 'time' ? 'editor' : 'commenter',
          );
        } else if (original.projectId) {
          const project = projects.find((p) => p.id === original.projectId);
          requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'commenter');
        } else throw missing();
        const previous = await tx.spPlannerEventRevision.findFirst({
          where: { tenantId: ctx.tenantId, eventId: original.id },
          orderBy: { version: 'desc' },
        });
        if ((previous?.version ?? 0) !== dto.version)
          throw new ConflictException('This activity changed. Refresh before saving again.');
        if (original.kind !== 'time' && dto.minutes !== undefined)
          fail('Only time entries contain minutes');
        if (
          previous?.removed &&
          dto.removed !== false &&
          (dto.text !== undefined || dto.minutes !== undefined)
        )
          fail('Restore removed activity before editing it');
        const text = (dto.text as string | undefined) ?? previous?.text ?? original.text;
        const minutes =
          (dto.minutes as number | undefined) ?? previous?.minutes ?? original.minutes;
        const removed = (dto.removed as boolean | undefined) ?? previous?.removed ?? false;
        if (
          text === (previous?.text ?? original.text) &&
          minutes === (previous?.minutes ?? original.minutes) &&
          removed === (previous?.removed ?? false)
        )
          fail('Choose an activity change');
        const revision = await tx.spPlannerEventRevision.create({
          data: {
            tenantId: ctx.tenantId,
            eventId: original.id,
            actorId: ctx.clerkUserId,
            version: Number(dto.version) + 1,
            text,
            minutes,
            removed,
          },
        });
        return plannerEventView(original, revision);
      },
      true,
    );
  }
  /** Same grants as inbox/task views; applied in SQL before counting or limiting.
   * Revoked rows can neither inflate the badge nor hide newer authorized work. */
  private notificationWhere(ctx: AuthTenantContext, projects: SpPlannerProject[]) {
    const allowed = projects
      .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
      .map((p) => p.id);
    const ids = allowed.length
      ? Prisma.sql`ARRAY[${Prisma.join(allowed)}]::uuid[]`
      : Prisma.sql`ARRAY[]::uuid[]`;
    return Prisma.sql`i.tenant_id = ${ctx.tenantId}::uuid AND i.user_id = ${ctx.clerkUserId}
      AND NOT i.read AND NOT i.archived AND e.tenant_id = ${ctx.tenantId}::uuid
      AND (e.task_id IS NOT NULL OR e.project_id IS NOT NULL)
      AND (e.project_id IS NULL OR e.project_id = ANY(${ids}))
      AND (e.task_id IS NULL OR EXISTS (
        SELECT 1 FROM sp_planner_tasks t WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.id = e.task_id
        AND (t.data->>'assigneeId' = ${ctx.clerkUserId}
          OR (t.owner_id = ${ctx.clerkUserId} AND jsonb_array_length(t.data->'memberships') = 0)
          OR t.data->'collaborators' @> jsonb_build_array(${ctx.clerkUserId}::text)
          OR t.project_ids && ${ids})
      ))`;
  }
  async notifications(ctx: AuthTenantContext): Promise<PlannerBellFeed> {
    return this.scope(ctx, async (tx) => {
      if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId))
        throw new ForbiddenException('Active membership is required');
      const projects = await this.projects(tx, ctx);
      const rows = await tx.$queryRaw<{ id: string; eventId: string; unread: bigint }[]>`
        SELECT i.id, i.event_id AS "eventId", count(*) OVER() AS unread
        FROM sp_planner_inbox i JOIN sp_planner_events e ON e.tenant_id = i.tenant_id AND e.id = i.event_id
        WHERE ${this.notificationWhere(ctx, projects)}
        ORDER BY e.created_at DESC, i.id DESC LIMIT 100`;
      const events = await tx.spPlannerEvent.findMany({
        where: { tenantId: ctx.tenantId, id: { in: rows.map((r) => r.eventId) } },
      });
      const projected = await plannerReadActivity(tx, ctx, events);
      const byId = new Map(projected.map((e) => [e.id, e]));
      const tasks = await tx.spPlannerTask.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: events.flatMap((e) => (e.taskId ? [e.taskId] : [])) },
        },
      });
      return {
        unread: Number(rows[0]?.unread ?? 0),
        items: rows.map((row) => {
          const event = byId.get(row.eventId)!;
          const task = tasks.find((t) => t.id === event.taskId);
          const project = projects.find((p) => p.id === event.projectId);
          return {
            id: row.id,
            read: false,
            archived: false,
            event,
            title: task ? taskData(task).name : projectData(project!).name,
            deepLink: event.taskId
              ? `/planner?scope=mine&task=${encodeURIComponent(event.taskId)}`
              : `/planner?scope=project&project=${encodeURIComponent(event.projectId!)}`,
          };
        }),
      };
    });
  }
  async readAllNotifications(ctx: AuthTenantContext) {
    return this.scope(
      ctx,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId))
          throw new ForbiddenException('Active membership is required');
        const projects = await this.projects(tx, ctx);
        const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE sp_planner_inbox i SET read = true FROM sp_planner_events e
        WHERE e.id = i.event_id AND e.tenant_id = i.tenant_id AND ${this.notificationWhere(ctx, projects)}
        RETURNING i.id`;
        return { read: rows.length };
      },
      true,
    );
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
          include: { event: true },
        });
        if (!row) throw missing();
        const projects = await this.projects(tx, ctx);
        if (row.event.taskId) {
          const task = await tx.spPlannerTask.findFirst({
            where: { tenantId: ctx.tenantId, id: row.event.taskId },
          });
          requireRole(task ? plannerTaskAccess(task, projects, ctx.clerkUserId) : null, 'viewer');
        }
        if (row.event.projectId) {
          const project = projects.find((p) => p.id === row.event.projectId);
          requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'viewer');
        }
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
    goalIds = new Set<string>(),
    taskIds = new Set<string>(),
    projectIds?: Set<string>,
  ): PlannerResource {
    const access = this.resourceAccess(row, projects, ctx);
    requireRole(access, 'viewer');
    const data = structuredClone(row.data) as Record<string, unknown>;
    if (Array.isArray(data.projectIds))
      data.projectIds = data.projectIds.filter((id) =>
        projectIds
          ? projectIds.has(id)
          : projects.some((p) => p.id === id && plannerProjectAccess(p, ctx.clerkUserId)),
      );
    if (row.kind === 'goal') {
      if (Array.isArray(data.subgoalIds))
        data.subgoalIds = data.subgoalIds.filter((id) => goalIds.has(id));
      if (Array.isArray(data.taskIds)) data.taskIds = data.taskIds.filter((id) => taskIds.has(id));
      if (data.weightMode === 'custom')
        data.weights = plannerGoalWeights(data as unknown as PlannerGoalData);
    }
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
  private resourceViews(
    rows: SpPlannerResource[],
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
    tasks: GoalTaskRecord[],
  ) {
    const visible = rows.filter((row) => this.resourceAccess(row, projects, ctx));
    const goals = visible.filter((row) => row.kind === 'goal');
    const readableTasks = tasks.filter(
      (t) => !t.archived && plannerTaskAccess(t, projects, ctx.clerkUserId),
    );
    const goalIds = new Set(goals.map((g) => g.id));
    const taskIds = new Set(readableTasks.map((t) => t.id));
    const projectIds = new Set(
      projects.filter((p) => plannerProjectAccess(p, ctx.clerkUserId)).map((p) => p.id),
    );
    const parents = new Map<string, string[]>();
    for (const g of goals.filter((g) => !g.archived))
      for (const child of (g.data as unknown as PlannerGoalData).subgoalIds ?? [])
        if (goalIds.has(child)) {
          const linked = parents.get(child);
          if (linked) linked.push(g.id);
          else parents.set(child, [g.id]);
        }
    const views = visible.map((row) =>
      this.resourceView(row, projects, ctx, goalIds, taskIds, projectIds),
    );
    const progress = plannerGoalProgress(
      views,
      new Set(
        projects
          .filter((p) => !p.archived && plannerProjectAccess(p, ctx.clerkUserId))
          .map((p) => p.id),
      ),
      readableTasks.map((t) => {
        const data = taskData(t);
        return { id: t.id, status: data.status, kind: data.subtype, projectIds: t.projectIds };
      }),
    );
    for (const view of views)
      if (view.kind === 'goal') {
        view.goalProgress = progress.get(view.id);
        view.parentGoalIds = parents.get(view.id) ?? [];
      }
    return views;
  }
  private goalTasks(tx: Tx, ctx: AuthTenantContext): Promise<GoalTaskRecord[]> {
    return tx.$queryRaw<GoalTaskRecord[]>`
      SELECT id, owner_id AS "ownerId", assignee_id AS "assigneeId", project_ids AS "projectIds", archived,
        jsonb_strip_nulls(jsonb_build_object('status',data->'status','subtype',data->'subtype','assigneeId',data->'assigneeId',
          'memberships',data->'memberships','collaborators',data->'collaborators')) AS data
      FROM sp_planner_tasks WHERE tenant_id = ${ctx.tenantId}::uuid`;
  }
  async resources(ctx: AuthTenantContext) {
    return this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const rows = await tx.spPlannerResource.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const own = rows.filter((row) => row.kind === 'my_tasks' && row.ownerId === ctx.clerkUserId);
      const hasGoals = rows.some(
        (row) => row.kind === 'goal' && this.resourceAccess(row, projects, ctx),
      );
      const assigned = hasGoals
        ? await this.goalTasks(tx, ctx)
        : own.length
          ? await tx.spPlannerTask.findMany({
              where: { tenantId: ctx.tenantId, assigneeId: ctx.clerkUserId },
            })
          : [];
      const visible = new Set(
        assigned
          .filter((task) => plannerTaskAccess(task, projects, ctx.clerkUserId))
          .map((task) => task.id),
      );
      return this.resourceViews(rows, projects, ctx, assigned).map((result) => {
        if (result.kind === 'my_tasks')
          result.data.placements = (result.data.placements as { taskId: string }[]).filter(
            (p) =>
              visible.has(p.taskId) &&
              assigned.some((t) => t.id === p.taskId && t.assigneeId === ctx.clerkUserId),
          );
        return result;
      });
    });
  }
  private prepareGoalData(
    old: SpPlannerResource | null,
    patch: Record<string, unknown>,
    goals: SpPlannerResource[],
    tasks: GoalTaskRecord[],
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
  ) {
    const previous = (old?.data ?? {}) as unknown as PlannerGoalData;
    const data = { ...previous, ...patch } as PlannerGoalData;
    const readable = (key: string, id: string): boolean =>
      key === 'subgoalIds'
        ? goals.some((g) => g.id === id && this.resourceAccess(g, projects, ctx))
        : key === 'taskIds'
          ? tasks.some(
              (t) => t.id === id && !t.archived && plannerTaskAccess(t, projects, ctx.clerkUserId),
            )
          : projects.some((p) => p.id === id && plannerProjectAccess(p, ctx.clerkUserId));
    for (const key of ['projectIds', 'subgoalIds', 'taskIds'] as const) {
      if (patch[key] !== undefined) {
        if (!Array.isArray(patch[key]) || (patch[key] as unknown[]).length > 100)
          fail('Invalid goal connections');
        for (const requested of patch[key] as unknown[]) {
          uuid(requested);
          requireRole(readable(key, String(requested)) ? 'viewer' : null, 'viewer');
          const previousIds = previous[key] ?? [];
          const archived =
            key === 'subgoalIds'
              ? goals.find((g) => g.id === requested)?.archived
              : key === 'projectIds'
                ? projects.find((p) => p.id === requested)?.archived
                : false;
          if (archived && !previousIds.includes(String(requested)))
            fail('New goal connections require active work');
        }
        const hidden = (previous[key] ?? []).filter((id) => !readable(key, id));
        data[key] = [...new Set([...(patch[key] as string[]), ...hidden])];
      }
    }
    if (patch.weights !== undefined && data.weightMode === 'custom') {
      const visibleData = { ...data };
      for (const key of ['projectIds', 'subgoalIds', 'taskIds'] as const)
        if (visibleData[key])
          visibleData[key] = visibleData[key]!.filter((id) => readable(key, id));
      // Validate the caller's visible weights before scaling; never silently fix a bad total.
      validateResource('goal', visibleData);
      const sourceKey = data.progress.startsWith('subgoal_')
        ? 'subgoalIds'
        : data.progress === 'task_list_completion'
          ? 'taskIds'
          : 'projectIds';
      const hidden = plannerGoalSourceIds(data).filter((id) => !readable(sourceKey, id));
      const held = hidden.map((sourceId) => ({
        sourceId,
        weight:
          previous.progress === data.progress && previous.weightMode === 'custom'
            ? (previous.weights?.find((w) => w.sourceId === sourceId)?.weight ?? 0)
            : 0,
      }));
      const available = 100 - held.reduce((sum, w) => sum + w.weight, 0);
      data.weights = [
        ...data.weights!.map((w) => ({ ...w, weight: (w.weight * available) / 100 })),
        ...held,
      ];
    }
    return data;
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
        const goalRows =
          kind === 'goal'
            ? await tx.spPlannerResource.findMany({
                where: { tenantId: ctx.tenantId, kind: 'goal' },
              })
            : [];
        const goalTasks = kind === 'goal' ? await this.goalTasks(tx, ctx) : [];
        const newGoalId = kind === 'goal' && !old ? randomUUID() : null;
        const data = validateResource(
          kind,
          kind === 'goal'
            ? this.prepareGoalData(old, object(dto.data ?? {}), goalRows, goalTasks, projects, ctx)
            : { ...(old ? object(old.data) : {}), ...object(dto.data ?? {}) },
        );
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
        if (kind === 'goal') {
          const graph = [
            ...goalRows.filter((g) => g.id !== old?.id),
            { id: old?.id ?? newGoalId!, data },
          ];
          const byId = new Map(graph.map((g) => [g.id, g]));
          if (
            plannerGoalCycle(
              graph.map((g) => ({ id: g.id, data: g.data as unknown as PlannerGoalData })),
            )
          )
            fail('Goal connections cannot form a cycle');
          for (const parent of graph) {
            const config = parent.data as unknown as PlannerGoalData;
            if (config.progress === 'subgoal_total')
              for (const childId of config.subgoalIds ?? []) {
                const child = byId.get(childId);
                if (child && (child.data as unknown as PlannerGoalData).unit !== config.unit)
                  fail('Goal totals require compatible units');
              }
          }
        }
        if (kind === 'rule' || kind === 'form') {
          const p = projects.find((p) => p.id === projectId)!;
          if (kind === 'form' && dto.archived !== true)
            validatePlannerFormProject(data as unknown as PlannerFormData, projectData(p));
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
                ...(kind === 'form' && data.audience === 'organization'
                  ? { shareTokenHash: null }
                  : {}),
              },
            })
          : await tx.spPlannerResource.create({
              data: {
                tenantId: ctx.tenantId,
                ownerId: ctx.clerkUserId,
                kind,
                ...(newGoalId ? { id: newGoalId } : {}),
                projectId,
                name,
                data: json(data),
              },
            });
        return kind === 'goal'
          ? this.resourceViews(
              [...goalRows.filter((g) => g.id !== row.id), row],
              projects,
              ctx,
              goalTasks,
            ).find((g) => g.id === row.id)!
          : this.resourceView(row, projects, ctx);
      },
      true,
    );
  }
  async instantiateTemplate(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['name', 'anchorOn']);
    if (typeof dto.name !== 'string' || !dto.name.trim() || dto.name.length > 500)
      fail('Project name is required');
    if (dto.anchorOn !== undefined && !plannerCalendarDate(dto.anchorOn))
      fail('Invalid project reference date');
    return this.scope(
      ctx,
      async (tx) => {
        const projects = await this.projects(tx, ctx);
        const template = await tx.spPlannerResource.findFirst({
          where: { id, tenantId: ctx.tenantId, kind: 'template', archived: false },
        });
        if (!template) throw missing();
        requireRole(this.resourceAccess(template, projects, ctx), 'viewer');
        let config = validateResource('template', template.data) as unknown as PlannerTemplateData;
        if (config.schedule) {
          if (!plannerCalendarDate(dto.anchorOn))
            fail('Choose a project reference date for this template');
          config = plannerTemplateSchedule(config, dto.anchorOn);
          validateResource('template', config);
        } else if (dto.anchorOn !== undefined) fail('This template uses fixed dates');
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
          privacy: 'private',
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
        if (dto.enabled) {
          const config = validateResource('form', form.data) as unknown as PlannerFormData;
          if (config.audience === 'organization')
            fail('Change form access to Anyone with the link before publishing');
          const project = projects.find(
            (candidate) => candidate.id === form.projectId && !candidate.archived,
          );
          if (!project) throw missing();
          validatePlannerFormProject(config, projectData(project));
        }
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
      !(form.data as unknown as PlannerFormData).enabled ||
      (form.data as unknown as PlannerFormData).audience === 'organization'
    )
      throw missing();
    try {
      validatePlannerFormProject(
        validateResource('form', form.data) as unknown as PlannerFormData,
        projectData(project),
      );
    } catch {
      throw missing();
    }
    return form;
  }
  async publicForm(token: string): Promise<PlannerPublicForm> {
    const { ctx, hash } = this.publicFormScope(token);
    return this.scope(ctx, async (tx) => {
      const form = await this.publicFormRecord(tx, ctx, hash, await this.projects(tx, ctx));
      const config = validateResource('form', form.data) as unknown as PlannerFormData;
      // Public reads contain only the intake questions. No project or person identity.
      return plannerPublicForm(form.name, config);
    });
  }
  async submitPublicForm(token: string, raw: unknown, files: PlannerFormUpload[] = []) {
    const { ctx, hash } = this.publicFormScope(token);
    const answers = plannerFormAnswers(raw);
    if (files.length)
      return this.uploadedFormSubmission(ctx, answers, files, true, (tx, projects) =>
        this.publicFormRecord(tx, ctx, hash, projects),
      );
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
  async submitForm(
    ctx: AuthTenantContext,
    id: string,
    raw: unknown,
    files: PlannerFormUpload[] = [],
  ) {
    uuid(id);
    const answers = plannerFormAnswers(raw);
    if (files.length)
      return this.uploadedFormSubmission(ctx, answers, files, false, async (tx, projects) => {
        const form = await tx.spPlannerResource.findFirst({
          where: { id, tenantId: ctx.tenantId, kind: 'form', archived: false },
        });
        if (!form) throw missing();
        requireRole(this.resourceAccess(form, projects, ctx), 'viewer');
        return form;
      });
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
  private uploadedFormSubmission(
    ctx: AuthTenantContext,
    answers: Record<string, unknown>,
    files: PlannerFormUpload[],
    isPublic: true,
    findForm: (tx: Tx, projects: SpPlannerProject[]) => Promise<SpPlannerResource>,
  ): Promise<{ received: boolean }>;
  private uploadedFormSubmission(
    ctx: AuthTenantContext,
    answers: Record<string, unknown>,
    files: PlannerFormUpload[],
    isPublic: false,
    findForm: (tx: Tx, projects: SpPlannerProject[]) => Promise<SpPlannerResource>,
  ): Promise<PlannerTask>;
  private async uploadedFormSubmission(
    ctx: AuthTenantContext,
    answers: Record<string, unknown>,
    files: PlannerFormUpload[],
    isPublic: boolean,
    findForm: (tx: Tx, projects: SpPlannerProject[]) => Promise<SpPlannerResource>,
  ) {
    if (!this.formFiles)
      throw new ServiceUnavailableException('Planner attachment storage is not configured');
    const preflight = await this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const form = await findForm(tx, projects);
      const config = validateResource('form', form.data) as unknown as PlannerFormData;
      const selected = plannerFormFiles(config, answers, files);
      await this.formTaskData(
        tx,
        ctx,
        form,
        projects,
        answers,
        isPublic,
        selected.map((file) => ({
          fieldId: file.fieldname,
          fileName: plannerAttachmentName(file.originalname),
        })),
      );
      if (isPublic) await this.publicFormQuota(tx, ctx, form.id);
      return { id: form.id, version: form.version, selected };
    });
    const taskId = randomUUID();
    const prepared = preflight.selected.length
      ? await this.formFiles.prepare(ctx.tenantId, taskId, preflight.selected)
      : [];
    try {
      return await this.scope(
        ctx,
        async (tx) => {
          const projects = await this.projects(tx, ctx);
          const form = await findForm(tx, projects);
          if (form.id !== preflight.id) throw missing();
          version(form.version, preflight.version);
          if (isPublic) await this.publicFormQuota(tx, ctx, form.id);
          const actor = isPublic ? { ...ctx, clerkUserId: `public_form:${form.id}` } : ctx;
          const row = await this.createFormTask(
            tx,
            actor,
            form,
            projects,
            answers,
            isPublic,
            prepared,
            taskId,
          );
          return isPublic ? { received: true } : this.taskView(tx, row, projects, ctx);
        },
        true,
      );
    } catch (error) {
      await this.formFiles.remove(prepared);
      throw error;
    }
  }
  private async publicFormQuota(tx: Tx, ctx: AuthTenantContext, formId: string) {
    const recent = await tx.spPlannerEvent.count({
      where: {
        tenantId: ctx.tenantId,
        actorId: `public_form:${formId}`,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
    });
    if (recent >= 10)
      throw new HttpException('This form is receiving many requests. Try again shortly.', 429);
  }
  private async formTaskData(
    tx: Tx,
    ctx: AuthTenantContext,
    form: SpPlannerResource,
    projects: SpPlannerProject[],
    answers: Record<string, unknown>,
    isPublic: boolean,
    files: { fieldId: string; fileName: string }[] = [],
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
    const fileNames: Record<string, string[]> = {};
    for (const file of files) (fileNames[file.fieldId] ??= []).push(file.fileName);
    const values = plannerFormTaskValues(
      config,
      projectData(project),
      form.name,
      answers,
      Object.fromEntries(Object.entries(fileNames).map(([id, names]) => [id, names.length])),
      fileNames,
    );
    let data = validateTask({
      ...PLANNER_DEFAULT_TASK,
      ...config.defaults,
      ...values,
      collaborators: !isPublic && config.addSubmitterAsCollaborator ? [ctx.clerkUserId] : [],
      memberships: [
        {
          projectId: project.id,
          sectionId:
            config.sectionId === undefined
              ? (projectData(project).sections[0]?.id ?? null)
              : config.sectionId,
          position: 0,
        },
      ],
    });
    data = await this.runRules(tx, ctx, data, null, projects, people);
    return data;
  }
  private async createFormTask(
    tx: Tx,
    ctx: AuthTenantContext,
    form: SpPlannerResource,
    projects: SpPlannerProject[],
    answers: Record<string, unknown>,
    isPublic: boolean,
    files: PlannerPreparedFormFile[] = [],
    taskId?: string,
  ) {
    const data = await this.formTaskData(tx, ctx, form, projects, answers, isPublic, files);
    const project = projects.find(
      (candidate) => candidate.id === form.projectId && !candidate.archived,
    )!;
    const row = await tx.spPlannerTask.create({
      data: {
        ...(taskId ? { id: taskId } : {}),
        tenantId: ctx.tenantId,
        ownerId: isPublic ? form.ownerId : ctx.clerkUserId,
        assigneeId: data.assigneeId,
        projectIds: [project.id],
        data: storedTaskData(data),
        completedAt: data.status === 'done' ? new Date() : null,
      },
    });
    if (files.length)
      await tx.spPlannerAttachment.createMany({
        data: files.map((file) => ({
          id: file.id,
          tenantId: ctx.tenantId,
          taskId: row.id,
          uploadedBy: ctx.clerkUserId,
          fileName: file.fileName,
          sizeBytes: file.sizeBytes,
          objectKey: file.objectKey,
        })),
      });
    await this.event(tx, ctx, { taskId: row.id, kind: 'created', text: `Submitted ${form.name}` }, [
      project.ownerId,
      ...(data.assigneeId ? [data.assigneeId] : []),
    ]);
    return row;
  }
}
