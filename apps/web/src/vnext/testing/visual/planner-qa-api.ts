import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeDateBounds,
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
  type PlannerTimeDetails,
  type PlannerTimesheet,
  type PlannerTimeOptions,
  type PlannerTimePreferences,
  type PlannerTimeReviewView,
  PLANNER_DEFAULT_TIME_REVIEW,
  type PlannerTimesheetWorkRef,
  type PlannerTimesheetWorkRow,
  plannerTimeWorkKey,
  plannerWeekOn,
  plannerWeekDate,
  plannerDefaultBudget,
  PLANNER_DEFAULT_BUDGET_ALERT,
  plannerRatedCost,
  type PlannerProjectBudget,
  type PlannerBudgetData,
  type PlannerTimer,
  plannerTimeToday,
  PLANNER_DEFAULT_CAPACITY_PLAN,
  type PlannerCapacityCatalog,
  type PlannerCapacityAllocation,
  plannerCapacityDateShift,
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
const taskImports = new Map<string, { hash: string; taskId: string }>();
type QaTimer = PlannerTimer & { startKey: string; startHash: string; stopHash?: string };
const timerSessions = new Map<string, QaTimer>();
try {
  for (const row of JSON.parse(sessionStorage.getItem('planner-qa-timers') ?? '[]') as QaTimer[])
    timerSessions.set(row.id, row);
} catch {
  /* A stale synthetic fixture can be reset without touching live records. */
}
function saveQaTimers() {
  sessionStorage.setItem('planner-qa-timers', JSON.stringify([...timerSessions.values()]));
}
function qaTimerView(row: QaTimer) {
  const { startKey: _key, startHash: _hash, stopHash: _stop, ...timer } = row;
  const now = new Date();
  return {
    ...timer,
    serverNow: now.toISOString(),
    elapsedMilliseconds:
      timer.status === 'running'
        ? Math.max(0, now.getTime() - Date.parse(timer.startedAt))
        : timer.elapsedMilliseconds,
  };
}
const removedEventContents = new Map<string, { text: string; minutes: number | null }>();
const resources: PlannerResource[] = [];
const QA_CAPACITY_PLAN = '80000000-0000-4000-8000-000000000001',
  QA_TEAM = '80000000-0000-4000-8000-000000000002',
  QA_PLACEHOLDER = '80000000-0000-4000-8000-000000000003';
const capacityCatalog: PlannerCapacityCatalog = {
  plans: [
    {
      id: QA_CAPACITY_PLAN,
      name: 'Launch staffing',
      ownerId: 'user_qa',
      version: 1,
      archived: false,
      access: 'admin',
      data: { ...PLANNER_DEFAULT_CAPACITY_PLAN, projectIds: [PROJECT], teamIds: [QA_TEAM] },
    },
  ],
  teams: [
    {
      id: QA_TEAM,
      name: 'Product team',
      ownerId: 'user_qa',
      version: 1,
      archived: false,
      access: 'admin',
      data: {
        privacy: 'private',
        members: [],
        peopleIds: ['user_qa', 'user_qa2'],
        jobTitles: { user_qa: 'Product lead', user_qa2: 'Designer' },
      },
    },
  ],
  placeholders: [
    {
      id: QA_PLACEHOLDER,
      name: 'Open engineer',
      ownerId: 'user_qa',
      version: 1,
      archived: false,
      access: 'admin',
      data: { teamId: QA_TEAM, jobTitle: 'Engineer', weeklyMinutes: 1800 },
    },
  ],
};
const capacityAllocations: PlannerCapacityAllocation[] = [
  {
    id: '80000000-0000-4000-8000-000000000004',
    name: 'Project allocation',
    ownerId: 'user_qa',
    version: 1,
    archived: false,
    access: 'admin',
    projectId: PROJECT,
    projectName: 'Product launch',
    personName: 'Alex Morgan',
    weeklyMinutes: 2400,
    teamId: QA_TEAM,
    jobTitle: 'Product lead',
    data: {
      userId: 'user_qa',
      placeholderId: null,
      startOn: plannerTimeToday('America/New_York'),
      endOn: plannerCapacityDateShift(plannerTimeToday('America/New_York'), 13),
      effort: { unit: 'percent', value: 50 },
    },
  },
  {
    id: '80000000-0000-4000-8000-000000000005',
    name: 'Project allocation',
    ownerId: 'user_qa',
    version: 1,
    archived: false,
    access: 'admin',
    projectId: PROJECT,
    projectName: 'Product launch',
    personName: 'Open engineer',
    weeklyMinutes: 1800,
    teamId: QA_TEAM,
    jobTitle: 'Engineer',
    data: {
      userId: null,
      placeholderId: QA_PLACEHOLDER,
      startOn: plannerTimeToday('America/New_York'),
      endOn: plannerCapacityDateShift(plannerTimeToday('America/New_York'), 13),
      effort: { unit: 'hours', value: 45 },
    },
  },
];
const budgetConfigs = new Map<string, { version: number; data: PlannerBudgetData }>();
const budgetAlerts = new Map<string, PlannerProjectBudget['alert']>();
function projectBudget(id: string): PlannerProjectBudget {
  const stored = budgetConfigs.get(id),
    data = stored?.data ?? plannerDefaultBudget(timeSettings.options.budgetCurrency ?? 'USD');
  const personIds = new Set([...people.map((p) => p.id), ...data.rates.map((r) => r.userId)]);
  const rows = [...personIds].map((userId) => {
    const estimatedMinutes = tasks
      .filter(
        (t) =>
          !t.archived && t.assigneeId === userId && t.memberships.some((m) => m.projectId === id),
      )
      .reduce((n, t) => n + t.estimateMinutes, 0);
    const time = events.filter(
      (e) => e.kind === 'time' && !e.removed && e.actorId === userId && e.time?.projectId === id,
    );
    const actualMinutes = time
      .filter(
        (e) =>
          data.actualFilter === 'all' ||
          (e.time!.billable ? 'billable' : 'nonbillable') === data.actualFilter,
      )
      .reduce((n, e) => n + (e.minutes ?? 0), 0);
    const hourlyMinor = data.rates.find((r) => r.userId === userId)?.hourlyMinor ?? null;
    return {
      userId,
      name:
        people.find((p) => p.id === userId)?.name ??
        data.rates.find((r) => r.userId === userId)?.name ??
        'Former member',
      active: people.some((p) => p.id === userId),
      hourlyMinor,
      estimatedMinutes,
      actualMinutes,
      estimatedMinor: hourlyMinor === null ? null : plannerRatedCost(estimatedMinutes, hourlyMinor),
      actualMinor: hourlyMinor === null ? null : plannerRatedCost(actualMinutes, hourlyMinor),
    };
  });
  const time = events.filter((e) => e.kind === 'time' && !e.removed && e.time?.projectId === id);
  return {
    projectId: id,
    projectName: projects.find((p) => p.id === id)?.name ?? 'Project',
    version: stored?.version ?? 0,
    data: structuredClone(data),
    alert: structuredClone(budgetAlerts.get(id) ?? PLANNER_DEFAULT_BUDGET_ALERT),
    people: rows,
    estimatedMinutes: rows.reduce((n, p) => n + p.estimatedMinutes, 0),
    actualMinutes: rows.reduce((n, p) => n + p.actualMinutes, 0),
    billableMinutes: time.filter((e) => e.time!.billable).reduce((n, e) => n + (e.minutes ?? 0), 0),
    nonbillableMinutes: time
      .filter((e) => !e.time!.billable)
      .reduce((n, e) => n + (e.minutes ?? 0), 0),
    estimatedMinor: rows.reduce((n, p) => n + BigInt(p.estimatedMinor ?? '0'), 0n).toString(),
    actualMinor: rows.reduce((n, p) => n + BigInt(p.actualMinor ?? '0'), 0n).toString(),
    unratedEstimatedMinutes: rows
      .filter((p) => p.hourlyMinor === null)
      .reduce((n, p) => n + p.estimatedMinutes, 0),
    unratedActualMinutes: rows
      .filter((p) => p.hourlyMinor === null)
      .reduce((n, p) => n + p.actualMinutes, 0),
  };
}
const timeSettings = {
  version: 1,
  canManage: new URLSearchParams(window.location.search).get('qaRole') === 'admin',
  reviewers: { user_qa: 'user_qa2', user_qa2: 'user_qa', user_qa3: 'user_qa' } as Record<
    string,
    string
  >,
  options: structuredClone(PLANNER_DEFAULT_TIME_OPTIONS),
};
function timeAllowed(date: string) {
  const bounds = plannerTimeDateBounds(timeSettings.options, timeSettings.canManage);
  return (
    timeSettings.options.timeTrackingEnabled &&
    (!bounds.minOn || date >= bounds.minOn) &&
    (!bounds.maxOn || date <= bounds.maxOn)
  );
}
const timeSheets = new Map<
  string,
  { version: number; status: PlannerTimesheet['status']; notes: string; history: PlannerEvent[] }
>();
const timePreferences: PlannerTimePreferences = { version: 1, autoAddDueTasks: false };
const selectedWork = new Map<string, PlannerTimesheetWorkRef[]>();
const excludedWork = new Map<string, string[]>();
function timeSheet(week: string, userId = 'user_qa'): PlannerTimesheet {
  const weekOn = plannerWeekOn(week),
    key = userId + weekOn,
    stored = timeSheets.get(key);
  const entries = events.filter(
    (e) =>
      e.kind === 'time' &&
      !e.removed &&
      e.actorId === userId &&
      (e.time?.workedOn ?? e.createdAt.slice(0, 10)) >= weekOn &&
      (e.time?.workedOn ?? e.createdAt.slice(0, 10)) < plannerWeekDate(weekOn, 7),
  );
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = plannerWeekDate(weekOn, i),
      rows = entries.filter((e) => e.time?.workedOn === date);
    return {
      date,
      totalMinutes: rows.reduce((n, e) => n + (e.minutes ?? 0), 0),
      billableMinutes: rows
        .filter((e) => e.time?.billable)
        .reduce((n, e) => n + (e.minutes ?? 0), 0),
    };
  });
  const status = stored?.status ?? 'draft';
  const editable =
    (timeSettings.canManage || status === 'draft' || status === 'rejected') && timeAllowed(weekOn);
  const workRows = new Map<string, PlannerTimesheetWorkRow>();
  const addWork = (work: PlannerTimesheetWorkRef, origin: PlannerTimesheetWorkRow['origin']) => {
    const rowKey = plannerTimeWorkKey(work);
    if (workRows.has(rowKey)) return;
    const rows = entries.filter(
      (e) => e.taskId === work.taskId && e.time?.projectId === work.projectId,
    );
    const workDays = days.map((d) => ({
      ...d,
      totalMinutes: rows
        .filter((e) => e.time?.workedOn === d.date)
        .reduce((n, e) => n + (e.minutes ?? 0), 0),
      billableMinutes: rows
        .filter((e) => e.time?.workedOn === d.date && e.time.billable)
        .reduce((n, e) => n + (e.minutes ?? 0), 0),
    }));
    workRows.set(rowKey, {
      ...work,
      key: rowKey,
      origin,
      taskName: tasks.find((t) => t.id === work.taskId)?.name ?? null,
      projectName: projects.find((p) => p.id === work.projectId)?.name ?? null,
      totalMinutes: workDays.reduce((n, d) => n + d.totalMinutes, 0),
      billableMinutes: workDays.reduce((n, d) => n + d.billableMinutes, 0),
      days: workDays,
      canLogTime: editable && (!!work.taskId || timeSettings.options.generalWorkEnabled),
      canRemove: editable && !rows.length,
    });
  };
  for (const entry of entries)
    addWork(
      { taskId: entry.taskId, projectId: entry.time?.projectId ?? entry.projectId },
      'tracked',
    );
  for (const work of selectedWork.get(key) ?? []) addWork(work, 'added');
  if (timePreferences.autoAddDueTasks)
    for (const task of tasks.filter(
      (t) =>
        !t.archived &&
        t.assigneeId === userId &&
        t.dueOn &&
        t.dueOn >= weekOn &&
        t.dueOn <= plannerWeekDate(weekOn, 6),
    ))
      if (
        ![...workRows.values()].some((w) => w.taskId === task.id) &&
        !(excludedWork.get(key) ?? []).includes(task.id)
      )
        addWork(
          {
            taskId: task.id,
            projectId: task.memberships.length === 1 ? task.memberships[0]!.projectId : null,
          },
          'automatic',
        );
  return {
    id: stored ? key : null,
    userId,
    weekOn,
    throughOn: plannerWeekDate(weekOn, 6),
    reviewerId: timeSettings.reviewers[userId] ?? null,
    status,
    version: stored?.version ?? 0,
    revision: `${timeSettings.version.toString(16).padStart(8, '0')}${timePreferences.version.toString(16).padStart(8, '0')}${(stored?.version ?? 0).toString(16).padStart(48, '0')}`,
    notes: stored?.notes ?? '',
    correctedAfterApproval: false,
    totalMinutes: days.reduce((n, d) => n + d.totalMinutes, 0),
    billableMinutes: days.reduce((n, d) => n + d.billableMinutes, 0),
    days,
    matched: entries.length,
    unavailableEntries: false,
    items: entries.map((e) => ({
      ...e,
      time: e.time!,
      taskName: tasks.find((t) => t.id === e.taskId)?.name ?? null,
      projectName: projects.find((p) => p.id === (e.time?.projectId ?? e.projectId))?.name ?? null,
      canEdit:
        (timeSettings.canManage || status === 'draft' || status === 'rejected') &&
        timeAllowed(e.time!.workedOn),
    })),
    nextCursor: null,
    actions:
      status === 'submitted'
        ? ['recall_submission']
        : status === 'approved'
          ? []
          : entries.length &&
              (timeSettings.reviewers[userId] || timeSettings.options.approvalProcess === 'simple')
            ? ['submit']
            : [],
    history: stored?.history ?? [],
    canLogTime:
      (timeSettings.canManage || status === 'draft' || status === 'rejected') &&
      timeAllowed(weekOn),
    timeNotice: timeAllowed(weekOn)
      ? null
      : 'Time is unavailable under the organization time settings.',
    approvalProcess: timeSettings.options.approvalProcess,
    workRows: [...workRows.values()],
    matchedWork: workRows.size,
    nextWorkCursor: null,
  };
}
function touchTime(userId: string, date: string) {
  const key = userId + plannerWeekOn(date),
    old = timeSheets.get(key);
  if (!timeAllowed(date))
    error('This date is unavailable under the organization time settings', 403);
  if (!timeSettings.canManage && (old?.status === 'submitted' || old?.status === 'approved'))
    error('Recall this timesheet before editing time', 403);
  timeSheets.set(key, {
    version: (old?.version ?? 0) + 1,
    status: old?.status ?? 'draft',
    notes: old?.notes ?? '',
    history: old?.history ?? [],
  });
}
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
    if (path.endsWith('/capacity')) return { data: structuredClone(capacityCatalog) };
    if (path.includes('/capacity/plans/')) {
      const plan = capacityCatalog.plans.find((p) => p.id === path.split('/').at(-1));
      if (!plan) error('Plan unavailable', 404);
      const params = config?.params ?? {},
        data = plan!.data;
      const projectIds = [
        ...new Set([
          ...data.projectIds,
          ...resources
            .filter((r) => data.portfolioIds.includes(r.id) && !r.archived)
            .flatMap((r) => r.data.projectIds as string[]),
        ]),
      ];
      const personIds = [
        ...new Set([
          ...data.peopleIds,
          ...capacityCatalog.teams
            .filter((t) => data.teamIds.includes(t.id) && !t.archived)
            .flatMap((t) => [
              ...t.data.peopleIds,
              ...capacityCatalog.placeholders
                .filter((p) => !p.archived && p.data.teamId === t.id)
                .map((p) => p.id),
            ]),
        ]),
      ];
      const allocations = capacityAllocations
        .filter(
          (a) =>
            a.archived === (params.archived === 'true') &&
            (projectIds.includes(a.projectId) ||
              personIds.includes(a.data.userId ?? a.data.placeholderId!)),
        )
        .map((a) => ({
          ...a,
          weeklyMinutes: a.data.placeholderId
            ? (capacityCatalog.placeholders.find((p) => p.id === a.data.placeholderId)?.data
                .weeklyMinutes ?? 2400)
            : Number(
                resources
                  .filter((r) => r.kind === 'capacity' && !r.archived && !r.projectId)
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .find((r) => r.data.userId === a.data.userId)?.data.weeklyMinutes ?? 2400,
              ),
        }));
      const allPersonIds = [
        ...new Set([
          ...personIds,
          ...allocations.map((a) => a.data.userId ?? a.data.placeholderId!),
        ]),
      ];
      const weeklyCapacities = allPersonIds.map((id) => ({
        id,
        weeklyMinutes:
          capacityCatalog.placeholders.find((p) => p.id === id)?.data.weeklyMinutes ??
          Number(
            resources.find((r) => r.kind === 'capacity' && !r.archived && r.data.userId === id)
              ?.data.weeklyMinutes ?? 2400,
          ),
        canEdit: true,
      }));
      const portfolios = resources
        .filter((r) => data.portfolioIds.includes(r.id) && !r.archived)
        .map((r) => ({
          id: r.id,
          name: r.name,
          projectIds: (r.data.projectIds as string[]).filter((id) =>
            projects.some((p) => p.id === id && !p.archived),
          ),
        }));
      const revision = JSON.stringify([plan, allocations, weeklyCapacities, portfolios]);
      if (params.revision && params.revision !== revision) error('Capacity changed', 409);
      return {
        data: structuredClone({
          plan,
          allocations,
          matched: allocations.length,
          revision,
          nextCursor: null,
          weeklyCapacities,
          portfolios,
          projectIds: [...new Set([...projectIds, ...allocations.map((a) => a.projectId)])],
          personIds: [
            ...new Set([
              ...personIds,
              ...allocations.map((a) => a.data.userId ?? a.data.placeholderId!),
            ]),
          ],
        }),
      };
    }
    if (path.endsWith('/time/tree')) {
      const params = config?.params ?? {};
      const roots = tasks.filter(
        (task) =>
          task.archived === (params.archived === 'true') &&
          (!params.taskId || task.id === params.taskId) &&
          (params.mine !== 'true' || task.assigneeId === 'user_qa') &&
          (!params.projectId || task.memberships.some((m) => m.projectId === params.projectId)),
      );
      const rootIds = new Set(roots.map((task) => task.id)),
        selected = new Map<string, PlannerTask>(),
        pending = [...roots];
      while (pending.length) {
        const task = pending.pop()!;
        if (selected.has(task.id)) continue;
        selected.set(task.id, task);
        pending.push(...tasks.filter((child) => !child.archived && child.parentId === task.id));
      }
      const nodes = [...selected.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((task) => ({
          id: task.id,
          parentId: task.parentId && selected.has(task.parentId) ? task.parentId : null,
          version: task.version,
          scoped: rootIds.has(task.id),
          estimateMinutes: task.estimateMinutes,
          actualMinutes: task.actualMinutes,
        }));
      let hash = 2166136261;
      for (const char of JSON.stringify(nodes))
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const revision = (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
      if (params.revision && params.revision !== revision) error('Task time changed', 409);
      const start = params.cursor ? nodes.findIndex((node) => node.id === params.cursor) + 1 : 0;
      return {
        data: {
          nodes: nodes.slice(start, start + 100),
          revision,
          matched: nodes.length,
          nextCursor: start + 100 < nodes.length ? nodes[start + 99]!.id : null,
        },
      };
    }
    if (path.endsWith('/time/timer')) {
      const row = [...timerSessions.values()].find((t) => t.status === 'running');
      return { data: row ? qaTimerView(row) : null };
    }
    if (path.endsWith('/budget')) return { data: projectBudget(path.split('/').at(-2)!) };
    if (path.endsWith('/time/preferences')) return { data: structuredClone(timePreferences) };
    if (path.endsWith('/time/settings')) return { data: structuredClone(timeSettings) };
    if (path.endsWith('/time/entries')) {
      const params = config?.params ?? {},
        assigned = Object.keys(timeSettings.reviewers).filter(
          (id) => timeSettings.reviewers[id] === 'user_qa',
        );
      const items = events
        .filter(
          (e) =>
            e.kind === 'time' &&
            !e.removed &&
            e.time &&
            e.time.workedOn >= params.fromOn! &&
            e.time.workedOn <= params.throughOn! &&
            (params.scope === 'organization'
              ? timeSettings.canManage
              : params.scope === 'project'
                ? e.time.projectId === params.projectId
                : params.scope === 'review'
                  ? assigned.includes(e.actorId)
                  : e.actorId === params.userId),
        )
        .map((e) => ({
          ...e,
          taskName: tasks.find((t) => t.id === e.taskId)?.name ?? null,
          projectName: projects.find((p) => p.id === e.time?.projectId)?.name ?? null,
          canEdit: false,
          submitterName: people.find((p) => p.id === e.actorId)?.name ?? 'Former member',
          taskStatus: e.taskId
            ? tasks.find((t) => t.id === e.taskId)?.status === 'done'
              ? 'Completed'
              : 'Open'
            : null,
        }))
        .sort(
          (a, b) => a.time!.workedOn.localeCompare(b.time!.workedOn) || a.id.localeCompare(b.id),
        );
      const revision = JSON.stringify(items);
      if (params.revision && params.revision !== revision) error('Time changed during export', 409);
      const start = params.cursor ? items.findIndex((e) => e.id === params.cursor) + 1 : 0;
      return {
        data: {
          fromOn: params.fromOn,
          throughOn: params.throughOn,
          revision,
          matched: items.length,
          unavailableEntries: false,
          totalMinutes: items.reduce((n, e) => n + (e.minutes ?? 0), 0),
          billableMinutes: items.reduce((n, e) => n + (e.time!.billable ? (e.minutes ?? 0) : 0), 0),
          items: items.slice(start, start + 100),
          nextCursor: items.length > start + 100 ? items[start + 99]!.id : null,
        },
      };
    }
    if (path.endsWith('/timesheets/review')) {
      const params = config?.params ?? {},
        view: PlannerTimeReviewView = {
          ...PLANNER_DEFAULT_TIME_REVIEW,
          people: params.people ? params.people.split(',') : [],
          statuses: params.statuses
            ? (params.statuses.split(',') as PlannerTimeReviewView['statuses'])
            : [],
          sort: (params.sort ?? 'name') as PlannerTimeReviewView['sort'],
          direction: (params.direction ?? 'asc') as PlannerTimeReviewView['direction'],
        },
        assigned = people.filter((p) => timeSettings.reviewers[p.id] === 'user_qa');
      const items = assigned
        .map((p) => timeSheet(params.week ?? now.slice(0, 10), p.id))
        .filter(
          (s) =>
            (!view.people.length || view.people.includes(s.userId)) &&
            (!view.statuses.length || view.statuses.includes(s.status)),
        )
        .sort((a, b) => {
          const n =
            view.sort === 'total'
              ? a.totalMinutes - b.totalMinutes
              : view.sort === 'billable'
                ? a.billableMinutes - b.billableMinutes
                : people
                    .find((p) => p.id === a.userId)!
                    .name.localeCompare(people.find((p) => p.id === b.userId)!.name);
          return n * (view.direction === 'desc' ? -1 : 1) || a.userId.localeCompare(b.userId);
        });
      const revision = JSON.stringify([timeSettings.version, view, items.map((s) => s.revision)]);
      if (params.revision && params.revision !== revision) error('Reviewed time changed', 409);
      const start = params.cursor ? items.findIndex((s) => s.userId === params.cursor) + 1 : 0;
      return {
        data:
          params.paged === 'true'
            ? {
                weekOn: plannerWeekOn(params.week ?? now.slice(0, 10)),
                revision,
                people: assigned,
                matched: items.length,
                items: items.slice(start, start + 100),
                nextCursor: items.length > start + 100 ? items[start + 99]!.userId : null,
                totalMinutes: items.reduce((n, s) => n + s.totalMinutes, 0),
                billableMinutes: items.reduce((n, s) => n + s.billableMinutes, 0),
              }
            : items,
      };
    }
    if (path.endsWith('/timesheets')) {
      const sheet = timeSheet(
        config?.params?.week ?? new Date().toISOString().slice(0, 10),
        config?.params?.userId,
      );
      if (config?.params?.revision && config.params.revision !== sheet.revision)
        error('Time changed', 409);
      const start = config?.params?.historyCursor
        ? sheet.history.findIndex((e) => e.id === config.params!.historyCursor) + 1
        : 0;
      return {
        data: {
          ...sheet,
          history: sheet.history.slice(start, start + 100),
          nextHistoryCursor:
            sheet.history.length > start + 100 ? sheet.history[start + 99]!.id : null,
        },
      };
    }
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
      return {
        data: {
          me: people[0],
          people,
          projects: structuredClone(projects),
          timeOptions: structuredClone(timeSettings.options),
          timeAdmin: timeSettings.canManage,
        },
      };
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
    if (path.includes('/capacity/')) {
      const kind = path.split('/').at(-1)!;
      if (kind === 'weekly-capacities') {
        const page = await api.get('/strategy-api/planner/capacity/plans/' + body.planId);
        if ((page.data as any).revision !== body.revision) error('Capacity changed', 409);
        for (const c of body.changes as { id: string; weeklyMinutes: number }[]) {
          const placeholder = capacityCatalog.placeholders.find((p) => p.id === c.id);
          if (placeholder) {
            placeholder.data.weeklyMinutes = c.weeklyMinutes;
            placeholder.version++;
          } else {
            const old = resources.find(
              (r) => r.kind === 'capacity' && !r.archived && r.data.userId === c.id,
            );
            if (old) {
              old.data.weeklyMinutes = c.weeklyMinutes;
              old.version++;
            } else
              resources.push({
                id: crypto.randomUUID(),
                kind: 'capacity',
                name: 'Weekly capacity',
                ownerId: c.id,
                projectId: null,
                archived: false,
                version: 1,
                access: 'admin',
                data: { userId: c.id, weeklyMinutes: c.weeklyMinutes },
              });
          }
        }
        return { data: { ok: true } };
      }
      if (kind === 'allocations') {
        const plan = capacityCatalog.plans.find((p) => p.id === body.planId);
        if (!plan || plan.version !== body.planVersion) error('Plan changed', 409);
        const changed = (body.changes as any[]).map((c) => {
          const old = capacityAllocations.find((a) => a.id === c.id);
          if (old && old.version !== c.version) error('Allocation changed', 409);
          const data = { ...old?.data, ...c.data };
          if (c.shiftDays !== undefined) {
            data.startOn = plannerCapacityDateShift(data.startOn, c.shiftDays);
            data.endOn = plannerCapacityDateShift(data.endOn, c.shiftDays);
          }
          const placeholder = capacityCatalog.placeholders.find((p) => p.id === data.placeholderId);
          const team = capacityCatalog.teams.find(
            (t) => t.id === placeholder?.data.teamId || t.data.peopleIds.includes(data.userId),
          );
          const projectId = c.projectId ?? old?.projectId;
          return {
            ...old,
            id: c.duplicateId ?? c.id,
            name: 'Project allocation',
            ownerId: 'user_qa',
            version: c.duplicateId ? 1 : (old?.version ?? 0) + 1,
            archived: c.archived ?? old?.archived ?? false,
            access: 'admin',
            data,
            projectId,
            projectName: projects.find((p) => p.id === projectId)?.name,
            personName: placeholder?.name ?? people.find((p) => p.id === data.userId)?.name,
            weeklyMinutes: placeholder?.data.weeklyMinutes ?? 2400,
            teamId: team?.id ?? null,
            jobTitle: placeholder?.data.jobTitle ?? team?.data.jobTitles[data.userId] ?? '',
          } as PlannerCapacityAllocation;
        });
        for (const a of changed) {
          const index = capacityAllocations.findIndex((row) => row.id === a.id);
          index < 0 ? capacityAllocations.push(a) : capacityAllocations.splice(index, 1, a);
        }
        return { data: { allocations: structuredClone(changed) } };
      }
      const rows = capacityCatalog[kind as keyof PlannerCapacityCatalog] as any[];
      if (!rows) error('Staffing unavailable', 404);
      const old = rows.find((r) => r.id === body.id);
      if (old && old.version !== body.version) error('Staffing changed', 409);
      const row = {
        ...old,
        ...body,
        version: (old?.version ?? 0) + 1,
        ownerId: 'user_qa',
        access: 'admin',
        archived: body.archived ?? old?.archived ?? false,
      };
      const index = rows.findIndex((r) => r.id === body.id);
      index < 0 ? rows.push(row) : rows.splice(index, 1, row);
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/time/timers')) {
      const previous = [...timerSessions.values()].find((t) => t.startKey === body.startKey);
      if (previous) {
        if (previous.startHash !== JSON.stringify(body)) error('Timer start changed', 409);
        return { data: qaTimerView(previous) };
      }
      if ([...timerSessions.values()].some((t) => t.status === 'running'))
        error('Stop your running timer first', 409);
      const task = tasks.find((t) => t.id === body.taskId);
      if (!task) error('Task unavailable', 404);
      const now = new Date().toISOString();
      const row: QaTimer = {
        id: crypto.randomUUID(),
        version: 1,
        status: 'running',
        startedAt: now,
        endedAt: null,
        serverNow: now,
        elapsedMilliseconds: 0,
        minutes: 0,
        taskId: task!.id,
        taskName: task!.name,
        canStop: true,
        notice: null,
        time: {
          timeZone: timeSettings.options.timeZone,
          billable: timeSettings.options.billableEnabled && timeSettings.options.billableDefault,
          projectId: task!.memberships[0]?.projectId ?? null,
          category: '',
          ...(body.time as object),
        },
        startKey: String(body.startKey),
        startHash: JSON.stringify(body),
      };
      timerSessions.set(row.id, row);
      saveQaTimers();
      return { data: qaTimerView(row) };
    }
    if (path.includes('/time/timers/') && (path.endsWith('/stop') || path.endsWith('/discard'))) {
      const row = timerSessions.get(path.split('/').at(-2)!);
      if (!row) error('Timer unavailable', 404);
      const hash = JSON.stringify([path.endsWith('/stop') ? 'stop' : 'discard', body]);
      if (row!.status !== 'running') {
        if (row!.stopHash !== hash) error('Timer already ended', 409);
        return { data: qaTimerView(row!) };
      }
      if (row!.version !== body.version) error('Timer changed', 409);
      const now = new Date(),
        elapsed = Math.max(0, now.getTime() - Date.parse(row!.startedAt)),
        logging = path.endsWith('/stop');
      const time = {
        ...row!.time!,
        ...(body.time as object),
        workedOn: plannerTimeToday(row!.time!.timeZone, now),
      };
      if (logging) {
        touchTime('user_qa', time.workedOn);
        const minutes = Math.ceil(elapsed / 60_000);
        const task = tasks.find((t) => t.id === row!.taskId)!;
        if (minutes) {
          events.unshift({
            id: crypto.randomUUID(),
            taskId: task.id,
            projectId: null,
            actorId: 'user_qa',
            recordedBy: 'user_qa',
            kind: 'time',
            text: 'Tracked with timer',
            minutes,
            time,
            timeEditable: true,
            createdAt: now.toISOString(),
            version: 0,
          });
          task.actualMinutes += minutes;
        }
        row!.minutes = minutes;
        row!.time = { ...time };
      }
      row!.status = logging ? 'stopped' : 'discarded';
      row!.endedAt = now.toISOString();
      row!.elapsedMilliseconds = elapsed;
      row!.canStop = false;
      row!.stopHash = hash;
      row!.version++;
      saveQaTimers();
      return { data: qaTimerView(row!) };
    }
    if (path.endsWith('/tasks/import')) {
      const key = String(body.importKey),
        hash = JSON.stringify(body),
        receipt = taskImports.get(key);
      if (receipt) {
        if (receipt.hash !== hash) error('Import row changed', 409);
        return { data: structuredClone(tasks.find((t) => t.id === receipt.taskId)!) };
      }
      const row = {
        ...PLANNER_DEFAULT_TASK,
        ...(body.data as object),
        id: crypto.randomUUID(),
        ownerId: 'user_qa',
        version: 1,
        archived: false,
        access: 'editor',
        actualMinutes: Number(body.actualMinutes),
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      } as PlannerTask;
      const time: PlannerTimeDetails = {
        workedOn: new Date().toISOString().slice(0, 10),
        timeZone: timeSettings.options.timeZone,
        billable: timeSettings.options.billableEnabled && timeSettings.options.billableDefault,
        category: '',
        projectId: row.memberships[0]?.projectId ?? null,
        ...(body.time as object),
      };
      if (row.actualMinutes) touchTime('user_qa', time.workedOn);
      for (let remaining = row.actualMinutes; remaining > 0; remaining -= 1440)
        events.unshift({
          id: crypto.randomUUID(),
          taskId: row.id,
          projectId: null,
          actorId: 'user_qa',
          kind: 'time',
          text: 'Imported task time',
          minutes: Math.min(remaining, 1440),
          time,
          timeEditable: true,
          createdAt: now,
          version: 0,
        });
      tasks.push(row);
      taskImports.set(key, { hash, taskId: row.id });
      return { data: structuredClone(row) };
    }
    if (path.endsWith('/timesheets/work')) {
      const week = String(body.week),
        userId = String(body.userId),
        sheet = timeSheet(week, userId),
        key = userId + sheet.weekOn,
        work = body.work as PlannerTimesheetWorkRef;
      if (body.version !== sheet.version || body.revision !== sheet.revision)
        error('Work changed', 409);
      if (!sheet.canLogTime) error('This week is locked', 403);
      const workKey = plannerTimeWorkKey(work),
        old = selectedWork.get(key) ?? [];
      if (body.action === 'remove') {
        if (!sheet.workRows?.find((r) => r.key === workKey)?.canRemove)
          error('Remove time entries first', 403);
        selectedWork.set(
          key,
          old.filter((r) => plannerTimeWorkKey(r) !== workKey),
        );
        if (work.taskId)
          excludedWork.set(key, [...new Set([...(excludedWork.get(key) ?? []), work.taskId])]);
      } else {
        selectedWork.set(
          key,
          old.some((r) => plannerTimeWorkKey(r) === workKey) ? old : [...old, work],
        );
        if (work.taskId)
          excludedWork.set(
            key,
            (excludedWork.get(key) ?? []).filter((id) => id !== work.taskId),
          );
      }
      touchTime(userId, sheet.weekOn);
      return { data: timeSheet(week, userId) };
    }
    if (path.endsWith('/timesheets/status')) {
      const week = String(body.week),
        userId = String(body.userId),
        key = userId + plannerWeekOn(week),
        sheet = timeSheet(week, userId);
      if (body.version !== sheet.version || body.revision !== sheet.revision)
        error('Record changed', 409);
      const status = body.action === 'submit' ? 'submitted' : 'draft';
      const event: PlannerEvent = {
        id: crypto.randomUUID(),
        taskId: null,
        projectId: null,
        actorId: 'user_qa',
        kind: 'timesheet_status',
        text: `${status === 'submitted' ? 'Submitted' : 'Recalled'} timesheet · ${sheet.weekOn}`,
        timesheet: { weekOn: sheet.weekOn, userId },
        createdAt: new Date().toISOString(),
        minutes: null,
      };
      timeSheets.set(key, {
        version: sheet.version + 1,
        status,
        notes: String(body.notes),
        history: [event, ...sheet.history],
      });
      return { data: timeSheet(week, userId) };
    }
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
      const time =
        body.kind === 'time'
          ? ({
              workedOn: new Date().toISOString().slice(0, 10),
              timeZone: 'UTC',
              billable: false,
              projectId: path.includes('/projects/') ? path.split('/').at(-2) : null,
              category: '',
              ...(body.time as Partial<PlannerTimeDetails>),
            } as PlannerTimeDetails)
          : undefined;
      if (time) touchTime(String(body.loggerId ?? 'user_qa'), time.workedOn);
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
        ...(time ? { time, timeEditable: true } : {}),
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
      time?: Partial<PlannerTimeDetails>;
      reviewers?: Record<string, string>;
      options?: Partial<PlannerTimeOptions>;
      autoAddDueTasks?: boolean;
      reviewView?: PlannerTimeReviewView;
    },
  ) {
    if (path.endsWith('/time/preferences')) {
      if (body.version !== timePreferences.version) error('Settings changed', 409);
      if (body.autoAddDueTasks !== undefined)
        timePreferences.autoAddDueTasks = body.autoAddDueTasks;
      if (body.reviewView !== undefined)
        timePreferences.reviewView = structuredClone(body.reviewView);
      timePreferences.version++;
      return { data: { ok: true, version: timePreferences.version } };
    }
    if (path.endsWith('/budget/alert')) {
      const id = path.split('/').at(-3)!,
        old = budgetAlerts.get(id) ?? PLANNER_DEFAULT_BUDGET_ALERT;
      if (body.version !== old.version) error('Alert changed', 409);
      budgetAlerts.set(id, {
        ...old,
        ...body.data,
        version: old.version + 1,
      } as PlannerProjectBudget['alert']);
      return { data: projectBudget(id) };
    }
    if (path.endsWith('/budget')) {
      const id = path.split('/').at(-2)!,
        old = projectBudget(id);
      if (body.version !== old.version) error('Budget changed', 409);
      budgetConfigs.set(id, {
        version: old.version + 1,
        data: { ...old.data, ...body.data } as PlannerBudgetData,
      });
      return { data: projectBudget(id) };
    }
    if (path.endsWith('/time/settings')) {
      if (!timeSettings.canManage) error('Organization admin required', 403);
      if (body.version !== timeSettings.version) error('Record changed', 409);
      timeSettings.reviewers = body.reviewers ?? {};
      timeSettings.options = { ...timeSettings.options, ...body.options };
      timeSettings.version++;
      return { data: { ok: true } };
    }
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
      if (row!.kind === 'time' && row!.time) {
        for (const date of new Set([row!.time.workedOn, body.time?.workedOn ?? row!.time.workedOn]))
          touchTime(row!.actorId, date);
        if (body.time) row!.time = { ...row!.time, ...body.time };
      }
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
      row!.editedBy = 'user_qa';
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
