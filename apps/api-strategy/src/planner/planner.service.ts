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
  PLANNER_GOAL_GRADING_DAYS,
  plannerScheduledInstant,
  plannerWeekOn,
  plannerWeekDate,
  plannerTimeToday,
  plannerTimeWorkKey,
  plannerTemplateSchedule,
  plannerDependencyCycle,
  plannerDefaultBudget,
  PLANNER_DEFAULT_BUDGET_ALERT,
  plannerBudgetAmounts,
  plannerMoneyFormat,
  type PlannerBudgetData,
  type PlannerBudgetAlert,
  type PlannerProjectBudget,
  type PlannerPortfolioBudgets,
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
  type PlannerReportWidget,
  type PlannerReportResponse,
  type PlannerTimeDetails,
  type PlannerTimesheet,
  type PlannerTimesheetData,
  type PlannerTimeSettings,
  type PlannerTimeEntry,
  type PlannerTimePreferences,
  type PlannerTimesheetWorkRef,
  type PlannerTimeReviewPage,
  type PlannerTimeExportPage,
  type PlannerTimeExportEntry,
  type PlannerTimer,
  type PlannerTimeTreePage,
  type PlannerTimeTreeNode,
  plannerTimeRollups,
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
import {
  plannerActualMinutes,
  plannerEventView,
  plannerReadActivity,
  plannerStoredTime,
} from './planner-activity.js';
import {
  plannerTimeDetails,
  plannerTimesheetWeek,
  plannerTimesheetActions,
  plannerTimeEditable,
  requirePlannerTimeEditable,
  requirePlannerTimesheetVersion,
} from './planner-timesheets.js';
import {
  plannerTimeOptions,
  plannerTimeDateNotice,
  requirePlannerTimePolicy,
} from './planner-time-policy.js';
import { plannerTimesheetWorkRows, type PlannerTimeWorkSource } from './planner-timesheet-work.js';
import { plannerTimeExportQuery, type PlannerTimeExportQuery } from './planner-time-export.js';
import { plannerTimerDays, type PlannerTimerData } from './planner-timers.js';
import {
  plannerBudgetData,
  plannerBudgetAlert,
  plannerBudgetSummary,
  plannerBudgetAlertDue,
} from './planner-budgets.js';
import {
  plannerTimeReviewView,
  plannerTimeReviewRows,
  plannerTimeSubmissionDue,
} from './planner-time-review.js';
import { plannerDateRuleReady, plannerScheduleHash } from './planner-date-rules.js';
import {
  plannerGoalCycle,
  plannerGoalProgress,
  plannerGoalSourceIds,
  plannerGoalWeights,
  plannerGoalReminderDue,
} from './planner-goals.js';
import {
  plannerGoalSnapshotDetails,
  plannerGoalActivityView,
  validatePlannerGoalUpdate,
} from './planner-goal-activity.js';
import {
  plannerReportWidgetView,
  preparePlannerReportWidgets,
  type PlannerReportVisibility,
} from './planner-reporting-sharing.js';
import { validatePlannerReportChart } from './planner-reporting.validation.js';
import {
  plannerBuildReport,
  plannerReportMatches,
  plannerReportGroups,
  plannerReportValue,
} from './planner-reporting.js';
import { plannerReportRecords, type PlannerReportTaskRecord } from './planner-reporting-data.js';
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
type TimeReviewQuery = {
  week?: string;
  people?: string;
  statuses?: string;
  sort?: string;
  direction?: string;
  paged?: string;
  cursor?: string;
  revision?: string;
};
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
const projectData = (row: SpPlannerProject) =>
  ({ ...PLANNER_DEFAULT_PROJECT, ...(row.data as object) }) as PlannerProjectData;
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
      return {
        me,
        people,
        projects,
        timeOptions: this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)),
        timeAdmin: ctx.role === 'org:admin',
      };
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
        const beforeGoals =
          old &&
          (dto.archived !== undefined ||
            ['members', 'privacy'].some((k) => Object.hasOwn(dto.data, k)))
            ? await this.captureGoalViews(tx, ctx, await this.projects(tx, ctx))
            : [];
        const data = validateProject({
          ...(old ? projectData(old) : PLANNER_DEFAULT_PROJECT),
          ...dto.data,
        });
        if (old && data.allocationEditors !== projectData(old).allocationEditors)
          requireRole(plannerProjectAccess(old, ctx.clerkUserId), 'admin');
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
        if (beforeGoals.length) {
          const currentProjects = await this.projects(tx, ctx);
          await this.recordGoalChanges(
            tx,
            ctx,
            beforeGoals,
            await this.captureGoalViews(tx, ctx, currentProjects),
            currentProjects,
          );
        }
        return this.projectView(row, ctx);
      },
      true,
    );
  }
  async timeTree(
    ctx: AuthTenantContext,
    query: {
      projectId?: string;
      taskId?: string;
      mine?: string;
      archived?: string;
      cursor?: string;
      revision?: string;
    },
  ): Promise<PlannerTimeTreePage> {
    keys(query, ['projectId', 'taskId', 'mine', 'archived', 'cursor', 'revision']);
    if (query.projectId) uuid(query.projectId);
    if (query.taskId) uuid(query.taskId);
    if (query.cursor) uuid(query.cursor);
    for (const value of [query.mine, query.archived])
      if (value !== undefined && !['true', 'false'].includes(value))
        fail('Invalid time tree scope');
    if (query.cursor && !query.revision) fail('Time tree paging requires its revision');
    if (query.revision && !/^[a-f0-9]{64}$/.test(query.revision))
      fail('Invalid time tree revision');
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((person) => person.id === ctx.clerkUserId))
          throw missing();
        const projects = await this.projects(tx, ctx);
        if (
          query.projectId &&
          !projects.some(
            (p) => p.id === query.projectId && plannerProjectAccess(p, ctx.clerkUserId),
          )
        )
          throw missing();
        const rows = (
          await tx.spPlannerTask.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { id: 'asc' },
          })
        ).filter((row) => plannerTaskAccess(row, projects, ctx.clerkUserId));
        if (query.taskId && !rows.some((row) => row.id === query.taskId)) throw missing();
        const roots = rows.filter(
          (row) =>
            row.archived === (query.archived === 'true') &&
            (!query.taskId || row.id === query.taskId) &&
            (!query.projectId || row.projectIds.includes(query.projectId)) &&
            (query.mine !== 'true' || row.assigneeId === ctx.clerkUserId),
        );
        // Traverse only accessible, active links. A private/archived bridge cannot leak its subtree.
        const children = new Map<string, SpPlannerTask[]>();
        for (const row of rows) {
          if (!row.parentId || row.archived) continue;
          const siblings = children.get(row.parentId) ?? [];
          siblings.push(row);
          children.set(row.parentId, siblings);
        }
        const selected = new Map<string, SpPlannerTask>(),
          pending = [...roots];
        while (pending.length) {
          const row = pending.pop()!;
          if (selected.has(row.id)) continue;
          selected.set(row.id, row);
          pending.push(...(children.get(row.id) ?? []));
        }
        const minutes = await plannerActualMinutes(tx, ctx, [...selected.keys()]);
        const scopedIds = new Set(roots.map((row) => row.id));
        const nodes: PlannerTimeTreeNode[] = [...selected.values()]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            id: row.id,
            parentId: row.parentId && selected.has(row.parentId) ? row.parentId : null,
            version: row.version,
            scoped: scopedIds.has(row.id),
            estimateMinutes: taskData(row).estimateMinutes,
            actualMinutes: minutes.get(row.id) ?? 0,
          }));
        plannerTimeRollups(nodes);
        const revision = createHash('sha256')
          .update(
            JSON.stringify([
              ctx.clerkUserId,
              query.projectId ?? null,
              query.taskId ?? null,
              query.mine === 'true',
              query.archived === 'true',
              nodes,
            ]),
          )
          .digest('hex');
        if (query.revision && query.revision !== revision)
          throw new ConflictException('Task time or access changed. Refresh the time tree.');
        const start = query.cursor ? nodes.findIndex((node) => node.id === query.cursor) + 1 : 0;
        if (query.cursor && start === 0) fail('Invalid time tree cursor');
        const page = nodes.slice(start, start + 100);
        return {
          nodes: page,
          revision,
          matched: nodes.length,
          nextCursor: start + page.length < nodes.length ? page.at(-1)!.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeoutMs: 15_000 },
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
  async importTask(ctx: AuthTenantContext, raw: unknown, authorization?: string) {
    const input = object(raw);
    keys(input, ['importKey', 'data', 'actualMinutes', 'time']);
    const key = uuid(input.importKey);
    if (
      !Number.isInteger(input.actualMinutes) ||
      Number(input.actualMinutes) < 0 ||
      Number(input.actualMinutes) > 1_000_000
    )
      fail('Imported actual time requires 0–1,000,000 whole minutes');
    // Parsing here rejects malformed details even for a zero-time row. Defaults
    // are resolved once, in the first successful transaction, rather than on retry.
    if (input.time !== undefined) plannerTimeDetails(input.time);
    return this.saveTask(ctx, null, { data: input.data }, authorization, {
      key,
      actualMinutes: Number(input.actualMinutes),
      time: input.time,
    });
  }
  async saveTask(
    ctx: AuthTenantContext,
    id: string | null,
    raw: unknown,
    authorization?: string,
    imported?: { key: string; actualMinutes: number; time: unknown },
  ) {
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
        const importHash = imported
          ? createHash('sha256')
              .update(JSON.stringify([dto.data, imported.actualMinutes, imported.time]))
              .digest('hex')
          : null;
        if (imported) {
          if (id) fail('CSV imports create new tasks');
          if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId))
            throw new ForbiddenException('Active membership is required');
          const receipt = await tx.spPlannerResource.findFirst({
            where: { tenantId: ctx.tenantId, id: imported.key },
          });
          if (receipt) {
            if (receipt.kind !== 'task_import_receipt' || receipt.ownerId !== ctx.clerkUserId)
              throw missing();
            const recorded = object(receipt.data);
            if (recorded.hash !== importHash)
              throw new ConflictException('This import key already belongs to a different row');
            const task = await tx.spPlannerTask.findFirst({
              where: { tenantId: ctx.tenantId, id: uuid(recorded.taskId) },
            });
            if (!task) throw missing();
            requireRole(plannerTaskAccess(task, projects, ctx.clerkUserId), 'editor');
            return this.taskView(tx, task, projects, ctx);
          }
        }
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
        if (
          data.estimateMinutes !== (old ? taskData(old).estimateMinutes : 0) &&
          !this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)).timeTrackingEnabled
        )
          throw new ForbiddenException('Time tracking is disabled for this organization');
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
        if (imported) {
          if (imported.actualMinutes > 0) {
            const options = this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx));
            if (row.projectIds.length > 1)
              fail('Choose a single project for an imported time total');
            const time = plannerTimeDetails(imported.time, {
              workedOn: plannerTimeToday(options.timeZone),
              timeZone: options.timeZone,
              billable: options.billableEnabled && options.billableDefault,
              projectId: row.projectIds[0] ?? null,
              category: '',
            });
            this.validateTimeProject(time, row, projects, ctx);
            if (row.projectIds.length && !time.projectId)
              fail('Choose a project for imported time');
            requirePlannerTimePolicy(time, options, ctx.role === 'org:admin');
            await this.touchTimesheet(tx, ctx, ctx.clerkUserId, plannerWeekOn(time.workedOn));
            // CSV actual time is an aggregate, not a date-by-date historical
            // timesheet. Preserve the reviewed date/logger and split it into
            // normal, individually correctable entries of at most 24 hours.
            const entries = [];
            for (let remaining = imported.actualMinutes; remaining > 0; remaining -= 1440)
              entries.push({
                id: randomUUID(),
                tenantId: ctx.tenantId,
                actorId: ctx.clerkUserId,
                taskId: row.id,
                kind: 'time',
                text: 'Imported task time',
                minutes: Math.min(remaining, 1440),
                details: json({ time, recordedBy: ctx.clerkUserId }),
              });
            await tx.spPlannerEvent.createMany({ data: entries });
          }
          await tx.spPlannerResource.create({
            data: {
              id: imported.key,
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              kind: 'task_import_receipt',
              name: 'Task import receipt',
              data: json({ taskId: row.id, hash: importHash }),
            },
          });
        }
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
    const affectsGoals =
      !old ||
      dto.archived !== undefined ||
      ['status', 'subtype', 'memberships', 'collaborators', 'assigneeId'].some(
        (k) =>
          JSON.stringify((taskData(old) as unknown as Record<string, unknown>)[k]) !==
          JSON.stringify((data as unknown as Record<string, unknown>)[k]),
      );
    const beforeGoals = affectsGoals ? await this.captureGoalViews(tx, ctx, projects) : [];
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
    if (beforeGoals.length)
      await this.recordGoalChanges(
        tx,
        ctx,
        beforeGoals,
        await this.captureGoalViews(tx, ctx, projects),
        projects,
      );
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
      resourceId?: string;
      details?: Record<string, unknown>;
      kind: PlannerEvent['kind'];
      text: string;
      minutes?: number;
      timeOwnerId?: string;
    },
    recipients: string[],
    includeActor = false,
  ) {
    const { details, timeOwnerId, ...activity } = input;
    const event = await tx.spPlannerEvent.create({
      data: {
        tenantId: ctx.tenantId,
        actorId: timeOwnerId ?? ctx.clerkUserId,
        ...activity,
        ...(details ? { details: json(details) } : {}),
      },
    });
    const people = new Set(recipients.length ? (await this.people(tx, ctx)).map((p) => p.id) : []);
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
    target: { taskId?: string; projectId?: string; resourceId?: string },
  ): Promise<PlannerEvent[]>;
  async events(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string; resourceId?: string },
    query: ActivityQuery,
  ): Promise<PlannerEvent[] | PlannerActivityPage<PlannerEvent>>;
  async events(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string; resourceId?: string },
    query: ActivityQuery = {},
  ) {
    const paged = activityQuery(query);
    if ([target.taskId, target.projectId, target.resourceId].filter(Boolean).length !== 1)
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
      let goalContext: { audienceCount: number; following: boolean } | undefined;
      if (target.resourceId) {
        uuid(target.resourceId);
        const row = await this.goalRecord(tx, ctx, target.resourceId, 'viewer');
        const projects = await this.projects(tx, ctx);
        goalContext = {
          audienceCount: (await this.goalRecipients(tx, ctx, row, projects)).length,
          following: ((row.data as unknown as PlannerGoalData).followers ?? []).includes(
            ctx.clerkUserId,
          ),
        };
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
      const items = await this.activityViews(tx, ctx, rows.slice(0, 100));
      return paged
        ? {
            items,
            nextCursor: rows.length > 100 ? rows[99]!.id : null,
            ...(goalContext ? { goalContext } : {}),
          }
        : items;
    });
  }
  private async timerMember(tx: Tx, ctx: AuthTenantContext) {
    if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
  }
  private async timerView(
    tx: Tx,
    ctx: AuthTenantContext,
    row: SpPlannerResource,
    now: Date,
  ): Promise<PlannerTimer> {
    const data = row.data as unknown as PlannerTimerData;
    const projects = await this.projects(tx, ctx);
    const task = await tx.spPlannerTask.findFirst({
      where: { tenantId: ctx.tenantId, id: data.taskId },
    });
    const access = task ? plannerTaskAccess(task, projects, ctx.clerkUserId) : null;
    const options = this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx));
    const allocation = data.time.projectId
      ? projects.find((p) => p.id === data.time.projectId)
      : null;
    const allocationReadable =
      !data.time.projectId || !!(allocation && plannerProjectAccess(allocation, ctx.clerkUserId));
    return {
      id: row.id,
      version: row.version,
      status: data.status,
      startedAt: data.startedAt,
      endedAt: data.endedAt,
      serverNow: now.toISOString(),
      elapsedMilliseconds:
        data.status === 'running'
          ? Math.max(0, now.getTime() - Date.parse(data.startedAt))
          : data.elapsedMilliseconds,
      taskId: access ? data.taskId : null,
      taskName: access && task ? taskData(task).name : null,
      time: access
        ? { ...data.time, projectId: allocationReadable ? data.time.projectId : null }
        : null,
      canStop:
        data.status === 'running' &&
        ['editor', 'admin'].includes(access ?? '') &&
        options.timeTrackingEnabled,
      notice: !access
        ? 'This timer’s task is no longer available. You can discard the timer.'
        : !['editor', 'admin'].includes(access)
          ? 'Editing access is required to log this timer.'
          : !options.timeTrackingEnabled
            ? 'Time tracking is disabled for this organization.'
            : !allocationReadable
              ? 'Choose a current task project before logging this timer.'
              : null,
      minutes: data.minutes,
    };
  }
  async timer(ctx: AuthTenantContext): Promise<PlannerTimer | null> {
    return this.scope(ctx, async (tx) => {
      await this.timerMember(tx, ctx);
      const row = await tx.spPlannerResource.findFirst({
        where: {
          tenantId: ctx.tenantId,
          ownerId: ctx.clerkUserId,
          kind: 'timer_session',
          archived: false,
        },
      });
      return row ? this.timerView(tx, ctx, row, new Date()) : null;
    });
  }
  async startTimer(ctx: AuthTenantContext, raw: unknown, clock?: Date): Promise<PlannerTimer> {
    const dto = object(raw);
    keys(dto, ['startKey', 'taskId', 'time']);
    const startKey = uuid(dto.startKey).toLowerCase(),
      taskId = uuid(dto.taskId).toLowerCase();
    const supplied = dto.time === undefined ? {} : object(dto.time);
    keys(supplied, ['timeZone', 'billable', 'projectId', 'category']);
    // Opaque receipts are scoped to this organization and person even if a caller reuses a key.
    const bytes = createHash('sha256')
      .update(JSON.stringify(['planner-timer:v1', ctx.tenantId, ctx.clerkUserId, startKey]))
      .digest();
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex').slice(0, 32);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const startHash = createHash('sha256')
      .update(JSON.stringify([taskId, dto.time ?? null]))
      .digest('hex');
    return this.scope(
      ctx,
      async (tx) => {
        await this.timerMember(tx, ctx);
        const now = clock ?? new Date(),
          projects = await this.projects(tx, ctx);
        const task = await tx.spPlannerTask.findFirst({
          where: { tenantId: ctx.tenantId, id: taskId },
        });
        if (!task) throw missing();
        requireRole(plannerTaskAccess(task, projects, ctx.clerkUserId), 'editor');
        const existing = await tx.spPlannerResource.findFirst({
          where: { tenantId: ctx.tenantId, id },
        });
        if (existing) {
          if (existing.kind !== 'timer_session' || existing.ownerId !== ctx.clerkUserId)
            throw missing();
          if ((existing.data as unknown as PlannerTimerData).startHash !== startHash)
            throw new ConflictException(
              'This timer start key was already used for different values',
            );
          return this.timerView(tx, ctx, existing, now);
        }
        if (task.archived) fail('Restore the task before starting a timer');
        if (
          await tx.spPlannerResource.findFirst({
            where: {
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              kind: 'timer_session',
              archived: false,
            },
          })
        )
          throw new ConflictException('Stop or discard your running timer before starting another');
        const options = this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx));
        const time = plannerTimeDetails({
          timeZone: options.timeZone,
          billable: options.billableEnabled && options.billableDefault,
          ...supplied,
        });
        time.workedOn = plannerTimeToday(time.timeZone, now);
        if (supplied.projectId === undefined) {
          if (task.projectIds.length > 1) fail('Choose one task project for this timer');
          time.projectId = task.projectIds[0] ?? null;
        }
        if (task.projectIds.length && !time.projectId)
          fail('Choose one task project for this timer');
        this.validateTimeProject(time, task, projects, ctx);
        requirePlannerTimePolicy(time, options, ctx.role === 'org:admin');
        const weekOn = plannerWeekOn(time.workedOn),
          sheet = await this.timeSheetRecord(tx, ctx, ctx.clerkUserId, weekOn);
        const sheetData = await this.timeSheetData(tx, ctx, ctx.clerkUserId, weekOn, sheet);
        await this.timeSheetReadable(tx, ctx, ctx.clerkUserId, sheetData);
        requirePlannerTimeEditable(
          sheetData,
          ctx.clerkUserId,
          ctx.clerkUserId,
          ctx.role === 'org:admin',
        );
        const { workedOn: _date, ...details } = time;
        const data: PlannerTimerData = {
          taskId,
          startedAt: now.toISOString(),
          endedAt: null,
          status: 'running',
          time: details,
          startHash,
          stopHash: null,
          elapsedMilliseconds: 0,
          minutes: 0,
          eventIds: [],
        };
        const row = await tx.spPlannerResource.create({
          data: {
            id,
            tenantId: ctx.tenantId,
            ownerId: ctx.clerkUserId,
            kind: 'timer_session',
            name: 'Task timer',
            data: json(data),
          },
        });
        return this.timerView(tx, ctx, row, now);
      },
      true,
    );
  }
  async stopTimer(
    ctx: AuthTenantContext,
    id: string,
    raw: unknown,
    clock?: Date,
  ): Promise<PlannerTimer> {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'time']);
    if (!Number.isInteger(dto.version) || Number(dto.version) < 1)
      fail('An expected timer version is required');
    const supplied = dto.time === undefined ? {} : object(dto.time);
    keys(supplied, ['projectId', 'billable', 'category']);
    const stopHash = createHash('sha256')
      .update(JSON.stringify(['stop', dto.version, dto.time ?? null]))
      .digest('hex');
    return this.scope(
      ctx,
      async (tx) => {
        await this.timerMember(tx, ctx);
        const row = await tx.spPlannerResource.findFirst({
          where: { tenantId: ctx.tenantId, id, ownerId: ctx.clerkUserId, kind: 'timer_session' },
        });
        if (!row) throw missing();
        const data = row.data as unknown as PlannerTimerData,
          now = clock ?? new Date();
        const projects = await this.projects(tx, ctx),
          task = await tx.spPlannerTask.findFirst({
            where: { tenantId: ctx.tenantId, id: data.taskId },
          });
        if (!task) throw missing();
        requireRole(plannerTaskAccess(task, projects, ctx.clerkUserId), 'editor');
        if (data.status !== 'running') {
          if (data.status !== 'stopped' || data.stopHash !== stopHash)
            throw new ConflictException('This timer has already ended');
          return this.timerView(tx, ctx, row, now);
        }
        version(row.version, dto.version as number);
        const days = plannerTimerDays(new Date(data.startedAt), now, data.time.timeZone);
        const options = this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx));
        const time = plannerTimeDetails({
          ...data.time,
          ...supplied,
          workedOn: plannerTimeToday(data.time.timeZone, now),
        });
        if (task.projectIds.length && !time.projectId)
          fail('Choose one task project for this timer');
        this.validateTimeProject(time, task, projects, ctx);
        // A zero-duration stop still honors the current organization policy.
        requirePlannerTimePolicy(time, options, ctx.role === 'org:admin');
        const weeks = new Set<string>();
        for (const day of days) {
          requirePlannerTimePolicy(
            { ...time, workedOn: day.workedOn },
            options,
            ctx.role === 'org:admin',
          );
          weeks.add(plannerWeekOn(day.workedOn));
        }
        for (const week of weeks) await this.touchTimesheet(tx, ctx, ctx.clerkUserId, week);
        const events: Prisma.SpPlannerEventCreateManyInput[] = [];
        for (const day of days)
          for (let remaining = day.minutes; remaining > 0; remaining -= 1440)
            events.push({
              id: randomUUID(),
              tenantId: ctx.tenantId,
              taskId: task.id,
              actorId: ctx.clerkUserId,
              kind: 'time',
              text: 'Tracked with timer',
              minutes: Math.min(remaining, 1440),
              details: json({
                time: { ...time, workedOn: day.workedOn },
                recordedBy: ctx.clerkUserId,
                timer: { id: row.id, startedAt: data.startedAt, endedAt: now.toISOString() },
              }),
            });
        if (events.length) {
          await tx.spPlannerEvent.createMany({ data: events });
          const taskValues = taskData(task),
            people = new Set((await this.people(tx, ctx)).map((p) => p.id));
          const recipients = [
            ...new Set([taskValues.assigneeId, task.ownerId, ...taskValues.collaborators]),
          ].filter(
            (user): user is string => !!user && user !== ctx.clerkUserId && people.has(user),
          );
          if (recipients.length)
            await tx.spPlannerInbox.createMany({
              data: events.flatMap((e) =>
                recipients.map((userId) => ({
                  id: randomUUID(),
                  tenantId: ctx.tenantId,
                  userId,
                  eventId: e.id!,
                })),
              ),
            });
        }
        const { workedOn: _date, ...details } = time;
        const next: PlannerTimerData = {
          ...data,
          status: 'stopped',
          endedAt: now.toISOString(),
          time: details,
          stopHash,
          elapsedMilliseconds: now.getTime() - Date.parse(data.startedAt),
          minutes: days.reduce((n, d) => n + d.minutes, 0),
          eventIds: events.map((e) => e.id!),
        };
        const saved = await tx.spPlannerResource.update({
          where: { tenantId: ctx.tenantId, id },
          data: { data: json(next), archived: true, version: { increment: 1 } },
        });
        return this.timerView(tx, ctx, saved, now);
      },
      true,
    );
  }
  async discardTimer(
    ctx: AuthTenantContext,
    id: string,
    raw: unknown,
    clock?: Date,
  ): Promise<PlannerTimer> {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version']);
    if (!Number.isInteger(dto.version) || Number(dto.version) < 1)
      fail('An expected timer version is required');
    const stopHash = createHash('sha256')
      .update(JSON.stringify(['discard', dto.version]))
      .digest('hex');
    return this.scope(
      ctx,
      async (tx) => {
        await this.timerMember(tx, ctx);
        const row = await tx.spPlannerResource.findFirst({
          where: { tenantId: ctx.tenantId, id, ownerId: ctx.clerkUserId, kind: 'timer_session' },
        });
        if (!row) throw missing();
        const data = row.data as unknown as PlannerTimerData,
          now = clock ?? new Date();
        if (data.status !== 'running') {
          if (data.status !== 'discarded' || data.stopHash !== stopHash)
            throw new ConflictException('This timer has already ended');
          return this.timerView(tx, ctx, row, now);
        }
        version(row.version, dto.version as number);
        const next: PlannerTimerData = {
          ...data,
          status: 'discarded',
          endedAt: now.toISOString(),
          stopHash,
          elapsedMilliseconds: Math.max(0, now.getTime() - Date.parse(data.startedAt)),
        };
        const saved = await tx.spPlannerResource.update({
          where: { tenantId: ctx.tenantId, id },
          data: { data: json(next), archived: true, version: { increment: 1 } },
        });
        return this.timerView(tx, ctx, saved, now);
      },
      true,
    );
  }
  async addEvent(
    ctx: AuthTenantContext,
    target: { taskId?: string; projectId?: string; resourceId?: string },
    raw: unknown,
  ) {
    const dto = object(raw);
    keys(dto, ['kind', 'text', 'minutes', 'mentions', 'time', 'loggerId']);
    if ([target.taskId, target.projectId, target.resourceId].filter(Boolean).length !== 1)
      fail('One activity target is required');
    if (target.resourceId && dto.kind !== 'comment') fail('Goals accept comments through activity');
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
      ((!target.taskId && !target.projectId) ||
        !Number.isInteger(dto.minutes) ||
        Number(dto.minutes) < 1 ||
        Number(dto.minutes) > 1440)
    )
      fail('Time entries require 1–1440 minutes');
    if (dto.kind !== 'time' && dto.minutes !== undefined)
      fail('Only time entries can contain minutes');
    if (dto.kind !== 'time' && (dto.time !== undefined || dto.loggerId !== undefined))
      fail('Only time entries can contain time settings');
    if (
      dto.loggerId !== undefined &&
      (typeof dto.loggerId !== 'string' || !dto.loggerId || dto.loggerId.length > 200)
    )
      fail('Invalid time submitter');
    let time = dto.kind === 'time' ? plannerTimeDetails(dto.time) : undefined;
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
          if (time) {
            if (dto.time === undefined || object(dto.time).projectId === undefined) {
              if (task.projectIds.length > 1 && dto.time !== undefined)
                fail('Choose one task project for this time entry');
              time.projectId = task.projectIds.length === 1 ? task.projectIds[0]! : null;
            }
            if (dto.time !== undefined && task.projectIds.length && !time.projectId)
              fail('Choose one task project for this time entry');
            this.validateTimeProject(time, task, projects, ctx);
          }
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
            dto.kind === 'status' || dto.kind === 'time' ? 'editor' : 'commenter',
          );
          recipients = [p.ownerId, ...projectData(p).members.map((m) => m.userId)];
          mentionAccess = (id) => Boolean(plannerProjectAccess(p, id));
          if (time) {
            if (time.projectId && time.projectId !== p.id)
              fail('General project time must use this project');
            time.projectId = p.id;
          }
        } else if (target.resourceId) {
          uuid(target.resourceId);
          const row = await this.goalRecord(tx, ctx, target.resourceId, 'commenter');
          recipients = await this.goalRecipients(tx, ctx, row, projects);
          mentionAccess = (id) =>
            Boolean(this.resourceAccess(row, projects, { ...ctx, clerkUserId: id }));
        } else fail('An activity target is required');
        const timeOwnerId = typeof dto.loggerId === 'string' ? dto.loggerId : ctx.clerkUserId;
        if (time) {
          const options = this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx));
          const supplied = dto.time === undefined ? {} : object(dto.time);
          if (supplied.workedOn === undefined) time.workedOn = plannerTimeToday(options.timeZone);
          if (supplied.timeZone === undefined) time.timeZone = options.timeZone;
          if (supplied.billable === undefined)
            time.billable = options.billableEnabled && options.billableDefault;
          if (target.projectId && !options.generalWorkEnabled)
            throw new ForbiddenException('General project time is disabled for this organization');
          requirePlannerTimePolicy(time, options, ctx.role === 'org:admin');
          await this.touchTimesheet(tx, ctx, timeOwnerId, plannerWeekOn(time.workedOn));
        }
        return this.event(
          tx,
          ctx,
          {
            ...target,
            kind: dto.kind as PlannerEvent['kind'],
            text: dto.text as string,
            ...(dto.kind === 'time' ? { minutes: Number(dto.minutes) } : {}),
            ...(time ? { timeOwnerId, details: { time, recordedBy: ctx.clerkUserId } } : {}),
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
      const goals = await tx.spPlannerResource.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: { in: ['goal', 'timesheet', 'project_budget_alert'] },
          id: { in: scanned.flatMap((r) => (r.event.resourceId ? [r.event.resourceId] : [])) },
        },
      });
      const allowedGoals = new Set(
        goals.filter((g) => this.resourceAccess(g, projects, ctx)).map((g) => g.id),
      );
      for (const row of scanned) {
        if (row.event.resourceId && !allowedGoals.has(row.event.resourceId)) continue;
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
      const projected = await this.activityViews(
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
    keys(dto, ['version', 'text', 'minutes', 'removed', 'time']);
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
    if (
      dto.removed === true &&
      (dto.text !== undefined || dto.minutes !== undefined || dto.time !== undefined)
    )
      fail('Remove activity separately from editing it');
    return this.scope(
      ctx,
      async (tx) => {
        const original = await tx.spPlannerEvent.findFirst({
          where: { tenantId: ctx.tenantId, id },
        });
        if (!original) throw missing();
        if (!['comment', 'time'].includes(original.kind))
          fail('Only comments and time entries can be corrected');
        if (original.kind !== 'time' && original.actorId !== ctx.clerkUserId) throw missing();
        const projects = await this.projects(tx, ctx);
        let targetTask: SpPlannerTask | null = null;
        if (original.taskId) {
          const task = await tx.spPlannerTask.findFirst({
            where: { tenantId: ctx.tenantId, id: original.taskId },
          });
          if (!task) throw missing();
          targetTask = task;
          requireRole(
            plannerTaskAccess(task, projects, ctx.clerkUserId),
            original.kind === 'time' ? 'editor' : 'commenter',
          );
        } else if (original.projectId) {
          const project = projects.find((p) => p.id === original.projectId);
          requireRole(
            project ? plannerProjectAccess(project, ctx.clerkUserId) : null,
            original.kind === 'time' ? 'editor' : 'commenter',
          );
        } else if (original.resourceId) {
          await this.goalRecord(tx, ctx, original.resourceId, 'commenter');
        } else throw missing();
        const previous = await tx.spPlannerEventRevision.findFirst({
          where: { tenantId: ctx.tenantId, eventId: original.id },
          orderBy: { version: 'desc' },
        });
        if ((previous?.version ?? 0) !== dto.version)
          throw new ConflictException('This activity changed. Refresh before saving again.');
        if (original.kind !== 'time' && dto.minutes !== undefined)
          fail('Only time entries contain minutes');
        if (original.kind !== 'time' && dto.time !== undefined)
          fail('Only time entries have time settings');
        if (
          previous?.removed &&
          dto.removed !== false &&
          (dto.text !== undefined || dto.minutes !== undefined || dto.time !== undefined)
        )
          fail('Restore removed activity before editing it');
        const text = (dto.text as string | undefined) ?? previous?.text ?? original.text;
        const minutes =
          (dto.minutes as number | undefined) ?? previous?.minutes ?? original.minutes;
        const removed = (dto.removed as boolean | undefined) ?? previous?.removed ?? false;
        const beforeTime =
          original.kind === 'time' ? plannerStoredTime(original, previous ?? undefined) : undefined;
        const time = beforeTime ? plannerTimeDetails(dto.time, beforeTime) : undefined;
        if (time) {
          if (!original.taskId && time.projectId !== original.projectId)
            fail('General project time must stay in its project');
          this.validateTimeProject(time, targetTask, projects, ctx, beforeTime!.projectId);
          requirePlannerTimePolicy(
            time,
            this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)),
            ctx.role === 'org:admin',
            beforeTime,
          );
          for (const week of new Set([
            plannerWeekOn(beforeTime!.workedOn),
            plannerWeekOn(time.workedOn),
          ]))
            await this.touchTimesheet(tx, ctx, original.actorId, week);
        }
        if (
          text === (previous?.text ?? original.text) &&
          minutes === (previous?.minutes ?? original.minutes) &&
          removed === (previous?.removed ?? false) &&
          JSON.stringify(time) === JSON.stringify(beforeTime)
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
            ...(time ? { details: json({ time }) } : {}),
          },
        });
        return plannerEventView(original, revision);
      },
      true,
    );
  }
  /** Same grants as inbox/task views; applied in SQL before counting or limiting.
   * Revoked rows can neither inflate the badge nor hide newer authorized work. */
  private notificationWhere(
    ctx: AuthTenantContext,
    projects: SpPlannerProject[],
    goals: SpPlannerResource[],
  ) {
    const allowed = projects
      .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
      .map((p) => p.id);
    const ids = allowed.length
      ? Prisma.sql`ARRAY[${Prisma.join(allowed)}]::uuid[]`
      : Prisma.sql`ARRAY[]::uuid[]`;
    const allowedGoals = goals
      .filter(
        (g) =>
          ['goal', 'timesheet', 'project_budget_alert'].includes(g.kind) &&
          this.resourceAccess(g, projects, ctx),
      )
      .map((g) => g.id);
    const goalIds = allowedGoals.length
      ? Prisma.sql`ARRAY[${Prisma.join(allowedGoals)}]::uuid[]`
      : Prisma.sql`ARRAY[]::uuid[]`;
    return Prisma.sql`i.tenant_id = ${ctx.tenantId}::uuid AND i.user_id = ${ctx.clerkUserId}
      AND NOT i.read AND NOT i.archived AND e.tenant_id = ${ctx.tenantId}::uuid
      AND (e.task_id IS NOT NULL OR e.project_id IS NOT NULL OR e.resource_id IS NOT NULL)
      AND (e.resource_id IS NULL OR e.resource_id = ANY(${goalIds}))
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
      const goals = await tx.spPlannerResource.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: { in: ['goal', 'timesheet', 'project_budget_alert'] },
        },
      });
      const rows = await tx.$queryRaw<{ id: string; eventId: string; unread: bigint }[]>`
        SELECT i.id, i.event_id AS "eventId", count(*) OVER() AS unread
        FROM sp_planner_inbox i JOIN sp_planner_events e ON e.tenant_id = i.tenant_id AND e.id = i.event_id
        WHERE ${this.notificationWhere(ctx, projects, goals)}
        ORDER BY e.created_at DESC, i.id DESC LIMIT 100`;
      const events = await tx.spPlannerEvent.findMany({
        where: { tenantId: ctx.tenantId, id: { in: rows.map((r) => r.eventId) } },
      });
      const projected = await this.activityViews(tx, ctx, events);
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
            title: event.resourceId
              ? goals.find((g) => g.id === event.resourceId)!.name
              : task
                ? taskData(task).name
                : projectData(project!).name,
            deepLink: event.resourceId
              ? event.budgetThreshold
                ? `/planner?scope=budget&project=${encodeURIComponent(event.budgetThreshold.projectId)}`
                : goals.find((g) => g.id === event.resourceId)!.kind === 'timesheet'
                  ? `/planner?scope=timesheets&week=${encodeURIComponent((goals.find((g) => g.id === event.resourceId)!.data as unknown as PlannerTimesheetData).weekOn)}&user=${encodeURIComponent(goals.find((g) => g.id === event.resourceId)!.ownerId)}`
                  : `/planner?scope=goals&goal=${encodeURIComponent(event.resourceId)}`
              : event.taskId
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
        const goals = await tx.spPlannerResource.findMany({
          where: {
            tenantId: ctx.tenantId,
            kind: { in: ['goal', 'timesheet', 'project_budget_alert'] },
          },
        });
        const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE sp_planner_inbox i SET read = true FROM sp_planner_events e
        WHERE e.id = i.event_id AND e.tenant_id = i.tenant_id AND ${this.notificationWhere(ctx, projects, goals)}
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
        if (row.event.resourceId) {
          const resource = await tx.spPlannerResource.findFirst({
            where: {
              tenantId: ctx.tenantId,
              id: row.event.resourceId,
              kind: { in: ['goal', 'timesheet', 'project_budget_alert'] },
            },
          });
          if (!resource) throw missing();
          requireRole(this.resourceAccess(resource, projects, ctx), 'viewer');
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
    if (row.kind.startsWith('capacity_')) return null;
    if (['task_import_receipt', 'timer_session'].includes(row.kind)) return null;
    if (['project_budget', 'project_budget_alert'].includes(row.kind)) {
      const project = projects.find((p) => p.id === row.projectId);
      return project &&
        plannerProjectAccess(project, ctx.clerkUserId) === 'admin' &&
        (row.kind !== 'project_budget_alert' || row.ownerId === ctx.clerkUserId)
        ? 'admin'
        : null;
    }
    if (row.kind === 'timesheet') {
      const data = row.data as unknown as PlannerTimesheetData;
      return row.ownerId === ctx.clerkUserId || data.reviewerId === ctx.clerkUserId
        ? 'editor'
        : null;
    }
    if (row.kind === 'time_settings') return ctx.role === 'org:admin' ? 'admin' : null;
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
  private async goalRecord(tx: Tx, ctx: AuthTenantContext, id: string, minimum: PlannerRole) {
    const row = await tx.spPlannerResource.findFirst({
      where: { tenantId: ctx.tenantId, id, kind: 'goal' },
    });
    if (!row) throw missing();
    requireRole(this.resourceAccess(row, await this.projects(tx, ctx), ctx), minimum);
    return row;
  }
  private async goalRecipients(
    tx: Tx,
    ctx: AuthTenantContext,
    row: SpPlannerResource,
    projects: SpPlannerProject[],
  ) {
    const data = row.data as unknown as PlannerGoalData;
    const active = new Set((await this.people(tx, ctx)).map((p) => p.id));
    return [...new Set([row.ownerId, data.ownerId, ...(data.followers ?? [])])].filter(
      (id): id is string =>
        !!id && active.has(id) && !!this.resourceAccess(row, projects, { ...ctx, clerkUserId: id }),
    );
  }
  private async activityViews(tx: Tx, ctx: AuthTenantContext, rows: SpPlannerEvent[]) {
    const events = await plannerReadActivity(tx, ctx, rows);
    if (events.some((e) => e.kind === 'time')) {
      const projects = await this.projects(tx, ctx);
      const sheets = await tx.spPlannerResource.findMany({
        where: {
          tenantId: ctx.tenantId,
          kind: 'timesheet',
          ownerId: { in: events.filter((e) => e.kind === 'time').map((e) => e.actorId) },
        },
      });
      const config = await this.timeSettingsRecord(tx, ctx);
      const timeOptions = this.storedTimeOptions(config);
      const reviewers =
        (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
      const tasks = await tx.spPlannerTask.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: events.flatMap((e) => (e.taskId ? [e.taskId] : [])) },
        },
      });
      for (const event of events.filter((e) => e.kind === 'time')) {
        const weekOn = plannerWeekOn(event.time!.workedOn);
        const data = sheets.find(
          (s) =>
            s.ownerId === event.actorId &&
            (s.data as unknown as PlannerTimesheetData).weekOn === weekOn,
        )?.data as unknown as PlannerTimesheetData | undefined;
        const sheet = data ?? {
          weekOn,
          reviewerId: reviewers[event.actorId] ?? null,
          status: 'draft' as const,
          notes: '',
          correctedAfterApproval: false,
        };
        const task = tasks.find((t) => t.id === event.taskId),
          project = projects.find((p) => p.id === (event.time!.projectId ?? event.projectId));
        const role = task
          ? plannerTaskAccess(task, projects, ctx.clerkUserId)
          : project
            ? plannerProjectAccess(project, ctx.clerkUserId)
            : null;
        event.timeEditable =
          ['editor', 'admin'].includes(role ?? '') &&
          (!project ||
            ['editor', 'admin'].includes(plannerProjectAccess(project, ctx.clerkUserId) ?? '')) &&
          plannerTimeEditable(sheet, event.actorId, ctx.clerkUserId, ctx.role === 'org:admin') &&
          !plannerTimeDateNotice(event.time!.workedOn, timeOptions, ctx.role === 'org:admin');
        if (
          event.time!.projectId &&
          (!project || !plannerProjectAccess(project, ctx.clerkUserId))
        ) {
          event.time = { ...event.time!, projectId: null };
          event.timeEditable = false;
        }
      }
    }
    if (!rows.some((r) => r.resourceId && (r.details as Record<string, unknown>)?.goalSnapshot))
      return events;
    const projects = await this.projects(tx, ctx);
    const goals = await tx.spPlannerResource.findMany({
      where: { tenantId: ctx.tenantId, kind: 'goal' },
    });
    const tasks = await this.goalTasks(tx, ctx);
    const allowed = {
      goals: goals.filter((g) => this.resourceAccess(g, projects, ctx)).map((g) => g.id),
      projects: projects.filter((p) => plannerProjectAccess(p, ctx.clerkUserId)).map((p) => p.id),
      tasks: tasks.filter((t) => plannerTaskAccess(t, projects, ctx.clerkUserId)).map((t) => t.id),
    };
    const byId = new Map(rows.map((r) => [r.id, r]));
    return events.map((e) => plannerGoalActivityView(e, byId.get(e.id)!.details, allowed));
  }
  private async captureGoalViews(tx: Tx, ctx: AuthTenantContext, projects: SpPlannerProject[]) {
    const goals = await tx.spPlannerResource.findMany({
      where: { tenantId: ctx.tenantId, kind: 'goal' },
    });
    if (!goals.some((g) => !g.archived && this.resourceAccess(g, projects, ctx))) return [];
    return this.resourceViews(goals, projects, ctx, await this.goalTasks(tx, ctx));
  }
  private async recordGoalChanges(
    tx: Tx,
    ctx: AuthTenantContext,
    before: PlannerResource[],
    after: PlannerResource[],
    projects: SpPlannerProject[],
    skipIds = new Set<string>(),
    actorId = ctx.clerkUserId,
  ) {
    const prior = new Map(before.map((g) => [g.id, g]));
    const activeProjects = new Set(
      projects
        .filter((p) => !p.archived && plannerProjectAccess(p, ctx.clerkUserId))
        .map((p) => p.id),
    );
    const events: Prisma.SpPlannerEventCreateManyInput[] = [];
    for (const goal of after.filter((g) => !g.archived && !skipIds.has(g.id))) {
      const previous = prior.get(goal.id);
      // Connected-work changes preserve the original target and unit in each point.
      const details = plannerGoalSnapshotDetails(goal, after, activeProjects);
      if (
        previous &&
        JSON.stringify(
          plannerGoalSnapshotDetails(previous, before, activeProjects).goalSnapshot,
        ) === JSON.stringify(details.goalSnapshot) &&
        JSON.stringify(previous.goalProgress?.sources) ===
          JSON.stringify(goal.goalProgress?.sources) &&
        ((goal.data as unknown as PlannerGoalData).progress !== 'task_completion' ||
          JSON.stringify(previous.data.projectIds) === JSON.stringify(goal.data.projectIds))
      )
        continue;
      events.push({
        tenantId: ctx.tenantId,
        resourceId: goal.id,
        actorId,
        kind: 'goal_progress',
        text: previous ? 'Goal progress updated' : 'Goal created',
        details: json(details),
      });
    }
    if (events.length) await tx.spPlannerEvent.createMany({ data: events });
  }
  async followGoal(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'following']);
    if (typeof dto.following !== 'boolean') fail('Choose whether to follow this goal');
    return this.scope(
      ctx,
      async (tx) => {
        const row = await this.goalRecord(tx, ctx, id, 'viewer');
        version(row.version, dto.version as number | undefined);
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId))
          throw new ForbiddenException('Active membership is required');
        if (row.archived && dto.following) fail('Restore the goal before following it');
        const data = row.data as unknown as PlannerGoalData;
        const followers = (data.followers ?? []).filter((id) => id !== ctx.clerkUserId);
        if (dto.following) followers.push(ctx.clerkUserId);
        if (followers.length > 1000) fail('This goal has reached its follower limit');
        await tx.spPlannerResource.update({
          where: { tenantId: ctx.tenantId, id },
          data: { data: json({ ...data, followers }), version: { increment: 1 } },
        });
        return { following: dto.following };
      },
      true,
    );
  }
  async postGoalUpdate(ctx: AuthTenantContext, id: string, raw: unknown) {
    uuid(id);
    const dto = validatePlannerGoalUpdate(raw);
    return this.scope(
      ctx,
      async (tx) => {
        const row = await this.goalRecord(tx, ctx, id, 'editor');
        version(row.version, dto.version as number | undefined);
        if (row.archived) fail('Restore the goal before posting an update');
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId))
          throw new ForbiddenException('Active membership is required');
        const beforeViews = await this.captureGoalViews(tx, ctx, await this.projects(tx, ctx));
        const previous = row.data as unknown as PlannerGoalData;
        if (dto.current !== undefined && previous.progress !== 'manual')
          fail('Automatic goal progress comes from connected work');
        if (
          (dto.reminder !== undefined || dto.timeZone !== undefined) &&
          previous.ownerId !== ctx.clerkUserId
        )
          throw new ForbiddenException('Only the responsible goal owner can set reminders');
        const data = validateResource('goal', {
          ...previous,
          status: dto.status,
          ...(dto.current === undefined ? {} : { current: dto.current }),
          ...(dto.reminder === undefined ? {} : { reminder: dto.reminder }),
          ...(dto.timeZone === undefined ? {} : { timeZone: dto.timeZone }),
        });
        const saved = await tx.spPlannerResource.update({
          where: { tenantId: ctx.tenantId, id },
          data: { data: json(data), version: { increment: 1 } },
        });
        const projects = await this.projects(tx, ctx);
        const goals = await tx.spPlannerResource.findMany({
          where: { tenantId: ctx.tenantId, kind: 'goal' },
        });
        const views = this.resourceViews(goals, projects, ctx, await this.goalTasks(tx, ctx));
        const view = views.find((g) => g.id === id)!;
        await this.recordGoalChanges(tx, ctx, beforeViews, views, projects, new Set([id]));
        const details = {
          ...plannerGoalSnapshotDetails(
            view,
            views,
            new Set(
              projects
                .filter((p) => !p.archived && plannerProjectAccess(p, ctx.clerkUserId))
                .map((p) => p.id),
            ),
          ),
          goalUpdate: { title: dto.title, sections: dto.sections },
        };
        const event = await this.event(
          tx,
          ctx,
          {
            resourceId: id,
            kind: 'goal_status',
            text: dto.text,
            details: details as unknown as Record<string, unknown>,
          },
          await this.goalRecipients(tx, ctx, saved, projects),
        );
        const stored = await tx.spPlannerEvent.findFirst({
          where: { tenantId: ctx.tenantId, id: event.id },
        });
        return { goal: view, event: (await this.activityViews(tx, ctx, [stored!]))[0]! };
      },
      true,
    );
  }
  /** Goal cadence and grading notices share the existing approved Inbox/bell.
   * Each goal commits its immutable delivery receipt with the event and inbox row. */
  async runScheduledGoalWork(tenantId: string, now = new Date(), afterGoalId?: string) {
    uuid(tenantId);
    if (afterGoalId) uuid(afterGoalId);
    const scope: AuthTenantContext = { tenantId, clerkUserId: '', role: null };
    const page = await this.scope(scope, (tx) =>
      tx.spPlannerResource.findMany({
        where: {
          tenantId,
          kind: 'goal',
          archived: false,
          ...(afterGoalId ? { id: { gt: afterGoalId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
      }),
    );
    let executed = 0,
      failed = 0;
    for (const candidate of page.slice(0, 50)) {
      try {
        executed += await this.scope(
          scope,
          async (tx) => {
            const row = await tx.spPlannerResource.findFirst({
              where: { tenantId, id: candidate.id, kind: 'goal', archived: false },
            });
            if (!row) return 0;
            const data = validateResource('goal', row.data) as unknown as PlannerGoalData;
            if (!data.ownerId || !['on_track', 'at_risk', 'off_track'].includes(data.status))
              return 0;
            const author = { ...scope, clerkUserId: data.ownerId };
            if (!(await this.people(tx, author)).some((p) => p.id === data.ownerId)) return 0;
            const projects = await this.projects(tx, author);
            if (!['editor', 'admin'].includes(this.resourceAccess(row, projects, author) ?? ''))
              return 0;
            const deliveries: {
              kind: 'update' | 'grading';
              fingerprint: string;
              deadlineKey: string;
              text: string;
            }[] = [];
            if (data.reminder) {
              const due = plannerGoalReminderDue(data.reminder, now);
              if (due)
                deliveries.push({
                  kind: 'update',
                  fingerprint: plannerScheduleHash([
                    data.reminder.cadence,
                    data.reminder.anchorOn,
                    data.reminder.time,
                    data.reminder.timeZone,
                  ]),
                  deadlineKey: plannerScheduleHash([due.date]),
                  text: 'Time to post a goal status update',
                });
            }
            if (data.dueOn) {
              const date = new Date(`${data.dueOn}T12:00:00Z`);
              date.setUTCDate(date.getUTCDate() - PLANNER_GOAL_GRADING_DAYS);
              const zone = data.timeZone ?? data.reminder?.timeZone ?? 'UTC';
              const instant = plannerScheduledInstant(
                date.toISOString().slice(0, 10),
                '09:00',
                zone,
              );
              if (instant.getTime() <= now.getTime())
                deliveries.push({
                  kind: 'grading',
                  fingerprint: plannerScheduleHash([data.dueOn, zone, 'one-week-before-09:00']),
                  deadlineKey: plannerScheduleHash([data.dueOn]),
                  text: 'Your goal is nearing its due date. Review its progress and close it when ready.',
                });
            }
            let count = 0;
            for (const delivery of deliveries) {
              const key = {
                tenantId,
                resourceId: row.id,
                ownerId: data.ownerId,
                kind: delivery.kind,
                fingerprint: delivery.fingerprint,
                deadlineKey: delivery.deadlineKey,
              };
              if (await tx.spPlannerGoalReminderClaim.findFirst({ where: key })) continue;
              const event = await this.event(
                tx,
                author,
                { resourceId: row.id, kind: 'reminder', text: delivery.text },
                [data.ownerId],
                true,
              );
              await tx.spPlannerGoalReminderClaim.create({ data: { ...key, eventId: event.id } });
              count++;
            }
            return count;
          },
          true,
        );
      } catch {
        failed++;
        this.logger.warn(
          `Planner goal ${candidate.id} scheduled work failed; next cycle will retry`,
        );
      }
    }
    return { executed, failed, nextCursor: page.length > 50 ? page[49]!.id : null };
  }
  async runScheduledTimeWork(tenantId: string, now = new Date(), afterUserId?: string) {
    uuid(tenantId);
    if (afterUserId !== undefined && (!afterUserId || afterUserId.length > 200))
      fail('Invalid time reminder cursor');
    const scope: AuthTenantContext = { tenantId, clerkUserId: '', role: null };
    const candidates = await this.scope(scope, async (tx) => {
      const config = await this.timeSettingsRecord(tx, scope);
      const options = this.storedTimeOptions(config);
      if (!plannerTimeSubmissionDue(options, now)) return [];
      const people = await this.people(tx, scope),
        active = new Set(people.map((p) => p.id)),
        reviewers =
          (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
      return [...active]
        .filter(
          (id) =>
            typeof id === 'string' &&
            !!id &&
            (options.approvalProcess === 'simple' ||
              (!!reviewers[id] && active.has(reviewers[id]!))) &&
            (!afterUserId || id > afterUserId),
        )
        .sort()
        .slice(0, 51);
    });
    let executed = 0,
      failed = 0;
    for (const ownerId of candidates.slice(0, 50)) {
      try {
        executed += await this.scope(
          scope,
          async (tx) => {
            const config = await this.timeSettingsRecord(tx, scope),
              options = this.storedTimeOptions(config),
              due = plannerTimeSubmissionDue(options, now);
            if (!due) return 0;
            const active = new Set((await this.people(tx, scope)).map((p) => p.id)),
              reviewers =
                (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ??
                {};
            if (
              !active.has(ownerId) ||
              (options.approvalProcess === 'full' &&
                (!reviewers[ownerId] || !active.has(reviewers[ownerId]!)))
            )
              return 0;
            const author: AuthTenantContext = {
              tenantId,
              clerkUserId: ownerId,
              role: 'org:member',
            };
            const old = await this.timeSheetRecord(tx, author, ownerId, due.weekOn),
              data = await this.timeSheetData(tx, author, ownerId, due.weekOn, old);
            if (!['draft', 'rejected'].includes(data.status)) return 0;
            const weekOn = new Date(`${due.weekOn}T00:00:00Z`);
            if (
              await tx.spPlannerTimeReminderClaim.findFirst({
                where: { tenantId, ownerId, weekOn },
              })
            )
              return 0;
            const row =
              old ??
              (await tx.spPlannerResource.create({
                data: {
                  tenantId,
                  ownerId,
                  kind: 'timesheet',
                  name: `Timesheet · ${due.weekOn}`,
                  data: json(data),
                },
              }));
            const event = await this.event(
              tx,
              author,
              {
                resourceId: row.id,
                kind: 'reminder',
                text: `Time to submit your timesheet · ${due.weekOn}`,
                details: {
                  timesheet: { weekOn: due.weekOn, userId: ownerId },
                  timesheetReminder: { scheduledOn: due.scheduledOn, deadlineAt: due.deadlineAt },
                },
              },
              [ownerId],
              true,
            );
            await tx.spPlannerTimeReminderClaim.create({
              data: {
                tenantId,
                resourceId: row.id,
                ownerId,
                weekOn,
                scheduledOn: new Date(`${due.scheduledOn}T00:00:00Z`),
                eventId: event.id,
              },
            });
            return 1;
          },
          true,
        );
      } catch {
        failed++;
        this.logger.warn(
          `Planner time submitter ${ownerId} reminder failed; next cycle will retry`,
        );
      }
    }
    return { executed, failed, nextCursor: candidates.length > 50 ? candidates[49]! : null };
  }
  private reportVisibility(
    projects: SpPlannerProject[],
    rows: SpPlannerResource[],
    ctx: AuthTenantContext,
  ): PlannerReportVisibility {
    const readable = projects.filter((p) => plannerProjectAccess(p, ctx.clerkUserId));
    return {
      projects: new Set(readable.map((p) => p.id)),
      portfolios: new Set(
        rows
          .filter((r) => r.kind === 'portfolio' && this.resourceAccess(r, projects, ctx))
          .map((r) => r.id),
      ),
      fields: new Set(readable.flatMap((p) => projectData(p).fields.map((f) => f.id))),
    };
  }
  private resourceView(
    row: SpPlannerResource,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
    goalIds = new Set<string>(),
    taskIds = new Set<string>(),
    projectIds?: Set<string>,
    reportVisibility?: PlannerReportVisibility,
  ): PlannerResource {
    const access = this.resourceAccess(row, projects, ctx);
    requireRole(access, 'viewer');
    const data = structuredClone(row.data) as Record<string, unknown>;
    const report =
      row.kind === 'dashboard'
        ? plannerReportWidgetView(
            data.widgets as PlannerReportWidget[],
            reportVisibility ?? this.reportVisibility(projects, [], ctx),
          )
        : null;
    if (report) data.widgets = report.widgets;
    if (Array.isArray(data.projectIds))
      data.projectIds = data.projectIds.filter((id) =>
        projectIds
          ? projectIds.has(id)
          : projects.some((p) => p.id === id && plannerProjectAccess(p, ctx.clerkUserId)),
      );
    if (row.kind === 'goal') {
      if (Array.isArray(data.followers))
        data.followers = data.followers.filter((id) =>
          this.resourceAccess(row, projects, { ...ctx, clerkUserId: String(id) }),
        );
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
      ...(report ? { reportWarnings: report.warnings } : {}),
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
    const reportVisibility = this.reportVisibility(projects, rows, ctx);
    const views = visible.map((row) =>
      this.resourceView(row, projects, ctx, goalIds, taskIds, projectIds, reportVisibility),
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
        where: { tenantId: ctx.tenantId, kind: { in: RESOURCE_KINDS } },
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
  /** Current source grants are checked again for every aggregate. Private financial
   * configuration is never part of generic resource or project serialization. */
  private async budgetViews(
    tx: Tx,
    ctx: AuthTenantContext,
    projects: SpPlannerProject[],
    selectedIds: string[],
  ): Promise<PlannerProjectBudget[]> {
    const selected = projects.filter(
      (p) => selectedIds.includes(p.id) && plannerProjectAccess(p, ctx.clerkUserId) === 'admin',
    );
    if (!selected.length) return [];
    const ids = selected.map((p) => p.id),
      names = new Map((await this.people(tx, ctx)).map((p) => [p.id, p.name]));
    const resources = await tx.spPlannerResource.findMany({
      where: {
        tenantId: ctx.tenantId,
        projectId: { in: ids },
        kind: { in: ['project_budget', 'project_budget_alert'] },
      },
    });
    const currency =
      this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)).budgetCurrency ?? 'USD';
    const estimates = await tx.spPlannerTask.findMany({
      where: { tenantId: ctx.tenantId, archived: false, projectIds: { hasSome: ids } },
    });
    const events = await tx.$queryRaw<SpPlannerEvent[]>`
      SELECT e.id,e.tenant_id AS "tenantId",e.actor_id AS "actorId",e.task_id AS "taskId",e.project_id AS "projectId",
        e.resource_id AS "resourceId",e.details,e.kind,e.text,e.minutes,e.created_at AS "createdAt"
      FROM sp_planner_events e LEFT JOIN LATERAL (
        SELECT details,removed FROM sp_planner_event_revisions WHERE tenant_id=${ctx.tenantId}::uuid AND event_id=e.id ORDER BY version DESC LIMIT 1
      ) r ON true
      WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.kind='time' AND NOT COALESCE(r.removed,false)
      AND COALESCE(r.details->'time'->>'projectId',e.details->'time'->>'projectId',e.project_id::text) IN (${Prisma.join(ids)})`;
    const views = await plannerReadActivity(tx, ctx, events);
    const tasks = await tx.spPlannerTask.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: events.flatMap((e) => (e.taskId ? [e.taskId] : [])) },
      },
    });
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const visibleTime = views.filter(
      (e) =>
        !e.removed &&
        e.time?.projectId &&
        ids.includes(e.time.projectId) &&
        (!e.taskId ||
          (taskById.has(e.taskId) &&
            plannerTaskAccess(taskById.get(e.taskId)!, projects, ctx.clerkUserId))),
    );
    return selected.map((project) => {
      const row = resources.find((r) => r.kind === 'project_budget' && r.projectId === project.id);
      const alert = resources.find(
        (r) =>
          r.kind === 'project_budget_alert' &&
          r.projectId === project.id &&
          r.ownerId === ctx.clerkUserId,
      );
      return plannerBudgetSummary({
        projectId: project.id,
        projectName: projectData(project).name,
        version: row?.version ?? 0,
        data: row ? (row.data as unknown as PlannerBudgetData) : plannerDefaultBudget(currency),
        alert: alert
          ? {
              ...(alert.data as unknown as Omit<PlannerBudgetAlert, 'version'>),
              version: alert.version,
            }
          : { ...PLANNER_DEFAULT_BUDGET_ALERT },
        active: names,
        estimates: estimates
          .filter(
            (t) =>
              t.projectIds.includes(project.id) && plannerTaskAccess(t, projects, ctx.clerkUserId),
          )
          .map((t) => ({ userId: t.assigneeId, minutes: taskData(t).estimateMinutes })),
        time: visibleTime
          .filter((e) => e.time!.projectId === project.id)
          .map((e) => ({ userId: e.actorId, minutes: e.minutes ?? 0, billable: e.time!.billable })),
      });
    });
  }
  async projectBudget(ctx: AuthTenantContext, id: string): Promise<PlannerProjectBudget> {
    uuid(id);
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
        const projects = await this.projects(tx, ctx),
          project = projects.find((p) => p.id === id);
        requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'admin');
        return (await this.budgetViews(tx, ctx, projects, [id]))[0]!;
      },
      { timeoutMs: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async saveProjectBudget(
    ctx: AuthTenantContext,
    id: string,
    raw: unknown,
  ): Promise<PlannerProjectBudget> {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'data']);
    if (
      !Number.isInteger(dto.version) ||
      Number(dto.version) < 0 ||
      Number(dto.version) > 1_000_000
    )
      fail('An expected budget version is required');
    return this.scope(
      ctx,
      async (tx) => {
        const active = new Map((await this.people(tx, ctx)).map((p) => [p.id, p.name]));
        if (!active.has(ctx.clerkUserId)) throw missing();
        const projects = await this.projects(tx, ctx),
          project = projects.find((p) => p.id === id);
        requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'admin');
        if (project!.archived) fail('Restore the project before changing its budget');
        const row = await tx.spPlannerResource.findFirst({
          where: { tenantId: ctx.tenantId, projectId: id, kind: 'project_budget' },
        });
        if ((row?.version ?? 0) !== dto.version)
          throw new ConflictException('The budget changed. Refresh before saving again.');
        const currency =
          this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)).budgetCurrency ?? 'USD';
        const data = plannerBudgetData(
          dto.data,
          row ? (row.data as unknown as PlannerBudgetData) : plannerDefaultBudget(currency),
          active,
        );
        if (row)
          await tx.spPlannerResource.update({
            where: { tenantId: ctx.tenantId, id: row.id },
            data: { data: json(data), version: { increment: 1 } },
          });
        else
          await tx.spPlannerResource.create({
            data: {
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              projectId: id,
              kind: 'project_budget',
              name: 'Project budget',
              data: json(data),
            },
          });
        return (await this.budgetViews(tx, ctx, projects, [id]))[0]!;
      },
      true,
    );
  }
  async saveBudgetAlert(
    ctx: AuthTenantContext,
    id: string,
    raw: unknown,
  ): Promise<PlannerProjectBudget> {
    uuid(id);
    const dto = object(raw);
    keys(dto, ['version', 'data']);
    if (
      !Number.isInteger(dto.version) ||
      Number(dto.version) < 0 ||
      Number(dto.version) > 1_000_000
    )
      fail('An expected alert version is required');
    const data = plannerBudgetAlert(dto.data);
    return this.scope(
      ctx,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
        const projects = await this.projects(tx, ctx),
          project = projects.find((p) => p.id === id);
        requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'admin');
        if (project!.archived) fail('Restore the project before changing its budget alert');
        const row = await tx.spPlannerResource.findFirst({
          where: {
            tenantId: ctx.tenantId,
            projectId: id,
            ownerId: ctx.clerkUserId,
            kind: 'project_budget_alert',
          },
        });
        if ((row?.version ?? 0) !== dto.version)
          throw new ConflictException('The alert changed. Refresh before saving again.');
        if (row)
          await tx.spPlannerResource.update({
            where: { tenantId: ctx.tenantId, id: row.id },
            data: { data: json(data), version: { increment: 1 } },
          });
        else
          await tx.spPlannerResource.create({
            data: {
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              projectId: id,
              kind: 'project_budget_alert',
              name: `Budget · ${projectData(project!).name}`,
              data: json(data),
            },
          });
        return (await this.budgetViews(tx, ctx, projects, [id]))[0]!;
      },
      true,
    );
  }
  async portfolioBudgets(ctx: AuthTenantContext, id: string): Promise<PlannerPortfolioBudgets> {
    uuid(id);
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
        const projects = await this.projects(tx, ctx),
          row = await tx.spPlannerResource.findFirst({
            where: { tenantId: ctx.tenantId, id, kind: 'portfolio' },
          });
        if (!row) throw missing();
        requireRole(this.resourceAccess(row, projects, ctx), 'viewer');
        const budgets = await this.budgetViews(
          tx,
          ctx,
          projects,
          (row.data as { projectIds?: string[] }).projectIds ?? [],
        );
        const currencies = new Map<string, PlannerPortfolioBudgets['currencies'][number]>();
        for (const b of budgets) {
          const total = currencies.get(b.data.currency) ?? {
            currency: b.data.currency,
            estimatedMinor: '0',
            actualMinor: '0',
            budgetMinor: '0',
            unratedEstimatedMinutes: 0,
            unratedActualMinutes: 0,
          };
          for (const key of ['estimatedMinor', 'actualMinor'] as const)
            total[key] = (BigInt(total[key]) + BigInt(b[key])).toString();
          if (b.data.measurement === 'cost')
            total.budgetMinor = (
              BigInt(total.budgetMinor) + BigInt(b.data.budgetMinor ?? '0')
            ).toString();
          total.unratedEstimatedMinutes += b.unratedEstimatedMinutes;
          total.unratedActualMinutes += b.unratedActualMinutes;
          currencies.set(total.currency, total);
        }
        return {
          projects: budgets,
          estimatedMinutes: budgets.reduce((n, b) => n + b.estimatedMinutes, 0),
          actualMinutes: budgets.reduce((n, b) => n + b.actualMinutes, 0),
          budgetMinutes: budgets.reduce(
            (n, b) => n + (b.data.measurement === 'time' ? (b.data.budgetMinutes ?? 0) : 0),
            0,
          ),
          currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
        };
      },
      { timeoutMs: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async runScheduledBudgetWork(tenantId: string, _now = new Date(), afterId?: string) {
    uuid(tenantId);
    if (afterId) uuid(afterId);
    const scope: AuthTenantContext = { tenantId, clerkUserId: '', role: null };
    const candidates = await this.scope(scope, (tx) =>
      tx.spPlannerResource.findMany({
        where: {
          tenantId,
          kind: 'project_budget_alert',
          archived: false,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 51,
      }),
    );
    let executed = 0,
      failed = 0;
    for (const candidate of candidates.slice(0, 50)) {
      try {
        executed += await this.scope(
          scope,
          async (tx) => {
            const row = await tx.spPlannerResource.findFirst({
              where: { tenantId, id: candidate.id, kind: 'project_budget_alert', archived: false },
            });
            if (
              !row ||
              !(row.data as { enabled?: boolean }).enabled ||
              !(await this.people(tx, scope)).some((p) => p.id === row.ownerId)
            )
              return 0;
            const author = { ...scope, clerkUserId: row.ownerId },
              projects = await this.projects(tx, scope),
              project = projects.find((p) => p.id === row.projectId);
            if (!project || project.archived || !this.resourceAccess(row, projects, author))
              return 0;
            const budget = (await this.budgetViews(tx, author, projects, [project.id]))[0]!;
            if (!plannerBudgetAlertDue(budget)) return 0;
            const fingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  alertVersion: row.version,
                  budgetVersion: budget.version,
                  data: budget.data,
                  alert: budget.alert,
                }),
              )
              .digest('hex');
            if (
              await tx.spPlannerBudgetAlertClaim.findFirst({
                where: { tenantId, resourceId: row.id, ownerId: row.ownerId, fingerprint },
              })
            )
              return 0;
            const amounts = plannerBudgetAmounts(budget),
              reference =
                budget.alert.comparison === 'budget' ? amounts.budget! : amounts.estimated;
            const display =
              budget.data.measurement === 'cost'
                ? plannerMoneyFormat(amounts.actual, budget.data.currency)
                : `${(budget.actualMinutes / 60).toFixed(2)} hours`;
            const event = await this.event(
              tx,
              author,
              {
                resourceId: row.id,
                kind: 'budget_threshold',
                text: `${projectData(project).name} reached ${budget.alert.percent}% of its ${budget.alert.comparison} · ${display}`,
                details: {
                  budgetThreshold: {
                    projectId: project.id,
                    measurement: budget.data.measurement,
                    currency: budget.data.currency,
                    actual: amounts.actual,
                    reference,
                    percent: budget.alert.percent,
                    comparison: budget.alert.comparison,
                  },
                },
              },
              [row.ownerId],
              true,
            );
            await tx.spPlannerBudgetAlertClaim.create({
              data: {
                tenantId,
                resourceId: row.id,
                ownerId: row.ownerId,
                fingerprint,
                eventId: event.id,
              },
            });
            return 1;
          },
          true,
        );
      } catch {
        failed++;
        this.logger.warn(`Planner budget alert ${candidate.id} failed; next cycle will retry`);
      }
    }
    return { executed, failed, nextCursor: candidates.length > 50 ? candidates[49]!.id : null };
  }
  private async timeSettingsRecord(tx: Tx, ctx: AuthTenantContext) {
    return tx.spPlannerResource.findFirst({
      where: { tenantId: ctx.tenantId, kind: 'time_settings' },
    });
  }
  private timePreferencesRecord(tx: Tx, ctx: AuthTenantContext, userId = ctx.clerkUserId) {
    return tx.spPlannerResource.findFirst({
      where: { tenantId: ctx.tenantId, ownerId: userId, kind: 'time_preferences' },
    });
  }
  async timePreferences(ctx: AuthTenantContext): Promise<PlannerTimePreferences> {
    return this.scope(ctx, async (tx) => {
      if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
      const row = await this.timePreferencesRecord(tx, ctx);
      const stored = row?.data as { autoAddDueTasks?: boolean; reviewView?: unknown } | undefined;
      return {
        version: row?.version ?? 0,
        autoAddDueTasks: stored?.autoAddDueTasks === true,
        ...(stored?.reviewView === undefined
          ? {}
          : { reviewView: plannerTimeReviewView(stored.reviewView) }),
      };
    });
  }
  async saveTimePreferences(ctx: AuthTenantContext, raw: unknown) {
    const dto = object(raw);
    keys(dto, ['version', 'autoAddDueTasks', 'reviewView']);
    if (dto.autoAddDueTasks === undefined && dto.reviewView === undefined)
      fail('Choose a personal timesheet setting');
    if (dto.autoAddDueTasks !== undefined && typeof dto.autoAddDueTasks !== 'boolean')
      fail('Choose whether to auto-add due tasks');
    const reviewView =
      dto.reviewView === undefined ? undefined : plannerTimeReviewView(dto.reviewView);
    return this.scope(
      ctx,
      async (tx) => {
        if (!(await this.people(tx, ctx)).some((p) => p.id === ctx.clerkUserId)) throw missing();
        const row = await this.timePreferencesRecord(tx, ctx);
        requirePlannerTimesheetVersion(dto.version, row?.version ?? 0);
        const previous = row?.data as
          { autoAddDueTasks?: boolean; reviewView?: unknown } | undefined;
        const data = json({
          autoAddDueTasks: dto.autoAddDueTasks ?? previous?.autoAddDueTasks ?? false,
          ...(previous?.reviewView === undefined ? {} : { reviewView: previous.reviewView }),
          ...(reviewView === undefined ? {} : { reviewView }),
        });
        if (row)
          await tx.spPlannerResource.update({
            where: { tenantId: ctx.tenantId, id: row.id },
            data: { data, version: { increment: 1 } },
          });
        else
          await tx.spPlannerResource.create({
            data: {
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              kind: 'time_preferences',
              name: 'Personal timesheet settings',
              data,
            },
          });
        return { ok: true, version: (row?.version ?? 0) + 1 };
      },
      true,
    );
  }
  private storedTimeOptions(row: SpPlannerResource | null) {
    return plannerTimeOptions((row?.data as { options?: unknown } | undefined)?.options);
  }
  async timeSettings(ctx: AuthTenantContext): Promise<PlannerTimeSettings> {
    return this.scope(ctx, async (tx) => {
      const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
      if (!people.has(ctx.clerkUserId)) throw missing();
      const row = await this.timeSettingsRecord(tx, ctx);
      const reviewers =
        (row?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
      return {
        version: row?.version ?? 0,
        canManage: ctx.role === 'org:admin',
        options: this.storedTimeOptions(row),
        reviewers: Object.fromEntries(
          Object.entries(reviewers).filter(
            ([user, reviewer]) => people.has(user) && people.has(reviewer),
          ),
        ),
      };
    });
  }
  async saveTimeSettings(ctx: AuthTenantContext, raw: unknown) {
    const dto = object(raw);
    keys(dto, ['version', 'reviewers', 'options']);
    const reviewers = object(dto.reviewers);
    if (Object.keys(reviewers).length > 1000) fail('Too many reviewer assignments');
    return this.scope(
      ctx,
      async (tx) => {
        if (ctx.role !== 'org:admin')
          throw new ForbiddenException('Organization admin access is required');
        const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
        if (!people.has(ctx.clerkUserId)) throw missing();
        for (const [user, reviewer] of Object.entries(reviewers))
          if (
            !people.has(user) ||
            typeof reviewer !== 'string' ||
            !people.has(reviewer) ||
            user === reviewer
          )
            fail('Choose an active reviewer other than the submitter');
        const old = await this.timeSettingsRecord(tx, ctx);
        requirePlannerTimesheetVersion(dto.version, old?.version ?? 0);
        const options = plannerTimeOptions(dto.options, this.storedTimeOptions(old));
        const data = json({ reviewers, options });
        if (old)
          await tx.spPlannerResource.update({
            where: { id: old.id, tenantId: ctx.tenantId },
            data: { data, version: { increment: 1 } },
          });
        else
          await tx.spPlannerResource.create({
            data: {
              tenantId: ctx.tenantId,
              ownerId: ctx.clerkUserId,
              kind: 'time_settings',
              name: 'Time reviewers',
              data,
            },
          });
        const sheets = await tx.spPlannerResource.findMany({
          where: { tenantId: ctx.tenantId, kind: 'timesheet' },
        });
        for (const sheet of sheets) {
          const d = sheet.data as unknown as PlannerTimesheetData;
          const reviewerId = (reviewers[sheet.ownerId] as string | undefined) ?? null;
          if (reviewerId !== d.reviewerId)
            await tx.spPlannerResource.update({
              where: { tenantId: ctx.tenantId, id: sheet.id },
              data: { data: json({ ...d, reviewerId }), version: { increment: 1 } },
            });
        }
        return { ok: true };
      },
      true,
    );
  }
  private timeSheetRecord(tx: Tx, ctx: AuthTenantContext, userId: string, weekOn: string) {
    return tx.spPlannerResource.findFirst({
      where: {
        tenantId: ctx.tenantId,
        kind: 'timesheet',
        ownerId: userId,
        data: { path: ['weekOn'], equals: weekOn },
      },
    });
  }
  private async timeSheetData(
    tx: Tx,
    ctx: AuthTenantContext,
    userId: string,
    weekOn: string,
    row: SpPlannerResource | null,
  ): Promise<PlannerTimesheetData> {
    if (row) return row.data as unknown as PlannerTimesheetData;
    const config = await this.timeSettingsRecord(tx, ctx);
    const reviewers =
      (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
    return {
      weekOn,
      reviewerId: reviewers[userId] ?? null,
      status: 'draft',
      notes: '',
      correctedAfterApproval: false,
    };
  }
  private async timeSheetReadable(
    tx: Tx,
    ctx: AuthTenantContext,
    userId: string,
    data: PlannerTimesheetData,
  ) {
    const people = new Set((await this.people(tx, ctx)).map((p) => p.id));
    if (
      !people.has(ctx.clerkUserId) ||
      !people.has(userId) ||
      (ctx.clerkUserId !== userId &&
        (data.reviewerId !== ctx.clerkUserId || !people.has(data.reviewerId)))
    )
      throw missing();
  }
  private async touchTimesheet(tx: Tx, ctx: AuthTenantContext, userId: string, weekOn: string) {
    const row = await this.timeSheetRecord(tx, ctx, userId, weekOn);
    const data = await this.timeSheetData(tx, ctx, userId, weekOn, row);
    await this.timeSheetReadable(tx, ctx, userId, data);
    requirePlannerTimeEditable(data, userId, ctx.clerkUserId, ctx.role === 'org:admin');
    if (row)
      await tx.spPlannerResource.update({
        where: { tenantId: ctx.tenantId, id: row.id },
        data: {
          data: json({
            ...data,
            correctedAfterApproval: data.correctedAfterApproval || data.status === 'approved',
          }),
          version: { increment: 1 },
        },
      });
    else
      await tx.spPlannerResource.create({
        data: {
          tenantId: ctx.tenantId,
          ownerId: userId,
          kind: 'timesheet',
          name: `Timesheet · ${weekOn}`,
          data: json(data),
        },
      });
  }
  private validateTimeProject(
    time: PlannerTimeDetails,
    task: SpPlannerTask | null,
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
    previousProjectId?: string | null,
  ) {
    if (
      task &&
      time.projectId &&
      time.projectId !== previousProjectId &&
      !task.projectIds.includes(time.projectId)
    )
      fail('Time must be attributed to a project on this task');
    if (time.projectId) {
      const project = projects.find((p) => p.id === time.projectId);
      requireRole(project ? plannerProjectAccess(project, ctx.clerkUserId) : null, 'editor');
    }
  }
  private timeWorkSource(
    ref: PlannerTimesheetWorkRef,
    tasks: SpPlannerTask[],
    projects: SpPlannerProject[],
    ctx: AuthTenantContext,
  ): PlannerTimeWorkSource | null {
    const task = ref.taskId ? tasks.find((t) => t.id === ref.taskId) : null;
    const project = ref.projectId ? projects.find((p) => p.id === ref.projectId) : null;
    if ((ref.taskId && !task) || (ref.projectId && !project) || (!task && !project)) return null;
    const taskRole = task ? plannerTaskAccess(task, projects, ctx.clerkUserId) : null;
    const projectRole = project ? plannerProjectAccess(project, ctx.clerkUserId) : null;
    if ((task && !taskRole) || (project && !projectRole)) return null;
    const editable = (role: PlannerRole | null) => role === 'editor' || role === 'admin';
    return {
      ...ref,
      taskName: task ? taskData(task).name : null,
      projectName: project ? projectData(project).name : null,
      canLogTime:
        (!task || (!task.archived && editable(taskRole))) &&
        (!project || (!project.archived && editable(projectRole))) &&
        (!task ||
          (ref.projectId
            ? task.projectIds.includes(ref.projectId)
            : !task.projectIds.length ||
              task.projectIds.some((id) => {
                const p = projects.find((p) => p.id === id);
                return p && !p.archived && editable(plannerProjectAccess(p, ctx.clerkUserId));
              }))),
    };
  }
  private async timesheetView(
    tx: Tx,
    ctx: AuthTenantContext,
    userId: string,
    weekOn: string,
    query: {
      cursor?: string;
      workCursor?: string;
      historyCursor?: string;
      revision?: string;
      allWork?: boolean;
    } = {},
  ): Promise<PlannerTimesheet> {
    const row = await this.timeSheetRecord(tx, ctx, userId, weekOn);
    const data = await this.timeSheetData(tx, ctx, userId, weekOn, row);
    await this.timeSheetReadable(tx, ctx, userId, data);
    const config = await this.timeSettingsRecord(tx, ctx);
    const timeOptions = this.storedTimeOptions(config);
    const preferences = await this.timePreferencesRecord(tx, ctx, userId);
    const autoAddDueTasks =
      (preferences?.data as { autoAddDueTasks?: boolean } | undefined)?.autoAddDueTasks === true;
    const throughOn = plannerWeekDate(weekOn, 6),
      nextOn = plannerWeekDate(weekOn, 7);
    // Working dates come from the latest immutable snapshot, never a task's due date.
    const events = await tx.$queryRaw<SpPlannerEvent[]>`
      SELECT e.id,e.tenant_id AS "tenantId",e.actor_id AS "actorId",e.task_id AS "taskId",e.project_id AS "projectId",
        e.resource_id AS "resourceId",e.details,e.kind,e.text,e.minutes,e.created_at AS "createdAt"
      FROM sp_planner_events e LEFT JOIN LATERAL (
        SELECT details,removed FROM sp_planner_event_revisions WHERE tenant_id=${ctx.tenantId}::uuid AND event_id=e.id ORDER BY version DESC LIMIT 1
      ) r ON true WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.actor_id=${userId} AND e.kind='time' AND NOT COALESCE(r.removed,false)
      AND COALESCE(r.details->'time'->>'workedOn',e.details->'time'->>'workedOn',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) >= ${weekOn}
      AND COALESCE(r.details->'time'->>'workedOn',e.details->'time'->>'workedOn',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) < ${nextOn}`;
    const views = await plannerReadActivity(tx, ctx, events),
      projects = await this.projects(tx, ctx);
    const tasks = await tx.spPlannerTask.findMany({
      where: {
        tenantId: ctx.tenantId,
        OR: [
          {
            id: {
              in: [
                ...events.flatMap((e) => (e.taskId ? [e.taskId] : [])),
                ...(data.work ?? []).flatMap((w) => (w.taskId ? [w.taskId] : [])),
              ],
            },
          },
          ...(autoAddDueTasks
            ? [
                {
                  assigneeId: userId,
                  archived: false,
                  AND: [
                    { data: { path: ['dueOn'], gte: weekOn } },
                    { data: { path: ['dueOn'], lte: throughOn } },
                  ],
                },
              ]
            : []),
        ],
      },
    });
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: plannerWeekDate(weekOn, i),
      totalMinutes: 0,
      billableMinutes: 0,
    }));
    let unavailableEntries = false;
    const items: PlannerTimeEntry[] = [];
    for (const e of views) {
      const time = e.time!,
        task = tasks.find((t) => t.id === e.taskId),
        project = projects.find((p) => p.id === (time.projectId ?? e.projectId));
      const role = task
        ? plannerTaskAccess(task, projects, ctx.clerkUserId)
        : project
          ? plannerProjectAccess(project, ctx.clerkUserId)
          : null;
      if (
        !role ||
        (time.projectId && (!project || !plannerProjectAccess(project, ctx.clerkUserId)))
      ) {
        unavailableEntries = true;
        continue;
      }
      items.push({
        ...e,
        time,
        taskName: task ? taskData(task).name : null,
        projectName: project ? projectData(project).name : null,
        canEdit:
          ['editor', 'admin'].includes(role) &&
          (!project ||
            ['editor', 'admin'].includes(plannerProjectAccess(project, ctx.clerkUserId) ?? '')) &&
          plannerTimeEditable(data, userId, ctx.clerkUserId, ctx.role === 'org:admin') &&
          !plannerTimeDateNotice(time.workedOn, timeOptions, ctx.role === 'org:admin'),
      });
      const day = days.find((d) => d.date === time.workedOn)!;
      day.totalMinutes += e.minutes ?? 0;
      if (time.billable) day.billableMinutes += e.minutes ?? 0;
    }
    items.sort(
      (a, b) => a.time.workedOn.localeCompare(b.time.workedOn) || a.id.localeCompare(b.id),
    );
    const canEditWeek =
      plannerTimeEditable(data, userId, ctx.clerkUserId, ctx.role === 'org:admin') &&
      !plannerTimeDateNotice(weekOn, timeOptions, ctx.role === 'org:admin');
    const manual = (data.work ?? [])
      .map((w) => this.timeWorkSource(w, tasks, projects, ctx))
      .filter((w): w is PlannerTimeWorkSource => !!w);
    const automatic = autoAddDueTasks
      ? tasks
          .filter(
            (t) =>
              !t.archived &&
              t.assigneeId === userId &&
              taskData(t).dueOn &&
              taskData(t).dueOn! >= weekOn &&
              taskData(t).dueOn! <= throughOn,
          )
          .map((t) => {
            const projectIds = t.projectIds.filter((id) =>
              projects.some(
                (p) => p.id === id && !p.archived && plannerProjectAccess(p, ctx.clerkUserId),
              ),
            );
            return this.timeWorkSource(
              { taskId: t.id, projectId: projectIds.length === 1 ? projectIds[0]! : null },
              tasks,
              projects,
              ctx,
            );
          })
          .filter((w): w is PlannerTimeWorkSource => !!w)
      : [];
    const workRows = plannerTimesheetWorkRows(
      days.map((d) => d.date),
      items,
      manual,
      automatic,
      data.excludedTasks ?? [],
      canEditWeek,
      (e) =>
        this.timeWorkSource(
          { taskId: e.taskId, projectId: e.time.projectId },
          tasks,
          projects,
          ctx,
        )!,
    );
    for (const work of workRows)
      if (!work.taskId && !timeOptions.generalWorkEnabled) work.canLogTime = false;
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          version: row?.version ?? 0,
          timeSettingsVersion: config?.version ?? 0,
          timePreferencesVersion: preferences?.version ?? 0,
          data,
          items,
          workRows,
        }),
      )
      .digest('hex');
    if (query.revision && query.revision !== revision)
      throw new ConflictException('Time or access changed. Refresh this timesheet.');
    const start = query.cursor ? items.findIndex((e) => e.id === query.cursor) + 1 : 0;
    if (query.cursor && !start) fail('Timesheet cursor is no longer available');
    const workStart = query.workCursor
      ? workRows.findIndex((w) => w.key === query.workCursor) + 1
      : 0;
    if (query.workCursor && !workStart) fail('Timesheet work cursor is no longer available');
    if (query.historyCursor) {
      const cursorEvent =
        row &&
        (await tx.spPlannerEvent.findFirst({
          where: {
            tenantId: ctx.tenantId,
            id: query.historyCursor,
            resourceId: row.id,
            kind: 'timesheet_status',
          },
        }));
      if (!cursorEvent) fail('Timesheet history cursor is no longer available');
    }
    const history = row
      ? await tx.spPlannerEvent.findMany({
          where: { tenantId: ctx.tenantId, resourceId: row.id, kind: 'timesheet_status' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          ...(query.historyCursor
            ? {
                cursor: { tenantId_id: { tenantId: ctx.tenantId, id: query.historyCursor } },
                skip: 1,
              }
            : {}),
          take: 101,
        })
      : [];
    const reviewerActive =
      data.reviewerId && (await this.people(tx, ctx)).some((p) => p.id === data.reviewerId);
    const actions = plannerTimesheetActions(
      data,
      userId,
      ctx.clerkUserId,
      timeOptions.approvalProcess,
    ).filter(
      (action) =>
        !['submit', 'approve'].includes(action) ||
        ((reviewerActive || (action === 'submit' && timeOptions.approvalProcess === 'simple')) &&
          !unavailableEntries &&
          items.length > 0),
    );
    return {
      id: row?.id ?? null,
      userId,
      weekOn,
      throughOn,
      reviewerId: data.reviewerId,
      status: data.status,
      version: row?.version ?? 0,
      revision,
      notes: data.notes,
      correctedAfterApproval: data.correctedAfterApproval,
      totalMinutes: days.reduce((n, d) => n + d.totalMinutes, 0),
      billableMinutes: days.reduce((n, d) => n + d.billableMinutes, 0),
      days,
      matched: items.length,
      unavailableEntries,
      items: items.slice(start, start + 100),
      nextCursor: items.length > start + 100 ? items[start + 99]!.id : null,
      actions,
      history: history.slice(0, 100).map((e) => plannerEventView(e)),
      nextHistoryCursor: history.length > 100 ? history[99]!.id : null,
      canLogTime: canEditWeek,
      timeNotice: plannerTimeDateNotice(weekOn, timeOptions, ctx.role === 'org:admin'),
      approvalProcess: timeOptions.approvalProcess,
      workRows: query.allWork ? workRows : workRows.slice(workStart, workStart + 100),
      matchedWork: workRows.length,
      nextWorkCursor: workRows.length > workStart + 100 ? workRows[workStart + 99]!.key : null,
    };
  }
  async timesheet(
    ctx: AuthTenantContext,
    query: {
      week?: string;
      userId?: string;
      cursor?: string;
      workCursor?: string;
      historyCursor?: string;
      revision?: string;
    },
  ) {
    keys(query, ['week', 'userId', 'cursor', 'workCursor', 'historyCursor', 'revision']);
    const weekOn = plannerTimesheetWeek(query.week),
      userId = query.userId ?? ctx.clerkUserId;
    if (typeof userId !== 'string' || userId.length > 200) fail('Invalid time submitter');
    if (query.cursor) {
      uuid(query.cursor);
      if (!query.revision) fail('Timesheet paging requires its data revision');
    }
    if (query.workCursor && (query.workCursor.length > 80 || !query.revision))
      fail('Work paging requires a cursor and data revision');
    if (query.historyCursor) {
      uuid(query.historyCursor);
      if (!query.revision) fail('Status history paging requires its data revision');
    }
    if (query.revision && !/^[a-f0-9]{64}$/.test(query.revision))
      fail('Invalid timesheet revision');
    return this.scope(ctx, (tx) => this.timesheetView(tx, ctx, userId, weekOn, query));
  }
  async saveTimesheetWork(ctx: AuthTenantContext, raw: unknown) {
    const dto = object(raw);
    keys(dto, ['week', 'userId', 'version', 'revision', 'action', 'work']);
    const weekOn = plannerTimesheetWeek(dto.week),
      userId = dto.userId ?? ctx.clerkUserId;
    if (typeof userId !== 'string' || !userId || userId.length > 200)
      fail('Invalid time submitter');
    if (typeof dto.revision !== 'string' || !/^[a-f0-9]{64}$/.test(dto.revision))
      fail('A current timesheet revision is required');
    if (!['add', 'remove'].includes(String(dto.action)))
      fail('Choose whether to add or remove work');
    const rawWork = object(dto.work);
    keys(rawWork, ['taskId', 'projectId']);
    const work: PlannerTimesheetWorkRef = {
      taskId: rawWork.taskId === null ? null : uuid(rawWork.taskId),
      projectId: rawWork.projectId === null ? null : uuid(rawWork.projectId),
    };
    if (!work.taskId && !work.projectId) fail('Choose a task or project');
    return this.scope(
      ctx,
      async (tx) => {
        const view = await this.timesheetView(tx, ctx, userId, weekOn, {
          revision: dto.revision as string,
          allWork: true,
        });
        requirePlannerTimesheetVersion(dto.version, view.version);
        if (!view.canLogTime) throw new ForbiddenException('This week is locked for time changes');
        const row = await this.timeSheetRecord(tx, ctx, userId, weekOn),
          data = await this.timeSheetData(tx, ctx, userId, weekOn, row);
        const storedWork = data.work ?? [],
          key = plannerTimeWorkKey(work);
        let selected: PlannerTimesheetWorkRef[],
          excluded = data.excludedTasks ?? [];
        if (dto.action === 'remove') {
          const found = view.workRows!.find((w) => w.key === key);
          if (!found) throw missing();
          if (!found.canRemove)
            throw new ForbiddenException(
              'Remove all time entries for this work before removing its row',
            );
          selected = storedWork.filter((w) => plannerTimeWorkKey(w) !== key);
          if (work.taskId) excluded = [...new Set([...excluded, work.taskId])];
        } else {
          const projects = await this.projects(tx, ctx);
          const tasks = work.taskId
            ? await tx.spPlannerTask.findMany({
                where: { tenantId: ctx.tenantId, id: work.taskId },
              })
            : [];
          const source = this.timeWorkSource(work, tasks, projects, ctx);
          if (!source) throw missing();
          if (!source.canLogTime) throw new ForbiddenException('This work cannot accept time');
          const task = tasks[0];
          if (task && task.projectIds.length && !work.projectId)
            fail('Choose a project for this task');
          if (
            !task &&
            !this.storedTimeOptions(await this.timeSettingsRecord(tx, ctx)).generalWorkEnabled
          )
            throw new ForbiddenException('General project time is disabled for this organization');
          selected = storedWork.some((w) => plannerTimeWorkKey(w) === key)
            ? storedWork
            : [...storedWork, work];
          if (work.taskId) excluded = excluded.filter((id) => id !== work.taskId);
        }
        if (selected.length > 500 || excluded.length > 2000)
          fail('Too many weekly work selections');
        const next = json({ ...data, work: selected, excludedTasks: excluded });
        if (row)
          await tx.spPlannerResource.update({
            where: { tenantId: ctx.tenantId, id: row.id },
            data: { data: next, version: { increment: 1 } },
          });
        else
          await tx.spPlannerResource.create({
            data: {
              tenantId: ctx.tenantId,
              ownerId: userId,
              kind: 'timesheet',
              name: `Timesheet · ${weekOn}`,
              data: next,
            },
          });
        return this.timesheetView(tx, ctx, userId, weekOn);
      },
      true,
    );
  }
  async timeExport(
    ctx: AuthTenantContext,
    raw: PlannerTimeExportQuery,
  ): Promise<PlannerTimeExportPage> {
    const query = plannerTimeExportQuery(raw);
    // Every query in a page sees the same entries, corrections and source grants.
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const people = await this.people(tx, ctx),
          names = new Map(people.map((p) => [p.id, p.name]));
        if (!names.has(ctx.clerkUserId)) throw missing();
        const config = await this.timeSettingsRecord(tx, ctx);
        const reviewers =
          (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
        const assigned = Object.keys(reviewers)
          .filter((id) => reviewers[id] === ctx.clerkUserId && names.has(id))
          .sort();
        const projects = await this.projects(tx, ctx);
        const selected = projects.find((p) => p.id === query.projectId);
        let users: string[];
        if (query.scope === 'project') {
          requireRole(selected ? plannerProjectAccess(selected, ctx.clerkUserId) : null, 'viewer');
          users = []; // Project grants permit its time history, including departed submitters.
        } else if (query.scope === 'organization') {
          if (ctx.role !== 'org:admin')
            throw new ForbiddenException('Organization admin access is required');
          users = [];
        } else if (query.scope === 'review') users = assigned;
        else {
          const userId = query.userId ?? ctx.clerkUserId;
          if (!names.has(userId) || (userId !== ctx.clerkUserId && !assigned.includes(userId)))
            throw missing();
          users = [userId];
        }
        const events =
          !['project', 'organization'].includes(query.scope) && !users.length
            ? []
            : await tx.$queryRaw<SpPlannerEvent[]>`
        SELECT e.id,e.tenant_id AS "tenantId",e.actor_id AS "actorId",e.task_id AS "taskId",e.project_id AS "projectId",
          e.resource_id AS "resourceId",e.details,e.kind,e.text,e.minutes,e.created_at AS "createdAt"
        FROM sp_planner_events e LEFT JOIN LATERAL (
          SELECT details,removed FROM sp_planner_event_revisions WHERE tenant_id=${ctx.tenantId}::uuid AND event_id=e.id ORDER BY version DESC LIMIT 1
        ) r ON true
        WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.kind='time' AND NOT COALESCE(r.removed,false)
        AND COALESCE(r.details->'time'->>'workedOn',e.details->'time'->>'workedOn',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) >= ${query.fromOn}
        AND COALESCE(r.details->'time'->>'workedOn',e.details->'time'->>'workedOn',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD')) <= ${query.throughOn}
        ${
          query.scope === 'project'
            ? Prisma.sql`AND COALESCE(r.details->'time'->>'projectId',e.details->'time'->>'projectId',e.project_id::text) = ${query.projectId}`
            : query.scope === 'organization'
              ? Prisma.empty
              : Prisma.sql`AND e.actor_id IN (${Prisma.join(users)})`
        }`;
        const views = await plannerReadActivity(tx, ctx, events);
        const tasks = await tx.spPlannerTask.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: events.flatMap((e) => (e.taskId ? [e.taskId] : [])) },
          },
        });
        const taskById = new Map(tasks.map((t) => [t.id, t])),
          projectById = new Map(projects.map((p) => [p.id, p]));
        const items: PlannerTimeExportEntry[] = [];
        let unavailableEntries = false;
        for (const e of views) {
          const time = e.time!,
            task = taskById.get(e.taskId ?? ''),
            project = projectById.get(time.projectId ?? e.projectId ?? '');
          const readable = task
            ? plannerTaskAccess(task, projects, ctx.clerkUserId)
            : project
              ? plannerProjectAccess(project, ctx.clerkUserId)
              : null;
          if (
            !readable ||
            (time.projectId && (!project || !plannerProjectAccess(project, ctx.clerkUserId)))
          ) {
            // Organization export reveals only readable work, without counts
            // or existence indicators for unrelated private entries.
            if (query.scope !== 'organization') unavailableEntries = true;
            continue;
          }
          items.push({
            ...e,
            time,
            taskName: task ? taskData(task).name : null,
            projectName: project ? projectData(project).name : null,
            canEdit: false,
            submitterName: names.get(e.actorId) ?? 'Former member',
            taskStatus: task ? (taskData(task).status === 'done' ? 'Completed' : 'Open') : null,
          });
        }
        items.sort(
          (a, b) => a.time.workedOn.localeCompare(b.time.workedOn) || a.id.localeCompare(b.id),
        );
        const revision = createHash('sha256')
          .update(
            JSON.stringify({
              scope: query.scope,
              fromOn: query.fromOn,
              throughOn: query.throughOn,
              users,
              projectId: query.projectId,
              items,
              unavailableEntries,
            }),
          )
          .digest('hex');
        if (query.revision && query.revision !== revision)
          throw new ConflictException('Time or access changed during export. Start a new export.');
        const start = query.cursor ? items.findIndex((e) => e.id === query.cursor) + 1 : 0;
        if (query.cursor && !start) fail('Export cursor is no longer available');
        return {
          fromOn: query.fromOn,
          throughOn: query.throughOn,
          revision,
          matched: items.length,
          unavailableEntries,
          totalMinutes: items.reduce((n, e) => n + (e.minutes ?? 0), 0),
          billableMinutes: items.reduce((n, e) => n + (e.time.billable ? (e.minutes ?? 0) : 0), 0),
          items: items.slice(start, start + 100),
          nextCursor: items.length > start + 100 ? items[start + 99]!.id : null,
        };
      },
      { timeoutMs: 15_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async timeReview(
    ctx: AuthTenantContext,
    query: TimeReviewQuery & { paged: 'true' },
  ): Promise<PlannerTimeReviewPage>;
  async timeReview(
    ctx: AuthTenantContext,
    query: TimeReviewQuery & { paged?: 'false' },
  ): Promise<PlannerTimesheet[]>;
  async timeReview(
    ctx: AuthTenantContext,
    query: TimeReviewQuery,
  ): Promise<PlannerTimeReviewPage | PlannerTimesheet[]>;
  async timeReview(
    ctx: AuthTenantContext,
    query: TimeReviewQuery,
  ): Promise<PlannerTimeReviewPage | PlannerTimesheet[]> {
    keys(query, ['week', 'people', 'statuses', 'sort', 'direction', 'paged', 'cursor', 'revision']);
    const weekOn = plannerTimesheetWeek(query.week);
    if (query.paged !== undefined && !['true', 'false'].includes(query.paged))
      fail('Choose whether to page time review');
    for (const key of ['people', 'statuses', 'sort', 'direction', 'cursor', 'revision'] as const)
      if (
        query[key] !== undefined &&
        (typeof query[key] !== 'string' || query[key]!.length > 20100)
      )
        fail('Invalid time review filter');
    if (query.cursor && (query.cursor.length > 200 || query.paged !== 'true' || !query.revision))
      fail('Review paging requires its data revision');
    if (query.revision && !/^[a-f0-9]{64}$/.test(query.revision))
      fail('Invalid time review revision');
    const view = plannerTimeReviewView({
      ...(query.people === undefined
        ? {}
        : { people: query.people ? query.people.split(',') : [] }),
      ...(query.statuses === undefined
        ? {}
        : { statuses: query.statuses ? query.statuses.split(',') : [] }),
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(query.direction === undefined ? {} : { direction: query.direction }),
    });
    return this.scope(ctx, async (tx) => {
      const config = await this.timeSettingsRecord(tx, ctx);
      const reviewers =
        (config?.data as { reviewers?: Record<string, string> } | undefined)?.reviewers ?? {};
      const members = await this.people(tx, ctx);
      const active = new Set(members.map((p) => p.id));
      if (!active.has(ctx.clerkUserId)) throw missing();
      const users = Object.keys(reviewers).filter(
        (id) => reviewers[id] === ctx.clerkUserId && active.has(id),
      );
      const result: PlannerTimesheet[] = [];
      for (const user of users) {
        const sheet = await this.timesheetView(tx, ctx, user, weekOn);
        result.push({
          ...sheet,
          items: [],
          history: [],
          workRows: [],
          nextCursor: null,
          nextWorkCursor: null,
          nextHistoryCursor: null,
        });
      }
      const people = members
        .filter((p) => users.includes(p.id))
        .map(({ id, name }) => ({ id, name }));
      people.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const items = plannerTimeReviewRows(result, view, new Map(people.map((p) => [p.id, p.name])));
      if (query.paged !== 'true') return items;
      const revision = createHash('sha256')
        .update(
          JSON.stringify({
            weekOn,
            view,
            settingsVersion: config?.version ?? 0,
            people,
            items,
          }),
        )
        .digest('hex');
      if (query.revision && query.revision !== revision)
        throw new ConflictException('Reviewed time or access changed. Refresh time review.');
      const start = query.cursor ? items.findIndex((s) => s.userId === query.cursor) + 1 : 0;
      if (query.cursor && !start) fail('Review cursor is no longer available');
      return {
        weekOn,
        revision,
        people,
        matched: items.length,
        items: items.slice(start, start + 100),
        nextCursor: items.length > start + 100 ? items[start + 99]!.userId : null,
        totalMinutes: items.reduce((n, s) => n + s.totalMinutes, 0),
        billableMinutes: items.reduce((n, s) => n + s.billableMinutes, 0),
      } satisfies PlannerTimeReviewPage;
    });
  }
  async transitionTimesheet(ctx: AuthTenantContext, raw: unknown) {
    const dto = object(raw);
    keys(dto, ['week', 'userId', 'version', 'revision', 'action', 'notes']);
    const weekOn = plannerTimesheetWeek(dto.week),
      userId = dto.userId ?? ctx.clerkUserId;
    if (typeof userId !== 'string' || userId.length > 200) fail('Invalid time submitter');
    if (typeof dto.notes !== 'string' || dto.notes.length > 20000) fail('Invalid timesheet notes');
    const notes = dto.notes as string;
    if (typeof dto.revision !== 'string' || !/^[a-f0-9]{64}$/.test(dto.revision))
      fail('A current timesheet revision is required');
    return this.scope(
      ctx,
      async (tx) => {
        const view = await this.timesheetView(tx, ctx, userId, weekOn, {
          revision: dto.revision as string,
        });
        requirePlannerTimesheetVersion(dto.version, view.version);
        if (!view.actions.includes(dto.action as never))
          throw new ForbiddenException('This timesheet action is unavailable');
        const status = (
          {
            submit: 'submitted',
            recall_submission: 'draft',
            approve: 'approved',
            reject: 'rejected',
            recall_approval: 'submitted',
          } as Record<string, PlannerTimesheetData['status']>
        )[String(dto.action)]!;
        const previous = await this.timeSheetData(
          tx,
          ctx,
          userId,
          weekOn,
          await this.timeSheetRecord(tx, ctx, userId, weekOn),
        );
        const data: PlannerTimesheetData = {
          ...previous,
          weekOn,
          reviewerId: view.reviewerId,
          status,
          notes,
          correctedAfterApproval: status === 'approved' ? false : view.correctedAfterApproval,
        };
        const row = view.id
          ? await tx.spPlannerResource.update({
              where: { tenantId: ctx.tenantId, id: view.id },
              data: { data: json(data), version: { increment: 1 } },
            })
          : await tx.spPlannerResource.create({
              data: {
                tenantId: ctx.tenantId,
                ownerId: userId,
                kind: 'timesheet',
                name: `Timesheet · ${weekOn}`,
                data: json(data),
              },
            });
        const label = (
          {
            submit: 'Submitted',
            recall_submission: 'Recalled submission for',
            approve: 'Approved',
            reject: 'Rejected',
            recall_approval:
              view.status === 'rejected' ? 'Recalled rejection for' : 'Recalled approval for',
          } as Record<string, string>
        )[String(dto.action)];
        await this.event(
          tx,
          ctx,
          {
            resourceId: row.id,
            kind: 'timesheet_status',
            text: `${label} timesheet · ${weekOn}${notes.trim() ? '\n' + notes.trim() : ''}`,
            details: {
              timesheet: { weekOn, userId },
              timesheetStatus: {
                from: view.status,
                to: status,
                totalMinutes: view.totalMinutes,
                billableMinutes: view.billableMinutes,
                revision: view.revision,
              },
            },
          },
          [userId, view.reviewerId].filter((id): id is string => !!id),
        );
        return this.timesheetView(tx, ctx, userId, weekOn);
      },
      true,
    );
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
  async reportWidget(
    ctx: AuthTenantContext,
    dashboardId: string,
    widgetId: string,
    raw: unknown = {},
  ): Promise<PlannerReportResponse> {
    uuid(dashboardId);
    uuid(widgetId);
    const query = object(raw);
    keys(query, ['rows', 'cursor', 'bucket', 'version', 'revision']);
    if (
      query.revision !== undefined &&
      (typeof query.revision !== 'string' || !/^[0-9a-f]{64}$/.test(query.revision))
    )
      fail('Invalid report revision');
    const reportRevision = (payload: unknown) => {
      const revision = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (query.revision !== undefined && query.revision !== revision)
        throw new ConflictException(
          'Work in this report changed. Refresh the report before continuing.',
        );
      return revision;
    };
    if (query.rows !== undefined && !['true', 'false'].includes(String(query.rows)))
      fail('Invalid report rows option');
    if (query.cursor !== undefined) {
      uuid(query.cursor);
      if (query.rows !== 'true') fail('A report cursor requires rows');
    }
    if (
      query.bucket !== undefined &&
      (typeof query.bucket !== 'string' || query.bucket.length > 1000)
    )
      fail('Invalid report category');
    if (
      query.version !== undefined &&
      (!/^[1-9][0-9]*$/.test(String(query.version)) || !Number.isSafeInteger(Number(query.version)))
    )
      fail('Invalid dashboard version');
    return this.scope(ctx, async (tx) => {
      const projects = await this.projects(tx, ctx);
      const dashboard = await tx.spPlannerResource.findFirst({
        where: { tenantId: ctx.tenantId, id: dashboardId, kind: 'dashboard' },
      });
      if (!dashboard) throw missing();
      requireRole(this.resourceAccess(dashboard, projects, ctx), 'viewer');
      if (query.version !== undefined) version(dashboard.version, Number(query.version));
      const widget = (dashboard.data as unknown as { widgets: PlannerReportWidget[] }).widgets.find(
        (w) => w.id === widgetId,
      );
      if (!widget || widget.kind !== 'chart') throw missing();
      const chart = structuredClone(validatePlannerReportChart(widget.chart));
      if (dashboard.projectId && chart.entity !== 'tasks')
        fail('Project dashboards report on their tasks');
      const rows = await tx.spPlannerResource.findMany({
        where: { tenantId: ctx.tenantId, kind: { in: ['goal', 'portfolio'] } },
      });
      const visible = this.reportVisibility(projects, rows, ctx);
      const source = chart.filters.source;
      const unavailableSources =
        source.kind === 'all'
          ? false
          : source.ids.some((id) => !visible[source.kind as 'projects' | 'portfolios'].has(id));
      const numericFields = new Set(
        projects
          .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
          .flatMap((p) =>
            projectData(p)
              .fields.filter((f) => f.type === 'number')
              .map((f) => f.id),
          ),
      );
      const unavailableFields =
        [
          chart.groupFieldId,
          chart.metricFieldId,
          ...chart.filters.custom.map((f) => f.fieldId),
        ].some((id) => !!id && !visible.fields.has(id)) ||
        (chart.metric === 'custom_number' && !numericFields.has(chart.metricFieldId!));
      const unit = chart.metric.endsWith('_minutes')
        ? 'minutes'
        : chart.metric === 'progress'
          ? 'percent'
          : chart.metric === 'custom_number'
            ? 'number'
            : 'items';
      if (unavailableFields)
        return {
          dashboardVersion: dashboard.version,
          revision: reportRevision({
            version: dashboard.version,
            unavailableFields: true,
            unavailableSources,
          }),
          total: null,
          matched: null,
          buckets: [],
          unit,
          overlapping: false,
          unavailableSources,
          unavailableFields: true,
          ...(query.rows === 'true' ? { items: [], nextCursor: null } : {}),
        };
      const activeProjects = new Set(
        projects
          .filter((p) => !p.archived && plannerProjectAccess(p, ctx.clerkUserId))
          .map((p) => p.id),
      );
      let sourceProjects = new Set<string>();
      if (source.kind === 'projects')
        sourceProjects = new Set(source.ids.filter((id) => activeProjects.has(id)));
      else if (source.kind === 'portfolios') {
        for (const portfolio of rows.filter(
          (r) =>
            r.kind === 'portfolio' &&
            !r.archived &&
            source.ids.includes(r.id) &&
            this.resourceAccess(r, projects, ctx),
        ))
          for (const id of (portfolio.data as unknown as { projectIds: string[] }).projectIds)
            if (activeProjects.has(id)) sourceProjects.add(id);
      }
      if (dashboard.projectId) {
        const matches =
          source.kind === 'all'
            ? activeProjects.has(dashboard.projectId)
            : sourceProjects.has(dashboard.projectId);
        sourceProjects = new Set(matches ? [dashboard.projectId] : []);
        chart.filters.source = { kind: 'projects', ids: [dashboard.projectId] };
      }
      const readableProjects = projects
        .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
        .map((p) => p.id);
      const projectArray = readableProjects.length
        ? Prisma.sql`ARRAY[${Prisma.join(readableProjects.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`
        : Prisma.sql`ARRAY[]::uuid[]`;
      const needsTasks =
        chart.entity === 'tasks' ||
        (chart.entity === 'projects' && chart.metric !== 'count') ||
        (chart.entity === 'goals' && chart.metric === 'progress');
      const restricted =
        chart.filters.source.kind !== 'all' && ['tasks', 'projects'].includes(chart.entity);
      const sourceArray = sourceProjects.size
        ? Prisma.sql`ARRAY[${Prisma.join([...sourceProjects].map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`
        : Prisma.sql`ARRAY[]::uuid[]`;
      const taskRows = needsTasks
        ? (
            await tx.$queryRaw<PlannerReportTaskRecord[]>`
        SELECT id,owner_id AS "ownerId",assignee_id AS "assigneeId",project_ids AS "projectIds",parent_id AS "parentId",archived,
          created_at AS "createdAt",completed_at AS "completedAt",
          jsonb_build_object('name',data->'name','status',data->'status','priority',data->'priority','subtype',data->'subtype',
            'startOn',data->'startOn','dueOn',data->'dueOn','assigneeId',data->'assigneeId','memberships',data->'memberships',
            'collaborators',data->'collaborators','tags',data->'tags','customValues',data->'customValues','estimateMinutes',data->'estimateMinutes') AS data
        FROM sp_planner_tasks WHERE tenant_id=${ctx.tenantId}::uuid AND archived=false
          ${restricted ? Prisma.sql`AND project_ids && ${sourceArray}` : Prisma.empty}
          AND (project_ids && ${projectArray} OR assignee_id=${ctx.clerkUserId}
            OR (cardinality(project_ids)=0 AND owner_id=${ctx.clerkUserId})
            OR COALESCE(data->'collaborators','[]'::jsonb) ? ${ctx.clerkUserId})
      `
          ).filter((task) => plannerTaskAccess(task, projects, ctx.clerkUserId))
        : [];
      const minutes = new Map<string, number>();
      if (chart.metric === 'actual_minutes')
        for (let offset = 0; offset < taskRows.length; offset += 1000) {
          const batch = await plannerActualMinutes(
            tx,
            ctx,
            taskRows.slice(offset, offset + 1000).map((t) => t.id),
          );
          for (const [id, value] of batch) minutes.set(id, value);
        }
      const resourceViews = this.resourceViews(rows, projects, ctx, taskRows);
      const created = new Map(rows.map((r) => [r.id, r.createdAt]));
      const records = plannerReportRecords({
        tasks: taskRows,
        projects: projects
          .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
          .map((p) => this.projectView(p, ctx)),
        resources: resourceViews.map((r) => ({ ...r, createdAt: created.get(r.id)! })),
        people: await this.people(tx, ctx),
        minutes,
        timeZone: chart.filters.timeZone,
      });
      if (chart.entity === 'portfolios' && chart.filters.source.kind === 'projects')
        for (const record of records.filter((r) => r.entity === 'portfolios')) {
          const selected = record.projectIds.filter((id) => sourceProjects.has(id));
          record.metrics.project_count = selected.length;
          record.contributions = { project_count: selected.map((id) => ({ id, value: 1 })) };
        }
      const result = plannerBuildReport(records, chart, sourceProjects, unavailableSources);
      const authorized = records
        .filter((record) => plannerReportMatches(record, chart, sourceProjects))
        .sort((a, b) => a.id.localeCompare(b.id));
      const revision = reportRevision({ version: dashboard.version, result, records: authorized });
      if (query.rows !== 'true')
        return { ...result, dashboardVersion: dashboard.version, revision };
      const matching = authorized
        .filter(
          (record) =>
            plannerReportMatches(record, chart, sourceProjects) &&
            (!query.bucket ||
              plannerReportGroups(record, chart).some((group) => group.key === query.bucket)) &&
            (!query.cursor || record.id > String(query.cursor)),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 101);
      return {
        ...result,
        dashboardVersion: dashboard.version,
        revision,
        items: matching.slice(0, 100).map((record) => ({
          id: record.id,
          entity: record.entity,
          name: record.name,
          status: record.status,
          personName: record.personName,
          dueOn: record.dates.due,
          value: plannerReportValue(record, chart),
        })),
        nextCursor: matching.length > 100 ? matching[99]!.id : null,
      };
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
        const goalRows =
          kind === 'goal'
            ? await tx.spPlannerResource.findMany({
                where: { tenantId: ctx.tenantId, kind: 'goal' },
              })
            : [];
        const goalTasks = kind === 'goal' ? await this.goalTasks(tx, ctx) : [];
        const newGoalId = kind === 'goal' && !old ? randomUUID() : null;
        const reportRows =
          kind === 'dashboard'
            ? await tx.spPlannerResource.findMany({
                where: { tenantId: ctx.tenantId, kind: 'portfolio' },
              })
            : [];
        const reportVisibility =
          kind === 'dashboard' ? this.reportVisibility(projects, reportRows, ctx) : undefined;
        const patch = object(dto.data ?? {});
        const resourceData = { ...(old ? object(old.data) : {}), ...patch };
        if (kind === 'dashboard' && patch.widgets !== undefined)
          resourceData.widgets = preparePlannerReportWidgets(
            (old?.data as { widgets?: PlannerReportWidget[] } | undefined)?.widgets ?? [],
            patch.widgets,
            reportVisibility!,
          );
        const data = validateResource(
          kind,
          kind === 'goal'
            ? this.prepareGoalData(old, object(dto.data ?? {}), goalRows, goalTasks, projects, ctx)
            : resourceData,
        );
        if (kind === 'dashboard') {
          const numeric = new Set(
            projects
              .filter((p) => plannerProjectAccess(p, ctx.clerkUserId))
              .flatMap((p) =>
                projectData(p)
                  .fields.filter((f) => f.type === 'number')
                  .map((f) => f.id),
              ),
          );
          const previous =
            (old?.data as { widgets?: PlannerReportWidget[] } | undefined)?.widgets ?? [];
          for (const widget of data.widgets as PlannerReportWidget[]) {
            if (widget.kind !== 'chart') continue;
            if (projectId && widget.chart.entity !== 'tasks')
              fail('Project dashboards report on their tasks');
            if (
              widget.chart.metric === 'custom_number' &&
              !numeric.has(widget.chart.metricFieldId!)
            ) {
              const baseline = previous.find((w) => w.id === widget.id);
              if (!(
                baseline?.kind === 'chart' &&
                baseline.chart.metric === 'custom_number' &&
                baseline.chart.metricFieldId === widget.chart.metricFieldId
              ))
                fail('Choose a numeric report field');
            }
          }
        }
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
          const config = data as unknown as PlannerGoalData;
          const before = old?.data as unknown as PlannerGoalData | undefined;
          const patch = object(dto.data ?? {});
          if (
            Object.hasOwn(patch, 'followers') &&
            JSON.stringify(config.followers ?? []) !== JSON.stringify(before?.followers ?? [])
          ) {
            if (old) requireRole(this.resourceAccess(old, projects, ctx), 'admin');
            for (const userId of config.followers ?? []) {
              if (!people.has(userId)) fail('Goal followers must be active team members');
              const candidate = {
                ...(old ?? { ownerId: ctx.clerkUserId, kind: 'goal', projectId }),
                data: json(data),
              } as SpPlannerResource;
              requireRole(
                this.resourceAccess(candidate, projects, { ...ctx, clerkUserId: userId }),
                'viewer',
              );
            }
          } else if (before?.followers) data.followers = before.followers;
          const changingOwner = !!before && config.ownerId !== before.ownerId;
          if (changingOwner) {
            if (config.ownerId !== ctx.clerkUserId && patch.reminder != null)
              throw new ForbiddenException(
                'The new responsible owner must configure their own reminders',
              );
            data.reminder =
              config.ownerId === ctx.clerkUserId && Object.hasOwn(patch, 'reminder')
                ? config.reminder
                : null;
          }
          if (
            (Object.hasOwn(patch, 'reminder') &&
              (!changingOwner || data.reminder != null) &&
              JSON.stringify(data.reminder ?? null) !== JSON.stringify(before?.reminder ?? null)) ||
            (Object.hasOwn(patch, 'timeZone') && data.timeZone !== before?.timeZone)
          ) {
            if (config.ownerId !== ctx.clerkUserId)
              throw new ForbiddenException('Only the responsible goal owner can set reminders');
          }
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
        if (kind !== 'goal')
          return this.resourceView(
            row,
            projects,
            ctx,
            undefined,
            undefined,
            undefined,
            reportVisibility,
          );
        const views = this.resourceViews(
          [...goalRows.filter((g) => g.id !== row.id), row],
          projects,
          ctx,
          goalTasks,
        );
        const result = views.find((g) => g.id === row.id)!;
        await this.recordGoalChanges(
          tx,
          ctx,
          this.resourceViews(goalRows, projects, ctx, goalTasks),
          views,
          projects,
        );
        return result;
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
    // The already-authorized form owner supplies the automation's rollup grants.
    // Anonymous submissions still return only their receipt, never goal contents.
    const historyContext = isPublic ? { ...ctx, clerkUserId: form.ownerId } : ctx;
    const beforeGoals = await this.captureGoalViews(tx, historyContext, projects);
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
    if (beforeGoals.length)
      await this.recordGoalChanges(
        tx,
        historyContext,
        beforeGoals,
        await this.captureGoalViews(tx, historyContext, projects),
        projects,
        new Set(),
        ctx.clerkUserId,
      );
    return row;
  }
}
