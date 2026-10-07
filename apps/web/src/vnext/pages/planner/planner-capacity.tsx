import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Users, FolderKanban, Download } from 'lucide-react';
import {
  PLANNER_DEFAULT_CAPACITY_VIEW,
  plannerCapacityDateShift,
  plannerCapacityMinutes,
  plannerCapacitySummary,
  plannerCapacityWorkdays,
  type PlannerBootstrap,
  type PlannerCapacityAllocation,
  type PlannerCapacityView,
  type PlannerCapacityAllocationChange,
} from '@capiro/strategy-verifier';
import {
  usePlannerCapacityCatalog,
  usePlannerCapacityPlan,
  usePlannerCapacityMutations,
  plannerLoadCapacity,
} from './planner-capacity-api.js';
import { PlannerCapacityEditor, type CapacityEditor } from './planner-capacity-editor.js';
import { PlannerAllocationBar } from './planner-capacity-bar.js';
import { usePlannerResources, plannerError, usePlannerKey } from './planner-api.js';
import { useApi } from '../../../lib/use-api.js';
import { plannerToday } from './planner-views.js';
import { plannerCsvCell } from './planner-csv.js';
const hours = (minutes: number) =>
  `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
const personId = (a: PlannerCapacityAllocation) => a.data.userId ?? a.data.placeholderId!;
export function plannerCapacityCsv(
  rows: PlannerCapacityAllocation[],
  people: PlannerBootstrap['people'],
) {
  return (
    '\ufeff' +
    [
      [
        'Allocation ID',
        'Person',
        'Placeholder',
        'Job title',
        'Project',
        'Start date',
        'End date',
        'Effort unit',
        'Effort',
        'Planned hours',
        'Weekly capacity hours',
        'Archived',
      ],
      ...rows.map((a) => [
        a.id,
        people.find((p) => p.id === a.data.userId)?.name ?? a.personName,
        a.data.placeholderId ? 'Yes' : 'No',
        a.jobTitle,
        a.projectName,
        a.data.startOn,
        a.data.endOn,
        a.data.effort.unit,
        a.data.effort.value,
        plannerCapacityMinutes(a) / 60,
        a.weeklyMinutes / 60,
        a.archived ? 'Yes' : 'No',
      ]),
    ]
      .map((row) => row.map(plannerCsvCell).join(','))
      .join('\r\n')
  );
}
export function PlannerCapacity({
  bootstrap,
  selectedId,
  onSelect,
}: {
  bootstrap: PlannerBootstrap;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const catalogQuery = usePlannerCapacityCatalog(),
    resources = usePlannerResources(),
    mutations = usePlannerCapacityMutations(),
    api = useApi(),
    key = usePlannerKey();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [archived, setArchived] = useState(false),
    [editor, setEditor] = useState<CapacityEditor | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [staffing, setStaffing] = useState(false),
    [error, setError] = useState<unknown>(),
    [exporting, setExporting] = useState(false);
  const [view, setView] = useState<PlannerCapacityView>({
    ...PLANNER_DEFAULT_CAPACITY_VIEW,
    startOn: plannerToday(),
  });
  const [bulkPerson, setBulkPerson] = useState(''),
    [bulkProject, setBulkProject] = useState(''),
    [shift, setShift] = useState(7),
    [viewName, setViewName] = useState('');
  const planQuery = usePlannerCapacityPlan(selectedId, archived);
  const scopeKey = key.join('|');
  useEffect(() => {
    setSelected([]);
    setEditor(null);
    setError(null);
  }, [scopeKey, selectedId, archived]);
  useEffect(() => {
    setView({ ...PLANNER_DEFAULT_CAPACITY_VIEW, startOn: plannerToday() });
  }, [scopeKey, selectedId]);
  const catalog = !catalogQuery.isError ? catalogQuery.data : undefined;
  const page = !planQuery.isError && !catalogQuery.isError ? planQuery.data : undefined;
  const plan = page?.plan;
  const portfolios = resources.isError
    ? []
    : (resources.data ?? []).filter((r) => r.kind === 'portfolio' && !r.archived);
  const names = new Map([
    ...bootstrap.people.map((p) => [p.id, p.name] as const),
    ...(catalog?.placeholders ?? []).map((p) => [p.id, p.name] as const),
  ]);
  const allocations = page?.allocations ?? [];
  const canEdit =
    !!plan &&
    !plan.archived &&
    plan.access === 'admin' &&
    !mutations.allocations.isPending &&
    !mutations.record.isPending;
  const columns = useMemo(() => {
    const count = view.zoom === 'day' ? 14 : view.zoom === 'week' ? 8 : 6,
      result: { start: string; end: string; label: string }[] = [];
    let date = view.startOn || plannerToday();
    for (let i = 0; i < count; i++) {
      let end: string;
      if (view.zoom === 'month') {
        const d = new Date(`${date}T12:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + 1, 1);
        end = plannerCapacityDateShift(d.toISOString().slice(0, 10), -1);
      } else end = plannerCapacityDateShift(date, view.zoom === 'week' ? 6 : 0);
      result.push({
        start: date,
        end,
        label: new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
          month: 'short',
          ...(view.zoom === 'month' ? { year: 'numeric' } : { day: 'numeric' }),
          timeZone: 'UTC',
        }),
      });
      date = plannerCapacityDateShift(end, 1);
    }
    return result;
  }, [view.zoom, view.startOn]);
  const through = columns.at(-1)!.end,
    start = columns[0]!.start;
  const filter = (a: PlannerCapacityAllocation) =>
    (!view.projectId || a.projectId === view.projectId) &&
    (!view.personId || personId(a) === view.personId) &&
    (!view.search ||
      `${names.get(personId(a)) ?? a.personName} ${a.projectName} ${a.jobTitle}`
        .toLowerCase()
        .includes(view.search.toLowerCase()));
  const filtered = allocations.filter(filter),
    summary = plannerCapacitySummary(filtered, start, through);
  const rowIds = view.tab === 'people' ? (page?.personIds ?? []) : (page?.projectIds ?? []);
  const rows = rowIds
    .map((id) => {
      const items = filtered.filter((a) =>
        view.tab === 'people' ? personId(a) === id : a.projectId === id,
      );
      const name =
        view.tab === 'people'
          ? (names.get(id) ?? 'Member')
          : (bootstrap.projects.find((p) => p.id === id)?.name ??
            items[0]?.projectName ??
            'Project');
      const person = catalog?.placeholders.find((p) => p.id === id),
        team = catalog?.teams.find(
          (t) =>
            !t.archived &&
            (t.id === (person?.data.teamId ?? items[0]?.teamId) ||
              (view.tab === 'people' && t.data.peopleIds.includes(id))),
        );
      const jobTitle = person?.data.jobTitle ?? team?.data.jobTitles[id] ?? '';
      const group =
        view.group === 'team'
          ? (team?.name ?? 'No team')
          : view.group === 'jobTitle'
            ? jobTitle || 'No job title'
            : view.group === 'health'
              ? (bootstrap.projects.find((p) => p.id === id)?.health.replaceAll('_', ' ') ??
                'People')
              : '';
      const capacityResource = resources.isError
        ? undefined
        : resources.data?.find((r) => r.kind === 'capacity' && !r.archived && r.data.userId === id);
      return {
        id,
        name,
        items,
        group,
        jobTitle,
        person,
        weeklyMinutes:
          person?.data.weeklyMinutes ??
          Number(capacityResource?.data.weeklyMinutes ?? items[0]?.weeklyMinutes ?? 2400),
      };
    })
    .filter(
      (r) =>
        (!view.personId || view.tab !== 'people' || r.id === view.personId) &&
        (!view.projectId || view.tab !== 'projects' || r.id === view.projectId) &&
        (!view.search ||
          `${r.name} ${r.jobTitle}`.toLowerCase().includes(view.search.toLowerCase()) ||
          r.items.length > 0),
    )
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const change = async (changes: PlannerCapacityAllocationChange[]) => {
    if (!plan || !canEdit) return;
    setError(null);
    try {
      await mutations.allocations.mutateAsync({
        planId: plan.id,
        planVersion: plan.version,
        changes,
      });
      setSelected([]);
    } catch (err) {
      setError(err);
    }
  };
  const bulk = (
    patch: Omit<PlannerCapacityAllocationChange, 'id' | 'version'>,
    duplicate = false,
  ) =>
    change(
      allocations
        .filter((a) => selected.includes(a.id))
        .map((a) => ({
          id: a.id,
          version: a.version,
          ...patch,
          ...(duplicate ? { duplicateId: crypto.randomUUID() } : {}),
        })),
    );
  const archiveRecord = async (kind: 'plans' | 'teams' | 'placeholders', row: any) => {
    setError(null);
    try {
      await mutations.record.mutateAsync({
        kind,
        id: row.id,
        version: row.version,
        name: row.name,
        data: row.data,
        archived: !row.archived,
      });
    } catch (err) {
      setError(err);
    }
  };
  const exportCsv = async () => {
    if (!selectedId) return;
    setExporting(true);
    setError(null);
    try {
      const fresh = await plannerLoadCapacity(api, selectedId, archived);
      if (!alive.current) return;
      const content = plannerCapacityCsv(fresh.allocations.filter(filter), bootstrap.people);
      const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'planner-capacity.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="planner-capacity" aria-label="Capacity planning">
      <div className="planner-capacity-toolbar">
        <label>
          Capacity plan
          <select
            aria-label="Capacity plan"
            value={selectedId ?? ''}
            onChange={(e) => onSelect(e.target.value || null)}
          >
            <option value="">Choose a plan</option>
            {catalog?.plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => setEditor({ kind: 'plans' })}
          disabled={!catalog || resources.isError}
        >
          <Plus size={15} />
          New plan
        </button>
        <button onClick={() => setStaffing(!staffing)} aria-expanded={staffing}>
          <Users size={15} />
          Teams & placeholders
        </button>
        <label className="planner-capacity-checkbox">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
            }}
          />
          Archived allocations & staffing
        </label>
      </div>
      {error || catalogQuery.error || planQuery.error ? (
        <p role="alert" className="planner-error">
          {plannerError(error || catalogQuery.error || planQuery.error)}
        </p>
      ) : null}
      {catalogQuery.isPending && <p role="status">Loading capacity plans…</p>}
      {staffing && catalog && (
        <div className="planner-capacity-staffing">
          <header>
            <h3>Planner staffing</h3>
            <button onClick={() => setEditor({ kind: 'teams' })}>New team</button>
            <button
              disabled={!catalog.teams.some((t) => !t.archived && t.access === 'admin')}
              onClick={() => setEditor({ kind: 'placeholders' })}
            >
              New placeholder
            </button>
          </header>
          <p className="planner-muted">
            Planner teams organize people and job titles. Placeholders reserve capacity until a
            person is ready to take the allocation.
          </p>
          {catalog.teams
            .filter((t) => t.archived === archived)
            .map((t) => (
              <div className="planner-capacity-staff-row" key={t.id}>
                <strong>{t.name}</strong>
                <span>
                  {t.data.peopleIds.length} people · {t.access}
                </span>
                {t.access === 'admin' && (
                  <>
                    <button
                      disabled={mutations.record.isPending}
                      onClick={() => setEditor({ kind: 'teams', row: t })}
                    >
                      Edit team {t.name}
                    </button>
                    <button
                      disabled={mutations.record.isPending}
                      onClick={() => void archiveRecord('teams', t)}
                    >
                      {t.archived ? 'Restore' : 'Archive'} team
                    </button>
                  </>
                )}
              </div>
            ))}
          {catalog.placeholders
            .filter((p) => p.archived === archived)
            .map((p) => (
              <div className="planner-capacity-staff-row" key={p.id}>
                <strong>{p.name}</strong>
                <span>
                  {p.data.jobTitle || 'Placeholder'} · {hours(p.data.weeklyMinutes)} / week
                </span>
                {p.access === 'admin' && (
                  <>
                    <button onClick={() => setEditor({ kind: 'placeholders', row: p })}>
                      Edit placeholder {p.name}
                    </button>
                    <button
                      disabled={mutations.record.isPending}
                      onClick={() => void archiveRecord('placeholders', p)}
                    >
                      {p.archived ? 'Restore' : 'Archive'} placeholder
                    </button>
                  </>
                )}
              </div>
            ))}
        </div>
      )}
      {!selectedId && (
        <div className="planner-empty">
          <FolderKanban size={32} />
          <h3>Plan the people behind your projects</h3>
          <p>
            Create a plan with projects, live portfolios or people. Allocations follow their
            projects and people across plans.
          </p>
        </div>
      )}
      {selectedId && planQuery.isPending && (
        <p role="status">Loading the complete staffing schedule…</p>
      )}
      {page && plan && (
        <>
          <div className="planner-capacity-heading">
            <div>
              <h3>{plan.name}</h3>
              <p>
                {plan.data.description || 'Shared project allocations'} · {plan.access}
              </p>
            </div>
            <div className="planner-capacity-toolbar">
              {plan.access === 'admin' && (
                <>
                  <button
                    disabled={!catalog}
                    onClick={() => setEditor({ kind: 'plans', row: plan })}
                  >
                    Plan settings
                  </button>
                  <button
                    disabled={mutations.record.isPending}
                    onClick={() => void archiveRecord('plans', plan)}
                  >
                    {plan.archived ? 'Restore plan' : 'Archive plan'}
                  </button>
                </>
              )}
              <button disabled={exporting || planQuery.isFetching} onClick={() => void exportCsv()}>
                <Download size={15} />
                {exporting ? 'Verifying export…' : 'Export allocations'}
              </button>
              {canEdit && (
                <button
                  className="planner-primary"
                  onClick={() => setEditor({ kind: 'allocation' })}
                >
                  Allocate work
                </button>
              )}
            </div>
          </div>
          <div className="planner-capacity-summary">
            <div>
              <strong>{hours(summary.minutes)}</strong>
              <span>Planned in this window</span>
            </div>
            <div>
              <strong>{summary.people}</strong>
              <span>People & placeholders</span>
            </div>
            <div>
              <strong>{summary.projects}</strong>
              <span>Projects staffed</span>
            </div>
            <div>
              <strong>{summary.personMonths.toFixed(2)}</strong>
              <span>Person-months at 40 h/week</span>
            </div>
          </div>
          <div className="planner-capacity-toolbar">
            <div className="planner-capacity-tabs" role="tablist" aria-label="Capacity layout">
              <button
                role="tab"
                aria-selected={view.tab === 'people'}
                onClick={() => setView({ ...view, tab: 'people' })}
              >
                People
              </button>
              <button
                role="tab"
                aria-selected={view.tab === 'projects'}
                onClick={() => setView({ ...view, tab: 'projects' })}
              >
                Projects
              </button>
            </div>
            <button
              aria-label="Previous capacity window"
              onClick={() =>
                setView({
                  ...view,
                  startOn: plannerCapacityDateShift(
                    start,
                    -(view.zoom === 'day' ? 14 : view.zoom === 'week' ? 56 : 182),
                  ),
                })
              }
            >
              <ChevronLeft size={17} />
            </button>
            <label>
              Start
              <input
                type="date"
                aria-label="Capacity window start"
                value={start}
                onChange={(e) => e.target.value && setView({ ...view, startOn: e.target.value })}
              />
            </label>
            <button
              aria-label="Next capacity window"
              onClick={() => setView({ ...view, startOn: plannerCapacityDateShift(through, 1) })}
            >
              <ChevronRight size={17} />
            </button>
            <label>
              Zoom
              <select
                aria-label="Capacity zoom"
                value={view.zoom}
                onChange={(e) => setView({ ...view, zoom: e.target.value as any })}
              >
                <option value="day">Day</option>
                <option value="week">Week</option>
                <option value="month">Month</option>
              </select>
            </label>
            <label>
              Display
              <select
                aria-label="Capacity display"
                value={view.unit}
                onChange={(e) => setView({ ...view, unit: e.target.value as any })}
              >
                <option value="hours">Hours</option>
                <option value="percent">Percent</option>
                <option value="count">People / projects</option>
              </select>
            </label>
          </div>
          <div className="planner-capacity-toolbar">
            <input
              aria-label="Search staffing"
              placeholder="People, projects or job titles"
              value={view.search}
              onChange={(e) => setView({ ...view, search: e.target.value })}
            />
            <select
              aria-label="Filter capacity project"
              value={view.projectId}
              onChange={(e) => setView({ ...view, projectId: e.target.value })}
            >
              <option value="">All projects</option>
              {page.projectIds.map((id) => (
                <option key={id} value={id}>
                  {bootstrap.projects.find((p) => p.id === id)?.name ??
                    allocations.find((a) => a.projectId === id)?.projectName}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter capacity person"
              value={view.personId}
              onChange={(e) => setView({ ...view, personId: e.target.value })}
            >
              <option value="">All people & placeholders</option>
              {page.personIds.map((id) => (
                <option key={id} value={id}>
                  {names.get(id) ?? 'Member'}
                </option>
              ))}
            </select>
            <select
              aria-label="Group capacity"
              value={view.group}
              onChange={(e) => setView({ ...view, group: e.target.value as any })}
            >
              <option value="none">No grouping</option>
              <option value="team">Planner team</option>
              <option value="jobTitle">Job title</option>
              <option value="health">Project health</option>
            </select>
          </div>
          <div className="planner-capacity-toolbar">
            <select
              aria-label="Saved capacity view"
              value={view.id}
              onChange={(e) => {
                const saved = plan.data.views.find((v) => v.id === e.target.value);
                setView(
                  saved
                    ? { ...saved, startOn: saved.startOn || plannerToday() }
                    : { ...PLANNER_DEFAULT_CAPACITY_VIEW, startOn: plannerToday() },
                );
              }}
            >
              <option value="">Current view</option>
              {plan.data.views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            {canEdit && (
              <>
                <input
                  aria-label="Capacity view name"
                  placeholder="Name this view"
                  maxLength={200}
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                />
                <button
                  disabled={!viewName.trim()}
                  onClick={async () => {
                    setError(null);
                    try {
                      const saved = { ...view, id: crypto.randomUUID(), name: viewName.trim() };
                      await mutations.record.mutateAsync({
                        kind: 'plans',
                        id: plan.id,
                        version: plan.version,
                        name: plan.name,
                        data: { ...plan.data, views: [...plan.data.views, saved] },
                      });
                      setView(saved);
                      setViewName('');
                    } catch (err) {
                      setError(err);
                    }
                  }}
                >
                  Save view
                </button>
                {view.id && (
                  <button
                    onClick={async () => {
                      setError(null);
                      try {
                        await mutations.record.mutateAsync({
                          kind: 'plans',
                          id: plan.id,
                          version: plan.version,
                          name: plan.name,
                          data: {
                            ...plan.data,
                            views: plan.data.views.filter((v) => v.id !== view.id),
                          },
                        });
                        setView({ ...view, id: '', name: '' });
                      } catch (err) {
                        setError(err);
                      }
                    }}
                  >
                    Remove view
                  </button>
                )}
              </>
            )}
          </div>
          <div
            className="planner-capacity-scroll"
            role="region"
            aria-label="Staffing timeline"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSelected([]);
                return;
              }
              if (
                !canEdit ||
                archived ||
                event.key !== 'Delete' ||
                (event.target instanceof HTMLElement &&
                  (event.target.isContentEditable ||
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))
              )
                return;
              const focusedId =
                event.target instanceof HTMLElement
                  ? event.target.closest<HTMLElement>('[data-capacity-allocation]')?.dataset
                      .capacityAllocation
                  : undefined;
              const ids = selected.length ? selected : focusedId ? [focusedId] : [];
              const current = allocations.filter(
                (a) => ids.includes(a.id) && a.access === 'admin' && !a.archived,
              );
              if (!current.length) return;
              event.preventDefault();
              event.stopPropagation();
              void change(current.map((a) => ({ id: a.id, version: a.version, archived: true })));
            }}
          >
            <div
              className="planner-capacity-timeline"
              style={{ minWidth: 210 + columns.length * 108 }}
            >
              <div
                className="planner-capacity-timeline-head"
                style={{
                  gridTemplateColumns: `210px repeat(${columns.length}, minmax(108px, 1fr))`,
                }}
              >
                <strong className="planner-capacity-sticky">
                  {view.tab === 'people' ? 'People' : 'Projects'}
                </strong>
                {columns.map((c) => (
                  <span key={c.start}>{c.label}</span>
                ))}
              </div>
              {rows.map((row, index) => (
                <div key={row.id}>
                  {row.group && (index === 0 || rows[index - 1]?.group !== row.group) && (
                    <h4 className="planner-capacity-group">{row.group}</h4>
                  )}
                  <div
                    className="planner-capacity-row"
                    style={{
                      gridTemplateColumns: `210px repeat(${columns.length}, minmax(108px, 1fr))`,
                    }}
                  >
                    <div className="planner-capacity-sticky planner-capacity-person">
                      <strong>{row.name}</strong>
                      <small>
                        {view.tab === 'people'
                          ? `${row.person ? 'Placeholder · ' : ''}${hours(row.weeklyMinutes)} / week${row.jobTitle ? ' · ' + row.jobTitle : ''}`
                          : bootstrap.projects
                              .find((p) => p.id === row.id)
                              ?.health.replaceAll('_', ' ')}
                      </small>
                      {row.person && canEdit && (
                        <button
                          onClick={() => {
                            setSelected(
                              allocations
                                .filter(
                                  (a) => a.data.placeholderId === row.id && a.access === 'admin',
                                )
                                .slice(0, 100)
                                .map((a) => a.id),
                            );
                            setBulkPerson(bootstrap.me.id);
                          }}
                        >
                          Transfer allocations
                        </button>
                      )}
                    </div>
                    {columns.map((c) => {
                      const active = row.items.filter(
                          (a) => a.data.startOn <= c.end && a.data.endOn >= c.start,
                        ),
                        minutes = active.reduce(
                          (n, a) => n + plannerCapacityMinutes(a, c.start, c.end),
                          0,
                        ),
                        capacity =
                          ((view.tab === 'people'
                            ? row.weeklyMinutes
                            : [
                                ...new Map(
                                  active.map((a) => [personId(a), a.weeklyMinutes]),
                                ).values(),
                              ].reduce((n, v) => n + v, 0)) /
                            5) *
                          plannerCapacityWorkdays(c.start, c.end).length;
                      const label =
                        view.unit === 'hours'
                          ? hours(minutes)
                          : view.unit === 'count'
                            ? String(
                                new Set(
                                  active.map((a) =>
                                    view.tab === 'people' ? a.projectId : personId(a),
                                  ),
                                ).size,
                              )
                            : capacity
                              ? `${Math.round((minutes / capacity) * 100)}%`
                              : minutes
                                ? 'No capacity'
                                : '0%';
                      return (
                        <div
                          key={c.start}
                          className={`planner-capacity-cell ${view.tab === 'people' && minutes > capacity ? 'is-overallocated' : ''}`}
                          data-capacity-start={c.start}
                          data-capacity-end={c.end}
                          onDragOver={(e) => canEdit && e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!canEdit) return;
                            const id = e.dataTransfer.getData('text/plain'),
                              a = allocations.find((a) => a.id === id);
                            if (!a || a.access !== 'admin') return;
                            const delta = Math.round(
                              (Date.parse(c.start) - Date.parse(a.data.startOn)) / 86400000,
                            );
                            const moving = selected.includes(a.id)
                              ? allocations.filter((item) => selected.includes(item.id))
                              : [a];
                            const target =
                              view.tab === 'projects'
                                ? { projectId: row.id }
                                : {
                                    data: {
                                      userId: row.person ? null : row.id,
                                      placeholderId: row.person ? row.id : null,
                                    },
                                  };
                            void change(
                              moving.map((item) => ({
                                id: item.id,
                                version: item.version,
                                shiftDays: delta,
                                ...target,
                              })),
                            );
                          }}
                        >
                          <small aria-label={`${row.name} ${c.start} planned effort`}>
                            {label}
                          </small>
                          {active.map((a) => (
                            <PlannerAllocationBar
                              key={`${a.id}:${a.version}:${a.archived}`}
                              allocation={a}
                              column={c}
                              label={
                                view.tab === 'people'
                                  ? a.projectName
                                  : (names.get(personId(a)) ?? a.personName)
                              }
                              description={`${a.projectName} · ${names.get(personId(a)) ?? a.personName} · ${a.data.startOn} – ${a.data.endOn} · ${hours(plannerCapacityMinutes(a))}`}
                              color={
                                bootstrap.projects.find((p) => p.id === a.projectId)?.color ??
                                '#7565dd'
                              }
                              selected={selected.includes(a.id)}
                              canEdit={canEdit}
                              onSelect={() =>
                                setSelected((current) =>
                                  current.includes(a.id)
                                    ? current.filter((id) => id !== a.id)
                                    : current.length < 100
                                      ? [...current, a.id]
                                      : current,
                                )
                              }
                              onEdit={() => setEditor({ kind: 'allocation', row: a })}
                              onChange={(changeDto) => void change([changeDto])}
                              onError={setError}
                            />
                          ))}
                          {canEdit &&
                            !archived &&
                            plannerCapacityWorkdays(c.start, c.end).length > 0 &&
                            (view.tab === 'people' ||
                              bootstrap.projects.some(
                                (p) => p.id === row.id && ['admin', 'editor'].includes(p.access),
                              )) && (
                              <button
                                type="button"
                                className="planner-capacity-add-cell"
                                aria-label={`Allocate ${row.name} from ${c.start} to ${c.end}`}
                                onClick={() =>
                                  setEditor({
                                    kind: 'allocation',
                                    initial: {
                                      ...(view.tab === 'projects' ? { projectId: row.id } : {}),
                                      data: {
                                        startOn: c.start,
                                        endOn: c.end,
                                        userId:
                                          view.tab === 'people'
                                            ? row.person
                                              ? null
                                              : row.id
                                            : bootstrap.me.id,
                                        placeholderId:
                                          view.tab === 'people' && row.person ? row.id : null,
                                      },
                                    },
                                  })
                                }
                              >
                                <Plus size={12} aria-hidden="true" />
                              </button>
                            )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {!rows.length && (
            <p className="planner-muted">
              No people or projects match this view. Add them in Plan settings.
            </p>
          )}
          <div className="planner-capacity-allocations">
            <h4>Allocations · {filtered.length}</h4>
            <p className="planner-muted">
              This list includes all dates that match your filters. Use the timeline to focus on a
              window.
            </p>
            {filtered.map((a) => (
              <div key={a.id} className="planner-capacity-allocation-line">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Select allocation ${a.projectName} ${names.get(personId(a)) ?? a.personName} ${a.data.startOn}`}
                    disabled={
                      !canEdit ||
                      a.access !== 'admin' ||
                      (!selected.includes(a.id) && selected.length >= 100)
                    }
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, a.id]
                          : selected.filter((id) => id !== a.id),
                      )
                    }
                  />
                  <strong>{a.projectName}</strong>
                </label>
                <span>{names.get(personId(a)) ?? a.personName}</span>
                <span>
                  {a.data.startOn} – {a.data.endOn}
                </span>
                <span>
                  {a.data.effort.value}
                  {a.data.effort.unit === 'percent' ? '%' : ' h'} ·{' '}
                  {hours(plannerCapacityMinutes(a))}
                </span>
                {canEdit && a.access === 'admin' && (
                  <button onClick={() => setEditor({ kind: 'allocation', row: a })}>
                    Edit allocation
                  </button>
                )}
              </div>
            ))}
            {!filtered.length && <p>No allocations match this view.</p>}
          </div>
          {selected.length > 0 && canEdit && (
            <div className="planner-capacity-bulk">
              <strong>{selected.length} selected</strong>
              <button onClick={() => setSelected([])}>Clear selection</button>
              <label>
                Move by days
                <input
                  type="number"
                  min={-3660}
                  max={3660}
                  value={shift}
                  onChange={(e) => setShift(Number(e.target.value))}
                />
              </label>
              <button onClick={() => void bulk({ shiftDays: shift })}>Move selected</button>
              <button onClick={() => void bulk({ shiftDays: shift }, true)}>
                Duplicate selected
              </button>
              <label>
                Transfer to
                <select
                  aria-label="Transfer selected allocations to"
                  value={bulkPerson}
                  onChange={(e) => setBulkPerson(e.target.value)}
                >
                  <option value="">Choose a person</option>
                  {bootstrap.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {catalog?.placeholders
                    .filter((p) => !p.archived)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · Placeholder
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={!bulkPerson}
                onClick={() =>
                  void bulk({
                    data: {
                      userId: catalog?.placeholders.some((p) => p.id === bulkPerson)
                        ? null
                        : bulkPerson,
                      placeholderId: catalog?.placeholders.some((p) => p.id === bulkPerson)
                        ? bulkPerson
                        : null,
                    },
                  })
                }
              >
                Transfer selected
              </button>
              <label>
                Reallocate to project
                <select
                  aria-label="Reallocate selected project"
                  value={bulkProject}
                  onChange={(e) => setBulkProject(e.target.value)}
                >
                  <option value="">Choose a project</option>
                  {bootstrap.projects
                    .filter((p) => !p.archived && ['admin', 'editor'].includes(p.access))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <button disabled={!bulkProject} onClick={() => void bulk({ projectId: bulkProject })}>
                Reallocate selected
              </button>
              <button onClick={() => void bulk({ archived: !archived })}>
                {archived ? 'Restore selected' : 'Archive selected'}
              </button>
            </div>
          )}
        </>
      )}
      {editor && catalog && (
        <PlannerCapacityEditor
          key={`${editor.kind}:${editor.row?.id ?? 'new'}`}
          editor={editor}
          catalog={catalog}
          bootstrap={bootstrap}
          portfolios={portfolios}
          plan={plan}
          onClose={() => setEditor(null)}
          onSave={async (body) => {
            if (editor.kind === 'allocation') {
              if (!plan) throw new Error('Choose a capacity plan');
              await mutations.allocations.mutateAsync({
                planId: plan.id,
                planVersion: plan.version,
                changes: [body],
              });
            } else {
              const saved = (await mutations.record.mutateAsync({
                kind: editor.kind,
                ...body,
              })) as { id: string };
              if (editor.kind === 'plans' && alive.current) onSelect(saved.id);
            }
          }}
        />
      )}
    </section>
  );
}
