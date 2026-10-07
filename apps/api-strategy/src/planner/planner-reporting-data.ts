import {
  plannerDateInZone,
  PLANNER_STATUS_LABELS,
  type PlannerPerson,
  type PlannerProject,
  type PlannerResource,
  type PlannerTaskData,
  type PlannerGoalData,
} from '@capiro/strategy-verifier';
import type { SpPlannerTask } from '../../generated/prisma-client/index.js';
import type { PlannerReportRecord } from './planner-reporting.js';

export type PlannerReportTaskRecord = Pick<
  SpPlannerTask,
  | 'id'
  | 'ownerId'
  | 'assigneeId'
  | 'projectIds'
  | 'parentId'
  | 'archived'
  | 'createdAt'
  | 'completedAt'
  | 'data'
>;
type ResourceRecord = PlannerResource & { createdAt: Date };
const title = (value: string) =>
  value
    .split('_')
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ');

/** The caller supplies only currently readable tasks/projects/resources. Custom
 * values additionally require a readable declaring project on the same task. */
export function plannerReportRecords({
  tasks,
  projects,
  resources,
  people,
  minutes,
  timeZone,
}: {
  tasks: PlannerReportTaskRecord[];
  projects: PlannerProject[];
  resources: ResourceRecord[];
  people: PlannerPerson[];
  minutes: Map<string, number>;
  timeZone: string;
}): PlannerReportRecord[] {
  const names = new Map(people.map((p) => [p.id, p.name]));
  const person = (id: string | null) => ({
    key: id ?? 'unassigned',
    label: id ? (names.get(id) ?? 'Former member') : 'Unassigned',
  });
  const activeProjects = projects.filter((p) => !p.archived);
  const projectNames = new Map(activeProjects.map((p) => [p.id, p.name]));
  const projectFields = new Map(projects.map((p) => [p.id, new Set(p.fields.map((f) => f.id))]));
  const taskRecords = tasks
    .filter((t) => !t.archived)
    .map((row) => {
      const data = row.data as unknown as PlannerTaskData;
      const projectIds = row.projectIds.filter((id) => projectNames.has(id));
      const fields = new Set(row.projectIds.flatMap((id) => [...(projectFields.get(id) ?? [])]));
      const custom = Object.fromEntries(
        Object.entries(data.customValues ?? {}).filter(
          ([id, value]) =>
            fields.has(id) &&
            (value === null ||
              typeof value === 'string' ||
              typeof value === 'number' ||
              (Array.isArray(value) && value.every((v) => typeof v === 'string'))),
        ),
      );
      const assignee = data.assigneeId ?? row.assigneeId;
      return {
        id: row.id,
        entity: 'tasks' as const,
        name: data.name,
        status: data.status,
        personId: assignee,
        personName: assignee ? (names.get(assignee) ?? 'Former member') : null,
        priority: data.priority,
        type: data.subtype,
        projectIds,
        tags: data.tags ?? [],
        parentId: row.parentId,
        dates: {
          created: plannerDateInZone(row.createdAt, timeZone),
          start: data.startOn ?? null,
          due: data.dueOn ?? null,
          completed: row.completedAt ? plannerDateInZone(row.completedAt, timeZone) : null,
        },
        custom,
        metrics: {
          estimated_minutes: data.estimateMinutes ?? 0,
          actual_minutes: minutes.get(row.id) ?? 0,
        },
        groups: {
          status: [{ key: data.status, label: PLANNER_STATUS_LABELS[data.status] }],
          owner: [person(row.ownerId)],
          assignee: [person(assignee)],
          priority: [{ key: data.priority, label: title(data.priority) }],
          type: [{ key: data.subtype, label: title(data.subtype) }],
          project: projectIds.map((id) => ({ key: id, label: projectNames.get(id)! })),
          tag: (data.tags ?? []).map((tag) => ({ key: tag, label: tag })),
        },
      } satisfies PlannerReportRecord;
    });
  const records: PlannerReportRecord[] = [...taskRecords];
  const byProject = new Map<string, typeof taskRecords>();
  for (const task of taskRecords)
    for (const id of new Set(task.projectIds)) {
      const linked = byProject.get(id) ?? [];
      linked.push(task);
      byProject.set(id, linked);
    }
  for (const project of activeProjects) {
    const connected = byProject.get(project.id) ?? [];
    const estimated = connected.map((t) => ({ id: t.id, value: t.metrics.estimated_minutes }));
    const actual = connected.map((t) => ({ id: t.id, value: t.metrics.actual_minutes }));
    records.push({
      id: project.id,
      entity: 'projects',
      name: project.name,
      status: project.health,
      personId: project.ownerId,
      personName: names.get(project.ownerId) ?? 'Former member',
      priority: null,
      type: null,
      projectIds: [project.id],
      tags: [],
      parentId: null,
      dates: {
        created: plannerDateInZone(new Date(project.createdAt), timeZone),
        start: project.startOn,
        due: project.dueOn,
        completed: null,
      },
      custom: {},
      metrics: {
        estimated_minutes: estimated.reduce((sum, t) => sum + t.value, 0),
        actual_minutes: actual.reduce((sum, t) => sum + t.value, 0),
        progress: connected.length
          ? (connected.filter((t) => t.status === 'done').length / connected.length) * 100
          : 0,
      },
      contributions: { estimated_minutes: estimated, actual_minutes: actual },
      groups: {
        status: [{ key: project.health, label: title(project.health) }],
        owner: [person(project.ownerId)],
      },
    });
  }
  for (const resource of resources.filter(
    (r) => !r.archived && (r.kind === 'goal' || r.kind === 'portfolio'),
  )) {
    const isGoal = resource.kind === 'goal';
    const data = resource.data as unknown as PlannerGoalData;
    const responsible = isGoal ? data.ownerId : resource.ownerId;
    const projectIds = data.projectIds.filter((id) => projectNames.has(id));
    records.push({
      id: resource.id,
      entity: isGoal ? 'goals' : 'portfolios',
      name: resource.name,
      status: isGoal ? data.status : null,
      personId: responsible,
      personName: responsible ? (names.get(responsible) ?? 'Former member') : null,
      priority: null,
      type: isGoal ? (data.goalType ?? 'team') : null,
      projectIds,
      tags: [],
      parentId: null,
      dates: {
        created: plannerDateInZone(resource.createdAt, timeZone),
        start: isGoal ? (data.startOn ?? null) : null,
        due: isGoal ? data.dueOn : null,
        completed: null,
      },
      custom: {},
      metrics: isGoal
        ? { progress: resource.goalProgress?.percentage ?? 0 }
        : { project_count: projectIds.length },
      ...(!isGoal
        ? { contributions: { project_count: projectIds.map((id) => ({ id, value: 1 })) } }
        : {}),
      groups: {
        owner: [person(responsible)],
        ...(isGoal
          ? {
              status: [{ key: data.status, label: title(data.status) }],
              type: [{ key: data.goalType ?? 'team', label: title(data.goalType ?? 'team') }],
              period: data.timePeriod ? [{ key: data.timePeriod, label: data.timePeriod }] : [],
            }
          : {}),
      },
    });
  }
  return records;
}
