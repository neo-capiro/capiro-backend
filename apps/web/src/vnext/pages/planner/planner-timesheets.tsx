import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import {
  plannerCalendarDate,
  plannerWeekOn,
  plannerWeekDate,
  plannerTimeToday,
  PLANNER_DEFAULT_TIME_OPTIONS,
  type PlannerBootstrap,
  type PlannerTimesheet,
  type PlannerTimesheetAction,
  type PlannerTimeEntry,
  type PlannerTimeSettings,
  type PlannerTimeOptions,
} from '@capiro/strategy-verifier';
import {
  usePlannerTimesheet,
  usePlannerTimeReview,
  usePlannerTimeSettings,
  usePlannerTask,
  usePlannerTasks,
  usePlannerMutations,
  usePlannerKey,
  plannerError,
} from './planner-api.js';
import { PlannerTimeForm } from './planner-time-form.js';
import { PlannerTimeOptionsFields } from './planner-time-options.js';
import { PlannerTimesheetWork } from './planner-timesheet-work.js';
import { PlannerFormattedText } from './planner-rich-text.js';
import { plannerCsvCell } from './planner-csv.js';
import { useApi } from '../../../lib/use-api.js';

const actionLabels: Record<PlannerTimesheetAction, string> = {
  submit: 'Submit timesheet',
  recall_submission: 'Recall submission',
  approve: 'Approve timesheet',
  reject: 'Reject timesheet',
  recall_approval: 'Recall approval',
};
const hours = (minutes: number) =>
  `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
function Frame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      className="planner-modal-overlay"
    >
      <Modal className="planner-modal">
        <Dialog aria-label={title}>
          <header className="planner-dialog-head">
            <Heading slot="title">{title}</Heading>
            <button type="button" aria-label={`Close ${title}`} onClick={onClose}>
              ×
            </button>
          </header>
          <div className="planner-dialog-body">{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
export function plannerTimeCsv(entries: PlannerTimeEntry[], people: PlannerBootstrap['people']) {
  return [
    [
      'Work date',
      'Logger',
      'Project',
      'Task',
      'Minutes',
      'Billable',
      'Category',
      'Description',
      'Edited by',
      'Entry ID',
    ],
    ...entries.map((e) => [
      e.time.workedOn,
      people.find((p) => p.id === e.actorId)?.name ?? 'Member',
      e.projectName,
      e.taskName,
      e.minutes,
      e.time.billable ? 'Yes' : 'No',
      e.time.category,
      e.text,
      people.find((p) => p.id === e.editedBy)?.name ?? '',
      e.id,
    ]),
  ]
    .map((row) => row.map(plannerCsvCell).join(','))
    .join('\r\n');
}
export async function plannerLoadTimeExport(
  sheet: PlannerTimesheet,
  load: (cursor: string, revision: string) => Promise<PlannerTimesheet>,
) {
  const entries = [...sheet.items],
    seen = new Set<string>();
  let cursor = sheet.nextCursor;
  while (cursor) {
    if (seen.has(cursor)) throw Error('Timesheet pagination repeated');
    seen.add(cursor);
    const page = await load(cursor, sheet.revision);
    if (page.revision !== sheet.revision) throw Error('Time changed during export');
    entries.push(...page.items);
    cursor = page.nextCursor;
  }
  if (entries.length !== sheet.matched)
    throw Error('Timesheet export is incomplete. Refresh before exporting.');
  return entries;
}
export function PlannerTimesheets({
  bootstrap,
  week: givenWeek,
  userId: onUser,
  onSelect,
}: {
  bootstrap: PlannerBootstrap;
  week: string | null;
  userId: string | null;
  onSelect: (week: string, userId: string | null) => void;
}) {
  const today = plannerTimeToday(
    bootstrap.timeOptions?.timeZone ?? PLANNER_DEFAULT_TIME_OPTIONS.timeZone,
  );
  const week = plannerWeekOn(plannerCalendarDate(givenWeek) ? givenWeek! : today);
  const userId = onUser ?? bootstrap.me.id;
  const [reviewing, setReviewing] = useState(false),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<PlannerTimeEntry | null>(null),
    [settings, setSettings] = useState<PlannerTimeSettings | null>(null),
    [categoryText, setCategoryText] = useState('');
  const [action, setAction] = useState<{
      sheet: PlannerTimesheet;
      action: PlannerTimesheetAction;
    } | null>(null),
    [notes, setNotes] = useState(''),
    [error, setError] = useState<unknown>(),
    [exporting, setExporting] = useState(false);
  const query = usePlannerTimesheet(week, userId),
    review = usePlannerTimeReview(week, reviewing),
    config = usePlannerTimeSettings(),
    mutations = usePlannerMutations(),
    api = useApi();
  const scope = JSON.stringify(usePlannerKey()),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setAdding(false);
    setEditing(null);
    setSettings(null);
    setAction(null);
    setError(null);
    setExporting(false);
    return () => controller.current?.abort();
  }, [week, userId, scope]);
  const sheet = query.data?.pages[0],
    pages = query.data?.pages ?? [],
    items = pages.flatMap((p) => p.items),
    person = (id: string | null) =>
      bootstrap.people.find((p) => p.id === id)?.name ?? 'Not assigned';
  const stalePages = sheet && pages.some((p) => p.revision !== sheet.revision);
  const download = async () => {
    if (!sheet) return;
    setExporting(true);
    setError(null);
    const active = new AbortController();
    controller.current = active;
    try {
      const fresh = (
        await api.get<PlannerTimesheet>('/strategy-api/planner/timesheets', {
          params: { week, userId, revision: sheet.revision },
          signal: active.signal,
        })
      ).data;
      const entries = await plannerLoadTimeExport(
        fresh,
        async (cursor, revision) =>
          (
            await api.get<PlannerTimesheet>('/strategy-api/planner/timesheets', {
              params: { week, userId, cursor, revision },
              signal: active.signal,
            })
          ).data,
      );
      if (active.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([plannerTimeCsv(entries, bootstrap.people)], { type: 'text/csv;charset=utf-8;' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `planner-time-${week}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!active.signal.aborted) setError(e);
    } finally {
      if (controller.current === active) setExporting(false);
    }
  };
  return (
    <section className="planner-timesheets">
      <div className="planner-tabs">
        <button type="button" aria-pressed={!reviewing} onClick={() => setReviewing(false)}>
          Timesheet
        </button>
        <button type="button" aria-pressed={reviewing} onClick={() => setReviewing(true)}>
          Time review
        </button>
        {config.data?.canManage && (
          <button
            type="button"
            onClick={() => {
              const options = config.data?.options ?? PLANNER_DEFAULT_TIME_OPTIONS;
              setSettings(structuredClone({ ...config.data!, options }));
              setCategoryText(options.categories.join('\n'));
            }}
          >
            Time settings
          </button>
        )}
      </div>
      <div className="planner-config-row">
        <button type="button" onClick={() => onSelect(plannerWeekDate(week, -7), onUser)}>
          Previous week
        </button>
        <label className="planner-field">
          <span>Week containing</span>
          <input
            type="date"
            aria-label="Timesheet week"
            value={week}
            onInput={(e) => {
              const value = e.currentTarget.value;
              if (value) onSelect(plannerWeekOn(value), onUser);
            }}
            onChange={(e) => {
              if (e.currentTarget.value) onSelect(plannerWeekOn(e.currentTarget.value), onUser);
            }}
          />
        </label>
        <button type="button" onClick={() => onSelect(plannerWeekDate(week, 7), onUser)}>
          Next week
        </button>
        <button
          type="button"
          onClick={() =>
            onSelect(
              plannerWeekOn(
                plannerTimeToday(
                  config.data?.options?.timeZone ??
                    bootstrap.timeOptions?.timeZone ??
                    PLANNER_DEFAULT_TIME_OPTIONS.timeZone,
                ),
              ),
              onUser,
            )
          }
        >
          This week
        </button>
      </div>
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      {reviewing ? (
        <>
          {review.isError ? (
            <p role="alert" className="planner-error">
              {plannerError(review.error)}
            </p>
          ) : review.isPending ? (
            <p role="status">Loading time review…</p>
          ) : (
            <>
              {!review.data?.length && <p>No submitters are assigned to you for time review.</p>}
              <table className="planner-table">
                <thead>
                  <tr>
                    <th>Submitter</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th>Billable</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {review.data?.map((s) => (
                    <tr key={s.userId}>
                      <td>{person(s.userId)}</td>
                      <td>
                        {s.status}
                        {s.unavailableEntries ? ' · Some work unavailable' : ''}
                      </td>
                      <td>{hours(s.totalMinutes)}</td>
                      <td>{hours(s.billableMinutes)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(week, s.userId);
                            setReviewing(false);
                          }}
                        >
                          View timesheet
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : query.isError || stalePages ? (
        <p role="alert" className="planner-error">
          {stalePages
            ? 'Time changed while loading. Refresh this timesheet.'
            : plannerError(query.error)}
        </p>
      ) : !sheet ? (
        <p role="status">Loading timesheet…</p>
      ) : (
        <>
          <header className="planner-timesheet-heading">
            <div>
              <h3>
                {person(userId)} · {sheet.weekOn}–{sheet.throughOn}
              </h3>
              <p>
                {sheet.status} ·{' '}
                {sheet.approvalProcess === 'simple'
                  ? 'Submission without approval'
                  : `Reviewer: ${person(sheet.reviewerId)}`}
              </p>
            </div>
            {userId !== bootstrap.me.id && (
              <button type="button" onClick={() => onSelect(week, null)}>
                My timesheet
              </button>
            )}
          </header>
          {sheet.unavailableEntries && (
            <p role="status">
              Some entries use work you cannot currently access. Totals include only visible work.
              Submission and approval are unavailable until all entries can be reviewed.
            </p>
          )}
          {sheet.correctedAfterApproval && (
            <p role="status">
              Time was corrected by an admin after approval. Recall approval to review the changes.
            </p>
          )}
          <div className="planner-timesheet-summary">
            <div>
              <span>Total time</span>
              <strong>{hours(sheet.totalMinutes)}</strong>
            </div>
            <div>
              <span>Billable time</span>
              <strong>{hours(sheet.billableMinutes)}</strong>
            </div>
            <div>
              <span>Non-billable time</span>
              <strong>{hours(sheet.totalMinutes - sheet.billableMinutes)}</strong>
            </div>
          </div>
          <div className="planner-table-scroll">
            <table className="planner-table">
              <caption>Weekly time totals</caption>
              <thead>
                <tr>
                  <th>Time</th>
                  {sheet.days.map((d) => (
                    <th key={d.date}>{d.date}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>All time</th>
                  {sheet.days.map((d) => (
                    <td key={d.date}>{hours(d.totalMinutes)}</td>
                  ))}
                  <td>{hours(sheet.totalMinutes)}</td>
                </tr>
                <tr>
                  <th>Billable</th>
                  {sheet.days.map((d) => (
                    <td key={d.date}>{hours(d.billableMinutes)}</td>
                  ))}
                  <td>{hours(sheet.billableMinutes)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {sheet.workRows !== undefined && (
            <PlannerTimesheetWork
              key={`${scope}:${week}:${userId}`}
              bootstrap={bootstrap}
              sheet={sheet}
              options={config.data?.options ?? bootstrap.timeOptions}
              canManage={config.data?.canManage ?? bootstrap.timeAdmin}
            />
          )}
          <div className="planner-actions">
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={
                sheet.canLogTime === false ||
                (!config.data?.canManage &&
                  (sheet.status === 'approved' ||
                    (sheet.status === 'submitted' && userId === bootstrap.me.id)))
              }
            >
              Add time
            </button>
            {sheet.actions.map((a) => (
              <button
                type="button"
                key={a}
                onClick={() => {
                  setNotes('');
                  setAction({ sheet, action: a });
                }}
              >
                {actionLabels[a]}
              </button>
            ))}
            {exporting ? (
              <button type="button" onClick={() => controller.current?.abort()}>
                Cancel export
              </button>
            ) : (
              <button type="button" disabled={!sheet.matched} onClick={() => void download()}>
                Export time entries
              </button>
            )}
          </div>
          {sheet.timeNotice && (
            <p role="status" className="planner-muted">
              {sheet.timeNotice}
            </p>
          )}
          {!sheet.reviewerId && sheet.approvalProcess !== 'simple' && (
            <p className="planner-muted">
              An organization admin can assign your reviewer in Time settings.
            </p>
          )}
          <div className="planner-table-scroll">
            <table className="planner-table">
              <caption>Time entries · {sheet.matched} matching entries</caption>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Work</th>
                  <th>Time</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.time.workedOn}</td>
                    <td>
                      <Link
                        to={
                          e.taskId
                            ? `/planner?scope=all&task=${e.taskId}`
                            : `/planner?scope=project&project=${e.projectId}`
                        }
                      >
                        {e.taskName ?? 'General project work'}
                      </Link>
                      <p>{e.projectName ?? 'Personal task'}</p>
                    </td>
                    <td>
                      {hours(e.minutes ?? 0)}
                      <p>{e.time.billable ? 'Billable' : 'Non-billable'}</p>
                    </td>
                    <td>
                      <PlannerFormattedText text={e.text} />
                      {e.time.category && <p>{e.time.category}</p>}
                      {e.editedAt && (
                        <p className="planner-muted">Edited by {person(e.editedBy ?? null)}</p>
                      )}
                    </td>
                    <td>
                      {e.canEdit && (
                        <>
                          <button type="button" onClick={() => setEditing(e)}>
                            Edit time entry
                          </button>
                          <button
                            type="button"
                            disabled={mutations.reviseEvent.isPending}
                            onClick={() => {
                              setError(null);
                              void mutations.reviseEvent
                                .mutateAsync({ id: e.id, version: e.version ?? 0, removed: true })
                                .catch(setError);
                            }}
                          >
                            Remove time entry
                          </button>
                        </>
                      )}
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
              Load more time entries
            </button>
          )}
          <details>
            <summary>Timesheet status activity</summary>
            {sheet.history.length ? (
              sheet.history.map((e) => (
                <article key={e.id} className="planner-activity">
                  <strong>{person(e.actorId)}</strong>
                  <time>{new Date(e.createdAt).toLocaleString()}</time>
                  <PlannerFormattedText text={e.text} />
                </article>
              ))
            ) : (
              <p>No status changes yet.</p>
            )}
          </details>
        </>
      )}
      {adding && (
        <AddTime
          bootstrap={bootstrap}
          week={week}
          userId={userId}
          options={config.data?.options ?? bootstrap.timeOptions}
          canManage={config.data?.canManage ?? bootstrap.timeAdmin}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <EditTime
          bootstrap={bootstrap}
          entry={editing}
          options={config.data?.options ?? bootstrap.timeOptions}
          canManage={config.data?.canManage ?? bootstrap.timeAdmin}
          onClose={() => setEditing(null)}
        />
      )}
      {action && (
        <Frame title={actionLabels[action.action]} onClose={() => setAction(null)}>
          <p>
            {person(action.sheet.userId)} · {action.sheet.weekOn} ·{' '}
            {hours(action.sheet.totalMinutes)}
          </p>
          <label className="planner-field">
            <span>Review notes</span>
            <textarea
              aria-label="Review notes"
              maxLength={20000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {mutations.timesheet.error && (
            <p role="alert" className="planner-error">
              {plannerError(mutations.timesheet.error)}
            </p>
          )}
          <button
            type="button"
            className="planner-primary"
            disabled={mutations.timesheet.isPending}
            onClick={() =>
              void mutations.timesheet
                .mutateAsync({
                  week: action.sheet.weekOn,
                  userId: action.sheet.userId,
                  version: action.sheet.version,
                  revision: action.sheet.revision,
                  action: action.action,
                  notes,
                })
                .then(() => setAction(null))
                .catch(() => {})
            }
          >
            {actionLabels[action.action]}
          </button>
        </Frame>
      )}
      {settings && (
        <Frame title="Time settings" onClose={() => setSettings(null)}>
          <PlannerTimeOptionsFields
            value={settings.options}
            onChange={(options) => setSettings((old) => (old ? { ...old, options } : old))}
            categories={categoryText}
            onCategories={setCategoryText}
          />
          <h3>Reviewers</h3>
          <p>
            Reviewer assignments allow weekly review. Existing task and project access still
            controls which entries a reviewer can see and correct.
          </p>
          {bootstrap.people.map((p) => (
            <label className="planner-field" key={p.id}>
              <span>{p.name}</span>
              <select
                aria-label={`${p.name} time reviewer`}
                value={settings.reviewers[p.id] ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setSettings((old) => {
                    if (!old) return old;
                    const reviewers = { ...old.reviewers };
                    if (value) reviewers[p.id] = value;
                    else delete reviewers[p.id];
                    return { ...old, reviewers };
                  });
                }}
              >
                <option value="">No reviewer</option>
                {bootstrap.people
                  .filter((r) => r.id !== p.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          {mutations.timeSettings.error && (
            <p role="alert" className="planner-error">
              {plannerError(mutations.timeSettings.error)}
            </p>
          )}
          <button
            type="button"
            className="planner-primary"
            disabled={mutations.timeSettings.isPending}
            onClick={() =>
              void mutations.timeSettings
                .mutateAsync({
                  version: settings.version,
                  reviewers: settings.reviewers,
                  options: {
                    ...settings.options,
                    categories: categoryText
                      .split(/\r?\n/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  },
                })
                .then(() => setSettings(null))
                .catch(() => {})
            }
          >
            Save time settings
          </button>
        </Frame>
      )}
    </section>
  );
}
function EditTime({
  bootstrap,
  entry,
  options,
  canManage,
  onClose,
}: {
  bootstrap: PlannerBootstrap;
  entry: PlannerTimeEntry;
  options?: PlannerTimeOptions;
  canManage?: boolean;
  onClose: () => void;
}) {
  const query = usePlannerTask(entry.taskId),
    mutations = usePlannerMutations();
  return (
    <Frame title="Edit time entry" onClose={onClose}>
      {query.isError ? (
        <p role="alert" className="planner-error">
          {plannerError(query.error)}
        </p>
      ) : entry.taskId && !query.data ? (
        <p role="status">Loading task…</p>
      ) : (
        <PlannerTimeForm
          projects={bootstrap.projects}
          task={query.data}
          projectId={!entry.taskId ? (entry.projectId ?? undefined) : undefined}
          initial={entry}
          options={options}
          canManage={canManage}
          onSave={async (input) => {
            await mutations.reviseEvent.mutateAsync({
              id: entry.id,
              version: entry.version ?? 0,
              ...input,
            });
            onClose();
          }}
          onCancel={onClose}
        />
      )}
    </Frame>
  );
}
function AddTime({
  bootstrap,
  week,
  userId,
  options = PLANNER_DEFAULT_TIME_OPTIONS,
  canManage,
  onClose,
}: {
  bootstrap: PlannerBootstrap;
  week: string;
  userId: string;
  options?: PlannerTimeOptions;
  canManage?: boolean;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(''),
    [target, setTarget] = useState(''),
    [kind, setKind] = useState<'task' | 'project'>('task');
  const query = usePlannerTasks({ search }, kind === 'task'),
    mutations = usePlannerMutations(),
    tasks =
      query.data?.pages
        .flatMap((p) => p.items)
        .filter((t) => ['admin', 'editor'].includes(t.access)) ?? [];
  const task = tasks.find((t) => t.id === target);
  return (
    <Frame title="Add time" onClose={onClose}>
      <label className="planner-field">
        <span>Log time on</span>
        <select
          aria-label="Log time on"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as 'task' | 'project');
            setTarget('');
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
            aria-label="Search tasks for time"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setTarget('');
            }}
          />
        </label>
      )}
      <label className="planner-field">
        <span>{kind === 'task' ? 'Task' : 'Project'}</span>
        <select
          aria-label="Time entry work"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">Choose work</option>
          {(kind === 'task'
            ? tasks
            : bootstrap.projects.filter(
                (p) => !p.archived && ['admin', 'editor'].includes(p.access),
              )
          ).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {query.isError && kind === 'task' && (
        <p role="alert" className="planner-error">
          {plannerError(query.error)}
        </p>
      )}
      {kind === 'task' && query.hasNextPage && (
        <button type="button" onClick={() => void query.fetchNextPage()}>
          Load more tasks
        </button>
      )}
      {target && (kind === 'project' || task) && (
        <PlannerTimeForm
          key={target}
          projects={bootstrap.projects}
          task={kind === 'task' ? task : undefined}
          projectId={kind === 'project' ? target : undefined}
          workedOn={week}
          options={options}
          canManage={canManage}
          onSave={async (input) => {
            await mutations.event.mutateAsync({
              ...input,
              ...(kind === 'task' ? { taskId: target } : { projectId: target }),
              loggerId: userId,
              kind: 'time',
            });
            onClose();
          }}
          onCancel={onClose}
        />
      )}
    </Frame>
  );
}
