import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ModalOverlay, Modal, Dialog, Heading } from 'react-aria-components';
import { ArrowLeft, BarChart3, Plus, RefreshCw, X } from 'lucide-react';
import {
  PLANNER_DEFAULT_REPORT_CHART,
  PLANNER_REPORT_OPTIONS,
  type PlannerBootstrap,
  type PlannerDashboardData,
  type PlannerField,
  type PlannerResource,
  type PlannerReportChart,
  type PlannerReportWidget,
  type PlannerReportResult,
  type PlannerReportResponse,
  type PlannerReportRow,
  type PlannerReportBucket,
} from '@capiro/strategy-verifier';
import {
  usePlannerResources,
  usePlannerMutations,
  usePlannerReport,
  usePlannerReportRows,
  usePlannerKey,
  plannerError,
} from './planner-api.js';
import { useApi } from '../../../lib/use-api.js';
import { PlannerRichText, PlannerFormattedText } from './planner-rich-text.js';
import { plannerCsvCell } from './planner-csv.js';

const editable = (role: string) => ['admin', 'editor'].includes(role);
const label = (value: string) =>
  value
    .split('_')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
const metrics: Record<PlannerReportChart['metric'], string> = {
  count: 'Count',
  estimated_minutes: 'Estimated time',
  actual_minutes: 'Time logged',
  progress: 'Average progress',
  project_count: 'Distinct projects',
  custom_number: 'Sum of numeric field',
};
const groups: Record<PlannerReportChart['group'], string> = {
  none: 'No grouping',
  status: 'Status',
  owner: 'Owner',
  assignee: 'Assignee',
  priority: 'Priority',
  type: 'Type',
  project: 'Project',
  tag: 'Tag',
  custom: 'Custom field',
  created: 'Created date',
  due: 'Due date',
  completed: 'Completed date',
  period: 'Goal time period',
};
const colors = ['#7565dd', '#54a59a', '#e2ab52', '#7294cb', '#c57598', '#8b9c61'];
export function plannerReportNumber(value: number | null, unit: PlannerReportResult['unit']) {
  if (value === null) return 'Unavailable';
  if (unit === 'minutes')
    return `${(value / 60).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit === 'percent' ? '%' : ''}`;
}
export function plannerReportLink(row: PlannerReportRow) {
  if (row.entity === 'tasks') return `/planner?scope=all&task=${encodeURIComponent(row.id)}`;
  if (row.entity === 'projects')
    return `/planner?scope=project&project=${encodeURIComponent(row.id)}`;
  return `/planner?scope=${row.entity}&${row.entity === 'goals' ? 'goal' : 'portfolio'}=${encodeURIComponent(row.id)}`;
}
export function plannerReportCsv(rows: PlannerReportRow[], unit: PlannerReportResult['unit']) {
  return [
    ['Name', 'Entity', 'Status', 'Person', 'Due date', `Value (${unit})`, 'Link'],
    ...rows.map((r) => [
      r.name,
      r.entity,
      r.status,
      r.personName,
      r.dueOn,
      r.value,
      plannerReportLink(r),
    ]),
  ]
    .map((row) => row.map(plannerCsvCell).join(','))
    .join('\r\n');
}
function Alert({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="planner-error">
      {plannerError(error)}
    </p>
  ) : null;
}
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
      <Modal className="planner-modal planner-report-modal">
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
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="planner-field">
      <span>{name}</span>
      {children}
    </label>
  );
}
function Multi({
  name,
  values,
  options,
  onChange,
}: {
  name: string;
  values: string[];
  options: { id: string; name: string }[];
  onChange: (values: string[]) => void;
}) {
  const choices = [
    ...options,
    ...values
      .filter((id) => !options.some((o) => o.id === id))
      .map((id) => ({ id, name: label(id) })),
  ];
  return (
    <Field name={name}>
      <select
        multiple
        value={values}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions, (o) => o.value))}
      >
        {choices.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
function newChart(projectId?: string | null): PlannerReportWidget {
  const chart = structuredClone(PLANNER_DEFAULT_REPORT_CHART);
  chart.filters.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (projectId) chart.filters.source = { kind: 'projects', ids: [projectId] };
  return {
    id: crypto.randomUUID(),
    kind: 'chart',
    title: 'Tasks by status',
    style: 'bar',
    labels: true,
    chart,
  };
}
export function PlannerReporting({
  bootstrap,
  selectedId,
  onSelect,
  projectId,
}: {
  bootstrap: PlannerBootstrap;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  projectId?: string | null;
}) {
  const query = usePlannerResources(),
    actions = usePlannerMutations();
  const client = useQueryClient(),
    key = usePlannerKey();
  const [archived, setArchived] = useState(false),
    [search, setSearch] = useState('');
  const [editor, setEditor] = useState<PlannerResource | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const project = bootstrap.projects.find((p) => p.id === projectId);
  const canCreate = !projectId || (!!project && !project.archived && editable(project.access));
  const dashboards =
    query.data?.filter(
      (r) => r.kind === 'dashboard' && (!projectId || r.projectId === projectId),
    ) ?? [];
  const selected = dashboards.find((r) => r.id === selectedId);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
  };
  const copy = async (row: PlannerResource) => {
    setError(null);
    try {
      const data = row.data as unknown as PlannerDashboardData;
      const created = await actions.resource.mutateAsync({
        kind: 'dashboard',
        projectId: row.projectId,
        name: `${row.name} (copy)`,
        data: {
          description: data.description,
          privacy: 'private',
          members: [],
          widgets: data.widgets.map((w) => ({ ...structuredClone(w), id: crypto.randomUUID() })),
        },
      });
      onSelect(created.id);
    } catch (e) {
      setError(e);
    }
  };
  if (query.isPending) return <p role="status">Loading saved dashboards…</p>;
  if (query.isError)
    return (
      <>
        <Alert error={query.error} />
        <button onClick={refresh}>Retry dashboards</button>
      </>
    );
  const currentEditor =
    typeof editor === 'object' && editor ? dashboards.find((r) => r.id === editor.id) : null;
  return (
    <div className="planner-reporting">
      <div className="planner-report-actions">
        {selectedId && (
          <button onClick={() => onSelect(null)}>
            <ArrowLeft size={15} /> All dashboards
          </button>
        )}
        <div className="planner-report-actions-spacer" />
        {!selectedId && (
          <input
            aria-label="Search dashboards"
            placeholder="Search dashboards"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        {!selectedId && (
          <button onClick={() => setArchived(!archived)}>
            {archived ? 'Active dashboards' : 'Archived dashboards'}
          </button>
        )}
        <button aria-label="Refresh reports" onClick={refresh}>
          <RefreshCw size={16} />
        </button>
        {canCreate && (
          <button
            className="planner-primary"
            onClick={() => {
              setError(null);
              setEditor('new');
            }}
          >
            <Plus size={16} /> New dashboard
          </button>
        )}
      </div>
      <Alert error={error} />
      {selectedId ? (
        selected ? (
          <>
            <div className="planner-report-heading">
              <div>
                <p className="planner-eyebrow">
                  {selected.projectId ? 'PROJECT DASHBOARD' : 'SAVED DASHBOARD'}
                </p>
                <h3>{selected.name}</h3>
                <p>{String(selected.data.description)}</p>
                <small>
                  {selected.data.privacy === 'private' ? 'Private' : 'Shared with team'} · Charts
                  use your current access · Refresh every 30 seconds
                </small>
              </div>
              <div className="planner-report-actions">
                {editable(selected.access) && !selected.archived && (
                  <button onClick={() => setEditor(selected)}>Edit dashboard</button>
                )}
                <button
                  disabled={
                    !!selected.reportWarnings?.length ||
                    (!!selected.projectId &&
                      !editable(
                        project?.access ??
                          bootstrap.projects.find((p) => p.id === selected.projectId)?.access ??
                          '',
                      )) ||
                    actions.resource.isPending
                  }
                  onClick={() => void copy(selected)}
                >
                  Duplicate dashboard
                </button>
                {selected.access === 'admin' && (
                  <button
                    disabled={actions.resource.isPending}
                    onClick={async () => {
                      setError(null);
                      try {
                        await actions.resource.mutateAsync({
                          id: selected.id,
                          version: selected.version,
                          archived: !selected.archived,
                        });
                        onSelect(null);
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    {selected.archived ? 'Restore dashboard' : 'Archive dashboard'}
                  </button>
                )}
              </div>
            </div>
            {selected.archived && (
              <p role="status" className="planner-muted">
                This dashboard is archived. Restore it to edit.
              </p>
            )}
            {selected.reportWarnings?.length ? (
              <p className="planner-report-notice">
                Some saved sources or fields are unavailable. Their criteria remain in this
                dashboard.
              </p>
            ) : null}
            <div className="planner-report-grid">
              {(selected.data.widgets as PlannerReportWidget[]).map((widget) =>
                widget.kind === 'text' ? (
                  <article className="planner-report-widget planner-report-text" key={widget.id}>
                    <h4>{widget.title}</h4>
                    <PlannerFormattedText text={widget.text} />
                  </article>
                ) : (
                  <ReportWidget
                    key={`${selected.id}/${widget.id}/${selected.version}`}
                    dashboard={selected}
                    widget={widget}
                  />
                ),
              )}
            </div>
            {!(selected.data.widgets as PlannerReportWidget[]).length && (
              <div className="planner-empty">
                <BarChart3 size={32} />
                <h3>Add your first chart</h3>
                <p>Edit this dashboard to add charts and notes.</p>
              </div>
            )}
          </>
        ) : (
          <p role="alert">This dashboard is unavailable or your access changed.</p>
        )
      ) : (
        <>
          <p className="planner-muted">
            Build a shared view of progress, priorities, and effort across your work.
          </p>
          <div className="planner-project-grid">
            {dashboards
              .filter(
                (r) =>
                  r.archived === archived && r.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((row) => (
                <button
                  className="planner-report-card"
                  key={row.id}
                  onClick={() => onSelect(row.id)}
                >
                  <span className="planner-project-symbol">
                    <BarChart3 size={23} />
                  </span>
                  <h3>{row.name}</h3>
                  <p>{String(row.data.description) || 'A clear view of your work.'}</p>
                  <small>
                    {(row.data.widgets as PlannerReportWidget[]).length} widgets ·{' '}
                    {row.data.privacy === 'private' ? 'Private' : 'Team'}
                    {row.projectId
                      ? ` · ${bootstrap.projects.find((p) => p.id === row.projectId)?.name ?? 'Project'}`
                      : ''}
                  </small>
                </button>
              ))}
          </div>
          {!dashboards.some((r) => r.archived === archived) && (
            <div className="planner-empty">
              <BarChart3 size={36} />
              <h3>{archived ? 'No archived dashboards' : 'See the bigger picture'}</h3>
              <p>Create a dashboard and choose the work you want to measure.</p>
            </div>
          )}
        </>
      )}
      {editor && (editor === 'new' || (currentEditor && editable(currentEditor.access))) && (
        <PlannerDashboardEditor
          key={editor === 'new' ? `new/${projectId ?? ''}` : editor.id}
          resource={editor === 'new' ? undefined : editor}
          bootstrap={bootstrap}
          resources={query.data ?? []}
          projectId={projectId}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            onSelect(id);
          }}
        />
      )}
    </div>
  );
}

export function PlannerDashboardEditor({
  resource,
  bootstrap,
  resources,
  projectId,
  onClose,
  onSaved,
}: {
  resource?: PlannerResource;
  bootstrap: PlannerBootstrap;
  resources: PlannerResource[];
  projectId?: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const actions = usePlannerMutations();
  const [name, setName] = useState(resource?.name ?? 'Work overview');
  const [data, setData] = useState<PlannerDashboardData>(() =>
    resource
      ? (structuredClone(resource.data) as unknown as PlannerDashboardData)
      : { description: '', privacy: 'private', members: [], widgets: [newChart(projectId)] },
  );
  const [selectedWidget, setSelectedWidget] = useState(data.widgets[0]?.id ?? '');
  const [error, setError] = useState<unknown>(null);
  const edit = (patch: Partial<PlannerDashboardData>) => setData((d) => ({ ...d, ...patch }));
  const selected = data.widgets.find((w) => w.id === selectedWidget);
  const updateWidget = (next: PlannerReportWidget) =>
    edit({ widgets: data.widgets.map((w) => (w.id === next.id ? next : w)) });
  const boundProject = resource?.projectId ?? projectId;
  const add = (kind: 'chart' | 'text') => {
    const widget: PlannerReportWidget =
      kind === 'chart'
        ? newChart(boundProject)
        : { id: crypto.randomUUID(), kind: 'text', title: 'Notes', text: '' };
    edit({ widgets: [...data.widgets, widget] });
    setSelectedWidget(widget.id);
  };
  const move = (index: number, by: number) => {
    const next = [...data.widgets],
      target = index + by;
    [next[index], next[target]] = [next[target]!, next[index]!];
    edit({ widgets: next });
  };
  return (
    <Frame title={resource ? 'Edit dashboard' : 'New dashboard'} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const patch = resource
              ? Object.fromEntries(
                  Object.entries(data).filter(
                    ([k, v]) => JSON.stringify(v) !== JSON.stringify(resource.data[k]),
                  ),
                )
              : data;
            const saved = await actions.resource.mutateAsync({
              id: resource?.id,
              version: resource?.version,
              kind: 'dashboard',
              ...(!resource ? { projectId: boundProject ?? null } : {}),
              name,
              data: patch as unknown as Record<string, unknown>,
            });
            onSaved(saved.id);
          } catch (e) {
            setError(e);
          }
        }}
      >
        <div className="planner-dialog-body planner-report-editor-body">
          <div className="planner-report-settings">
            <Field name="Dashboard name">
              <input
                required
                maxLength={500}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field name="Description">
              <textarea
                rows={2}
                maxLength={50000}
                value={data.description}
                onChange={(e) => edit({ description: e.target.value })}
              />
            </Field>
            {!boundProject && (
              <Field name="Dashboard privacy">
                <select
                  disabled={!!resource && resource.access !== 'admin'}
                  value={data.privacy}
                  onChange={(e) =>
                    edit({ privacy: e.target.value as PlannerDashboardData['privacy'] })
                  }
                >
                  <option value="private">Private</option>
                  <option value="team">Shared with team</option>
                </select>
              </Field>
            )}
            {boundProject ? (
              <p className="planner-muted">
                This dashboard uses the project’s permissions and reports on its tasks.
              </p>
            ) : (
              <details>
                <summary>Members and permissions</summary>
                {bootstrap.people
                  .filter((p) => p.id !== (resource?.ownerId ?? bootstrap.me.id))
                  .map((p) => (
                    <Field key={p.id} name={p.name}>
                      <select
                        disabled={!!resource && resource.access !== 'admin'}
                        value={data.members.find((m) => m.userId === p.id)?.role ?? ''}
                        onChange={(e) =>
                          edit({
                            members: [
                              ...data.members.filter((m) => m.userId !== p.id),
                              ...(e.target.value
                                ? [
                                    {
                                      userId: p.id,
                                      role: e.target
                                        .value as PlannerDashboardData['members'][number]['role'],
                                    },
                                  ]
                                : []),
                            ],
                          })
                        }
                      >
                        <option value="">No explicit grant</option>
                        {['admin', 'editor', 'commenter', 'viewer'].map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </Field>
                  ))}
              </details>
            )}
          </div>
          <div className="planner-report-editor-layout">
            <aside className="planner-widget-list" aria-label="Dashboard widgets">
              <div className="planner-report-actions">
                <button
                  type="button"
                  disabled={data.widgets.length >= 40}
                  onClick={() => add('chart')}
                >
                  <Plus size={14} /> Chart
                </button>
                <button
                  type="button"
                  disabled={data.widgets.length >= 40}
                  onClick={() => add('text')}
                >
                  Text
                </button>
              </div>
              {data.widgets.map((w, i) => (
                <div className="planner-widget-list-item" key={w.id}>
                  <button
                    type="button"
                    aria-pressed={w.id === selectedWidget}
                    onClick={() => setSelectedWidget(w.id)}
                  >
                    {w.title || 'Untitled widget'}
                  </button>
                  <div>
                    <button
                      type="button"
                      aria-label={`Move ${w.title} up`}
                      disabled={!i}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${w.title} down`}
                      disabled={i === data.widgets.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${w.title}`}
                      onClick={() => {
                        edit({ widgets: data.widgets.filter((r) => r.id !== w.id) });
                        if (selectedWidget === w.id)
                          setSelectedWidget(data.widgets.find((r) => r.id !== w.id)?.id ?? '');
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </aside>
            <section className="planner-widget-editor" aria-label="Widget settings">
              {selected ? (
                <>
                  {resource?.reportWarnings?.some((w) => w.widgetId === selected.id) && (
                    <p className="planner-report-notice">
                      Unavailable criteria are retained when you edit visible settings. Replace this
                      widget to start with new criteria.
                    </p>
                  )}
                  <Field name="Widget title">
                    <input
                      required
                      maxLength={500}
                      value={selected.title}
                      onChange={(e) => updateWidget({ ...selected, title: e.target.value })}
                    />
                  </Field>
                  {selected.kind === 'text' ? (
                    <PlannerRichText
                      label="Widget text"
                      value={selected.text}
                      maxLength={20000}
                      onChange={(text) => updateWidget({ ...selected, text })}
                    />
                  ) : (
                    <PlannerReportChartEditor
                      key={selected.id}
                      widget={selected}
                      bootstrap={bootstrap}
                      resources={resources}
                      projectId={boundProject}
                      allowUnavailableFields={resource?.reportWarnings?.some(
                        (w) => w.widgetId === selected.id && w.unavailableFields,
                      )}
                      onChange={updateWidget}
                    />
                  )}
                </>
              ) : (
                <p className="planner-muted">Add a chart or text widget to this dashboard.</p>
              )}
            </section>
          </div>
          <Alert error={error} />
        </div>
        <div className="planner-dialog-footer">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="planner-primary" disabled={actions.resource.isPending}>
            {actions.resource.isPending ? 'Saving…' : 'Save dashboard'}
          </button>
        </div>
      </form>
    </Frame>
  );
}

export function PlannerReportChartEditor({
  widget,
  bootstrap,
  resources,
  projectId,
  allowUnavailableFields,
  onChange,
}: {
  widget: Extract<PlannerReportWidget, { kind: 'chart' }>;
  bootstrap: PlannerBootstrap;
  resources: PlannerResource[];
  projectId?: string | null;
  allowUnavailableFields?: boolean;
  onChange: (widget: PlannerReportWidget) => void;
}) {
  const c = widget.chart,
    f = c.filters,
    options = PLANNER_REPORT_OPTIONS[c.entity];
  const fields = [
    ...new Map(
      bootstrap.projects.flatMap((p) => p.fields).map((field) => [field.id, field]),
    ).values(),
  ];
  const edit = (patch: Partial<PlannerReportChart>) =>
    onChange({ ...widget, chart: { ...c, ...patch } });
  const filter = (patch: Partial<PlannerReportChart['filters']>) =>
    edit({ filters: { ...f, ...patch } });
  const style = (value: typeof widget.style) => {
    onChange({
      ...widget,
      style: value,
      chart: {
        ...c,
        group: value === 'number' ? 'none' : value === 'line' ? 'created' : c.group,
        groupFieldId: value === 'number' || value === 'line' ? null : c.groupFieldId,
      },
    });
  };
  return (
    <>
      <div className="planner-report-field-grid">
        <Field name="Report on">
          <select
            disabled={!!projectId}
            value={c.entity}
            onChange={(e) => {
              const entity = e.target.value as PlannerReportChart['entity'];
              onChange({
                ...widget,
                style: widget.style === 'number' ? 'number' : 'bar',
                chart: {
                  ...structuredClone(PLANNER_DEFAULT_REPORT_CHART),
                  entity,
                  group:
                    widget.style === 'number'
                      ? 'none'
                      : entity === 'portfolios'
                        ? 'owner'
                        : 'status',
                  filters: {
                    ...structuredClone(PLANNER_DEFAULT_REPORT_CHART.filters),
                    source: f.source,
                    timeZone: f.timeZone,
                    dateField: entity === 'portfolios' ? 'created' : 'due',
                  },
                },
              });
            }}
          >
            {Object.keys(PLANNER_REPORT_OPTIONS).map((e) => (
              <option key={e} value={e}>
                {label(e)}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Chart style">
          <select
            value={widget.style}
            onChange={(e) => style(e.target.value as typeof widget.style)}
          >
            {['bar', 'donut', 'line', 'number'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field name="Measure">
          <select
            value={c.metric}
            onChange={(e) =>
              edit({
                metric: e.target.value as PlannerReportChart['metric'],
                metricFieldId:
                  e.target.value === 'custom_number'
                    ? (fields.find((f) => f.type === 'number')?.id ?? null)
                    : null,
              })
            }
          >
            {options.metrics.map((m) => (
              <option key={m} value={m}>
                {metrics[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Group by">
          <select
            disabled={widget.style === 'number'}
            value={c.group}
            onChange={(e) =>
              edit({
                group: e.target.value as PlannerReportChart['group'],
                groupFieldId: e.target.value === 'custom' ? (fields[0]?.id ?? null) : null,
              })
            }
          >
            {options.groups
              .filter((g) => widget.style !== 'line' || ['created', 'due', 'completed'].includes(g))
              .map((g) => (
                <option key={g} value={g}>
                  {groups[g]}
                </option>
              ))}
          </select>
        </Field>
        {c.metric === 'custom_number' && (
          <Field name="Numeric field">
            <select
              required={!allowUnavailableFields}
              value={c.metricFieldId ?? ''}
              onChange={(e) => edit({ metricFieldId: e.target.value })}
            >
              <option value="">
                {allowUnavailableFields ? 'Saved field unavailable' : 'Choose a numeric field'}
              </option>
              {fields
                .filter((f) => f.type === 'number')
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        {c.group === 'custom' && (
          <Field name="Grouping field">
            <select
              required={!allowUnavailableFields}
              value={c.groupFieldId ?? ''}
              onChange={(e) => edit({ groupFieldId: e.target.value })}
            >
              <option value="">
                {allowUnavailableFields ? 'Saved field unavailable' : 'Choose a field'}
              </option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {['created', 'due', 'completed'].includes(c.group) && (
          <Field name="Date grouping">
            <select
              value={c.granularity}
              onChange={(e) =>
                edit({ granularity: e.target.value as PlannerReportChart['granularity'] })
              }
            >
              {['day', 'week', 'month', 'quarter', 'year'].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <label className="planner-report-check">
        <input
          type="checkbox"
          checked={widget.labels}
          onChange={(e) => onChange({ ...widget, labels: e.target.checked })}
        />{' '}
        Show values on chart
      </label>
      {['estimated_minutes', 'actual_minutes'].includes(c.metric) && (
        <p className="planner-muted">
          Time on matching tasks. Date filters select tasks by their dates.
        </p>
      )}
      {c.metric === 'progress' && (
        <p className="planner-muted">
          The average of each matching {c.entity === 'goals' ? 'goal’s' : 'project’s'} current
          progress.
        </p>
      )}
      <h4>Sources and filters</h4>
      {!projectId && (
        <Field name="Source">
          <select
            value={f.source.kind}
            onChange={(e) =>
              filter({ source: { kind: e.target.value as typeof f.source.kind, ids: [] } })
            }
          >
            <option value="all">All work visible to me</option>
            <option value="projects">Selected projects</option>
            <option value="portfolios">Selected portfolios</option>
          </select>
        </Field>
      )}
      {!projectId && f.source.kind !== 'all' && (
        <Multi
          name={f.source.kind === 'projects' ? 'Source projects' : 'Source portfolios'}
          values={f.source.ids}
          options={
            f.source.kind === 'projects'
              ? bootstrap.projects.filter((p) => !p.archived || f.source.ids.includes(p.id))
              : resources.filter(
                  (r) => r.kind === 'portfolio' && (!r.archived || f.source.ids.includes(r.id)),
                )
          }
          onChange={(ids) => filter({ source: { ...f.source, ids } })}
        />
      )}
      <p className="planner-muted">
        Leave a filter empty to include all values. Multiple choices within a filter match any
        choice; different filters apply together.
      </p>
      <div className="planner-report-field-grid">
        {options.statuses.length > 0 && (
          <Multi
            name="Statuses"
            values={f.statuses}
            options={options.statuses.map((id) => ({ id, name: label(id) }))}
            onChange={(statuses) => filter({ statuses })}
          />
        )}
        <Multi
          name={c.entity === 'tasks' ? 'Assignees' : 'Owners'}
          values={f.personIds}
          options={[{ id: 'unassigned', name: 'Unassigned' }, ...bootstrap.people]}
          onChange={(personIds) => filter({ personIds })}
        />
        {options.types.length > 0 && (
          <Multi
            name="Types"
            values={f.types}
            options={options.types.map((id) => ({ id, name: label(id) }))}
            onChange={(types) => filter({ types })}
          />
        )}
        {c.entity === 'tasks' && (
          <Multi
            name="Priorities"
            values={f.priorities}
            options={['none', 'low', 'medium', 'high'].map((id) => ({ id, name: label(id) }))}
            onChange={(priorities) => filter({ priorities })}
          />
        )}
        <Field name="Filter date">
          <select
            value={f.dateField}
            onChange={(e) => filter({ dateField: e.target.value as typeof f.dateField })}
          >
            {(c.entity === 'portfolios'
              ? ['created']
              : c.entity === 'tasks'
                ? ['created', 'start', 'due', 'completed']
                : ['created', 'start', 'due']
            ).map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Time zone">
          <input
            required
            value={f.timeZone}
            onChange={(e) => filter({ timeZone: e.target.value })}
          />
        </Field>
        <Field name="From date">
          <input
            type="date"
            value={f.from ?? ''}
            onInput={(e) => filter({ from: e.currentTarget.value || null })}
            onChange={(e) => filter({ from: e.target.value || null })}
          />
        </Field>
        <Field name="Through date">
          <input
            type="date"
            min={f.from ?? undefined}
            value={f.through ?? ''}
            onInput={(e) => filter({ through: e.currentTarget.value || null })}
            onChange={(e) => filter({ through: e.target.value || null })}
          />
        </Field>
      </div>
      {c.entity === 'tasks' && (
        <>
          <label className="planner-report-check">
            <input
              type="checkbox"
              checked={f.includeSubtasks}
              onChange={(e) => filter({ includeSubtasks: e.target.checked })}
            />{' '}
            Include subtasks
          </label>
          <TagFilter values={f.tags} onChange={(tags) => filter({ tags })} />
          <details>
            <summary>Custom field filters</summary>
            {f.custom.map((filterRow) => (
              <div className="planner-custom-report-filter" key={filterRow.fieldId}>
                <CustomFilter
                  field={fields.find((f) => f.id === filterRow.fieldId)}
                  values={filterRow.values}
                  onChange={(values) =>
                    filter({
                      custom: f.custom.map((r) =>
                        r.fieldId === filterRow.fieldId ? { ...r, values } : r,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  onClick={() =>
                    filter({ custom: f.custom.filter((r) => r.fieldId !== filterRow.fieldId) })
                  }
                >
                  Remove filter
                </button>
              </div>
            ))}
            <Field name="Add field filter">
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    filter({ custom: [...f.custom, { fieldId: e.target.value, values: [] }] });
                }}
              >
                <option value="">Choose a field</option>
                {fields
                  .filter((field) => !f.custom.some((f) => f.fieldId === field.id))
                  .map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
              </select>
            </Field>
          </details>
        </>
      )}
    </>
  );
}
function TagFilter({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join('\n'));
  return (
    <Field name="Tags (one per line)">
      <textarea
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange([...new Set(e.target.value.split('\n').filter(Boolean))]);
        }}
      />
    </Field>
  );
}
function CustomFilter({
  field,
  values,
  onChange,
}: {
  field?: PlannerField;
  values: (string | number)[];
  onChange: (values: (string | number)[]) => void;
}) {
  const [text, setText] = useState(values.join('\n'));
  if (field?.type === 'select' || field?.type === 'multi_select')
    return (
      <Multi
        name={`${field.name} values`}
        values={values.map(String)}
        options={field.options.map((id) => ({ id, name: id }))}
        onChange={onChange}
      />
    );
  return (
    <Field name={`${field?.name ?? 'Field'} values (one per line)`}>
      <textarea
        required
        rows={3}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const chosen = e.target.value.split('\n').filter((v) => v.trim());
          const numbers = chosen.map(Number);
          e.target.setCustomValidity(
            field?.type === 'number' && numbers.some((v) => !Number.isFinite(v))
              ? 'Enter numeric values, one per line.'
              : '',
          );
          onChange(field?.type === 'number' ? numbers : chosen);
        }}
      />
    </Field>
  );
}

function ReportWidget({
  dashboard,
  widget,
}: {
  dashboard: PlannerResource;
  widget: Extract<PlannerReportWidget, { kind: 'chart' }>;
}) {
  const query = usePlannerReport(dashboard.id, widget.id, dashboard.version);
  const [drill, setDrill] = useState<{ key?: string; label: string } | null>(null);
  return (
    <article className="planner-report-widget">
      <div className="planner-report-widget-head">
        <h4>{widget.title}</h4>
        <small>{metrics[widget.chart.metric]}</small>
      </div>
      {query.isPending ? (
        <p role="status">Loading chart…</p>
      ) : query.isError ? (
        <>
          <Alert error={query.error} />
          <button onClick={() => void query.refetch()}>Retry chart</button>
        </>
      ) : query.data ? (
        <>
          <div className="planner-report-total">
            <strong>{plannerReportNumber(query.data.total, query.data.unit)}</strong>
            <span>
              {query.data.matched === null
                ? 'Saved field unavailable'
                : `${query.data.matched} matching ${widget.chart.entity}`}
            </span>
          </div>
          {query.data.unavailableSources && (
            <p className="planner-report-notice">
              Some saved sources are unavailable. Results cover the sources you can access.
            </p>
          )}
          {query.data.unavailableFields ? (
            <p className="planner-report-notice">
              A saved field is unavailable. Update the chart or restore your access to evaluate it.
            </p>
          ) : (
            <>
              {query.data.overlapping && (
                <p className="planner-muted">
                  An item can appear in several groups. The total counts shared work once.
                </p>
              )}
              <PlannerReportGraphic
                widget={widget}
                result={query.data}
                onBucket={(bucket) => setDrill({ key: bucket.key, label: bucket.label })}
              />
              <button
                className="planner-report-results-button"
                onClick={() => setDrill({ label: 'All matching work' })}
              >
                View matching work
              </button>
            </>
          )}
        </>
      ) : null}
      {drill && !query.isError && !query.data?.unavailableFields && (
        <ReportDrilldown
          dashboard={dashboard}
          widget={widget}
          bucket={drill.key}
          title={drill.label}
          onClose={() => setDrill(null)}
        />
      )}
    </article>
  );
}

export function PlannerReportGraphic({
  widget,
  result,
  onBucket,
}: {
  widget: Extract<PlannerReportWidget, { kind: 'chart' }>;
  result: PlannerReportResult;
  onBucket: (bucket: PlannerReportBucket) => void;
}) {
  const [page, setPage] = useState(0);
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(result.buckets.length / 20) - 1));
  const buckets = result.buckets.slice(effectivePage * 20, (effectivePage + 1) * 20);
  if (widget.style === 'number') return null;
  if (!result.buckets.length) return <p className="planner-muted">No matching work.</p>;
  const low = Math.min(0, ...buckets.map((b) => b.value)),
    high = Math.max(1, ...buckets.map((b) => b.value)),
    range = high - low;
  const total = buckets.reduce((sum, b) => sum + b.value, 0);
  const donut = widget.style === 'donut' && buckets.every((b) => b.value >= 0) && total > 0;
  let offset = 0;
  return (
    <>
      {widget.style === 'donut' && !donut && (
        <p className="planner-muted">
          These values are shown as bars because a donut needs positive totals and no negative
          values.
        </p>
      )}
      {donut && (
        <svg
          viewBox="0 0 220 160"
          className="planner-report-donut"
          role="img"
          aria-label={`${widget.title} donut chart. Values are listed below.`}
        >
          {buckets.map((b, i) => {
            const length = (b.value / total) * 314.159,
              start = offset;
            offset += length;
            return (
              <circle
                key={b.key}
                cx="110"
                cy="80"
                r="50"
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth="22"
                strokeDasharray={`${length} ${314.159 - length}`}
                strokeDashoffset={-start}
                transform="rotate(-90 110 80)"
              />
            );
          })}
        </svg>
      )}
      {widget.style === 'line' && (
        <svg
          viewBox="0 0 600 180"
          className="planner-report-line"
          role="img"
          aria-label={`${widget.title} line chart. Values are listed below.`}
        >
          <line
            x1="12"
            x2="588"
            y1={160 - ((0 - low) / range) * 140}
            y2={160 - ((0 - low) / range) * 140}
            stroke="#dce0e7"
          />
          <polyline
            fill="none"
            stroke="#7565dd"
            strokeWidth="3"
            points={buckets
              .filter((b) => b.key !== 'undated')
              .map(
                (b, i, all) =>
                  `${12 + (i / Math.max(1, all.length - 1)) * 576},${160 - ((b.value - low) / range) * 140}`,
              )
              .join(' ')}
          />
          {buckets
            .filter((b) => b.key !== 'undated')
            .map((b, i, all) => (
              <circle
                key={b.key}
                cx={12 + (i / Math.max(1, all.length - 1)) * 576}
                cy={160 - ((b.value - low) / range) * 140}
                r="4"
                fill="#7565dd"
              >
                <title>
                  {b.label}: {plannerReportNumber(b.value, result.unit)}
                </title>
              </circle>
            ))}
        </svg>
      )}
      <div className="planner-report-buckets">
        {buckets.map((b, i) => (
          <button
            key={b.key}
            onClick={() => onBucket(b)}
            aria-label={`View ${b.label}: ${plannerReportNumber(b.value, result.unit)}`}
          >
            <span className="planner-report-bucket-label">
              <i style={{ background: colors[i % colors.length] }} />
              {b.label}
            </span>
            {!donut && widget.style !== 'line' && (
              <span className="planner-report-bucket-track">
                <i
                  style={{
                    left: `${((Math.min(0, b.value) - low) / range) * 100}%`,
                    width: `${(Math.abs(b.value) / range) * 100}%`,
                    background: colors[i % colors.length],
                  }}
                />
              </span>
            )}
            {widget.labels && <strong>{plannerReportNumber(b.value, result.unit)}</strong>}
          </button>
        ))}
      </div>
      {result.buckets.length > 20 && (
        <div className="planner-report-actions">
          <button disabled={!effectivePage} onClick={() => setPage(effectivePage - 1)}>
            Previous groups
          </button>
          <small>
            Groups {effectivePage * 20 + 1}–
            {Math.min((effectivePage + 1) * 20, result.buckets.length)} of {result.buckets.length}.
            Total includes all groups.
          </small>
          <button
            disabled={(effectivePage + 1) * 20 >= result.buckets.length}
            onClick={() => setPage(effectivePage + 1)}
          >
            Next groups
          </button>
        </div>
      )}
    </>
  );
}
function ReportDrilldown({
  dashboard,
  widget,
  bucket,
  title,
  onClose,
}: {
  dashboard: PlannerResource;
  widget: Extract<PlannerReportWidget, { kind: 'chart' }>;
  bucket?: string;
  title: string;
  onClose: () => void;
}) {
  const query = usePlannerReportRows(dashboard.id, widget.id, dashboard.version, bucket),
    api = useApi();
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState<unknown>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const pages = query.isError ? [] : (query.data?.pages ?? []);
  const unavailable = pages.some((p) => p.unavailableFields);
  const rows = unavailable
    ? []
    : [...new Map(pages.flatMap((p) => p.items ?? []).map((r) => [r.id, r])).values()];
  const download = async () => {
    setError(null);
    setExporting(true);
    const active = new AbortController();
    controller.current = active;
    try {
      const all: PlannerReportRow[] = [],
        seen = new Set<string>();
      let cursor: string | null = null,
        revision: string | undefined,
        unit: PlannerReportResult['unit'] = 'items';
      do {
        const page: PlannerReportResponse = (
          await api.get<PlannerReportResponse>(
            `/strategy-api/planner/reports/${dashboard.id}/widgets/${widget.id}`,
            {
              params: {
                rows: 'true',
                version: String(dashboard.version),
                ...(bucket ? { bucket } : {}),
                ...(cursor ? { cursor } : {}),
                ...(revision ? { revision } : {}),
              },
              signal: active.signal,
            },
          )
        ).data;
        if (page.unavailableFields)
          throw new Error('A saved field is unavailable. Refresh the chart before exporting.');
        all.push(...(page.items ?? []));
        unit = page.unit;
        revision = page.revision;
        cursor = page.nextCursor ?? null;
        if (cursor && seen.has(cursor))
          throw new Error('The report changed during export. Refresh and retry.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      const unique = [...new Map(all.map((r) => [r.id, r])).values()];
      const blob = new Blob(['\uFEFF', plannerReportCsv(unique, unit)], {
        type: 'text/csv;charset=utf-8',
      });
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `${widget.title.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80) || 'Planner report'}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!active.signal.aborted) setError(e);
    } finally {
      setExporting(false);
    }
  };
  return (
    <Frame title={`${widget.title} · ${title}`} onClose={onClose}>
      <div className="planner-dialog-body planner-report-drilldown">
        <p className="planner-muted">
          {rows.length} loaded {widget.chart.entity}. Values reflect your current access.
        </p>
        <Alert error={query.error || error} />
        {query.isError ? (
          <button onClick={() => void query.refetch()}>Retry results</button>
        ) : query.isPending ? (
          <p role="status">Loading matching work…</p>
        ) : unavailable ? (
          <p role="alert">
            A saved field is unavailable. Refresh the dashboard to update this chart.
          </p>
        ) : (
          <>
            {pages.some((p) => p.unavailableSources) && (
              <p className="planner-report-notice">Some saved sources are unavailable.</p>
            )}
            <div className="planner-report-table-wrap">
              <table className="planner-report-table">
                <thead>
                  <tr>
                    <th>Work</th>
                    <th>Status</th>
                    <th>Person</th>
                    <th>Due</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={plannerReportLink(r)} onClick={onClose}>
                          {r.name}
                        </Link>
                      </td>
                      <td>{r.status ? label(r.status) : '—'}</td>
                      <td>{r.personName ?? 'Unassigned'}</td>
                      <td>{r.dueOn ?? '—'}</td>
                      <td>{plannerReportNumber(r.value, pages[0]?.unit ?? 'items')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <p className="planner-muted">No matching work.</p>}
            {query.hasNextPage && (
              <button
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? 'Loading…' : 'Load more results'}
              </button>
            )}
          </>
        )}
      </div>
      <div className="planner-dialog-footer">
        <button onClick={onClose}>Close</button>
        {exporting ? (
          <button
            onClick={() => {
              controller.current?.abort();
            }}
          >
            Cancel export
          </button>
        ) : (
          <button
            disabled={query.isPending || query.isError || unavailable}
            onClick={() => void download()}
          >
            Export all matching rows
          </button>
        )}
      </div>
    </Frame>
  );
}
