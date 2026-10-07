import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { Plus, X } from 'lucide-react';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_STATUS_LABELS,
  type PlannerBootstrap,
  type PlannerTask,
  type PlannerResource,
  type PlannerResourceKind,
  type PlannerRuleData,
  type PlannerGoalData,
  type PlannerFormData,
  type PlannerTaskData,
  type PlannerProjectData,
  type PlannerRole,
  type PlannerTemplateData,
  plannerTemplateSchedule,
  plannerCalendarDate,
  plannerGoalSourceIds,
  plannerGoalPercentage,
  plannerGoalWeights,
} from '@capiro/strategy-verifier';
import {
  usePlannerResources,
  usePlannerMutations,
  usePlannerEvents,
  plannerError,
} from './planner-api.js';
import { PlannerRichText, PlannerFormattedText } from './planner-rich-text.js';
import { PlannerActivity } from './planner-activity.js';
import { PlannerTemplateScheduleEditor } from './planner-template-schedule.js';
import { PlannerGoalEditor, PLANNER_GOAL_STATUS_LABELS } from './planner-goal-editor.js';
import { PlannerGoalDetail } from './planner-goal-detail.js';
import { PlannerPortfolioBudget } from './planner-budgets.js';
import { PlannerGoalActivity } from './planner-goal-activity.js';
import { PlannerFormBuilder, plannerDuplicateFormData } from './planner-form-builder.js';
import {
  PlannerFormQuestions,
  plannerFormSubmissionError,
  type PlannerFormFiles,
} from './planner-form-questions.js';

const editable = (role: string) => ['admin', 'editor'].includes(role);
const sharing = { description: '', privacy: 'private', members: [] };
export function plannerResourceDefaults(kind: PlannerResourceKind): Record<string, unknown> {
  if (kind === 'portfolio') return { ...sharing, projectIds: [] };
  if (kind === 'goal')
    return {
      ...sharing,
      projectIds: [],
      ownerId: null,
      dueOn: null,
      status: 'on_track',
      progress: 'manual',
      current: 0,
      target: 100,
      unit: '%',
      startValue: 0,
      direction: 'increase',
      subgoalIds: [],
      taskIds: [],
      startOn: null,
      timePeriod: '',
      goalType: 'team',
      weightMode: 'equal',
      weights: [],
    };
  if (kind === 'template')
    return {
      ...sharing,
      project: { ...PLANNER_DEFAULT_PROJECT, name: 'Untitled project' },
      tasks: [],
    };
  if (kind === 'rule')
    return { enabled: true, trigger: 'created', conditions: {}, actions: { priority: 'medium' } };
  if (kind === 'capacity') return { userId: '', weeklyMinutes: 2400 };
  return {
    description: '',
    enabled: true,
    fields: [
      {
        id: crypto.randomUUID(),
        label: 'What needs to be done?',
        type: 'text',
        required: true,
        options: [],
        taskField: 'name',
      },
      {
        id: crypto.randomUUID(),
        label: 'Tell us more',
        type: 'paragraph',
        required: false,
        options: [],
        taskField: null,
      },
    ],
    defaults: { assigneeId: null, status: 'todo', priority: 'none', estimateMinutes: 0 },
    copyAnswersToDescription: true,
    audience: 'organization',
    allowAnotherSubmission: true,
    addSubmitterAsCollaborator: false,
  };
}
function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <label className="planner-field">
      <span>{name}</span>
      {children}
    </label>
  );
}
function Alert({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="planner-error">
      {plannerError(error)}
    </p>
  ) : null;
}
function ModalFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
          <div className="planner-dialog-head">
            <Heading slot="title">{title}</Heading>
            <button aria-label={`Close ${title}`} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function PlannerManagement({
  kind,
  bootstrap,
  tasks,
  onProject,
  onTask,
  selectedGoalId,
  onGoal,
  selectedPortfolioId,
  onPortfolio,
}: {
  kind: PlannerResourceKind;
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  onProject: (id: string) => void;
  onTask: (id: string) => void;
  selectedGoalId?: string | null;
  onGoal?: (id: string | null) => void;
  selectedPortfolioId?: string | null;
  onPortfolio?: (id: string | null) => void;
}) {
  const query = usePlannerResources();
  const actions = usePlannerMutations();
  const [editor, setEditor] = useState<PlannerResource | 'new' | null>(null);
  const [archived, setArchived] = useState(false);
  const [using, setUsing] = useState<PlannerResource | null>(null);
  const [name, setName] = useState('');
  const [anchorOn, setAnchorOn] = useState('');
  const [goalId, setGoalId] = useState<string | null>(null);
  const openGoal = onGoal ?? setGoalId;
  const [goalSearch, setGoalSearch] = useState('');
  const [goalOwner, setGoalOwner] = useState('');
  const [goalStatus, setGoalStatus] = useState('');
  const [goalType, setGoalType] = useState('');
  const [goalPeriod, setGoalPeriod] = useState('');
  const currentGoalId = onGoal ? selectedGoalId : goalId;
  const goalDetail = query.data?.find((r) => r.id === currentGoalId && r.kind === 'goal');
  const [shareLink, setShareLink] = useState<{ formId: string; url: string } | null>(null);
  const sharedForm = query.data?.find((row) => row.id === shareLink?.formId);
  const shareLinkCurrent =
    sharedForm?.kind === 'form' &&
    !sharedForm.archived &&
    sharedForm.data.enabled === true &&
    sharedForm.data.audience !== 'organization' &&
    sharedForm.publicShared === true &&
    editable(sharedForm.access);
  useEffect(() => {
    if (shareLink && query.data && !shareLinkCurrent) setShareLink(null);
  }, [shareLink, query.data, shareLinkCurrent]);
  const rows =
    query.data?.filter(
      (r) =>
        r.kind === kind &&
        r.archived === archived &&
        (kind !== 'portfolio' || !selectedPortfolioId || r.id === selectedPortfolioId) &&
        (kind !== 'goal' ||
          ((!goalSearch || r.name.toLowerCase().includes(goalSearch.toLowerCase())) &&
            (!goalOwner || r.data.ownerId === goalOwner) &&
            (!goalStatus || r.data.status === goalStatus) &&
            (!goalType || (r.data.goalType ?? 'team') === goalType) &&
            (!goalPeriod || r.data.timePeriod === goalPeriod))),
    ) ?? [];
  const goalFiltered =
    kind === 'goal' && [goalSearch, goalOwner, goalStatus, goalType, goalPeriod].some(Boolean);
  return (
    <div className="planner-management">
      {kind === 'portfolio' && selectedPortfolioId && (
        <div className="planner-report-actions">
          <button onClick={() => onPortfolio?.(null)}>All portfolios</button>
          {!query.isPending && !rows.length && (
            <p role="alert">This portfolio is unavailable or your access changed.</p>
          )}
        </div>
      )}
      <div className="planner-management-actions">
        <button
          className="planner-primary"
          onClick={() => {
            actions.resource.reset();
            setEditor('new');
          }}
        >
          <Plus size={16} />
          New {kind}
        </button>
        <button onClick={() => setArchived(!archived)}>{archived ? 'Active' : 'Archived'}</button>
      </div>
      {kind === 'goal' && (
        <div className="planner-toolbar" aria-label="Goal filters">
          <input
            aria-label="Search goals"
            placeholder="Search goals"
            value={goalSearch}
            onChange={(e) => setGoalSearch(e.target.value)}
          />
          <select
            aria-label="Filter goal owner"
            value={goalOwner}
            onChange={(e) => setGoalOwner(e.target.value)}
          >
            <option value="">All owners</option>
            {bootstrap.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter goal status"
            value={goalStatus}
            onChange={(e) => setGoalStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(PLANNER_GOAL_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter goal type"
            value={goalType}
            onChange={(e) => setGoalType(e.target.value)}
          >
            <option value="">All types</option>
            <option value="company">Company</option>
            <option value="team">Team</option>
            <option value="individual">Individual</option>
          </select>
          <select
            aria-label="Filter goal time period"
            value={goalPeriod}
            onChange={(e) => setGoalPeriod(e.target.value)}
          >
            <option value="">All time periods</option>
            {Array.from(
              new Set(
                query.data
                  ?.filter((r) => r.kind === 'goal' && r.data.timePeriod)
                  .map((r) => String(r.data.timePeriod)),
              ),
            )
              .sort()
              .map((period) => (
                <option key={period}>{period}</option>
              ))}
          </select>
        </div>
      )}
      <Alert
        error={
          query.error ||
          actions.resource.error ||
          actions.instantiate.error ||
          actions.shareForm.error
        }
      />
      {kind === 'goal' && currentGoalId && query.data && !goalDetail && (
        <p role="alert">
          This goal is unavailable or your access has changed.{' '}
          <button onClick={() => openGoal(null)}>Back to goals</button>
        </p>
      )}
      {kind === 'form' && shareLink && shareLinkCurrent && (
        <div className="planner-form-share" role="status">
          <p>
            Anyone with this link can submit a request. Creating a new link revokes the previous
            link.
          </p>
          <label className="planner-field">
            <span>Public form link</span>
            <input readOnly value={shareLink.url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareLink.url);
              } catch {}
            }}
          >
            Copy link
          </button>
          <button onClick={() => setShareLink(null)}>Dismiss</button>
        </div>
      )}
      {query.isPending ? (
        <p role="status">Loading {kind}s…</p>
      ) : (
        <div className="planner-project-grid">
          {rows.map((row) => {
            const projectIds = (row.data.projectIds ?? []) as string[];
            const linked = bootstrap.projects.filter((p) => projectIds.includes(p.id));
            const percentage =
              row.goalProgress?.percentage ??
              (row.data.progress === 'manual'
                ? plannerGoalPercentage(row.data as unknown as PlannerGoalData)
                : 0);
            return (
              <article className="planner-management-card" key={row.id}>
                <h3>{row.name}</h3>
                <p>{String(row.data.description ?? '')}</p>
                {row.projectId && (
                  <p className="planner-muted">
                    {bootstrap.projects.find((p) => p.id === row.projectId)?.name}
                  </p>
                )}
                {kind === 'goal' && (
                  <>
                    <strong>
                      {row.data.progress !== 'manual' && row.data.progress !== 'subgoal_total'
                        ? `${percentage.toFixed(0)}%`
                        : `${row.goalProgress?.value ?? row.data.current} / ${row.data.target} ${row.data.unit}`}
                    </strong>
                    <progress
                      max={100}
                      value={Math.min(100, percentage)}
                      aria-label={`${row.name} progress`}
                    />
                    <p>
                      {PLANNER_GOAL_STATUS_LABELS[row.data.status as PlannerGoalData['status']]}
                      {row.data.dueOn ? ` · Due ${row.data.dueOn}` : ''}
                    </p>
                    {!!row.data.timePeriod && (
                      <p className="planner-muted">{String(row.data.timePeriod)}</p>
                    )}
                    <p className="planner-muted">
                      {bootstrap.people.find((p) => p.id === row.data.ownerId)?.name ??
                        'Unassigned'}
                    </p>
                    <button className="planner-related-link" onClick={() => openGoal(row.id)}>
                      View goal
                    </button>
                  </>
                )}
                {kind === 'portfolio' && (
                  <p>
                    {linked.length} projects ·{' '}
                    {
                      linked.filter((p) => p.health === 'at_risk' || p.health === 'off_track')
                        .length
                    }{' '}
                    need attention
                  </p>
                )}
                {linked.map((p) => (
                  <button
                    className="planner-related-link"
                    key={p.id}
                    onClick={() => onProject(p.id)}
                  >
                    {p.name} · {p.health.replaceAll('_', ' ')}
                  </button>
                ))}
                {kind === 'portfolio' && (
                  <PlannerPortfolioBudget id={row.id} onProject={onProject} />
                )}
                {kind === 'rule' && (
                  <p>
                    {row.data.enabled ? 'Enabled' : 'Paused'} ·{' '}
                    {String(row.data.trigger).replaceAll('_', ' ')}
                  </p>
                )}
                {kind === 'form' && <p>{row.data.enabled ? 'Accepting requests' : 'Closed'}</p>}
                <div className="planner-head-actions">
                  {editable(row.access) && (
                    <button
                      onClick={() => {
                        actions.resource.reset();
                        setEditor(row);
                      }}
                    >
                      Edit
                    </button>
                  )}
                  {row.access === 'admin' && (
                    <button
                      disabled={actions.resource.isPending}
                      onClick={() =>
                        actions.resource.mutate({
                          id: row.id,
                          version: row.version,
                          archived: !row.archived,
                        })
                      }
                    >
                      {archived ? 'Restore' : 'Archive'}
                    </button>
                  )}
                  {kind === 'template' && !archived && (
                    <button
                      onClick={() => {
                        actions.instantiate.reset();
                        setName(`${row.name} project`);
                        setAnchorOn('');
                        setUsing(row);
                      }}
                    >
                      Use template
                    </button>
                  )}
                  {kind === 'form' && !archived && row.data.enabled === true && (
                    <button
                      onClick={() => {
                        actions.submitForm.reset();
                        setUsing(row);
                      }}
                    >
                      Open form
                    </button>
                  )}
                  {kind === 'form' && !archived && editable(row.access) && (
                    <button
                      disabled={actions.resource.isPending}
                      onClick={() =>
                        actions.resource.mutate({
                          kind: 'form',
                          projectId: row.projectId,
                          name: `${row.name} copy`.slice(0, 500),
                          data: plannerDuplicateFormData(
                            row.data as unknown as PlannerFormData,
                          ) as unknown as Record<string, unknown>,
                        })
                      }
                    >
                      Duplicate form
                    </button>
                  )}
                  {kind === 'goal' && !archived && editable(row.access) && (
                    <button
                      disabled={actions.resource.isPending}
                      onClick={() => {
                        const data = structuredClone(row.data) as unknown as PlannerGoalData;
                        data.privacy = 'private';
                        data.members = [];
                        data.followers = [];
                        data.reminder = null;
                        data.ownerId = bootstrap.me.id;
                        data.projectIds = data.projectIds.filter((id) =>
                          bootstrap.projects.some((p) => p.id === id && !p.archived),
                        );
                        data.subgoalIds = (data.subgoalIds ?? []).filter((id) =>
                          query.data?.some((g) => g.id === id && !g.archived),
                        );
                        // The resource response already filters task connections by current access
                        // and archive state. Preserve them while task-name pages are still loading.
                        data.taskIds = data.taskIds ?? [];
                        if (data.weightMode === 'custom') {
                          data.weights = plannerGoalWeights(data, plannerGoalSourceIds(data));
                          if (
                            Math.abs(data.weights.reduce((sum, w) => sum + w.weight, 0) - 100) >
                            0.000001
                          ) {
                            data.weightMode = 'equal';
                            data.weights = [];
                          }
                        }
                        actions.resource.mutate({
                          kind: 'goal',
                          name: `${row.name} copy`.slice(0, 500),
                          data: data as unknown as Record<string, unknown>,
                        });
                      }}
                    >
                      Duplicate goal
                    </button>
                  )}
                  {kind === 'form' && !archived && editable(row.access) && (
                    <>
                      <button
                        disabled={
                          actions.shareForm.isPending ||
                          row.data.enabled !== true ||
                          row.data.audience === 'organization'
                        }
                        onClick={async () => {
                          try {
                            const result = await actions.shareForm.mutateAsync({
                              id: row.id,
                              version: row.version,
                              enabled: true,
                            });
                            setShareLink({
                              formId: row.id,
                              url: `${window.location.origin}/planner/forms/${result.token}`,
                            });
                          } catch {}
                        }}
                      >
                        {row.publicShared ? 'Create new public link' : 'Create public link'}
                      </button>
                      {row.publicShared && (
                        <button
                          disabled={actions.shareForm.isPending}
                          onClick={async () => {
                            try {
                              await actions.shareForm.mutateAsync({
                                id: row.id,
                                version: row.version,
                                enabled: false,
                              });
                              setShareLink(null);
                            } catch {}
                          }}
                        >
                          Revoke public link
                        </button>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {!query.isPending && !rows.length && (
        <div className="planner-empty">
          <h3>
            {goalFiltered ? (
              'No goals match these filters'
            ) : (
              <>
                No {archived ? 'archived ' : ''}
                {kind}s yet
              </>
            )}
          </h3>
          <p>
            {goalFiltered
              ? 'Try different filters to find your goals.'
              : 'Create one to organize your team’s work.'}
          </p>
        </div>
      )}
      {editor && (
        <ResourceEditor
          kind={kind}
          resource={editor === 'new' ? undefined : editor}
          bootstrap={bootstrap}
          tasks={tasks}
          onClose={() => setEditor(null)}
        />
      )}
      {goalDetail && kind === 'goal' && (
        <ModalFrame title="Goal details" onClose={() => openGoal(null)}>
          <div className="planner-dialog-body planner-goal-body">
            <PlannerGoalDetail
              key={goalDetail.id}
              goal={goalDetail}
              goals={query.data ?? []}
              bootstrap={bootstrap}
              tasks={tasks}
              onGoal={openGoal}
              onProject={(id) => {
                openGoal(null);
                onProject(id);
              }}
              onTask={(id) => {
                openGoal(null);
                onTask(id);
              }}
              onEdit={() => {
                actions.resource.reset();
                setEditor(goalDetail);
                openGoal(null);
              }}
            />
            <PlannerGoalActivity
              key={`activity:${goalDetail.id}`}
              goal={goalDetail}
              bootstrap={bootstrap}
            />
          </div>
        </ModalFrame>
      )}
      {using && kind === 'template' && (
        <ModalFrame title="Create project from template" onClose={() => setUsing(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const project = await actions.instantiate.mutateAsync({
                  id: using.id,
                  name,
                  ...(using.data.schedule ? { anchorOn } : {}),
                });
                setUsing(null);
                onProject(project.id);
              } catch {}
            }}
          >
            <div className="planner-dialog-body">
              <Field name="Project name">
                <input required value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Alert error={actions.instantiate.error} />
              {using.data.schedule != null && (
                <>
                  <Field
                    name={
                      (using.data as unknown as PlannerTemplateData).schedule?.anchor === 'due'
                        ? 'Project due date'
                        : 'Project start date'
                    }
                  >
                    <input
                      type="date"
                      required
                      value={anchorOn}
                      onInput={(e) => setAnchorOn(e.currentTarget.value)}
                    />
                  </Field>
                  {plannerCalendarDate(anchorOn) && (
                    <div
                      className="planner-template-offsets"
                      aria-label="Template schedule preview"
                    >
                      {plannerTemplateSchedule(
                        using.data as unknown as PlannerTemplateData,
                        anchorOn,
                      ).tasks.map((task, index) => (
                        <p key={index}>
                          {task.name}: {task.startOn ?? 'No start'} → {task.dueOn ?? 'No due date'}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <footer className="planner-dialog-footer">
              <button className="planner-primary" disabled={actions.instantiate.isPending}>
                Create project
              </button>
            </footer>
          </form>
        </ModalFrame>
      )}
      {using && kind === 'form' && (
        <FormSubmission
          resource={using}
          onClose={() => setUsing(null)}
          onSaved={(id) => {
            setUsing(null);
            onTask(id);
          }}
        />
      )}
    </div>
  );
}

function ResourceEditor({
  kind,
  resource,
  bootstrap,
  tasks,
  onClose,
}: {
  kind: PlannerResourceKind;
  resource?: PlannerResource;
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  onClose: () => void;
}) {
  const actions = usePlannerMutations();
  const resources = usePlannerResources();
  const [name, setName] = useState(resource?.name ?? '');
  const [projectId, setProjectId] = useState(resource?.projectId ?? '');
  const [data, setData] = useState<Record<string, unknown>>(() =>
    structuredClone(
      resource?.data ?? {
        ...plannerResourceDefaults(kind),
        ...(kind === 'goal' ? { ownerId: bootstrap.me.id } : {}),
      },
    ),
  );
  const edit = (patch: Record<string, unknown>) => setData((old) => ({ ...old, ...patch }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const patch = Object.fromEntries(
        Object.entries(data).filter(
          ([key, value]) =>
            !resource || JSON.stringify(resource.data[key]) !== JSON.stringify(value),
        ),
      );
      await actions.resource.mutateAsync({
        id: resource?.id,
        version: resource?.version,
        kind,
        projectId: projectId || null,
        name,
        data: patch,
      });
      onClose();
    } catch {}
  };
  const selectedProjects = (data.projectIds ?? []) as string[];
  const rule = data as unknown as PlannerRuleData;
  const form = data as unknown as PlannerFormData;
  return (
    <ModalFrame title={`${resource ? 'Edit' : 'New'} ${kind}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="planner-dialog-body">
          <Field name="Name">
            <input
              required
              maxLength={500}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {['rule', 'form'].includes(kind) && (
            <Field name="Project">
              <select
                required
                disabled={!!resource}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Choose a project</option>
                {bootstrap.projects
                  .filter((p) => !p.archived && editable(p.access))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {kind !== 'rule' && (
            <Field name="Description">
              <textarea
                rows={3}
                value={String(data.description ?? '')}
                onChange={(e) => edit({ description: e.target.value })}
              />
            </Field>
          )}
          {['portfolio', 'goal', 'template'].includes(kind) && (
            <>
              <Field name="Visibility">
                <select
                  disabled={!!resource && resource.access !== 'admin'}
                  value={String(data.privacy)}
                  onChange={(e) => edit({ privacy: e.target.value })}
                >
                  <option value="private">Private to members</option>
                  <option value="team">Shared with your team</option>
                </select>
              </Field>
              <details>
                <summary>Members and permissions</summary>
                {bootstrap.people.map((person) => {
                  const members = data.members as { userId: string; role: string }[];
                  const member = members.find((m) => m.userId === person.id);
                  return (
                    <Field key={person.id} name={person.name}>
                      <select
                        disabled={!!resource && resource.access !== 'admin'}
                        value={member?.role ?? ''}
                        onChange={(e) =>
                          edit({
                            members: [
                              ...members.filter((m) => m.userId !== person.id),
                              ...(e.target.value
                                ? [{ userId: person.id, role: e.target.value }]
                                : []),
                            ],
                          })
                        }
                      >
                        <option value="">No explicit grant</option>
                        {['admin', 'editor', 'commenter', 'viewer'].map((role) => (
                          <option key={role}>{role}</option>
                        ))}
                      </select>
                    </Field>
                  );
                })}
              </details>
            </>
          )}
          {kind === 'portfolio' && (
            <Field name="Projects">
              <select
                multiple
                value={selectedProjects}
                onChange={(e) =>
                  edit({ projectIds: Array.from(e.target.selectedOptions, (o) => o.value) })
                }
              >
                {bootstrap.projects
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {kind === 'goal' && (
            <PlannerGoalEditor
              goal={data as unknown as PlannerGoalData}
              id={resource?.id}
              goals={resources.data ?? []}
              bootstrap={bootstrap}
              tasks={tasks}
              edit={edit}
            />
          )}
          {kind === 'template' && (
            <>
              <Field name="Copy project structure and tasks">
                <select
                  defaultValue=""
                  onChange={(e) => {
                    const p = bootstrap.projects.find((p) => p.id === e.target.value);
                    if (!p) return;
                    const project = Object.fromEntries(
                      Object.keys(PLANNER_DEFAULT_PROJECT).map((k) => [
                        k,
                        p[k as keyof PlannerProjectData],
                      ]),
                    );
                    const copied = tasks
                      .filter((t) => t.memberships.some((m) => m.projectId === p.id))
                      .sort(
                        (a, b) =>
                          (a.memberships.find((m) => m.projectId === p.id)?.position ?? 0) -
                          (b.memberships.find((m) => m.projectId === p.id)?.position ?? 0),
                      );
                    edit({
                      project: { ...project, clientId: null, members: [] },
                      schedule: undefined,
                      layout: copied.map((t) => ({
                        sectionId:
                          t.memberships.find((m) => m.projectId === p.id)?.sectionId ?? null,
                        parentIndex:
                          t.parentId && copied.some((p) => p.id === t.parentId)
                            ? copied.findIndex((p) => p.id === t.parentId)
                            : null,
                        dependencyIndices: t.dependencies
                          .map((id) => copied.findIndex((t) => t.id === id))
                          .filter((i) => i >= 0),
                      })),
                      tasks: copied.map((t) => ({
                        ...Object.fromEntries(
                          Object.keys(PLANNER_DEFAULT_TASK).map((k) => [
                            k,
                            t[k as keyof PlannerTaskData],
                          ]),
                        ),
                        memberships: [],
                        parentId: null,
                        dependencies: [],
                        clientId: null,
                        meetingId: null,
                        customValues: Object.fromEntries(
                          Object.entries(t.customValues).filter(([id]) =>
                            p.fields.some((f) => f.id === id),
                          ),
                        ),
                      })),
                    });
                  }}
                >
                  <option value="">Choose an existing project</option>
                  {bootstrap.projects
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </Field>
              <PlannerTemplateScheduleEditor
                config={data as unknown as PlannerTemplateData}
                onChange={(schedule) => edit({ schedule })}
              />
              <p>
                {(data.tasks as unknown[]).length} tasks ·{' '}
                {(data.project as PlannerProjectData).sections.length} sections ·{' '}
                {(data.project as PlannerProjectData).fields.length} custom fields
              </p>
              <p className="planner-muted">
                Copies visible tasks, subtasks, dependencies, sections, and custom fields. New
                projects receive fresh IDs.
              </p>
            </>
          )}
          {kind === 'rule' && (
            <>
              <Field name="Enabled">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => edit({ enabled: e.target.checked })}
                />
              </Field>
              <Field name="When">
                <select
                  value={rule.trigger}
                  onChange={(e) => {
                    const trigger = e.target.value;
                    const scheduled = ['due_approaching', 'overdue'].includes(trigger);
                    edit({
                      trigger,
                      schedule: scheduled
                        ? (rule.schedule ?? { amount: 0, unit: 'days' })
                        : undefined,
                      actions: scheduled
                        ? rule.actions
                        : Object.fromEntries(
                            Object.entries(rule.actions).filter(([k]) => k !== 'notify'),
                          ),
                    });
                  }}
                >
                  {[
                    'created',
                    'status_changed',
                    'priority_changed',
                    'section_changed',
                    'due_approaching',
                    'overdue',
                  ].map((t) => (
                    <option key={t} value={t}>
                      {t.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              {['due_approaching', 'overdue'].includes(rule.trigger) && (
                <div className="planner-form-grid">
                  <Field name={rule.trigger === 'overdue' ? 'After due date' : 'Before due date'}>
                    <input
                      type="number"
                      min={0}
                      max={
                        rule.schedule?.unit === 'days'
                          ? 365
                          : rule.schedule?.unit === 'hours'
                            ? 8760
                            : 525600
                      }
                      value={rule.schedule?.amount ?? 0}
                      onChange={(e) =>
                        edit({
                          schedule: {
                            unit: rule.schedule?.unit ?? 'days',
                            amount: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </Field>
                  <Field name="Offset unit">
                    <select
                      value={rule.schedule?.unit ?? 'days'}
                      onChange={(e) => edit({ schedule: { amount: 0, unit: e.target.value } })}
                    >
                      <option value="days">Calendar days</option>
                      <option value="hours">Hours</option>
                      <option value="minutes">Minutes</option>
                    </select>
                  </Field>
                  <Field name="Send Planner reminder">
                    <input
                      type="checkbox"
                      checked={rule.actions.notify ?? false}
                      onChange={(e) =>
                        edit({ actions: { ...rule.actions, notify: e.target.checked } })
                      }
                    />
                  </Field>
                </div>
              )}
              <h3>Only when</h3>
              <div className="planner-form-grid">
                <Field name="Status condition">
                  <select
                    value={rule.conditions.status ?? ''}
                    onChange={(e) =>
                      edit({
                        conditions: e.target.value
                          ? { ...rule.conditions, status: e.target.value }
                          : Object.fromEntries(
                              Object.entries(rule.conditions).filter(([k]) => k !== 'status'),
                            ),
                      })
                    }
                  >
                    <option value="">Any status</option>
                    {Object.entries(PLANNER_STATUS_LABELS).map(([s, label]) => (
                      <option key={s} value={s}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field name="Priority condition">
                  <select
                    value={rule.conditions.priority ?? ''}
                    onChange={(e) =>
                      edit({
                        conditions: e.target.value
                          ? { ...rule.conditions, priority: e.target.value }
                          : Object.fromEntries(
                              Object.entries(rule.conditions).filter(([k]) => k !== 'priority'),
                            ),
                      })
                    }
                  >
                    <option value="">Any priority</option>
                    {['none', 'low', 'medium', 'high'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <h3>Then</h3>
              <div className="planner-form-grid">
                <Field name="Set status">
                  <select
                    value={rule.actions.status ?? ''}
                    onChange={(e) =>
                      edit({
                        actions: e.target.value
                          ? { ...rule.actions, status: e.target.value }
                          : Object.fromEntries(
                              Object.entries(rule.actions).filter(([k]) => k !== 'status'),
                            ),
                      })
                    }
                  >
                    <option value="">Keep status</option>
                    {Object.entries(PLANNER_STATUS_LABELS).map(([s, label]) => (
                      <option key={s} value={s}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field name="Set priority">
                  <select
                    value={rule.actions.priority ?? ''}
                    onChange={(e) =>
                      edit({
                        actions: e.target.value
                          ? { ...rule.actions, priority: e.target.value }
                          : Object.fromEntries(
                              Object.entries(rule.actions).filter(([k]) => k !== 'priority'),
                            ),
                      })
                    }
                  >
                    <option value="">Keep priority</option>
                    {['none', 'low', 'medium', 'high'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </Field>
                <Field name="Assign to">
                  <select
                    value={
                      rule.actions.assigneeId === undefined
                        ? 'keep'
                        : (rule.actions.assigneeId ?? '')
                    }
                    onChange={(e) =>
                      edit({
                        actions:
                          e.target.value === 'keep'
                            ? Object.fromEntries(
                                Object.entries(rule.actions).filter(([k]) => k !== 'assigneeId'),
                              )
                            : { ...rule.actions, assigneeId: e.target.value || null },
                      })
                    }
                  >
                    <option value="keep">Keep assignee</option>
                    <option value="">Unassign</option>
                    {bootstrap.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field name="Move to section">
                  <select
                    value={
                      rule.actions.sectionId === undefined ? 'keep' : (rule.actions.sectionId ?? '')
                    }
                    onChange={(e) =>
                      edit({
                        actions:
                          e.target.value === 'keep'
                            ? Object.fromEntries(
                                Object.entries(rule.actions).filter(([k]) => k !== 'sectionId'),
                              )
                            : { ...rule.actions, sectionId: e.target.value || null },
                      })
                    }
                  >
                    <option value="keep">Keep section</option>
                    <option value="">Unsectioned</option>
                    {bootstrap.projects
                      .find((p) => p.id === projectId)
                      ?.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <p className="planner-muted">
                Date rules run automatically once per due schedule on unfinished top-level tasks.
                Calendar days use the task’s time zone (UTC when unset). Reminders appear in Planner
                Inbox and Capiro’s bell. Other rules run once per task change, in creation order.
              </p>
            </>
          )}
          {kind === 'form' && (
            <PlannerFormBuilder
              form={form}
              edit={edit}
              project={bootstrap.projects.find((project) => project.id === projectId)}
              people={bootstrap.people}
            />
          )}
          <Alert error={actions.resource.error} />
        </div>
        <footer className="planner-dialog-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="planner-primary" disabled={actions.resource.isPending}>
            {actions.resource.isPending ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

function FormSubmission({
  resource,
  onClose,
  onSaved,
}: {
  resource: PlannerResource;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const form = resource.data as unknown as PlannerFormData;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<PlannerFormFiles>({});
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState<string | null>(null);
  const [draft, setDraft] = useState(0);
  const sending = useRef(false);
  const actions = usePlannerMutations();
  return (
    <ModalFrame title={resource.name} onClose={onClose}>
      {received ? (
        <div className="planner-dialog-body">
          <h3>Request received</h3>
          <p className="planner-form-message">
            {form.confirmationMessage || 'Your response has been sent to the team.'}
          </p>
          <div className="planner-head-actions">
            <button type="button" className="planner-primary" onClick={() => onSaved(received)}>
              Open created task
            </button>
            {form.allowAnotherSubmission && (
              <button
                type="button"
                onClick={() => {
                  setReceived(null);
                  setAnswers({});
                  setFiles({});
                  setError(null);
                  setDraft((old) => old + 1);
                  actions.submitForm.reset();
                }}
              >
                Submit another response
              </button>
            )}
          </div>
        </div>
      ) : (
        <form
          key={draft}
          onSubmit={async (event) => {
            event.preventDefault();
            if (sending.current) return;
            const problem = plannerFormSubmissionError(form.fields, answers, files);
            setError(problem);
            if (problem) return;
            sending.current = true;
            try {
              const task = await actions.submitForm.mutateAsync({
                id: resource.id,
                fields: form.fields,
                answers,
                files,
              });
              setReceived(task.id);
            } catch {
            } finally {
              sending.current = false;
            }
          }}
        >
          <div className="planner-dialog-body">
            <p className="planner-form-message">{form.description}</p>
            <PlannerFormQuestions
              fields={form.fields}
              answers={answers}
              setAnswers={setAnswers}
              files={files}
              setFiles={setFiles}
            />
            {error && (
              <p role="alert" className="planner-error">
                {error}
              </p>
            )}
            <Alert error={actions.submitForm.error} />
          </div>
          <footer className="planner-dialog-footer">
            <button className="planner-primary" disabled={actions.submitForm.isPending}>
              {actions.submitForm.isPending ? 'Sending…' : 'Submit request'}
            </button>
          </footer>
        </form>
      )}
    </ModalFrame>
  );
}

export function PlannerProjectActivity({
  projectId,
  bootstrap,
  canEdit,
  access,
}: {
  projectId: string;
  bootstrap: PlannerBootstrap;
  canEdit: boolean;
  access: PlannerRole;
}) {
  const query = usePlannerEvents(undefined, projectId);
  const actions = usePlannerMutations();
  const [text, setText] = useState('');
  return (
    <details className="planner-project-activity">
      <summary>Project updates and activity</summary>
      <Alert error={query.error || actions.event.error} />
      {canEdit && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await actions.event.mutateAsync({ projectId, kind: 'status', text });
              setText('');
            } catch {}
          }}
        >
          <Field name="Status update">
            <PlannerRichText
              label="Status update"
              rows={3}
              maxLength={20000}
              value={text}
              onChange={setText}
            />
          </Field>
          <button disabled={actions.event.isPending || !text.trim()}>Post update</button>
        </form>
      )}
      {query.data?.pages
        .flatMap((page) => page.items)
        .map((e) => (
          <PlannerActivity
            key={e.id}
            event={e}
            author={bootstrap.people.find((p) => p.id === e.actorId)?.name ?? 'Team member'}
            me={bootstrap.me.id}
            access={access}
            mutation={actions.reviseEvent}
            timeOptions={bootstrap.timeOptions}
            timeAdmin={bootstrap.timeAdmin}
          />
        ))}
      {query.hasNextPage && (
        <button disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading older updates…' : 'Load older updates'}
        </button>
      )}
    </details>
  );
}
