import { useState } from 'react';
import {
  plannerDateInZone,
  plannerGoalNextReminder,
  plannerTimeZone,
  plannerTime,
  plannerCalendarDate,
  type PlannerBootstrap,
  type PlannerEvent,
  type PlannerGoalData,
  type PlannerGoalReminder,
  type PlannerGoalUpdateSection,
  type PlannerResource,
} from '@capiro/strategy-verifier';
import { plannerError, usePlannerEvents, usePlannerMutations } from './planner-api.js';
import { PlannerActivity } from './planner-activity.js';
import { PlannerRichText } from './planner-rich-text.js';
import { PLANNER_GOAL_STATUS_LABELS } from './planner-goal-editor.js';

export function PlannerGoalHistory({ events }: { events: PlannerEvent[] }) {
  const points = events
    .filter((e) => e.goalSnapshot)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (!points.length)
    return <p className="planner-muted">Progress history starts with your next goal update.</p>;
  const start = new Date(points[0]!.createdAt).getTime(),
    end = new Date(points.at(-1)!.createdAt).getTime();
  const x = (event: PlannerEvent, i: number) =>
    end > start
      ? 44 + ((new Date(event.createdAt).getTime() - start) / (end - start)) * 512
      : 44 + (i / Math.max(1, points.length - 1)) * 512;
  let connected = false;
  const path = points
    .map((e, i) => {
      const percentage = e.goalSnapshot!.percentage;
      if (percentage === undefined) {
        connected = false;
        return '';
      }
      const command = `${connected ? 'L' : 'M'} ${x(e, i)} ${126 - percentage}`;
      connected = true;
      return command;
    })
    .join(' ');
  return (
    <section className="planner-goal-history" aria-label="Progress history">
      <h3>Progress history</h3>
      <p className="planner-muted">
        History for loaded updates. Each point keeps its original target and measurement.
      </p>
      <svg
        viewBox="0 0 600 156"
        role="img"
        aria-label="Goal progress over time; values are also available in the history table"
      >
        {[0, 50, 100].map((value) => (
          <g key={value}>
            <line
              x1={44}
              x2={556}
              y1={126 - value}
              y2={126 - value}
              className="planner-goal-grid"
            />
            <text x={6} y={130 - value}>
              {value}%
            </text>
          </g>
        ))}
        <path d={path} className="planner-goal-trend" />
        {points.map((e, i) =>
          e.goalSnapshot!.percentage === undefined ? null : (
            <circle
              key={e.id}
              cx={x(e, i)}
              cy={126 - e.goalSnapshot!.percentage!}
              r={4}
              className="planner-goal-point"
            >
              <title>
                {new Date(e.createdAt).toLocaleString()}: {e.goalSnapshot!.percentage!.toFixed(1)}%
              </title>
            </circle>
          ),
        )}
        <text x={44} y={150}>
          {new Date(points[0]!.createdAt).toLocaleDateString()}
        </text>
        <text x={556} y={150} textAnchor="end">
          {new Date(points.at(-1)!.createdAt).toLocaleDateString()}
        </text>
      </svg>
      <div className="planner-goal-history-table">
        <table className="planner-table">
          <caption>Recorded goal progress</caption>
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Measurement</th>
            </tr>
          </thead>
          <tbody>
            {points
              .slice()
              .reverse()
              .map((e) => {
                const s = e.goalSnapshot!;
                return (
                  <tr key={e.id}>
                    <td>
                      <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                    </td>
                    <td>{PLANNER_GOAL_STATUS_LABELS[s.status]}</td>
                    <td>
                      {s.percentage === undefined
                        ? 'Unavailable with current access'
                        : `${s.percentage.toFixed(1)}%`}
                    </td>
                    <td>
                      {s.value === undefined
                        ? 'Progress is private'
                        : s.measurement === 'manual' || s.measurement === 'subgoal_total'
                          ? `${s.value} ${s.unit} (start ${s.startValue}, target ${s.target})`
                          : `${s.value.toFixed(1)}% from connected work`}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PlannerGoalActivity({
  goal,
  bootstrap,
}: {
  goal: PlannerResource;
  bootstrap: PlannerBootstrap;
}) {
  const query = usePlannerEvents(undefined, undefined, goal.id);
  const actions = usePlannerMutations();
  const data = goal.data as unknown as PlannerGoalData;
  const [composing, setComposing] = useState(false),
    [editingReminder, setEditingReminder] = useState(false);
  const [comment, setComment] = useState(''),
    [error, setError] = useState<unknown>(null);
  const events = query.error ? [] : (query.data?.pages.flatMap((p) => p.items) ?? []);
  const context = query.data?.pages[0]?.goalContext;
  const editable = ['admin', 'editor'].includes(goal.access) && !goal.archived;
  const responsibleOwner = data.ownerId === bootstrap.me.id;
  const notificationOwner = responsibleOwner || goal.ownerId === bootstrap.me.id;
  const following = context?.following ?? (data.followers ?? []).includes(bootstrap.me.id);
  const closed = !['on_track', 'at_risk', 'off_track'].includes(data.status);
  return (
    <div className="planner-goal-updates">
      <div className="planner-activity-actions">
        {editable && (
          <button
            className="planner-primary"
            onClick={() => {
              setError(null);
              setComposing(true);
            }}
          >
            Post status update
          </button>
        )}
        {notificationOwner ? (
          <span className="planner-muted">Goal owners receive updates.</span>
        ) : (
          <button
            disabled={actions.followGoal.isPending || goal.archived || !!query.error}
            aria-pressed={following}
            onClick={async () => {
              setError(null);
              try {
                await actions.followGoal.mutateAsync({
                  id: goal.id,
                  version: goal.version,
                  following: !following,
                });
              } catch (failure) {
                setError(failure);
              }
            }}
          >
            {following ? 'Unfollow goal' : 'Follow goal'}
          </button>
        )}
      </div>
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      {composing && (
        <GoalUpdateComposer
          key={goal.id}
          goal={goal}
          audience={context?.audienceCount}
          canSetReminders={responsibleOwner}
          mutation={actions.goalUpdate}
          onClose={() => setComposing(false)}
        />
      )}
      {responsibleOwner && (
        <section aria-label="Goal reminders">
          <h3>Goal reminders</h3>
          {data.reminder ? (
            <p>
              {data.reminder.cadence === 'biweekly'
                ? 'Every two weeks'
                : `${data.reminder.cadence[0]!.toUpperCase()}${data.reminder.cadence.slice(1)}`}
              {' at '}
              {data.reminder.time} in {data.reminder.timeZone}.
              {!closed && !goal.archived && (
                <>
                  {' '}
                  Next reminder:{' '}
                  <time
                    dateTime={plannerGoalNextReminder(
                      data.reminder,
                      new Date(),
                    ).instant.toISOString()}
                  >
                    {plannerGoalNextReminder(data.reminder, new Date()).date}
                  </time>
                  .
                </>
              )}
            </p>
          ) : (
            <p className="planner-muted">Status update reminders are off.</p>
          )}
          {data.dueOn && (
            <p className="planner-muted">
              A reminder to review and close this goal arrives one week before {data.dueOn} at 09:00
              in {data.timeZone ?? data.reminder?.timeZone ?? 'UTC'}.
            </p>
          )}
          {(closed || goal.archived) && (
            <p className="planner-muted">
              Reminders are paused while this goal is closed or archived.
            </p>
          )}
          {editable && <button onClick={() => setEditingReminder(true)}>Edit reminders</button>}
          {editingReminder && (
            <GoalReminderEditor
              key={goal.id}
              goal={goal}
              mutation={actions.resource}
              onClose={() => setEditingReminder(false)}
            />
          )}
        </section>
      )}
      {query.isPending ? (
        <p role="status">Loading goal updates...</p>
      ) : query.error ? (
        <p role="alert" className="planner-error">
          {plannerError(query.error)}
        </p>
      ) : (
        <>
          <PlannerGoalHistory events={events} />
          <section aria-label="Goal updates and comments">
            <h3>Updates and comments</h3>
            {events
              .filter((e) => e.kind !== 'goal_progress')
              .map((event) => (
                <div key={event.id}>
                  {event.goalSnapshot && (
                    <p className="planner-muted">
                      {PLANNER_GOAL_STATUS_LABELS[event.goalSnapshot.status]}
                      {event.goalSnapshot.percentage === undefined
                        ? ' - Progress unavailable with current access'
                        : ` - ${event.goalSnapshot.percentage.toFixed(1)}% at this update`}
                    </p>
                  )}
                  <PlannerActivity
                    event={event}
                    author={bootstrap.people.find((p) => p.id === event.actorId)?.name ?? 'Planner'}
                    me={bootstrap.me.id}
                    access={goal.access}
                    mutation={actions.reviseEvent}
                  />
                </div>
              ))}
            {!events.some((e) => e.kind !== 'goal_progress') && (
              <p className="planner-muted">Share your first update or comment.</p>
            )}
          </section>
        </>
      )}
      {goal.access !== 'viewer' && !goal.archived && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await actions.event.mutateAsync({
                resourceId: goal.id,
                kind: 'comment',
                text: comment,
              });
              setComment('');
            } catch (failure) {
              setError(failure);
            }
          }}
        >
          <PlannerRichText
            label="Goal comment"
            value={comment}
            onChange={setComment}
            maxLength={20000}
            rows={3}
          />
          <button className="planner-primary" disabled={!comment.trim() || actions.event.isPending}>
            Add comment
          </button>
        </form>
      )}
      {query.hasNextPage && (
        <button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading older updates...' : 'Load older updates'}
        </button>
      )}
    </div>
  );
}

export function GoalUpdateComposer({
  goal,
  audience,
  canSetReminders = false,
  mutation,
  onClose,
}: {
  goal: PlannerResource;
  audience?: number;
  canSetReminders?: boolean;
  mutation: Pick<ReturnType<typeof usePlannerMutations>['goalUpdate'], 'mutateAsync' | 'isPending'>;
  onClose: () => void;
}) {
  const initial = goal.data as unknown as PlannerGoalData;
  const [version] = useState(goal.version),
    [title, setTitle] = useState('');
  const [status, setStatus] = useState(initial.status),
    [current, setCurrent] = useState(initial.current);
  const [sections, setSections] = useState<PlannerGoalUpdateSection[]>(() =>
    ['Summary', 'What went well', 'Risks and next steps'].map((title) => ({
      id: crypto.randomUUID(),
      title,
      text: '',
    })),
  );
  const [error, setError] = useState<unknown>(null);
  const [setReminders, enableReminders] = useState(false);
  const [reminderSettings, setReminderSettings] = useState(() => initialGoalReminder(initial));
  const setSection = (id: string, patch: Partial<PlannerGoalUpdateSection>) =>
    setSections((old) => old.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  return (
    <form
      className="planner-goal-composer"
      aria-label="Post goal status"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await mutation.mutateAsync({
            id: goal.id,
            version,
            title,
            status,
            sections,
            ...(initial.progress === 'manual' ? { current } : {}),
            ...(canSetReminders && setReminders
              ? {
                  reminder:
                    reminderSettings.cadence === 'off'
                      ? null
                      : (reminderSettings as PlannerGoalReminder),
                  timeZone: reminderSettings.timeZone,
                }
              : {}),
          });
          onClose();
        } catch (failure) {
          setError(failure);
        }
      }}
    >
      <h3>Post status update</h3>
      <p className="planner-muted">
        {audience === undefined
          ? 'Updates notify goal owners and followers who can access this goal.'
          : `${audience} ${audience === 1 ? 'person receives' : 'people receive'} goal updates. Your own post does not notify you.`}
      </p>
      <label className="planner-field">
        <span>Update title</span>
        <input required maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="planner-field">
        <span>Update status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as PlannerGoalData['status'])}
        >
          {Object.entries(PLANNER_GOAL_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {initial.progress === 'manual' && (
        <label className="planner-field">
          <span>Progress value ({initial.unit})</span>
          <input
            type="number"
            required
            step="any"
            min={-1000000}
            max={1000000}
            value={current}
            onChange={(e) => setCurrent(Number(e.target.value))}
          />
        </label>
      )}
      {sections.map((section, i) => (
        <fieldset key={section.id}>
          <legend>Update section {i + 1}</legend>
          <label className="planner-field">
            <span>Section {i + 1} heading</span>
            <input
              required
              maxLength={200}
              value={section.title}
              onChange={(e) => setSection(section.id, { title: e.target.value })}
            />
          </label>
          <PlannerRichText
            label={`Section ${i + 1} text`}
            value={section.text}
            onChange={(text) => setSection(section.id, { text })}
            maxLength={20000}
            rows={3}
          />
          <button
            type="button"
            disabled={sections.length === 1}
            onClick={() => setSections((old) => old.filter((s) => s.id !== section.id))}
          >
            Remove section {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={sections.length >= 20}
        onClick={() =>
          setSections((old) => [
            ...old,
            { id: crypto.randomUUID(), title: 'New section', text: '' },
          ])
        }
      >
        Add update section
      </button>
      {canSetReminders && (
        <section aria-label="Status update reminder settings">
          <label>
            <input
              type="checkbox"
              checked={setReminders}
              onChange={(e) => enableReminders(e.target.checked)}
            />{' '}
            Set reminders with this update
          </label>
          {setReminders && (
            <GoalReminderFields settings={reminderSettings} onChange={setReminderSettings} />
          )}
        </section>
      )}
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      <div className="planner-activity-actions">
        <button
          className="planner-primary"
          disabled={
            mutation.isPending ||
            !title.trim() ||
            (canSetReminders && setReminders && !validGoalReminder(reminderSettings))
          }
        >
          {mutation.isPending ? 'Posting...' : 'Post update'}
        </button>
        <button type="button" disabled={mutation.isPending} onClick={onClose}>
          Cancel update
        </button>
      </div>
    </form>
  );
}

type GoalReminderSettings = Omit<PlannerGoalReminder, 'cadence'> & {
  cadence: PlannerGoalReminder['cadence'] | 'off';
};
function initialGoalReminder(data: PlannerGoalData): GoalReminderSettings {
  const zone =
    data.reminder?.timeZone ?? data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tomorrow = new Date(`${plannerDateInZone(new Date(), zone)}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return {
    cadence: data.reminder?.cadence ?? 'off',
    anchorOn: data.reminder?.anchorOn ?? tomorrow.toISOString().slice(0, 10),
    time: data.reminder?.time ?? '09:00',
    timeZone: zone,
  };
}
function validGoalReminder(settings: GoalReminderSettings) {
  return (
    plannerTimeZone(settings.timeZone) &&
    (settings.cadence === 'off' ||
      (plannerCalendarDate(settings.anchorOn) && plannerTime(settings.time)))
  );
}
function GoalReminderFields({
  settings,
  onChange,
}: {
  settings: GoalReminderSettings;
  onChange: (value: GoalReminderSettings) => void;
}) {
  const { cadence, anchorOn, time, timeZone } = settings;
  return (
    <>
      <label className="planner-field">
        <span>Reminder cadence</span>
        <select
          value={cadence}
          onChange={(e) => onChange({ ...settings, cadence: e.target.value as typeof cadence })}
        >
          <option value="off">Off</option>
          <option value="weekly">Weekly</option>
          <option value="biweekly">Every two weeks</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
        </select>
      </label>
      {cadence !== 'off' && (
        <>
          <label className="planner-field">
            <span>First reminder</span>
            <input
              required
              type="date"
              value={anchorOn}
              onInput={(e) => onChange({ ...settings, anchorOn: e.currentTarget.value })}
              onChange={(e) => onChange({ ...settings, anchorOn: e.target.value })}
            />
          </label>
          <label className="planner-field">
            <span>Reminder time</span>
            <input
              required
              type="time"
              value={time}
              onInput={(e) => onChange({ ...settings, time: e.currentTarget.value })}
              onChange={(e) => onChange({ ...settings, time: e.target.value })}
            />
          </label>
        </>
      )}
      <label className="planner-field">
        <span>Reminder time zone</span>
        <input
          required
          maxLength={100}
          value={timeZone}
          onChange={(e) => onChange({ ...settings, timeZone: e.target.value })}
        />
      </label>
      {cadence !== 'off' && validGoalReminder(settings) && (
        <p className="planner-muted">
          Next reminder: {plannerGoalNextReminder(settings as PlannerGoalReminder, new Date()).date}{' '}
          at {time} in {timeZone}. A past first reminder is due immediately.
        </p>
      )}
    </>
  );
}
export function GoalReminderEditor({
  goal,
  mutation,
  onClose,
}: {
  goal: PlannerResource;
  mutation: Pick<ReturnType<typeof usePlannerMutations>['resource'], 'mutateAsync' | 'isPending'>;
  onClose: () => void;
}) {
  const [version] = useState(goal.version);
  const [settings, setSettings] = useState(() =>
    initialGoalReminder(goal.data as unknown as PlannerGoalData),
  );
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="planner-goal-composer"
      aria-label="Edit goal reminders"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await mutation.mutateAsync({
            id: goal.id,
            version,
            data: {
              reminder: settings.cadence === 'off' ? null : settings,
              timeZone: settings.timeZone,
            },
          });
          onClose();
        } catch (failure) {
          setError(failure);
        }
      }}
    >
      <GoalReminderFields settings={settings} onChange={setSettings} />
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      <div className="planner-activity-actions">
        <button
          className="planner-primary"
          disabled={mutation.isPending || !validGoalReminder(settings)}
        >
          Save reminders
        </button>
        <button type="button" disabled={mutation.isPending} onClick={onClose}>
          Cancel reminders
        </button>
      </div>
    </form>
  );
}
