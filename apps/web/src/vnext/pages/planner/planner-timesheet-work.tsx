import { useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  PlannerBootstrap,
  PlannerTimesheet,
  PlannerTimesheetWorkRow,
  PlannerTimeOptions,
  PlannerTimePreferences,
} from '@capiro/strategy-verifier';
import { PLANNER_DEFAULT_TIME_OPTIONS } from '@capiro/strategy-verifier';
import {
  usePlannerTimesheetWork,
  usePlannerTimePreferences,
  usePlannerTasks,
  usePlannerTask,
  usePlannerMutations,
  plannerError,
} from './planner-api.js';
import { PlannerTimeDialog } from './planner-time-dialog.js';
import { PlannerTimeForm } from './planner-time-form.js';

const hours = (n: number) =>
  (n / 60).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' h';
export function PlannerTimesheetWork({
  bootstrap,
  sheet,
  options = PLANNER_DEFAULT_TIME_OPTIONS,
  canManage = false,
}: {
  bootstrap: PlannerBootstrap;
  sheet: PlannerTimesheet;
  options?: PlannerTimeOptions;
  canManage?: boolean;
}) {
  const query = usePlannerTimesheetWork(sheet.weekOn, sheet.userId, sheet.revision),
    prefs = usePlannerTimePreferences(),
    mutations = usePlannerMutations();
  const [preferences, setPreferences] = useState<PlannerTimePreferences | null>(null);
  const [editor, setEditor] = useState<{
    mode: 'add' | 'log';
    sheet: PlannerTimesheet;
    row?: PlannerTimesheetWorkRow;
    date?: string;
  } | null>(null);
  const [error, setError] = useState<unknown>();
  const pages = query.data?.pages ?? [],
    rows = pages.flatMap((p) => p.workRows ?? []);
  const stale = pages.some((p) => p.revision !== sheet.revision);
  return (
    <section className="planner-timesheet-work">
      <h3>Work this week</h3>
      <div className="planner-actions">
        <button
          type="button"
          disabled={sheet.canLogTime === false || query.isError || stale}
          onClick={() => setEditor({ mode: 'add', sheet: structuredClone(sheet) })}
        >
          Add work to timesheet
        </button>
        {sheet.userId === bootstrap.me.id && prefs.data && !prefs.isError && (
          <button type="button" onClick={() => setPreferences(structuredClone(prefs.data!))}>
            My timesheet settings
          </button>
        )}
      </div>
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      {query.isError || stale ? (
        <p role="alert" className="planner-error">
          {stale
            ? 'Work changed while loading. Refresh this timesheet.'
            : plannerError(query.error)}
        </p>
      ) : !query.data ? (
        <p role="status">Loading weekly work…</p>
      ) : (
        <>
          {!rows.length && (
            <p>No work rows yet. Add work or enable automatic tasks in your timesheet settings.</p>
          )}
          <div className="planner-table-scroll">
            <table className="planner-table">
              <caption>Weekly work · {pages[0]?.matchedWork ?? rows.length} rows</caption>
              <thead>
                <tr>
                  <th>Work</th>
                  {sheet.days.map((d) => (
                    <th key={d.date}>{d.date}</th>
                  ))}
                  <th>Total</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      {row.taskId ? (
                        <Link to={`/planner?scope=all&task=${row.taskId}`}>
                          {row.taskName ?? 'Task'}
                        </Link>
                      ) : (
                        'General project work'
                      )}
                      {row.projectId && (
                        <p>
                          <Link to={`/planner?scope=project&project=${row.projectId}`}>
                            {row.projectName ?? 'Project'}
                          </Link>
                        </p>
                      )}
                      {row.origin === 'automatic' && (
                        <p className="planner-muted">Assigned and due this week</p>
                      )}
                    </td>
                    {row.days.map((d) => (
                      <td key={d.date}>
                        {hours(d.totalMinutes)}
                        {row.canLogTime && (
                          <button
                            type="button"
                            aria-label={`Log time for ${row.taskName ?? row.projectName ?? 'work'} on ${d.date}`}
                            onClick={() =>
                              setEditor({
                                mode: 'log',
                                sheet: structuredClone(sheet),
                                row,
                                date: d.date,
                              })
                            }
                          >
                            +
                          </button>
                        )}
                      </td>
                    ))}
                    <td>
                      {hours(row.totalMinutes)}
                      <p>{hours(row.billableMinutes)} billable</p>
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={!row.canRemove || mutations.timesheetWork.isPending}
                        title={row.totalMinutes ? 'Remove time entries first' : undefined}
                        onClick={() => {
                          setError(null);
                          void mutations.timesheetWork
                            .mutateAsync({
                              week: sheet.weekOn,
                              userId: sheet.userId,
                              version: sheet.version,
                              revision: sheet.revision,
                              action: 'remove',
                              work: { taskId: row.taskId, projectId: row.projectId },
                            })
                            .catch(setError);
                        }}
                      >
                        Remove work row
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage && (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading work…' : 'Load more work rows'}
            </button>
          )}
        </>
      )}
      {preferences && (
        <PlannerTimeDialog title="My timesheet settings" onClose={() => setPreferences(null)}>
          <label className="planner-check">
            <input
              type="checkbox"
              checked={preferences.autoAddDueTasks}
              onChange={(e) =>
                setPreferences((old) => old && { ...old, autoAddDueTasks: e.target.checked })
              }
            />
            Auto-add tasks assigned to me that are due each week
          </label>
          <p className="planner-muted">
            This adds zero-hour work rows. Logged time stays unchanged. Removed automatic rows stay
            hidden for their week; adding them again restores them.
          </p>
          {mutations.timePreferences.error && (
            <p role="alert" className="planner-error">
              {plannerError(mutations.timePreferences.error)}
            </p>
          )}
          <button
            type="button"
            className="planner-primary"
            disabled={mutations.timePreferences.isPending}
            onClick={() =>
              void mutations.timePreferences
                .mutateAsync({
                  version: preferences.version,
                  autoAddDueTasks: preferences.autoAddDueTasks,
                })
                .then(() => setPreferences(null))
                .catch(() => {})
            }
          >
            Save my timesheet settings
          </button>
        </PlannerTimeDialog>
      )}
      {editor && (
        <WorkEditor
          bootstrap={bootstrap}
          value={editor}
          options={options}
          canManage={canManage}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}
function WorkEditor({
  bootstrap,
  value,
  options,
  canManage,
  onClose,
}: {
  bootstrap: PlannerBootstrap;
  value: {
    mode: 'add' | 'log';
    sheet: PlannerTimesheet;
    row?: PlannerTimesheetWorkRow;
    date?: string;
  };
  options: PlannerTimeOptions;
  canManage: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<'task' | 'project'>(
    value.row?.taskId || !value.row ? 'task' : 'project',
  );
  const [selected, setSelected] = useState(value.row?.taskId ?? value.row?.projectId ?? ''),
    [project, setProject] = useState(value.row?.projectId ?? ''),
    [search, setSearch] = useState('');
  const tasks = usePlannerTasks({ search }, kind === 'task' && value.mode === 'add'),
    task = usePlannerTask(kind === 'task' && selected ? selected : null),
    mutations = usePlannerMutations();
  const choices =
    kind === 'task'
      ? (tasks.data?.pages.flatMap((p) => p.items) ?? [])
      : bootstrap.projects.filter((p) => !p.archived && ['admin', 'editor'].includes(p.access));
  const projects = bootstrap.projects.filter(
    (p) =>
      !p.archived &&
      ['admin', 'editor'].includes(p.access) &&
      (kind === 'project'
        ? p.id === selected
        : task.data?.memberships.some((m) => m.projectId === p.id)),
  );
  const projectId =
    kind === 'project' ? selected : project || (projects.length === 1 ? projects[0]!.id : null);
  const add = async () => {
    await mutations.timesheetWork.mutateAsync({
      week: value.sheet.weekOn,
      userId: value.sheet.userId,
      version: value.sheet.version,
      revision: value.sheet.revision,
      action: 'add',
      work: { taskId: kind === 'task' ? selected : null, projectId: projectId || null },
    });
    onClose();
  };
  return (
    <PlannerTimeDialog
      title={value.mode === 'add' ? 'Add work to timesheet' : 'Log time for weekly work'}
      onClose={onClose}
    >
      {value.mode === 'add' ? (
        <>
          <label className="planner-field">
            <span>Work type</span>
            <select
              aria-label="Timesheet work type"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as 'task' | 'project');
                setSelected('');
                setProject('');
              }}
            >
              <option value="task">Task</option>
              <option value="project" disabled={!options.generalWorkEnabled}>
                General project work
              </option>
            </select>
          </label>
          {kind === 'task' && (
            <label className="planner-field">
              <span>Search tasks</span>
              <input
                aria-label="Search work for timesheet"
                maxLength={200}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          )}
          <label className="planner-field">
            <span>{kind === 'task' ? 'Task' : 'Project'}</span>
            <select
              aria-label="Work for timesheet"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setProject('');
              }}
            >
              <option value="">Choose work</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {kind === 'task' && tasks.hasNextPage && (
            <button disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
              Load more tasks
            </button>
          )}
        </>
      ) : (
        <p>
          {value.row?.taskName ?? 'General project work'}
          {value.row?.projectName ? ' · ' + value.row.projectName : ''}
        </p>
      )}
      {tasks.isError || task.isError ? (
        <p role="alert" className="planner-error">
          {plannerError(tasks.error ?? task.error)}
        </p>
      ) : kind === 'task' && selected && !task.data ? (
        <p role="status">Loading task…</p>
      ) : (
        selected &&
        (value.mode === 'log' ? (
          <PlannerTimeForm
            projects={bootstrap.projects}
            task={kind === 'task' ? task.data : undefined}
            projectId={projectId || undefined}
            workedOn={value.date ?? value.sheet.weekOn}
            options={options}
            canManage={canManage}
            onSave={async (input) => {
              await mutations.event.mutateAsync({
                ...(kind === 'task' ? { taskId: selected } : { projectId: selected }),
                loggerId: value.sheet.userId,
                kind: 'time',
                ...input,
              });
              onClose();
            }}
            onCancel={onClose}
          />
        ) : (
          <>
            {kind === 'task' && projects.length > 0 && (
              <label className="planner-field">
                <span>Project for work</span>
                <select
                  aria-label="Project for weekly work"
                  value={projectId ?? ''}
                  onChange={(e) => setProject(e.target.value)}
                >
                  <option value="">Choose a project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="planner-primary"
              disabled={
                mutations.timesheetWork.isPending ||
                !options.timeTrackingEnabled ||
                (kind === 'task' && !!task.data?.memberships.length && !projectId)
              }
              onClick={() => void add().catch(() => {})}
            >
              Add zero-hour work row
            </button>
            {mutations.timesheetWork.error && (
              <p role="alert" className="planner-error">
                {plannerError(mutations.timesheetWork.error)}
              </p>
            )}
          </>
        ))
      )}
    </PlannerTimeDialog>
  );
}
