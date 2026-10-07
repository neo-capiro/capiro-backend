import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  type PlannerProject,
  type PlannerTask,
  type PlannerEvent,
  type PlannerResource,
  type PlannerResourceKind,
  type PlannerFormData,
  type PlannerTemplateData,
  plannerTemplateSchedule,
  plannerGoalProgress,
  type PlannerGoalData,
  type PlannerGoalUpdateSection,
  type PlannerReportWidget,
} from '@capiro/strategy-verifier';
const PROJECT = '20000000-0000-4000-8000-000000000001';
const SECTION = '40000000-0000-4000-8000-000000000001';
const people = [
  { id: 'user_qa', name: 'Alex Morgan' },
  { id: 'user_qa2', name: 'Jamie Lee' },
  { id: 'user_qa3', name: 'Sam Rivera' },
];
const now = new Date().toISOString();
const projects: PlannerProject[] = [
  {
    ...PLANNER_DEFAULT_PROJECT,
    id: PROJECT,
    name: 'Product launch',
    description: 'Bring the next release to life, together.',
    privacy: 'team',
    ownerId: 'user_qa',
    version: 1,
    archived: false,
    access: 'admin',
    createdAt: now,
    updatedAt: now,
    sections: [
      { id: SECTION, name: 'Planning' },
      { id: '40000000-0000-4000-8000-000000000002', name: 'In progress' },
      { id: '40000000-0000-4000-8000-000000000003', name: 'Ready for launch' },
    ],
  },
];
const tasks: PlannerTask[] = [
  'Align on the release plan',
  'Prepare the customer announcement',
  'Review launch readiness',
  'Confirm success metrics',
].map((name, i) => ({
  ...PLANNER_DEFAULT_TASK,
  id: `30000000-0000-4000-8000-00000000000${i + 1}`,
  name,
  assigneeId: people[i % 3]!.id,
  description: 'Synthetic task used to verify Planner interactions.',
  priority: i === 0 ? 'high' : 'medium',
  status: i === 1 ? 'in_progress' : 'todo',
  startOn: '2026-10-06',
  dueOn: `2026-10-${10 + i}`,
  ownerId: 'user_qa',
  version: 1,
  archived: false,
  access: 'editor',
  actualMinutes: 0,
  completedAt: null,
  createdAt: now,
  updatedAt: now,
  estimateMinutes: 90,
  memberships: [{ projectId: PROJECT, sectionId: SECTION, position: i }],
}));
const events: PlannerEvent[] = [];
const removedEventContents = new Map<string, { text: string; minutes: number | null }>();
const resources: PlannerResource[] = [];
function goalPoint(
  row: PlannerResource,
  kind: PlannerEvent['kind'] = 'goal_progress',
  update?: { title: string; sections: PlannerGoalUpdateSection[] },
) {
  const data = row.data as unknown as PlannerGoalData;
  const progress = plannerGoalProgress(
    resources,
    new Set(projects.filter((p) => !p.archived).map((p) => p.id)),
    tasks
      .filter((t) => !t.archived)
      .map((t) => ({
        id: t.id,
        status: t.status,
        kind: t.subtype,
        projectIds: t.memberships.map((m) => m.projectId),
      })),
  ).get(row.id);
  const event: PlannerEvent = {
    id: crypto.randomUUID(),
    taskId: null,
    projectId: null,
    resourceId: row.id,
    actorId: 'user_qa',
    kind,
    text: update
      ? [update.title, ...update.sections.map((s) => `## ${s.title}\n${s.text}`)].join('\n\n')
      : 'Goal progress updated',
    minutes: null,
    createdAt: new Date().toISOString(),
    goalSnapshot: {
      status: data.status,
      measurement: data.progress,
      target: data.target,
      startValue: data.startValue ?? 0,
      direction: data.direction ?? 'increase',
      unit: data.unit,
      value: progress?.value ?? data.current,
      percentage: progress?.percentage ?? 0,
    },
    ...(update ? { goalUpdate: update } : {}),
  };
  events.unshift(event);
  return event;
}
const error = (message: string, status = 400) => {
  throw { response: { status, data: { message } } };
};
const api = {
  async get(path: string, config?: { params?: Record<string, string> }) {
    if (path.includes('/reports/')) {
      const parts = path.split('/'),
        dashboard = resources.find((r) => r.id === parts.at(-3));
      if (!dashboard) error('Dashboard unavailable', 404);
      if (config?.params?.version && Number(config.params.version) !== dashboard!.version)
        error('Record changed', 409);
      const widget = (dashboard!.data.widgets as PlannerReportWidget[]).find(
        (w) => w.id === parts.at(-1),
      );
      if (!widget || widget.kind !== 'chart') error('Chart unavailable', 404);
      const c = (widget as Extract<PlannerReportWidget, { kind: 'chart' }>).chart,
        f = c.filters;
      const sourceIds =
        f.source.kind === 'portfolios'
          ? resources
              .filter((r) => f.source.ids.includes(r.id))
              .flatMap((r) => r.data.projectIds as string[])
          : f.source.ids;
      const matching = tasks.filter(
        (t) =>
          !t.archived &&
          c.entity === 'tasks' &&
          (!dashboard!.projectId ||
            t.memberships.some((m) => m.projectId === dashboard!.projectId)) &&
          (f.source.kind === 'all' || t.memberships.some((m) => sourceIds.includes(m.projectId))) &&
          (!f.statuses.length || f.statuses.includes(t.status)) &&
          (!f.personIds.length || f.personIds.includes(t.assigneeId ?? 'unassigned')) &&
          (!f.priorities.length || f.priorities.includes(t.priority)) &&
          (!f.types.length || f.types.includes(t.subtype)) &&
          (!f.tags.length || f.tags.some((tag) => t.tags.includes(tag))) &&
          (f.includeSubtasks || !t.parentId) &&
          f.custom.every((filter) =>
            filter.values.some((v) => t.customValues[filter.fieldId] === v),
          ) &&
          ((!f.from && !f.through) ||
            (() => {
              const date =
                f.dateField === 'due'
                  ? t.dueOn
                  : f.dateField === 'start'
                    ? t.startOn
                    : f.dateField === 'completed'
                      ? t.completedAt?.slice(0, 10)
                      : t.createdAt.slice(0, 10);
              return date && (!f.from || date >= f.from) && (!f.through || date <= f.through);
            })()),
      );
      const value = (t: PlannerTask) =>
        c.metric === 'estimated_minutes'
          ? t.estimateMinutes
          : c.metric === 'actual_minutes'
            ? t.actualMinutes
            : c.metric === 'custom_number'
              ? Number(t.customValues[c.metricFieldId!] ?? 0)
              : 1;
      const group = (t: PlannerTask) =>
        c.group === 'none'
          ? 'all'
          : c.group === 'assignee'
            ? (t.assigneeId ?? 'unassigned')
            : c.group === 'priority'
              ? t.priority
              : c.group === 'created'
                ? t.createdAt.slice(0, 7)
                : c.group === 'due'
                  ? (t.dueOn?.slice(0, 7) ?? 'undated')
                  : t.status;
      const buckets = [...new Set(matching.map(group))].map((key) => ({
        key,
        label: key,
        value: matching.filter((t) => group(t) === key).reduce((n, t) => n + value(t), 0),
        count: matching.filter((t) => group(t) === key).length,
      }));
      const revision = matching
        .map((t) => `${t.id}:${t.version}:${value(t)}`)
        .sort()
        .join('|');
      if (config?.params?.revision && config.params.revision !== revision)
        error('Report changed; refresh.', 409);
      const rows = matching
        .filter(
          (t) =>
            (!config?.params?.bucket || group(t) === config.params.bucket) &&
            (!config?.params?.cursor || t.id > config.params.cursor),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        data: {
          total: matching.reduce((n, t) => n + value(t), 0),
          matched: matching.length,
          buckets,
          dashboardVersion: dashboard!.version,
          revision,
          unit: c.metric.endsWith('_minutes')
            ? 'minutes'
            : c.metric === 'custom_number'
              ? 'number'
              : 'items',
          overlapping: false,
          unavailableSources: false,
          unavailableFields: false,
          ...(config?.params?.rows === 'true'
            ? {
                items: rows.slice(0, 100).map((t) => ({
                  id: t.id,
                  entity: 'tasks',
                  name: t.name,
                  status: t.status,
                  personName: people.find((p) => p.id === t.assigneeId)?.name ?? null,
                  dueOn: t.dueOn,
                  value: value(t),
                })),
                nextCursor: rows.length > 100 ? rows[99]!.id : null,
              }
            : {}),
        },
      };
    }
    if (path === '/api/clients')
      return { data: [{ id: '60000000-0000-4000-8000-000000000001', name: 'Synthetic client' }] };
    if (path === '/api/engagement/meetings')
      return {
        data: [
          { id: '70000000-0000-4000-8000-000000000001', subject: 'Synthetic launch check-in' },
        ],
      };
    if (path.endsWith('/bootstrap'))
      return { data: { me: people[0], people, projects: structuredClone(projects) } };
    if (path.endsWith('/inbox'))
      return { data: config?.params?.paged === 'true' ? { items: [], nextCursor: null } : [] };
    if (path.endsWith('/resources')) {
      const views = structuredClone(resources);
      const progress = plannerGoalProgress(
        views,
        new Set(projects.filter((p) => !p.archived).map((p) => p.id)),
        tasks
          .filter((t) => !t.archived)
          .map((t) => ({
            id: t.id,
            status: t.status,
            kind: t.subtype,
            projectIds: t.memberships.map((m) => m.projectId),
          })),
      );
      for (const row of views)
        if (row.kind === 'goal') {
          row.goalProgress = progress.get(row.id);
          row.parentGoalIds = views
            .filter(
              (g) =>
                g.kind === 'goal' &&
                !g.archived &&
                ((g.data as unknown as PlannerGoalData).subgoalIds ?? []).includes(row.id),
            )
            .map((g) => g.id);
        }
      return { data: views };
    }
    if (path.endsWith('/attachments')) return { data: [] };
    if (path.endsWith('/events')) {
      const target = path.split('/').at(-2);
      const matching = events.filter(
        (e) => e.taskId === target || e.projectId === target || e.resourceId === target,
      );
      const offset = config?.params?.cursor
        ? matching.findIndex((e) => e.id === config.params!.cursor) + 1
        : 0;
      return {
        data:
          config?.params?.paged === 'true'
            ? {
                ...(path.includes('/goals/')
                  ? {
                      goalContext: {
                        audienceCount: 1,
                        following:
                          (
                            resources.find((r) => r.id === target)?.data.followers as
                              string[] | undefined
                          )?.includes('user_qa') ?? false,
                      },
                    }
                  : {}),
                items: structuredClone(matching.slice(offset, offset + 100)),
                nextCursor: matching.length > offset + 100 ? matching[offset + 99]!.id : null,
              }
            : structuredClone(matching.slice(0, 100)),
      };
    }
    if (path.endsWith('/tasks'))
      return {
        data: {
          items: structuredClone(
            tasks.filter(
              (t) =>
                (!config?.params?.mine || t.assigneeId === 'user_qa') &&
                (!config?.params?.projectId ||
                  t.memberships.some((m) => m.projectId === config.params!.projectId)) &&
                (!config?.params?.parentId || t.parentId === config.params.parentId) &&
                t.archived === (config?.params?.archived === 'true'),
            ),
          ),
          nextCursor: null,
        },
      };
    const id = path.split('/').at(-1);
    const row = tasks.find((t) => t.id === id);
    if (!row) error('Task unavailable', 404);
    return { data: structuredClone(row) };
  },
  async post(path: string, body: Record<string, unknown>) {
    if (path.endsWith('/reorder')) {
      const projectId = path.split('/').at(-2);
      for (const [i, item] of (body.tasks as { id: string; version: number }[]).entries()) {
        const row = tasks.find((t) => t.id === item.id)!;
        if (row.version !== item.version) error('Record changed', 409);
        row.memberships = row.memberships.map((m) =>
          m.projectId === projectId ? { ...m, position: i * 1000 } : m,
        );
        row.version++;
      }
      return { data: { ok: true } };
    }
    if (path.endsWith('/share')) {
      const form = resources.find((r) => r.id === path.split('/').at(-2))!;
      if (form.version !== body.version) error('Record changed', 409);
      form.publicShared = Boolean(body.enabled);
      form.version++;
      return {
        data: {
          token: body.enabled ? `10000000-0000-4000-8000-000000000001.${'a'.repeat(64)}` : null,
        },
      };
    }
    if (path.endsWith('/duplicate') || path.endsWith('/instantiate')) {
      const sourceId = path.split('/').at(-2);
      let template = resources.find((r) => r.id === sourceId)?.data as unknown as
        PlannerTemplateData | undefined;
      if (template?.schedule) template = plannerTemplateSchedule(template, String(body.anchorOn));
      const source = template?.project ?? projects.find((p) => p.id === sourceId)!;
      const sourceTasks =
        template?.tasks ?? tasks.filter((t) => t.memberships.some((m) => m.projectId === sourceId));
      const sections = new Map(source.sections.map((s) => [s.id, crypto.randomUUID()]));
      const fields = new Map(source.fields.map((f) => [f.id, crypto.randomUUID()]));
      const row = {
        ...source,
        id: crypto.randomUUID(),
        name: String(body.name),
        privacy: 'private',
        members: [],
        ownerId: 'user_qa',
        version: 1,
        archived: false,
        access: 'admin',
        createdAt: now,
        updatedAt: now,
        sections: source.sections.map((s) => ({ ...s, id: sections.get(s.id)! })),
        fields: source.fields.map((f) => ({ ...f, id: fields.get(f.id)! })),
      } as PlannerProject;
      const ids = sourceTasks.map(() => crypto.randomUUID());
      const originalIds = new Map(sourceTasks.map((t, i) => [(t as PlannerTask).id, i]));
      sourceTasks.forEach((t, i) => {
        const parent =
          template?.layout?.[i]?.parentIndex ?? (t.parentId ? originalIds.get(t.parentId) : null);
        const deps =
          template?.layout?.[i]?.dependencyIndices ??
          t.dependencies.flatMap((d) => (originalIds.has(d) ? [originalIds.get(d)!] : []));
        const section =
          template?.layout?.[i]?.sectionId ??
          t.memberships.find((m) => m.projectId === sourceId)?.sectionId;
        tasks.push({
          ...t,
          id: ids[i]!,
          ownerId: 'user_qa',
          version: 1,
          archived: false,
          access: 'editor',
          createdAt: now,
          updatedAt: now,
          actualMinutes: 0,
          completedAt: null,
          status: 'todo',
          parentId: parent == null ? null : ids[parent]!,
          dependencies: deps.map((d) => ids[d]!),
          customValues: Object.fromEntries(
            Object.entries(t.customValues).map(([id, value]) => [fields.get(id)!, value]),
          ),
          memberships: [
            {
              projectId: row.id,
              sectionId: section ? sections.get(section)! : null,
              position: i * 1000,
            },
          ],
        });
      });
      projects.push(row);
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/resources')) {
      const row = {
        ...body,
        id: crypto.randomUUID(),
        ownerId: 'user_qa',
        version: 1,
        archived: false,
        access: 'admin',
      } as unknown as PlannerResource;
      resources.push(row);
      if (row.kind === 'goal') goalPoint(row);
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/submit')) {
      const form = resources.find((r) => r.id === path.split('/').at(-2));
      if (!form) error('Form unavailable', 404);
      const config = form!.data as unknown as PlannerFormData;
      const values = Object.fromEntries(
        config.fields.map((f) => [f.taskField, body[f.id]]).filter(([, v]) => v !== undefined),
      );
      const row = {
        ...PLANNER_DEFAULT_TASK,
        ...config.defaults,
        ...values,
        id: crypto.randomUUID(),
        ownerId: 'user_qa',
        version: 1,
        archived: false,
        access: 'editor',
        actualMinutes: 0,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        memberships: [{ projectId: form!.projectId!, sectionId: null, position: 0 }],
      } as PlannerTask;
      tasks.push(row);
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/projects')) {
      const row = {
        ...PLANNER_DEFAULT_PROJECT,
        ...(body.data as Record<string, unknown>),
        id: crypto.randomUUID(),
        ownerId: 'user_qa',
        version: 1,
        archived: false,
        access: 'admin',
        createdAt: now,
        updatedAt: now,
      } as PlannerProject;
      projects.push(row);
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/updates')) {
      const goal = resources.find((r) => r.id === path.split('/').at(-2));
      if (!goal) error('Goal unavailable', 404);
      if (goal!.version !== body.version) error('Record changed', 409);
      goal!.data = {
        ...goal!.data,
        status: body.status,
        ...(body.current === undefined ? {} : { current: body.current }),
        ...(body.reminder === undefined ? {} : { reminder: body.reminder }),
        ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
      };
      goal!.version++;
      const event = goalPoint(goal!, 'goal_status', {
        title: String(body.title),
        sections: body.sections as PlannerGoalUpdateSection[],
      });
      return { data: { goal: structuredClone(goal), event: structuredClone(event) } };
    }
    if (path.endsWith('/events')) {
      const row: PlannerEvent = {
        id: crypto.randomUUID(),
        taskId: path.includes('/tasks/') ? path.split('/').at(-2)! : null,
        projectId: path.includes('/projects/') ? path.split('/').at(-2)! : null,
        resourceId: path.includes('/goals/') ? path.split('/').at(-2)! : null,
        actorId: 'user_qa',
        kind: body.kind as PlannerEvent['kind'],
        text: String(body.text),
        minutes: (body.minutes as number) ?? null,
        createdAt: new Date().toISOString(),
        version: 0,
        editedAt: null,
        removed: false,
      };
      events.unshift(row);
      if (body.minutes) {
        const task = tasks.find((t) => t.id === row.taskId);
        if (task) task.actualMinutes += Number(body.minutes);
      }
      return { data: structuredClone(row) };
    }
    const row = {
      ...PLANNER_DEFAULT_TASK,
      ...(body.data as Record<string, unknown>),
      id: crypto.randomUUID(),
      ownerId: 'user_qa',
      version: 1,
      archived: false,
      access: 'editor',
      actualMinutes: 0,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    } as PlannerTask;
    tasks.push(row);
    return { data: structuredClone(row) };
  },
  async patch(
    path: string,
    body: {
      name?: string;
      data?: Record<string, unknown>;
      version?: number;
      archived?: boolean;
      text?: string;
      minutes?: number;
      removed?: boolean;
      following?: boolean;
    },
  ) {
    if (path.endsWith('/follow')) {
      const goal = resources.find((r) => r.id === path.split('/').at(-2));
      if (!goal) error('Goal unavailable', 404);
      if (goal!.version !== body.version) error('Record changed', 409);
      const followers = ((goal!.data.followers ?? []) as string[]).filter((id) => id !== 'user_qa');
      goal!.data.followers = body.following ? [...followers, 'user_qa'] : followers;
      goal!.version++;
      return { data: { following: body.following } };
    }
    if (path.includes('/events/')) {
      const row = events.find((e) => e.id === path.split('/').at(-1));
      if (!row) error('Activity unavailable', 404);
      if ((row!.version ?? 0) !== body.version) error('Record changed', 409);
      const priorMinutes = row!.removed ? 0 : (row!.minutes ?? 0);
      if (body.removed === true) {
        removedEventContents.set(row!.id, { text: row!.text, minutes: row!.minutes });
        row!.text = '';
        row!.minutes = null;
        row!.removed = true;
      } else if (body.removed === false) {
        Object.assign(row!, removedEventContents.get(row!.id), { removed: false });
      } else {
        if (body.text !== undefined) row!.text = body.text;
        if (body.minutes !== undefined) row!.minutes = body.minutes;
      }
      row!.version = (row!.version ?? 0) + 1;
      row!.editedAt = new Date().toISOString();
      if (row!.kind === 'time') {
        const task = tasks.find((t) => t.id === row!.taskId);
        if (task) task.actualMinutes += (row!.removed ? 0 : (row!.minutes ?? 0)) - priorMinutes;
      }
      return { data: structuredClone(row) };
    }
    if (path.includes('/resources/')) {
      const row = resources.find((r) => r.id === path.split('/').at(-1));
      if (!row) error('Resource unavailable', 404);
      if (row!.version !== body.version) error('Record changed', 409);
      Object.assign(row!, {
        ...(body.name === undefined ? {} : { name: body.name }),
        data: { ...row!.data, ...body.data },
        version: row!.version + 1,
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      return { data: structuredClone(row) };
    }
    const id = path.split('/').at(-1);
    const collection = path.includes('/projects/') ? projects : tasks;
    const row = collection.find((row) => row.id === id);
    if (!row) error('Record unavailable', 404);
    if (row!.version !== body.version) error('Record changed', 409);
    Object.assign(row!, body.data, {
      version: row!.version + 1,
      ...(body.archived === undefined ? {} : { archived: body.archived }),
    });
    return { data: structuredClone(row) };
  },
};
export function useApi() {
  return api;
}
