import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import {
  Plus,
  Search,
  X,
  LayoutList,
  Columns3,
  CalendarDays,
  ChartGantt,
  BarChart3,
  Inbox,
  CheckCircle2,
  FolderKanban,
  Users,
  Settings2,
  Archive,
  Download,
  RefreshCw,
  Clock3,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PlannerProject,
  PlannerProjectData,
  PlannerTask,
  PlannerTaskData,
  PlannerBootstrap,
  PlannerView,
  PlannerStatus,
  PlannerMyTasksData,
} from '@capiro/strategy-verifier';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_STATUS_LABELS,
  PLANNER_DEFAULT_MY_TASKS,
  plannerTaskOverdue,
  plannerDueTimestamp,
  plannerWeekOn,
  plannerTimeToday,
} from '@capiro/strategy-verifier';
import { useApi } from '../../../lib/use-api.js';
import {
  usePlannerBootstrap,
  usePlannerTasks,
  usePlannerTask,
  usePlannerEvents,
  usePlannerInbox,
  usePlannerMutations,
  usePlannerKey,
  usePlannerResources,
  plannerError,
} from './planner-api.js';
import {
  PlannerList,
  PlannerBoard,
  PlannerCalendar,
  PlannerTimeline,
  plannerToday,
  shiftPlannerDate,
} from './planner-views.js';
import { PlannerManagement, PlannerProjectActivity } from './planner-management.js';
import { PlannerActivity } from './planner-activity.js';
import { PlannerImport } from './planner-import.js';
import { plannerCsvCell } from './planner-csv.js';
import { SavePlannerView } from './planner-saved-view.js';
import { PlannerAttachments } from './planner-attachments.js';
import { PlannerRichText, PlannerFormattedText } from './planner-rich-text.js';
import { PlannerMyTasksSettings } from './planner-my-tasks.js';
import { PlannerTaskSchedule } from './planner-task-schedule.js';
import { PlannerReporting } from './planner-reporting.js';
import { PlannerTimesheets } from './planner-timesheets.js';
import { PlannerTimeExportButton } from './planner-time-export.js';
import { PlannerTimeForm } from './planner-time-form.js';
import type { PlannerSavedViewData } from '@capiro/strategy-verifier';
import './planner.css';

const VIEWS: { id: PlannerView; label: string; icon: typeof LayoutList }[] = [
  { id: 'list', label: 'List', icon: LayoutList },
  { id: 'board', label: 'Board', icon: Columns3 },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'timeline', label: 'Timeline', icon: ChartGantt },
  { id: 'gantt', label: 'Gantt', icon: ChartGantt },
];
const writable = (role: string) => ['admin', 'editor'].includes(role);
function changed<T extends object>(before: T | undefined, after: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => !before || JSON.stringify(value) !== JSON.stringify(before[key as keyof T]),
    ),
  ) as Partial<T>;
}
function Label({ children, name }: { children: React.ReactNode; name: string }) {
  return (
    <label className="planner-field">
      <span>{name}</span>
      {children}
    </label>
  );
}
function ErrorText({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="planner-error">
      {plannerError(error)}
    </p>
  ) : null;
}
function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="planner-empty">
      <FolderKanban size={38} />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function PlannerPage() {
  const queryClient = useQueryClient();
  const plannerCacheKey = usePlannerKey();
  const [params, setParams] = useSearchParams();
  const bootstrap = usePlannerBootstrap();
  const mutations = usePlannerMutations();
  const resources = usePlannerResources();
  const personalResource = resources.data?.find((r) => r.kind === 'my_tasks' && !r.archived);
  const personalData =
    (personalResource?.data as unknown as PlannerMyTasksData) ?? PLANNER_DEFAULT_MY_TASKS;
  const scope = params.get('scope') ?? 'mine';
  const projectId = params.get('project') ?? undefined;
  const project = bootstrap.data?.projects.find((p) => p.id === projectId);
  const archived = params.get('archived') === 'true';
  const query = usePlannerTasks(
    {
      ...(projectId ? { projectId } : scope === 'mine' ? { mine: 'true' } : {}),
      ...(archived ? { archived: 'true' } : {}),
    },
    Boolean(bootstrap.data) && !['inbox', 'reporting', 'timesheets'].includes(scope),
  );
  useEffect(() => {
    if (
      !['inbox', 'reporting', 'timesheets'].includes(scope) &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isError
    )
      void query.fetchNextPage();
  }, [scope, query.hasNextPage, query.isFetchingNextPage, query.isError, query.fetchNextPage]);
  const tasks = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('open');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('position');
  const [groupBy, setGroupBy] = useState<NonNullable<PlannerSavedViewData['groupBy']>>('section');
  const [projectEditor, setProjectEditor] = useState<PlannerProject | 'new' | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [importing, setImporting] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [personalEditor, setPersonalEditor] = useState<{
    data: PlannerMyTasksData;
    id?: string;
    version?: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState('done');
  const [bulkAssignee, setBulkAssignee] = useState('keep');
  const [bulkPriority, setBulkPriority] = useState('keep');
  const [bulkSection, setBulkSection] = useState('keep');
  const [bulkArchive, setBulkArchive] = useState(false);
  const [duplicatingProject, setDuplicatingProject] = useState(false);
  const [duplicateName, setDuplicateName] = useState('');
  const view = (params.get('view') ?? project?.defaultView ?? 'list') as PlannerView;
  const updateParams = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value === null ? next.delete(key) : next.set(key, value);
    setParams(next);
  };
  const go = (scope: string, projectId?: string) => {
    setParams({ scope, ...(projectId ? { project: projectId } : {}) });
    setSelected([]);
  };
  const openTask = (id: string) => updateParams({ task: id, goal: null });
  const savePersonal = async (
    data: PlannerMyTasksData,
    baseline: { id?: string; version?: number } = {
      id: personalResource?.id,
      version: personalResource?.version,
    },
  ) => {
    await mutations.resource.mutateAsync({
      ...baseline,
      kind: 'my_tasks',
      name: 'My tasks settings',
      data: { ...data },
    });
  };
  const movePersonal = async (task: PlannerTask, sectionId: string | null) => {
    setError(null);
    try {
      await savePersonal({
        ...personalData,
        placements: [
          ...personalData.placements.filter((p) => p.taskId !== task.id),
          {
            taskId: task.id,
            sectionId,
            position: Math.max(-1, ...personalData.placements.map((p) => p.position)) + 1,
          },
        ],
      });
    } catch (error) {
      setError(error);
    }
  };
  const reorderPersonal = async (id: string, targetId: string) => {
    const ordered = [...tasks].sort(
      (a, b) =>
        (personalData.placements.find((p) => p.taskId === a.id)?.position ?? 1000000) -
          (personalData.placements.find((p) => p.taskId === b.id)?.position ?? 1000000) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const moving = ordered.find((t) => t.id === id);
    if (!moving) return;
    const next = ordered.filter((t) => t.id !== id);
    next.splice(
      next.findIndex((t) => t.id === targetId),
      0,
      moving,
    );
    const positions = new Map(next.map((t, index) => [t.id, index]));
    const existing = new Map(personalData.placements.map((p) => [p.taskId, p]));
    for (const task of next)
      existing.set(task.id, {
        taskId: task.id,
        sectionId: existing.get(task.id)?.sectionId ?? null,
        position: positions.get(task.id)!,
      });
    setError(null);
    try {
      await savePersonal({ ...personalData, placements: [...existing.values()] });
    } catch (error) {
      setError(error);
    }
  };
  const reorder = async (id: string, targetId: string) => {
    if (!project) return;
    const ordered = [...tasks].sort(
      (a, b) =>
        (a.memberships.find((m) => m.projectId === project.id)?.position ?? 0) -
          (b.memberships.find((m) => m.projectId === project.id)?.position ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const moving = ordered.find((t) => t.id === id);
    if (!moving) return;
    const next = ordered.filter((t) => t.id !== id);
    next.splice(
      next.findIndex((t) => t.id === targetId),
      0,
      moving,
    );
    try {
      await mutations.reorder.mutateAsync({
        projectId: project.id,
        tasks: next.map((t) => ({ id: t.id, version: t.version })),
      });
    } catch (error) {
      setError(error);
    }
  };
  const visible = tasks
    .filter(
      (task) =>
        (!search ||
          `${task.name} ${task.description} ${task.tags.join(' ')}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (status === 'all' || status === 'open'
          ? status === 'all' || task.status !== 'done'
          : task.status === status) &&
        (!assignee || task.assigneeId === assignee) &&
        (!priority || task.priority === priority),
    )
    .sort((a, b) => {
      if (sort === 'due')
        return (
          plannerDueTimestamp(a) - plannerDueTimestamp(b) || a.createdAt.localeCompare(b.createdAt)
        );
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'priority')
        return (
          ['high', 'medium', 'low', 'none'].indexOf(a.priority) -
          ['high', 'medium', 'low', 'none'].indexOf(b.priority)
        );
      if (scope === 'mine' && !projectId)
        return (
          (personalData.placements.find((p) => p.taskId === a.id)?.position ?? 1000000) -
            (personalData.placements.find((p) => p.taskId === b.id)?.position ?? 1000000) ||
          a.createdAt.localeCompare(b.createdAt)
        );
      return (
        (a.memberships.find((m) => m.projectId === projectId)?.position ?? 0) -
          (b.memberships.find((m) => m.projectId === projectId)?.position ?? 0) ||
        a.createdAt.localeCompare(b.createdAt)
      );
    });
  const patchTask = async (task: PlannerTask, data: Partial<PlannerTaskData>) => {
    setError(null);
    try {
      await mutations.task.mutateAsync({ id: task.id, version: task.version, data });
    } catch (error) {
      setError(error);
    }
  };
  const exportTasks = () => {
    const quote = plannerCsvCell;
    const rows = [
      [
        'Task',
        'Description',
        'Assignee',
        'Start date',
        'Due date',
        'Start time',
        'Due time',
        'Time zone',
        'Priority',
        'Status',
      ],
      ...visible.map((t) => [
        t.name,
        t.description,
        bootstrap.data?.people.find((p) => p.id === t.assigneeId)?.name,
        t.startOn,
        t.dueOn,
        t.startTime,
        t.dueTime,
        t.timeZone,
        t.priority,
        t.status,
      ]),
    ];
    const blob = new Blob(['\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'planner-tasks.csv';
    link.click();
    URL.revokeObjectURL(url);
  };
  if (bootstrap.isPending)
    return (
      <div className="planner-loading" role="status">
        Loading Planner…
      </div>
    );
  if (bootstrap.isError || !bootstrap.data)
    return (
      <div className="planner-root">
        <ErrorText error={bootstrap.error} />
        <button onClick={() => void bootstrap.refetch()}>Retry Planner</button>
      </div>
    );
  const data = bootstrap.data;
  const managementKind = (
    {
      portfolios: 'portfolio',
      goals: 'goal',
      templates: 'template',
      rules: 'rule',
      forms: 'form',
    } as const
  )[scope as 'portfolios'];
  const title =
    project?.name ??
    {
      mine: 'My tasks',
      projects: 'Projects',
      inbox: 'Inbox',
      workload: 'Workload',
      reporting: 'Reporting',
      timesheets: 'Timesheets',
      portfolios: 'Portfolios',
      goals: 'Goals',
      templates: 'Templates',
      rules: 'Rules',
      forms: 'Forms',
    }[scope] ??
    'My tasks';
  const viewProps = {
    tasks: visible,
    people: data.people,
    project,
    onOpen: openTask,
    onPatch: patchTask,
    disabled:
      mutations.task.isPending ||
      (scope === 'mine' &&
        !projectId &&
        (resources.isPending || resources.isError || mutations.resource.isPending)),
    ...(scope === 'mine' && !projectId
      ? { personal: { ...personalData, onMove: movePersonal } }
      : {}),
  };
  return (
    <main className="planner-root" data-vnext-module="planner">
      <header className="planner-header">
        <div>
          <p className="planner-eyebrow">PLANNER</p>
          <h1>Make room for what matters.</h1>
          <p>Plan your work, keep your team aligned, and move projects forward.</p>
        </div>
        <button
          className="planner-primary"
          onClick={() => {
            mutations.project.reset();
            setProjectEditor('new');
          }}
        >
          <Plus size={17} /> New project
        </button>
      </header>
      <div className="planner-layout">
        <nav className="planner-nav" aria-label="Planner navigation">
          {[
            { id: 'mine', label: 'My tasks', icon: CheckCircle2 },
            { id: 'projects', label: 'Projects', icon: FolderKanban },
            { id: 'inbox', label: 'Inbox', icon: Inbox },
            { id: 'portfolios', label: 'Portfolios', icon: FolderKanban },
            { id: 'goals', label: 'Goals', icon: CheckCircle2 },
            { id: 'workload', label: 'Workload', icon: Users },
            { id: 'reporting', label: 'Reporting', icon: ChartGantt },
            { id: 'timesheets', label: 'Timesheets', icon: Clock3 },
            { id: 'templates', label: 'Templates', icon: LayoutList },
            { id: 'rules', label: 'Rules', icon: Settings2 },
            { id: 'forms', label: 'Forms', icon: LayoutList },
          ].map((item) => (
            <button
              key={item.id}
              aria-current={!projectId && scope === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              <item.icon size={18} />
              {item.label}
            </button>
          ))}
          <div className="planner-nav-projects">
            <span>PROJECTS</span>
            <button aria-label="Create a project" onClick={() => setProjectEditor('new')}>
              <Plus size={16} />
            </button>
          </div>
          {resources.data?.some((r) => r.kind === 'saved_view' && !r.archived) && (
            <span className="planner-eyebrow">SAVED VIEWS</span>
          )}
          {resources.data
            ?.filter((r) => r.kind === 'saved_view' && !r.archived)
            .map((r) => (
              <div className="planner-saved-nav" key={r.id}>
                <button
                  onClick={() => {
                    const saved = r.data as unknown as PlannerSavedViewData;
                    setParams({
                      scope: saved.scope,
                      ...(saved.projectId ? { project: saved.projectId } : {}),
                      view: saved.view,
                    });
                    setSearch(saved.search);
                    setStatus(saved.status);
                    setAssignee(saved.assigneeId);
                    setPriority(saved.priority);
                    setSort(saved.sort);
                    setGroupBy(saved.groupBy ?? 'section');
                  }}
                >
                  {r.name}
                </button>
                <button
                  aria-label={`Remove saved view ${r.name}`}
                  disabled={mutations.resource.isPending}
                  onClick={() =>
                    mutations.resource.mutate({ id: r.id, version: r.version, archived: true })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          {data.projects
            .filter((p) => p.archived === archived)
            .map((p) => (
              <button
                key={p.id}
                aria-current={projectId === p.id ? 'page' : undefined}
                onClick={() => go('project', p.id)}
              >
                <i style={{ background: p.color }} />
                {p.name}
              </button>
            ))}
          <button
            className="planner-nav-archive"
            onClick={() =>
              updateParams({ archived: archived ? null : 'true', project: null, scope: 'projects' })
            }
          >
            <Archive size={17} />
            {archived ? 'Active projects' : 'Archived work'}
          </button>
        </nav>
        <div className="planner-content">
          <div className="planner-content-head">
            <div>
              <h2>
                {title}
                {project && (
                  <span className="planner-project-health">
                    {project.health.replaceAll('_', ' ')}
                  </span>
                )}
              </h2>
              {project && (
                <p>
                  {project.description ||
                    `${project.privacy === 'private' ? 'Private' : 'Shared with your team'} project`}
                </p>
              )}
              {project && (
                <button
                  disabled={query.isFetchingNextPage}
                  onClick={() => {
                    setDuplicateName(`${project.name} (copy)`);
                    setDuplicatingProject(true);
                    mutations.duplicateProject.reset();
                  }}
                >
                  Duplicate project
                </button>
              )}
            </div>
            <div className="planner-head-actions">
              <button
                aria-label="Refresh Planner"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: plannerCacheKey });
                }}
              >
                <RefreshCw size={17} />
              </button>
              {project && (
                <button
                  onClick={() =>
                    updateParams({
                      scope: scope === 'reporting' ? 'project' : 'reporting',
                      report: null,
                    })
                  }
                >
                  <BarChart3 size={16} />{' '}
                  {scope === 'reporting' ? 'Project tasks' : 'Project dashboard'}
                </button>
              )}
              {project && (
                <button onClick={() => setProjectEditor(project)}>
                  <Settings2 size={16} /> Project settings
                </button>
              )}
              {scope !== 'inbox' &&
                !managementKind &&
                scope !== 'projects' &&
                scope !== 'workload' &&
                scope !== 'reporting' &&
                scope !== 'timesheets' &&
                (!project || writable(project.access)) &&
                !archived && (
                  <button
                    className="planner-primary"
                    onClick={() => {
                      mutations.task.reset();
                      setNewTask(true);
                    }}
                  >
                    <Plus size={16} /> Add task
                  </button>
                )}
            </div>
          </div>
          <ErrorText error={error || mutations.resource.error} />
          {projectId && !project ? (
            <Empty title="Project unavailable">
              This project is unavailable or your access has changed.
            </Empty>
          ) : scope === 'projects' ? (
            <div className="planner-project-grid">
              {data.projects
                .filter((p) => p.archived === archived)
                .map((p) => (
                  <button
                    className="planner-project-card"
                    key={p.id}
                    onClick={() => go('project', p.id)}
                  >
                    <span className="planner-project-symbol" style={{ background: p.color }}>
                      <FolderKanban size={22} />
                    </span>
                    <h3>{p.name}</h3>
                    <p>{p.description || 'A clear home for your team’s work.'}</p>
                    <span>
                      {p.health.replaceAll('_', ' ')} ·{' '}
                      {p.privacy === 'private' ? 'Private' : 'Team'}
                    </span>
                  </button>
                ))}
              {!data.projects.some((p) => p.archived === archived) && (
                <Empty title={archived ? 'No archived projects' : 'Start your first project'}>
                  Create a project, add your sections, and invite your team.
                </Empty>
              )}
            </div>
          ) : scope === 'inbox' ? (
            <PlannerInbox
              onOpen={openTask}
              onGoal={(id) => updateParams({ scope: 'goals', goal: id, task: null, project: null })}
              onProject={(id) => go('project', id)}
              onTimesheet={(week, userId) => setParams({ scope: 'timesheets', week, user: userId })}
            />
          ) : scope === 'workload' ? (
            <PlannerWorkload tasks={tasks} data={data} />
          ) : scope === 'reporting' ? (
            <PlannerReporting
              bootstrap={data}
              selectedId={params.get('report')}
              onSelect={(id) => updateParams({ report: id })}
              projectId={project?.id}
            />
          ) : scope === 'timesheets' ? (
            <PlannerTimesheets
              bootstrap={data}
              week={params.get('week')}
              userId={params.get('user')}
              onSelect={(week, userId) =>
                setParams({ scope: 'timesheets', week, ...(userId ? { user: userId } : {}) })
              }
            />
          ) : managementKind ? (
            <PlannerManagement
              kind={managementKind}
              bootstrap={data}
              tasks={tasks}
              onProject={(id) => go('project', id)}
              onTask={openTask}
              selectedGoalId={params.get('goal')}
              onGoal={(id) => updateParams({ goal: id })}
              selectedPortfolioId={params.get('portfolio')}
              onPortfolio={(id) => updateParams({ portfolio: id })}
            />
          ) : (
            <>
              <div className="planner-tabs" role="tablist" aria-label="Project view">
                {VIEWS.map((item) => (
                  <button
                    role="tab"
                    aria-selected={view === item.id}
                    key={item.id}
                    onClick={() => updateParams({ view: item.id })}
                  >
                    <item.icon size={16} />
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="planner-toolbar">
                {project && (
                  <PlannerTimeExportButton
                    key={project.id}
                    target={{ scope: 'project', projectId: project.id }}
                    week={plannerWeekOn(plannerTimeToday(data.timeOptions?.timeZone ?? 'UTC'))}
                    label={`Time allocated to ${project.name}`}
                  />
                )}
                <label className="planner-search">
                  <Search size={16} />
                  <input
                    aria-label="Search tasks"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search tasks…"
                  />
                </label>
                <select
                  aria-label="Filter task status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="open">Open tasks</option>
                  <option value="all">All tasks</option>
                  {Object.entries(PLANNER_STATUS_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter assignee"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">All assignees</option>
                  {data.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="">All priorities</option>
                  {['high', 'medium', 'low', 'none'].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <select
                  aria-label="Sort tasks"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="position">
                    {scope === 'mine' && !projectId ? 'My task order' : 'Project order'}
                  </option>
                  <option value="due">Due date</option>
                  <option value="name">Name</option>
                  <option value="priority">Priority</option>
                </select>
                <button onClick={exportTasks} aria-label="Export visible tasks">
                  <Download size={16} />
                </button>
                {view === 'list' && (
                  <select
                    aria-label="Group tasks"
                    value={groupBy}
                    onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
                  >
                    <option value="section">Sections</option>
                    <option value="status">Status</option>
                    <option value="priority">Priority</option>
                    <option value="assignee">Assignee</option>
                    <option value="none">No grouping</option>
                  </select>
                )}
                {(!project || writable(project.access)) && !archived && (
                  <button onClick={() => setImporting(true)}>Import CSV</button>
                )}
                {!archived && <button onClick={() => setSavingView(true)}>Save view</button>}
                {scope === 'mine' && !projectId && (
                  <button
                    disabled={
                      resources.isPending || resources.isError || mutations.resource.isPending
                    }
                    onClick={() => {
                      mutations.resource.reset();
                      setPersonalEditor({
                        data: structuredClone(personalData),
                        id: personalResource?.id,
                        version: personalResource?.version,
                      });
                    }}
                  >
                    My tasks settings
                  </button>
                )}
              </div>
              {query.isPending ? (
                <p role="status">Loading tasks…</p>
              ) : query.isError ? (
                <>
                  <ErrorText error={query.error} />
                  <button onClick={() => void query.refetch()}>Retry tasks</button>
                </>
              ) : !visible.length ? (
                <Empty title="A little space to plan">
                  {scope === 'mine'
                    ? 'Your assigned tasks will appear here. Add a task or join a project to get started.'
                    : 'Add a task or adjust your filters to see work here.'}
                </Empty>
              ) : view === 'board' ? (
                <PlannerBoard {...viewProps} />
              ) : view === 'calendar' ? (
                <PlannerCalendar {...viewProps} />
              ) : view === 'timeline' || view === 'gantt' ? (
                <PlannerTimeline {...viewProps} gantt={view === 'gantt'} />
              ) : (
                <PlannerList
                  {...viewProps}
                  groupBy={groupBy}
                  onReorder={
                    scope === 'mine' &&
                    !projectId &&
                    sort === 'position' &&
                    !query.hasNextPage &&
                    !archived &&
                    !resources.isPending &&
                    !resources.isError
                      ? reorderPersonal
                      : project &&
                          writable(project.access) &&
                          sort === 'position' &&
                          !query.hasNextPage &&
                          !archived &&
                          tasks.length <= 1000
                        ? reorder
                        : undefined
                  }
                  disabled={viewProps.disabled || mutations.reorder.isPending}
                />
              )}
              {personalEditor && (
                <PlannerMyTasksSettings
                  data={personalEditor.data}
                  onSave={(data) =>
                    savePersonal(data, { id: personalEditor.id, version: personalEditor.version })
                  }
                  onClose={() => setPersonalEditor(null)}
                  pending={mutations.resource.isPending}
                  error={mutations.resource.error ? plannerError(mutations.resource.error) : null}
                />
              )}
              {query.isFetchingNextPage && (
                <p role="status" className="planner-muted">
                  Loading remaining tasks…
                </p>
              )}
              {visible.length > 0 && (
                <details className="planner-bulk">
                  <summary>Bulk actions</summary>
                  <div>
                    <label>
                      <input
                        type="checkbox"
                        checked={
                          selected.length === visible.filter((t) => writable(t.access)).length &&
                          selected.length > 0
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? visible.filter((t) => writable(t.access)).map((t) => t.id)
                              : [],
                          )
                        }
                      />{' '}
                      Select editable tasks
                    </label>
                    <select
                      aria-label="Select tasks for bulk action"
                      multiple
                      value={selected}
                      onChange={(e) =>
                        setSelected(Array.from(e.target.selectedOptions, (o) => o.value))
                      }
                    >
                      {visible
                        .filter((t) => writable(t.access))
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                    <label className="planner-field">
                      <span>Status</span>
                      <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
                        <option value="keep">Keep status</option>
                        {Object.entries(PLANNER_STATUS_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="planner-field">
                      <span>Assignee</span>
                      <select
                        value={bulkAssignee}
                        onChange={(e) => setBulkAssignee(e.target.value)}
                      >
                        <option value="keep">Keep assignee</option>
                        <option value="">Unassigned</option>
                        {data.people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="planner-field">
                      <span>Priority</span>
                      <select
                        value={bulkPriority}
                        onChange={(e) => setBulkPriority(e.target.value)}
                      >
                        <option value="keep">Keep priority</option>
                        {['none', 'low', 'medium', 'high'].map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </label>
                    {project && writable(project.access) && (
                      <label className="planner-field">
                        <span>Section</span>
                        <select
                          value={bulkSection}
                          onChange={(e) => setBulkSection(e.target.value)}
                        >
                          <option value="keep">Keep section</option>
                          <option value="">Unsectioned</option>
                          {project.sections.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={bulkArchive}
                        onChange={(e) => setBulkArchive(e.target.checked)}
                      />{' '}
                      {archived ? 'Restore selected tasks' : 'Archive selected tasks'}
                    </label>
                    <button
                      disabled={!selected.length || mutations.task.isPending}
                      onClick={async () => {
                        setError(null);
                        for (const task of tasks.filter((t) => selected.includes(t.id))) {
                          try {
                            await mutations.task.mutateAsync({
                              id: task.id,
                              version: task.version,
                              data: {
                                ...(bulkStatus === 'keep'
                                  ? {}
                                  : { status: bulkStatus as PlannerTaskData['status'] }),
                                ...(bulkAssignee === 'keep'
                                  ? {}
                                  : { assigneeId: bulkAssignee || null }),
                                ...(bulkPriority === 'keep'
                                  ? {}
                                  : { priority: bulkPriority as PlannerTaskData['priority'] }),
                                ...(project && bulkSection !== 'keep'
                                  ? {
                                      memberships: task.memberships.map((m) =>
                                        m.projectId === project.id
                                          ? { ...m, sectionId: bulkSection || null }
                                          : m,
                                      ),
                                    }
                                  : {}),
                              },
                              ...(bulkArchive ? { archived: !archived } : {}),
                            });
                            setSelected((old) => old.filter((id) => id !== task.id));
                          } catch (error) {
                            setError(error);
                            break;
                          }
                        }
                      }}
                    >
                      Apply to {selected.length} selected
                    </button>
                  </div>
                </details>
              )}
            </>
          )}
          {project?.clientId && (
            <Link className="planner-related-link" to={`/clients?clientId=${project.clientId}`}>
              Open linked client →
            </Link>
          )}
          {project && (
            <PlannerProjectActivity
              projectId={project.id}
              bootstrap={data}
              canEdit={writable(project.access)}
              access={project.access}
            />
          )}
        </div>
      </div>
      {duplicatingProject && project && (
        <ModalOverlay
          isOpen
          isDismissable
          onOpenChange={(open) => !open && setDuplicatingProject(false)}
          className="planner-modal-overlay"
        >
          <Modal className="planner-modal">
            <Dialog aria-label="Duplicate project">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const copy = await mutations.duplicateProject.mutateAsync({
                      id: project.id,
                      name: duplicateName,
                    });
                    setDuplicatingProject(false);
                    go('project', copy.id);
                  } catch {}
                }}
              >
                <div className="planner-dialog-head">
                  <Heading slot="title">Duplicate project</Heading>
                  <button
                    type="button"
                    aria-label="Close duplicate project"
                    onClick={() => setDuplicatingProject(false)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="planner-dialog-body">
                  <Label name="Project name">
                    <input
                      required
                      maxLength={500}
                      value={duplicateName}
                      onChange={(e) => setDuplicateName(e.target.value)}
                    />
                  </Label>
                  <p>
                    The copy starts as a private project with fresh tasks, sections and fields.
                    Tasks keep dates, assignments and relationships within the copied project.
                  </p>
                  <ErrorText error={mutations.duplicateProject.error} />
                </div>
                <footer className="planner-dialog-footer">
                  <button type="button" onClick={() => setDuplicatingProject(false)}>
                    Cancel
                  </button>
                  <button
                    className="planner-primary"
                    disabled={mutations.duplicateProject.isPending}
                  >
                    {mutations.duplicateProject.isPending ? 'Copying…' : 'Create copy'}
                  </button>
                </footer>
              </form>
            </Dialog>
          </Modal>
        </ModalOverlay>
      )}
      {projectEditor && (
        <ProjectEditor
          key={projectEditor === 'new' ? 'new' : `${projectEditor.id}:${projectEditor.version}`}
          project={projectEditor === 'new' ? undefined : projectEditor}
          bootstrap={data}
          mutation={mutations.project}
          onClose={() => setProjectEditor(null)}
          onSaved={(p) => {
            setProjectEditor(null);
            go('project', p.id);
          }}
        />
      )}
      {newTask && (
        <TaskEditor
          bootstrap={data}
          project={project}
          tasks={tasks}
          mutation={mutations.task}
          onClose={() => setNewTask(false)}
          onSaved={(task) => {
            setNewTask(false);
            openTask(task.id);
          }}
        />
      )}
      {importing && (
        <PlannerImport bootstrap={data} project={project} onClose={() => setImporting(false)} />
      )}
      {savingView && (
        <SavePlannerView
          data={{
            scope: project ? 'project' : 'mine',
            projectId: project?.id ?? null,
            view,
            search,
            status,
            assigneeId: assignee,
            priority,
            sort: sort as PlannerSavedViewData['sort'],
            groupBy,
          }}
          onClose={() => setSavingView(false)}
        />
      )}
      {params.get('task') && (
        <ExistingTaskDialog
          id={params.get('task')!}
          bootstrap={data}
          tasks={tasks}
          onClose={() => updateParams({ task: null })}
        />
      )}
    </main>
  );
}

function ProjectEditor({
  project,
  bootstrap,
  mutation,
  onClose,
  onSaved,
}: {
  project?: PlannerProject;
  bootstrap: PlannerBootstrap;
  mutation: ReturnType<typeof usePlannerMutations>['project'];
  onClose: () => void;
  onSaved: (p: PlannerProject) => void;
}) {
  const [data, setData] = useState<PlannerProjectData>(() =>
    project
      ? structuredClone(project)
      : {
          ...PLANNER_DEFAULT_PROJECT,
          sections: [
            { id: crypto.randomUUID(), name: 'To do' },
            { id: crypto.randomUUID(), name: 'In progress' },
            { id: crypto.randomUUID(), name: 'Done' },
          ],
        },
  );
  // Keep response metadata out of mutation payloads.
  const clean = (value: PlannerProjectData) =>
    Object.fromEntries(
      Object.keys(PLANNER_DEFAULT_PROJECT).map((key) => [
        key,
        value[key as keyof PlannerProjectData],
      ]),
    ) as unknown as PlannerProjectData;
  const edit = (patch: Partial<PlannerProjectData>) => setData((old) => ({ ...old, ...patch }));
  const canEdit = !project || writable(project.access);
  const admin = !project || project.access === 'admin';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      onSaved(
        await mutation.mutateAsync({
          id: project?.id,
          version: project?.version,
          data: changed(project ? clean(project) : undefined, clean(data)),
        }),
      );
    } catch {}
  };
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label={project ? 'Project settings' : 'New project'}>
          <form onSubmit={submit}>
            <div className="planner-dialog-head">
              <Heading slot="title">{project ? 'Project settings' : 'New project'}</Heading>
              <button type="button" aria-label="Close project settings" onClick={onClose}>
                <X size={19} />
              </button>
            </div>
            <div className="planner-dialog-body">
              <Label name="Project name">
                <input
                  required
                  maxLength={500}
                  disabled={!canEdit}
                  value={data.name}
                  onChange={(e) => edit({ name: e.target.value })}
                />
              </Label>
              <Label name="Description">
                <textarea
                  rows={3}
                  disabled={!canEdit}
                  value={data.description}
                  onChange={(e) => edit({ description: e.target.value })}
                />
              </Label>
              <div className="planner-form-grid">
                <Label name="Privacy">
                  <select
                    disabled={!admin}
                    value={data.privacy}
                    onChange={(e) =>
                      edit({ privacy: e.target.value as PlannerProjectData['privacy'] })
                    }
                  >
                    <option value="private">Private to project members</option>
                    <option value="team">Everyone on your Capiro team</option>
                  </select>
                </Label>
                <Label name="Color">
                  <input
                    type="color"
                    disabled={!canEdit}
                    value={data.color}
                    onChange={(e) => edit({ color: e.target.value })}
                  />
                </Label>
                <Label name="Start date">
                  <input
                    type="date"
                    disabled={!canEdit}
                    value={data.startOn ?? ''}
                    onInput={(e) => edit({ startOn: e.currentTarget.value || null })}
                  />
                </Label>
                <Label name="Due date">
                  <input
                    type="date"
                    disabled={!canEdit}
                    min={data.startOn ?? undefined}
                    value={data.dueOn ?? ''}
                    onInput={(e) => edit({ dueOn: e.currentTarget.value || null })}
                  />
                </Label>
                <Label name="Default view">
                  <select
                    disabled={!canEdit}
                    value={data.defaultView}
                    onChange={(e) => edit({ defaultView: e.target.value as PlannerView })}
                  >
                    {VIEWS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label name="Project health">
                  <select
                    disabled={!canEdit}
                    value={data.health}
                    onChange={(e) =>
                      edit({ health: e.target.value as PlannerProjectData['health'] })
                    }
                  >
                    {['on_track', 'at_risk', 'off_track', 'on_hold', 'complete'].map((h) => (
                      <option key={h} value={h}>
                        {h.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </Label>
              </div>
              <h3>Sections</h3>
              {data.sections.map((s, i) => (
                <div className="planner-config-row" key={s.id}>
                  <input
                    aria-label={`Section ${i + 1} name`}
                    disabled={!canEdit}
                    value={s.name}
                    onChange={(e) =>
                      edit({
                        sections: data.sections.map((old) =>
                          old.id === s.id ? { ...old, name: e.target.value } : old,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    disabled={!canEdit}
                    aria-label={`Remove section ${s.name}`}
                    onClick={() =>
                      edit({ sections: data.sections.filter((old) => old.id !== s.id) })
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={!canEdit}
                onClick={() =>
                  edit({
                    sections: [...data.sections, { id: crypto.randomUUID(), name: 'New section' }],
                  })
                }
              >
                <Plus size={15} /> Add section
              </button>
              <h3>Custom fields</h3>
              {data.fields.map((f, i) => (
                <div className="planner-config-field" key={f.id}>
                  <input
                    aria-label={`Field ${i + 1} name`}
                    disabled={!canEdit}
                    value={f.name}
                    onChange={(e) =>
                      edit({
                        fields: data.fields.map((old) =>
                          old.id === f.id ? { ...old, name: e.target.value } : old,
                        ),
                      })
                    }
                  />
                  <select
                    aria-label={`Field ${i + 1} type`}
                    disabled={!canEdit}
                    value={f.type}
                    onChange={(e) =>
                      edit({
                        fields: data.fields.map((old) =>
                          old.id === f.id ? { ...old, type: e.target.value as typeof f.type } : old,
                        ),
                      })
                    }
                  >
                    {['text', 'number', 'date', 'select', 'multi_select'].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                  <input
                    aria-label={`Field ${i + 1} options`}
                    placeholder="Options separated by commas"
                    disabled={!canEdit || !['select', 'multi_select'].includes(f.type)}
                    defaultValue={f.options.join(', ')}
                    onBlur={(e) =>
                      edit({
                        fields: data.fields.map((old) =>
                          old.id === f.id
                            ? {
                                ...old,
                                options: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              }
                            : old,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    disabled={!canEdit}
                    aria-label={`Remove field ${f.name}`}
                    onClick={() => edit({ fields: data.fields.filter((old) => old.id !== f.id) })}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={!canEdit}
                onClick={() =>
                  edit({
                    fields: [
                      ...data.fields,
                      { id: crypto.randomUUID(), name: 'New field', type: 'text', options: [] },
                    ],
                  })
                }
              >
                <Plus size={15} /> Add field
              </button>
              <h3>Project members</h3>
              {bootstrap.people
                .filter((p) => p.id !== (project?.ownerId ?? bootstrap.me.id))
                .map((person) => (
                  <div className="planner-member-row" key={person.id}>
                    <span>{person.name}</span>
                    <select
                      aria-label={`${person.name} project access`}
                      disabled={!admin}
                      value={data.members.find((m) => m.userId === person.id)?.role ?? ''}
                      onChange={(e) =>
                        edit({
                          members: [
                            ...data.members.filter((m) => m.userId !== person.id),
                            ...(e.target.value
                              ? [{ userId: person.id, role: e.target.value as 'editor' }]
                              : []),
                          ],
                        })
                      }
                    >
                      <option value="">
                        {data.privacy === 'team' ? 'Team default (editor)' : 'No access'}
                      </option>
                      {['admin', 'editor', 'commenter', 'viewer'].map((role) => (
                        <option key={role}>{role}</option>
                      ))}
                    </select>
                  </div>
                ))}
              <CapiroLinkPicker
                clientId={data.clientId}
                onChange={(clientId) => edit({ clientId })}
                disabled={!canEdit}
              />
              <ErrorText error={mutation.error} />
            </div>
            <footer className="planner-dialog-footer">
              {project && admin && (
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={async () => {
                    try {
                      onSaved(
                        await mutation.mutateAsync({
                          id: project.id,
                          version: project.version,
                          archived: !project.archived,
                        }),
                      );
                    } catch {}
                  }}
                >
                  {project.archived ? 'Restore project' : 'Archive project'}
                </button>
              )}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              {canEdit && (
                <button className="planner-primary" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving…' : project ? 'Save project' : 'Create project'}
                </button>
              )}
            </footer>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function CapiroLinkPicker({
  clientId,
  meetingId,
  onChange,
  onMeetingChange,
  disabled,
}: {
  clientId: string | null;
  meetingId?: string | null;
  onChange: (id: string | null) => void;
  onMeetingChange?: (id: string | null) => void;
  disabled: boolean;
}) {
  const api = useApi();
  const key = usePlannerKey();
  const clients = useQuery({
    queryKey: [...key, 'link-clients'],
    queryFn: async () => (await api.get('/api/clients')).data,
    enabled: !disabled,
  });
  const meetings = useQuery({
    queryKey: [...key, 'link-meetings'],
    queryFn: async () => (await api.get('/api/engagement/meetings')).data,
    enabled: !disabled && Boolean(onMeetingChange),
  });
  const rows = (data: unknown): Record<string, string>[] =>
    Array.isArray(data)
      ? data
      : ((data as { items?: Record<string, string>[]; meetings?: Record<string, string>[] })
          ?.items ??
        (data as { meetings?: Record<string, string>[] })?.meetings ??
        []);
  return (
    <div className="planner-form-grid">
      <Label name="Linked client">
        <select
          disabled={disabled || clients.isPending}
          value={clientId ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">No client</option>
          {clientId && !rows(clients.data).some((c) => c.id === clientId) && (
            <option value={clientId}>Linked client</option>
          )}
          {rows(clients.data).map((client) => (
            <option value={client.id} key={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        {clients.isError && <small>Client links could not load.</small>}
      </Label>
      {onMeetingChange && (
        <Label name="Linked meeting">
          <select
            disabled={disabled || meetings.isPending}
            value={meetingId ?? ''}
            onChange={(e) => onMeetingChange(e.target.value || null)}
          >
            <option value="">No meeting</option>
            {meetingId && !rows(meetings.data).some((m) => m.id === meetingId) && (
              <option value={meetingId}>Linked meeting</option>
            )}
            {rows(meetings.data).map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.subject}
              </option>
            ))}
          </select>
          {meetings.isError && <small>Meeting links could not load.</small>}
        </Label>
      )}
    </div>
  );
}

function ExistingTaskDialog({
  id,
  bootstrap,
  tasks,
  onClose,
}: {
  id: string;
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  onClose: () => void;
}) {
  const query = usePlannerTask(id);
  const mutation = usePlannerMutations();
  if (query.isPending || query.isError)
    return (
      <ModalOverlay
        isOpen
        isDismissable
        onOpenChange={(open) => !open && onClose()}
        className="planner-modal-overlay"
      >
        <Modal className="planner-modal">
          <Dialog aria-label="Task">
            <button onClick={onClose}>Close</button>
            {query.isError ? <ErrorText error={query.error} /> : <p role="status">Loading task…</p>}
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  return (
    <TaskEditor
      key={`${query.data.id}:${query.data.version}`}
      bootstrap={bootstrap}
      task={query.data}
      tasks={tasks}
      mutation={mutation.task}
      onClose={onClose}
      onSaved={() => {}}
    />
  );
}

function TaskEditor({
  task,
  project,
  bootstrap,
  tasks,
  mutation,
  onClose,
  onSaved,
}: {
  task?: PlannerTask;
  project?: PlannerProject;
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  mutation: ReturnType<typeof usePlannerMutations>['task'];
  onClose: () => void;
  onSaved: (task: PlannerTask) => void;
}) {
  const clean = (value: PlannerTaskData) =>
    Object.fromEntries(
      Object.keys(PLANNER_DEFAULT_TASK).map((key) => [
        key,
        value[key as keyof PlannerTaskData] === undefined
          ? PLANNER_DEFAULT_TASK[key as keyof PlannerTaskData]
          : value[key as keyof PlannerTaskData],
      ]),
    ) as unknown as PlannerTaskData;
  const [data, setData] = useState<PlannerTaskData>(() =>
    task
      ? clean(task)
      : {
          ...PLANNER_DEFAULT_TASK,
          assigneeId: bootstrap.me.id,
          memberships: project
            ? [
                {
                  projectId: project.id,
                  sectionId: project.sections[0]?.id ?? null,
                  position: tasks.length,
                },
              ]
            : [],
        },
  );
  const [comment, setComment] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [subtask, setSubtask] = useState('');
  const [dependencySearch, setDependencySearch] = useState('');
  const dependencyQuery = usePlannerTasks({ search: dependencySearch });
  const [dialogParams, setDialogParams] = useSearchParams();
  const children = usePlannerTasks({ parentId: task?.id }, Boolean(task));
  useEffect(() => {
    if (children.hasNextPage && !children.isFetchingNextPage && !children.isError)
      void children.fetchNextPage();
  }, [children.hasNextPage, children.isFetchingNextPage, children.isError, children.fetchNextPage]);
  const navigateTask = (id: string) => {
    const next = new URLSearchParams(dialogParams);
    next.set('task', id);
    setDialogParams(next);
  };
  const events = usePlannerEvents(task?.id);
  const actions = usePlannerMutations();
  const canEdit = !task || writable(task.access);
  const edit = (patch: Partial<PlannerTaskData>) => setData((old) => ({ ...old, ...patch }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      onSaved(
        await mutation.mutateAsync({
          id: task?.id,
          version: task?.version,
          data: changed(task ? clean(task) : undefined, data),
        }),
      );
    } catch {}
  };
  const fields = data.memberships.flatMap(
    (m) => bootstrap.projects.find((p) => p.id === m.projectId)?.fields ?? [],
  );
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay planner-drawer-overlay"
    >
      <Modal className="planner-drawer">
        <Dialog aria-label={task ? 'Task details' : 'New task'}>
          <form onSubmit={submit}>
            <div className="planner-dialog-head">
              <Heading slot="title">{task ? 'Task details' : 'New task'}</Heading>
              <button type="button" aria-label="Close task" onClick={onClose}>
                <X size={19} />
              </button>
            </div>
            <div className="planner-dialog-body">
              <Label name="Task name">
                <input
                  required
                  maxLength={500}
                  disabled={!canEdit}
                  value={data.name}
                  onChange={(e) => edit({ name: e.target.value })}
                  placeholder="What needs to happen?"
                />
              </Label>
              <div className="planner-form-grid">
                <Label name="Assignee">
                  <select
                    disabled={!canEdit}
                    value={data.assigneeId ?? ''}
                    onChange={(e) => edit({ assigneeId: e.target.value || null })}
                  >
                    <option value="">Unassigned</option>
                    {bootstrap.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label name="Status">
                  <select
                    disabled={!canEdit}
                    value={data.status}
                    onChange={(e) => edit({ status: e.target.value as PlannerStatus })}
                  >
                    {Object.entries(PLANNER_STATUS_LABELS).map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label name="Priority">
                  <select
                    disabled={!canEdit}
                    value={data.priority}
                    onChange={(e) =>
                      edit({ priority: e.target.value as PlannerTaskData['priority'] })
                    }
                  >
                    {['none', 'low', 'medium', 'high'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Label>
                <Label name="Task type">
                  <select
                    disabled={!canEdit}
                    value={data.subtype}
                    onChange={(e) =>
                      edit({ subtype: e.target.value as PlannerTaskData['subtype'] })
                    }
                  >
                    <option value="task">Task</option>
                    <option value="milestone">Milestone</option>
                    <option value="approval">Approval</option>
                  </select>
                </Label>
              </div>
              <PlannerTaskSchedule data={data} disabled={!canEdit} onChange={edit} />
              {data.subtype === 'approval' && (
                <Label name="Approval">
                  <select
                    disabled={!canEdit}
                    value={data.approval}
                    onChange={(e) =>
                      edit({ approval: e.target.value as PlannerTaskData['approval'] })
                    }
                  >
                    {['pending', 'approved', 'rejected', 'changes_requested'].map((s) => (
                      <option key={s} value={s}>
                        {s.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </Label>
              )}
              <Label name="Description">
                <PlannerRichText
                  label="Task description"
                  disabled={!canEdit}
                  value={data.description}
                  onChange={(value) => edit({ description: value })}
                />
              </Label>
              <h3>Projects & sections</h3>
              {bootstrap.projects
                .filter((p) => !p.archived || data.memberships.some((m) => m.projectId === p.id))
                .map((p) => (
                  <div className="planner-member-row" key={p.id}>
                    <label>
                      <input
                        disabled={!canEdit || !writable(p.access)}
                        type="checkbox"
                        checked={data.memberships.some((m) => m.projectId === p.id)}
                        onChange={(e) =>
                          edit({
                            memberships: e.target.checked
                              ? [
                                  ...data.memberships,
                                  { projectId: p.id, sectionId: null, position: tasks.length },
                                ]
                              : data.memberships.filter((m) => m.projectId !== p.id),
                          })
                        }
                      />{' '}
                      {p.name}
                    </label>
                    {data.memberships.some((m) => m.projectId === p.id) && (
                      <select
                        aria-label={`${p.name} section`}
                        disabled={!canEdit || !writable(p.access)}
                        value={data.memberships.find((m) => m.projectId === p.id)?.sectionId ?? ''}
                        onChange={(e) =>
                          edit({
                            memberships: data.memberships.map((m) =>
                              m.projectId === p.id
                                ? { ...m, sectionId: e.target.value || null }
                                : m,
                            ),
                          })
                        }
                      >
                        <option value="">Unsectioned</option>
                        {p.sections.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              {fields.map((field) => (
                <Label key={field.id} name={field.name}>
                  {field.type === 'select' || field.type === 'multi_select' ? (
                    <select
                      disabled={!canEdit}
                      multiple={field.type === 'multi_select'}
                      value={
                        field.type === 'multi_select'
                          ? ((data.customValues[field.id] as string[]) ?? [])
                          : String(data.customValues[field.id] ?? '')
                      }
                      onChange={(e) =>
                        edit({
                          customValues: {
                            ...data.customValues,
                            [field.id]:
                              field.type === 'multi_select'
                                ? Array.from(e.target.selectedOptions, (o) => o.value)
                                : e.target.value || null,
                          },
                        })
                      }
                    >
                      {field.type === 'select' && <option value="">Not set</option>}
                      {field.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      disabled={!canEdit}
                      type={
                        field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
                      }
                      value={String(data.customValues[field.id] ?? '')}
                      onInput={(e) =>
                        edit({
                          customValues: {
                            ...data.customValues,
                            [field.id]: e.currentTarget.value
                              ? field.type === 'number'
                                ? Number(e.currentTarget.value)
                                : e.currentTarget.value
                              : null,
                          },
                        })
                      }
                    />
                  )}
                </Label>
              ))}
              <Label name="Dependencies">
                <input
                  aria-label="Search dependencies across Planner"
                  value={dependencySearch}
                  onChange={(e) => setDependencySearch(e.target.value)}
                  placeholder="Find a task in any project…"
                />
                <select
                  disabled={!canEdit}
                  multiple
                  value={data.dependencies}
                  aria-label="Dependencies"
                  onChange={(e) =>
                    edit({ dependencies: Array.from(e.target.selectedOptions, (o) => o.value) })
                  }
                >
                  {Array.from(
                    new Map(
                      [
                        ...tasks,
                        ...(dependencyQuery.data?.pages.flatMap((p) => p.items) ?? []),
                      ].map((t) => [t.id, t]),
                    ).values(),
                  )
                    .filter(
                      (t) =>
                        t.id !== task?.id &&
                        (!dependencySearch ||
                          data.dependencies.includes(t.id) ||
                          t.name.toLowerCase().includes(dependencySearch.toLowerCase())),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  {data.dependencies
                    .filter(
                      (id) =>
                        ![
                          ...tasks,
                          ...(dependencyQuery.data?.pages.flatMap((p) => p.items) ?? []),
                        ].some((t) => t.id === id),
                    )
                    .map((id) => (
                      <option key={id} value={id}>
                        Linked dependency {id}
                      </option>
                    ))}
                </select>
                <small>Hold Ctrl or Command to select several tasks.</small>
              </Label>
              <ErrorText error={dependencyQuery.error} />
              {dependencyQuery.hasNextPage && (
                <button
                  type="button"
                  disabled={dependencyQuery.isFetchingNextPage}
                  onClick={() => void dependencyQuery.fetchNextPage()}
                >
                  Load more dependencies
                </button>
              )}
              <Label name="Collaborators">
                <select
                  disabled={!canEdit}
                  multiple
                  value={data.collaborators}
                  onChange={(e) =>
                    edit({ collaborators: Array.from(e.target.selectedOptions, (o) => o.value) })
                  }
                >
                  {bootstrap.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Label>
              <Label name="Tags">
                <input
                  disabled={!canEdit}
                  defaultValue={data.tags.join(', ')}
                  onBlur={(e) =>
                    edit({
                      tags: e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="Separate tags with commas"
                />
              </Label>
              {bootstrap.timeOptions?.timeTrackingEnabled !== false && (
                <div className="planner-form-grid">
                  <Label name="Estimated minutes">
                    <input
                      type="number"
                      min={0}
                      disabled={!canEdit}
                      value={data.estimateMinutes}
                      onChange={(e) => edit({ estimateMinutes: Number(e.target.value) })}
                    />
                  </Label>
                </div>
              )}
              <CapiroLinkPicker
                clientId={data.clientId}
                meetingId={data.meetingId}
                disabled={!canEdit}
                onChange={(clientId) => edit({ clientId })}
                onMeetingChange={(meetingId) => edit({ meetingId })}
              />
              {task && (
                <>
                  <div className="planner-related-links">
                    {task.clientId && (
                      <Link to={`/clients?clientId=${task.clientId}`}>Open client →</Link>
                    )}
                    {task.meetingId && (
                      <Link to={`/engagement/meetings/${task.meetingId}`}>Open meeting →</Link>
                    )}
                  </div>
                  <PlannerAttachments task={task} />
                  <h3>Subtasks</h3>
                  <ErrorText error={children.error} />
                  {(children.data?.pages.flatMap((p) => p.items) ?? tasks)
                    .filter((t) => t.parentId === task.id)
                    .map((t) => (
                      <div key={t.id} className="planner-subtask">
                        <CheckCircle2 size={16} />
                        <button type="button" onClick={() => navigateTask(t.id)}>
                          {t.name}
                        </button>
                        <span>{PLANNER_STATUS_LABELS[t.status]}</span>
                      </div>
                    ))}
                  {canEdit && (
                    <div className="planner-config-row">
                      <input
                        aria-label="New subtask name"
                        value={subtask}
                        onChange={(e) => setSubtask(e.target.value)}
                        placeholder="Add a subtask…"
                      />
                      <button
                        type="button"
                        disabled={!subtask.trim() || actions.task.isPending}
                        aria-label="Add subtask"
                        onClick={async () => {
                          try {
                            await actions.task.mutateAsync({
                              data: {
                                ...PLANNER_DEFAULT_TASK,
                                name: subtask,
                                parentId: task.id,
                                assigneeId: task.assigneeId,
                              },
                            });
                            setSubtask('');
                          } catch {}
                        }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  )}
                  {bootstrap.timeOptions?.timeTrackingEnabled !== false && (
                    <h3>
                      Time tracking{' '}
                      <span className="planner-muted">{task.actualMinutes} minutes logged</span>
                    </h3>
                  )}
                  {canEdit && bootstrap.timeOptions?.timeTrackingEnabled !== false && (
                    <PlannerTimeForm
                      projects={bootstrap.projects}
                      task={task}
                      options={bootstrap.timeOptions}
                      canManage={bootstrap.timeAdmin}
                      onSave={(input) =>
                        actions.event.mutateAsync({ taskId: task.id, kind: 'time', ...input })
                      }
                    />
                  )}
                  <h3>Activity & comments</h3>
                  {task.access !== 'viewer' && (
                    <>
                      <PlannerRichText
                        label="New comment"
                        rows={3}
                        maxLength={20000}
                        value={comment}
                        onChange={setComment}
                      />
                      <Label name="Mention people">
                        <select
                          multiple
                          value={mentions}
                          onChange={(e) =>
                            setMentions(Array.from(e.target.selectedOptions, (o) => o.value))
                          }
                        >
                          {bootstrap.people
                            .filter((p) => p.id !== bootstrap.me.id)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </Label>
                      <p className="planner-muted">
                        Mentions notify people who already have access to this task.
                      </p>
                      <button
                        type="button"
                        disabled={!comment.trim() || actions.event.isPending}
                        onClick={async () => {
                          try {
                            await actions.event.mutateAsync({
                              taskId: task.id,
                              kind: 'comment',
                              text:
                                comment +
                                (mentions.length
                                  ? `\n\n${mentions.map((id) => `@${bootstrap.people.find((p) => p.id === id)?.name}`).join(' ')}`
                                  : ''),
                              mentions,
                            });
                            setComment('');
                            setMentions([]);
                          } catch {}
                        }}
                      >
                        Comment
                      </button>
                    </>
                  )}
                  <ErrorText error={events.error} />
                  {events.data?.pages
                    .flatMap((page) => page.items)
                    .map((event) => (
                      <PlannerActivity
                        key={event.id}
                        event={event}
                        author={
                          bootstrap.people.find((p) => p.id === event.actorId)?.name ??
                          'Team member'
                        }
                        me={bootstrap.me.id}
                        access={task.access}
                        mutation={actions.reviseEvent}
                        timeOptions={bootstrap.timeOptions}
                        timeAdmin={bootstrap.timeAdmin}
                      />
                    ))}
                  {events.hasNextPage && (
                    <button
                      type="button"
                      disabled={events.isFetchingNextPage}
                      onClick={() => events.fetchNextPage()}
                    >
                      {events.isFetchingNextPage
                        ? 'Loading older activity…'
                        : 'Load older activity'}
                    </button>
                  )}
                </>
              )}
              <ErrorText error={mutation.error || actions.task.error || actions.event.error} />
            </div>
            <footer className="planner-dialog-footer">
              {task && canEdit && (
                <button
                  type="button"
                  disabled={actions.task.isPending}
                  onClick={async () => {
                    try {
                      const copied = await actions.task.mutateAsync({
                        data: {
                          ...clean(task),
                          name: `${task.name} (copy)`,
                          status: 'todo',
                          approval: 'pending',
                          parentId: null,
                        },
                      });
                      navigateTask(copied.id);
                    } catch {}
                  }}
                >
                  Duplicate task
                </button>
              )}
              {task && canEdit && (
                <button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={async () => {
                    try {
                      await mutation.mutateAsync({
                        id: task.id,
                        version: task.version,
                        archived: !task.archived,
                      });
                      onClose();
                    } catch {}
                  }}
                >
                  {task.archived ? 'Restore task' : 'Archive task'}
                </button>
              )}
              <button type="button" onClick={onClose}>
                Close
              </button>
              {canEdit && (
                <button className="planner-primary" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving…' : task ? 'Save task' : 'Create task'}
                </button>
              )}
            </footer>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PlannerInbox({
  onOpen,
  onGoal,
  onProject,
  onTimesheet,
}: {
  onOpen: (id: string) => void;
  onGoal: (id: string) => void;
  onProject: (id: string) => void;
  onTimesheet: (week: string, userId: string) => void;
}) {
  const [archive, setArchive] = useState(false);
  const query = usePlannerInbox(archive);
  const actions = usePlannerMutations();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="planner-inbox">
      <div className="planner-tabs">
        <button onClick={() => setArchive(false)} aria-pressed={!archive}>
          Activity
        </button>
        <button onClick={() => setArchive(true)} aria-pressed={archive}>
          Archived
        </button>
      </div>
      <ErrorText error={query.error || actions.inbox.error} />
      {query.isPending ? (
        <p role="status">Loading inbox…</p>
      ) : (
        items.map((item) => (
          <article className={`planner-inbox-item ${item.read ? '' : 'is-unread'}`} key={item.id}>
            <button
              onClick={() => {
                actions.inbox.mutate({ id: item.id, read: true });
                if (item.event.timesheet)
                  onTimesheet(item.event.timesheet.weekOn, item.event.timesheet.userId);
                else if (item.event.resourceId) onGoal(item.event.resourceId);
                else if (item.event.taskId) onOpen(item.event.taskId);
                else if (item.event.projectId) onProject(item.event.projectId);
              }}
            >
              <strong>
                {item.event.removed
                  ? item.event.kind === 'time'
                    ? 'Time entry removed'
                    : 'Comment removed'
                  : item.event.text}
              </strong>
              <time>{new Date(item.event.createdAt).toLocaleString()}</time>
            </button>
            <button
              disabled={actions.inbox.isPending}
              onClick={() => actions.inbox.mutate({ id: item.id, archived: !item.archived })}
            >
              {archive ? 'Restore' : 'Archive'}
            </button>
          </article>
        ))
      )}
      {query.hasNextPage && (
        <button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading older updates…' : 'Load older updates'}
        </button>
      )}
      {!query.isPending && !query.error && !query.hasNextPage && items.length === 0 && (
        <Empty title="You’re all caught up">
          Updates to tasks and goals you follow or own will appear here.
        </Empty>
      )}
    </div>
  );
}
function PlannerWorkload({ tasks, data }: { tasks: PlannerTask[]; data: PlannerBootstrap }) {
  const resources = usePlannerResources();
  const actions = usePlannerMutations();
  const [week, setWeek] = useState(() => plannerToday());
  const end = shiftPlannerDate(week, 6);
  const open = tasks.filter((t) => t.status !== 'done' && !t.archived);
  const scheduled = open.filter((t) => t.dueOn && t.dueOn >= week && (t.startOn ?? t.dueOn) <= end);
  const max = Math.max(
    1,
    ...data.people.map((p) =>
      scheduled.filter((t) => t.assigneeId === p.id).reduce((n, t) => n + t.estimateMinutes, 0),
    ),
  );
  return (
    <div className="planner-workload">
      <p className="planner-muted">
        Estimated hours for open work visible to you that overlaps this seven-day window.
      </p>
      <label className="planner-field">
        <span>Week beginning</span>
        <input
          type="date"
          value={week}
          onInput={(e) => e.currentTarget.value && setWeek(e.currentTarget.value)}
        />
      </label>
      <ErrorText error={resources.error || actions.resource.error} />
      {data.people.map((person) => {
        const assigned = scheduled.filter((t) => t.assigneeId === person.id);
        const minutes = assigned.reduce((n, t) => n + t.estimateMinutes, 0);
        const capacity = resources.data?.find(
          (r) => r.kind === 'capacity' && !r.archived && r.data.userId === person.id,
        );
        const available = Number(capacity?.data.weeklyMinutes ?? 2400);
        return (
          <article key={person.id}>
            <div>
              <strong>{person.name}</strong>
              <span>
                {assigned.length} tasks · {(minutes / 60).toFixed(1)} /{' '}
                {(available / 60).toFixed(1)} h {minutes > available ? '· Over capacity' : ''}
              </span>
            </div>
            <div className="planner-workload-track">
              <i style={{ width: `${(minutes / max) * 100}%` }} />
            </div>
            <p>
              {assigned.filter((t) => plannerTaskOverdue(t)).length} overdue ·{' '}
              {assigned.filter((t) => !t.estimateMinutes).length} without estimates
            </p>
            {person.id === data.me.id && (
              <label>
                My weekly capacity (hours){' '}
                <input
                  type="number"
                  min={0}
                  max={168}
                  step={0.5}
                  key={`${capacity?.id}:${capacity?.version}`}
                  defaultValue={available / 60}
                  disabled={actions.resource.isPending}
                  onBlur={(e) => {
                    const weeklyMinutes = Math.round(Number(e.target.value) * 60);
                    if (weeklyMinutes === available || weeklyMinutes < 0 || weeklyMinutes > 10080)
                      return;
                    actions.resource.mutate({
                      id: capacity?.id,
                      version: capacity?.version,
                      kind: 'capacity',
                      name: `${person.name} capacity`,
                      data: { userId: person.id, weeklyMinutes },
                    });
                  }}
                />
              </label>
            )}
          </article>
        );
      })}
      <p className="planner-muted">
        {open.filter((t) => !t.assigneeId).length} tasks are unassigned.{' '}
        {open.filter((t) => !t.dueOn).length} tasks have no dates and are excluded from this window.
      </p>
    </div>
  );
}
