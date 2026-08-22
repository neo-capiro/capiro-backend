import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';
import type { CommitteeRef } from '../../../pages/directory/directory-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';
import { StaffProfileModalVNext } from './StaffProfileModalVNext.js';
import { useCommitteeStaffModel, type CommitteeStaffModel } from './useCommitteeStaffModel.js';

/**
 * Committee Staff (DIRECTORY-HANDOFF §7.2/§7.3).
 *
 * One route, one committee dataset, two peer views. The ROSTER is fully
 * source-backed today (`/api/directory/committees/:id/staff`). The HIERARCHY
 * canvas renders only what the source backs — committee, leadership (Chair /
 * Ranking Member are source-backed), and subcommittee units via parentOfficeId
 * — but per-unit staff placement, working-relationship edges and vacancies are
 * NOT modeled server-side (GAPS.md DIR-1/2/3). Those affordances ship disabled
 * with an explicit note, never synthesized.
 */

function committeeUnitLines(staffer: DirectoryCommitteeStaffer): { primary: string; secondary: string } {
  return {
    primary: staffer.committee?.name ?? '—',
    secondary: [staffer.committee?.chamber, staffer.isCurrent ? 'Current unit' : 'Former']
      .filter(Boolean)
      .join(' · '),
  };
}

export function CommitteeStaffVNext() {
  const model = useCommitteeStaffModel();
  return <CommitteeStaffVNextView model={model} />;
}

export function CommitteeStaffVNextView({ model }: { model: CommitteeStaffModel }) {
  const { search, view, committee, filters, results, selection } = model;
  const { total, staff, isInitialLoading, isRefetching } = results;
  // Clicking a person shows their profile without leaving the diagram/roster —
  // a modal, not the navigate-away `selection.onOpenProfile` the model exposes
  // (that's kept for callers that still want a real route, e.g. a bookmark).
  const [modalStaffId, setModalStaffId] = useState<string | null>(null);

  return (
    <DirectoryShell
      eyebrow="Directory · Committee Staff"
      title="Committee Staff"
      subtitle="Committee & subcommittee staff · Hierarchy and roster · One canonical staff identity."
    >
      <div className="capiro-directory-toolbar">
        <div className="capiro-directory-search">
          <label className="capiro-directory-search__label" htmlFor="directory-committee-search">
            Search
          </label>
          <input
            id="directory-committee-search"
            className="capiro-directory-search__input"
            type="search"
            value={search.text}
            placeholder="Committee, staffer or unit…"
            onChange={(event) => search.onChange(event.target.value)}
          />
          {search.text ? (
            <button
              type="button"
              className="capiro-directory-search__clear"
              onClick={() => search.onChange('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>

        <DirectoryFilterPill
          label="Committee"
          options={committee.options}
          selected={committee.selectedId ? [committee.selectedId] : []}
          multiple={false}
          onChange={(next) => (next[0] ? committee.onSelect(next[0]) : undefined)}
        />
        <DirectoryFilterPill
          label="Chamber"
          options={filters.chamberOptions}
          selected={filters.chamber}
          multiple={false}
          onChange={(next) => filters.onChange('chamber', next)}
        />

        {/* Hierarchy / Roster peer toggle (radiogroup per §9.2). */}
        <div className="capiro-directory-viewtoggle" role="radiogroup" aria-label="View">
          <button
            type="button"
            role="radio"
            aria-checked={view.current === 'hierarchy'}
            className={`capiro-directory-viewtoggle__btn${
              view.current === 'hierarchy' ? ' capiro-directory-viewtoggle__btn--active' : ''
            }`}
            onClick={() => view.onChange('hierarchy')}
          >
            Hierarchy
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view.current === 'roster'}
            className={`capiro-directory-viewtoggle__btn${
              view.current === 'roster' ? ' capiro-directory-viewtoggle__btn--active' : ''
            }`}
            onClick={() => view.onChange('roster')}
          >
            Roster
          </button>
        </div>

        {filters.hasAny ? (
          <button type="button" className="capiro-directory-toolbar__reset" onClick={filters.onClearAll}>
            Clear all
          </button>
        ) : null}
      </div>

      {view.current === 'hierarchy' ? (
        <HierarchyView model={model} onOpenStaffProfile={setModalStaffId} />
      ) : (
        <div className="capiro-directory-split">
          <div
            className={`capiro-directory-results capiro-directory-results--roster${
              isRefetching ? ' capiro-directory-results--refetching' : ''
            }`}
          >
            <div className="capiro-directory-results__header">
              <p className="capiro-directory-results__eyebrow">
                {committee.detail?.name ?? 'Committee Staff'}
              </p>
              <p className="capiro-directory-results__count">
                {isInitialLoading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
              </p>
            </div>

            <div className="capiro-directory-columns capiro-directory-row-grid--roster">
              <p className="capiro-directory-columns__label">Staffer</p>
              <p className="capiro-directory-columns__label">Committee / Unit</p>
              <p className="capiro-directory-columns__label">Role</p>
              <p className="capiro-directory-columns__label">Contact</p>
              <p className="capiro-directory-columns__label" aria-hidden="true" />
            </div>

            {results.isError ? (
              <CapiroErrorState
                title="Committee staff could not be loaded"
                description="The committee-staff source did not respond."
                onRetry={results.onRetry}
              />
            ) : isInitialLoading ? (
              <>
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="capiro-directory-row capiro-directory-row-grid--roster" key={index}>
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                  </div>
                ))}
              </>
            ) : staff.length === 0 ? (
              <CapiroEmptyState
                title={filters.hasAny ? 'No people match these filters' : 'No records in this source'}
                description={
                  filters.hasAny
                    ? 'Clear a filter or broaden the search to see more of the directory.'
                    : 'This committee has no staff on record.'
                }
                action={
                  filters.hasAny ? (
                    <CapiroButton size="compact" onClick={filters.onClearAll}>
                      Clear filters
                    </CapiroButton>
                  ) : undefined
                }
              />
            ) : (
              staff.map((staffer) => {
                const unit = committeeUnitLines(staffer);
                const isSelected = staffer.id === selection.selectedId;
                return (
                  <button
                    type="button"
                    key={staffer.id}
                    aria-pressed={isSelected}
                    className={`capiro-directory-row capiro-directory-row-grid--roster${
                      isSelected ? ' capiro-directory-row--selected' : ''
                    }`}
                    onClick={() => {
                      selection.onToggle(staffer.id);
                      setModalStaffId(staffer.id);
                    }}
                  >
                    <span className="capiro-directory-cell capiro-directory-cell--person">
                      <IdentityMark kind="person" size="sm" name={staffer.fullName} aria-hidden="true" />
                      <span className="capiro-directory-cell__stack">
                        <span className="capiro-directory-cell__primary-row">
                          <span className="capiro-directory-cell__primary">{staffer.fullName}</span>
                          {staffer.isCurrent ? null : <CapiroBadge>Former</CapiroBadge>}
                        </span>
                        <span className="capiro-directory-cell__secondary">{staffer.title || '—'}</span>
                      </span>
                    </span>
                    <span className="capiro-directory-cell capiro-directory-cell--mono">
                      <span className="capiro-directory-cell__primary">{unit.primary}</span>
                      <span className="capiro-directory-cell__secondary">{unit.secondary}</span>
                    </span>
                    <span className="capiro-directory-cell capiro-directory-cell--mono">
                      <span className="capiro-directory-cell__primary">{staffer.title || '—'}</span>
                    </span>
                    <span className="capiro-directory-cell capiro-directory-cell--mono capiro-directory-cell--contact">
                      <span className="capiro-directory-cell__primary">{staffer.email || 'No email'}</span>
                      <span className="capiro-directory-cell__secondary">{staffer.phone || 'No phone'}</span>
                    </span>
                    <span className="capiro-directory-cell">
                      <span className="capiro-directory-cell__action" aria-hidden="true">
                        Open →
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <SelectedCommitteeStaffRail
            staffer={selection.selected}
            onOpenProfile={setModalStaffId}
          />
        </div>
      )}

      <StaffProfileModalVNext
        staffId={modalStaffId}
        open={modalStaffId !== null}
        onClose={() => setModalStaffId(null)}
      />
    </DirectoryShell>
  );
}

/**
 * The hierarchy canvas renders only source-backed structure. Leadership
 * (Chair / Ranking Member) and subcommittee units are real; per-unit staff
 * placement, working-relationship edges and vacancies are not modeled
 * server-side (DIR-1/2/3) and ship as an explicit note, never synthesized.
 */
/**
 * Vertical trunk + horizontal bar + one leg per child, all positioned as
 * percentages of this connector's OWN width — which is always the shared
 * canvas-frame width every tier grid above and below it also spans at
 * `width: 100%`, so a leg here lines up with the grid column it targets
 * regardless of how many children that tier has. Equal-column grids only
 * (§ HierarchyView), so a child's center is always `(i+0.5)/N`.
 */
function TreeConnector({ toCount, height = 28 }: { toCount: number; height?: number }) {
  const centers = Array.from({ length: toCount }, (_, i) => ((i + 0.5) / toCount) * 100);
  const first = centers[0] ?? 50;
  const last = centers[centers.length - 1] ?? 50;
  return (
    <div className="capiro-directory-tree-connector" style={{ height }} aria-hidden="true">
      <span className="capiro-directory-tree-connector__trunk" />
      {toCount > 1 ? (
        <span
          className="capiro-directory-tree-connector__bar"
          style={{ left: `${first}%`, right: `${100 - last}%` }}
        />
      ) : null}
      {centers.map((c, i) => (
        <span key={i} className="capiro-directory-tree-connector__leg" style={{ left: `${c}%` }} />
      ))}
    </div>
  );
}

type OrgChartNodeData = {
  label: string;
  kind: 'committee' | 'leadership' | 'unit' | 'staff';
  meta?: string;
  initials?: string;
  staffId?: string;
  memberId?: string;
  former?: boolean;
};

type OrgChartNode = Node<OrgChartNodeData>;

type OrgChartEdge = Edge;

function initialsFor(name: string | null | undefined): string {
  return (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function OrgChartNodeView({ data }: NodeProps<OrgChartNode>) {
  const isPerson = data.kind === 'leadership' || data.kind === 'staff';
  const isInteractive = Boolean(data.staffId || data.memberId);
  return (
    <div
      className={`capiro-directory-node capiro-directory-flow-node capiro-directory-node--${data.kind}${
        data.former ? ' capiro-directory-node--former' : ''
      }`}
      role={isInteractive ? 'button' : undefined}
      aria-label={isInteractive ? data.label : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.currentTarget.click();
      }}
    >
      <span className={`capiro-directory-node__mark capiro-directory-node__mark--${isPerson ? 'person' : 'place'}`}>
        {data.initials ?? data.label.slice(0, 2).toUpperCase()}
      </span>
      <span className="capiro-directory-node__body">
        <span className="capiro-directory-node__kind">{data.kind === 'staff' ? 'Team' : data.kind}</span>
        <span className="capiro-directory-node__name">
          {data.label}
          {data.former ? <CapiroBadge>Former</CapiroBadge> : null}
        </span>
        {data.meta ? <span className="capiro-directory-node__meta">{data.meta}</span> : null}
      </span>
    </div>
  );
}

const ORG_NODE_TYPES = { committee: OrgChartNodeView, leadership: OrgChartNodeView, unit: OrgChartNodeView, staff: OrgChartNodeView };

function CommitteeOrgChart({
  detail,
  leaders,
  units,
  staff,
  selectedId,
  onSelectStaff,
  onOpenMember,
}: {
  detail: NonNullable<CommitteeStaffModel['committee']['detail']>;
  leaders: Array<{ role: string; memberRef: { id: string; name?: string | null } | null }>;
  units: CommitteeRef[];
  staff: DirectoryCommitteeStaffer[];
  selectedId: string | null;
  onSelectStaff: (id: string) => void;
  onOpenMember: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const nextNodes: OrgChartNode[] = [];
    const nextEdges: OrgChartEdge[] = [];
    nextNodes.push({
      id: 'committee',
      type: 'committee',
      position: { x: 360, y: 24 },
      data: {
        kind: 'committee',
        label: detail.name,
        initials: detail.committeeCode ?? detail.name.slice(0, 2).toUpperCase(),
        meta: [detail.chamber, detail.kind === 'subcommittee' ? 'Subcommittee' : 'Standing committee'].filter(Boolean).join(' · '),
      },
    });
    const leaderWidth = leaders.length > 1 ? 220 : 360;
    leaders.forEach((leader, index) => {
      const id = `leader-${leader.role}`;
      nextNodes.push({
        id,
        type: 'leadership',
        position: { x: 120 + index * leaderWidth, y: 178 },
        data: { kind: 'leadership', label: leader.memberRef?.name ?? 'Not recorded', initials: initialsFor(leader.memberRef?.name), meta: leader.role, memberId: leader.memberRef?.id },
      });
      nextEdges.push({ id: `committee-${id}`, source: 'committee', target: id, type: 'smoothstep' });
    });
    units.forEach((unit, index) => {
      const name = unitDisplayName(unit, detail.name);
      const id = `unit-${unit.id}`;
      nextNodes.push({ id, type: 'unit', position: { x: 40 + index * 230, y: 326 }, data: { kind: 'unit', label: name, meta: 'Subcommittee', initials: name.slice(0, 2).toUpperCase() } });
      nextEdges.push({ id: `committee-${id}`, source: 'committee', target: id, type: 'smoothstep' });
    });
    staff.forEach((person, index) => {
      const id = `staff-${person.id}`;
      nextNodes.push({ id, type: 'staff', position: { x: 40 + (index % 4) * 230, y: 474 + Math.floor(index / 4) * 112 }, data: { kind: 'staff', label: person.fullName, meta: person.title || '—', initials: initialsFor(person.fullName), staffId: person.id, former: !person.isCurrent } });
      // Staff are intentionally not connected: the source does not attribute
      // them to a unit or expose person-to-person reporting lines.
    });
    return { nodes: nextNodes, edges: nextEdges };
  }, [detail, leaders, units, staff]);

  const onNodeClick = useCallback((_: ReactMouseEvent, node: OrgChartNode) => {
    if (node.data.staffId) onSelectStaff(node.data.staffId);
    if (node.data.memberId) onOpenMember(node.data.memberId);
  }, [onOpenMember, onSelectStaff]);

  return (
    <div className="capiro-directory-flow-wrap" data-testid="committee-org-chart" aria-label="Committee organization chart">
      <ReactFlow
        nodes={nodes.map((node) => ({
          ...node,
          selected: node.data.staffId === selectedId,
          className: node.data.former ? 'capiro-directory-node--former' : undefined,
        }))}
        edges={edges}
        nodeTypes={ORG_NODE_TYPES}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.5}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <p className="capiro-directory-flow-note"><strong>Committee staff pool</strong> · Committee and leadership structure is source-backed. Staff remain unassigned until the source provides unit placement.</p>
    </div>
  );
}

function HierarchyView({
  model,
  onOpenStaffProfile,
}: {
  model: CommitteeStaffModel;
  onOpenStaffProfile: (staffId: string) => void;
}) {
  const { committee, results, selection } = model;
  const navigate = useNavigate();
  const detail = committee.detail;
  const leaders: Array<{ role: string; memberRef: { id: string; name?: string | null } | null }> = [];
  if (detail?.chair) leaders.push({ role: 'Committee Chair', memberRef: detail.chair });
  if (detail?.rankingMember) leaders.push({ role: 'Ranking Member', memberRef: detail.rankingMember });
  const units = committee.units;

  return (
    <div className="capiro-directory-hierarchy">
      <div className="capiro-directory-results__header">
        <p className="capiro-directory-results__eyebrow">{detail?.name ?? 'Committee'} · Hierarchy</p>
        <p className="capiro-directory-results__count">{results.isInitialLoading ? 'Loading…' : `${results.total} staff`}</p>
      </div>
      {results.isInitialLoading ? <CapiroSkeleton height={320} /> : !detail ? (
        <CapiroEmptyState title="No committee selected" description="Choose a committee to see its structure." />
      ) : (
        <div className="capiro-directory-canvas">
          <ReactFlowProvider>
            <CommitteeOrgChart
              detail={detail}
              leaders={leaders}
              units={units}
              staff={results.staff}
              selectedId={selection.selectedId}
              onSelectStaff={(id) => { selection.onToggle(id); onOpenStaffProfile(id); }}
              onOpenMember={(id) => navigate(`/directory/members/${id}`)}
            />
          </ReactFlowProvider>
          <div className="capiro-directory-legend">
            <span className="capiro-directory-legend__item">Solid · formal committee structure</span>
            <span className="capiro-directory-legend__item capiro-directory-legend__item--disabled">Staff pool is not attributed to a unit · not source-backed</span>
            <span className="capiro-directory-legend__item capiro-directory-legend__item--disabled">Person-to-person reporting lines · not source-backed</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Subcommittee names repeat their parent committee's full name as a literal
 * prefix (source data, not a display choice) — stripped so the card shows
 * only the part that actually distinguishes it from its siblings. */
function unitDisplayName(unit: CommitteeRef, committeeName: string): string {
  const prefix = `${committeeName} `;
  return unit.name.startsWith(prefix) ? unit.name.slice(prefix.length) : unit.name;
}

function UnitNode({ unit, committeeName }: { unit: CommitteeRef; committeeName: string }) {
  const name = unitDisplayName(unit, committeeName);
  return (
    <div className="capiro-directory-node capiro-directory-node--unit">
      <span className="capiro-directory-node__mark capiro-directory-node__mark--place">
        {name.slice(0, 2).toUpperCase()}
      </span>
      <span className="capiro-directory-node__body">
        <span className="capiro-directory-node__kind">Subcommittee</span>
        <span className="capiro-directory-node__name">{name}</span>
      </span>
    </div>
  );
}

function LeadershipNode({
  role,
  memberRef,
}: {
  role: string;
  memberRef: { id: string; name?: string | null } | null;
}) {
  const navigate = useNavigate();
  const name = memberRef?.name ?? null;
  const initials = (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  // Leadership is a MEMBER of Congress, a materially richer record than a
  // staffer's — no modal wraps that depth yet, so this opens the full member
  // profile page (still real navigation, unlike the staff modal above).
  return (
    <button
      type="button"
      className="capiro-directory-node capiro-directory-node--person capiro-directory-node--leader"
      disabled={!memberRef}
      onClick={() => memberRef && navigate(DIRECTORY_PROFILE_ROUTES.member(memberRef.id))}
    >
      <span className="capiro-directory-node__mark capiro-directory-node__mark--person">{initials}</span>
      <span className="capiro-directory-node__body">
        <span className="capiro-directory-node__kind">Leadership</span>
        <span className="capiro-directory-node__name">{name ?? 'Not recorded'}</span>
        <span className="capiro-directory-node__meta">{role}</span>
      </span>
    </button>
  );
}

function SelectedCommitteeStaffRail({
  staffer,
  onOpenProfile,
}: {
  staffer: DirectoryCommitteeStaffer | null;
  onOpenProfile: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [staffer?.id]);

  if (!staffer) {
    return (
      <aside className="capiro-directory-rail" aria-label="Selected staff profile">
        <p className="capiro-directory-rail__eyebrow">Selected staff profile</p>
        <CapiroEmptyState
          title="No one selected"
          description="Choose a person to see contact and committee context."
        />
      </aside>
    );
  }

  const person = staffer;
  const unit = committeeUnitLines(person);

  async function copyEmail() {
    const email = person.email;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <aside className="capiro-directory-rail" aria-label="Selected staff profile">
      <p className="capiro-directory-rail__eyebrow">Selected staff profile</p>

      <IdentityMark
        kind="person"
        size="lg"
        name={person.fullName}
        metadata={person.title}
        metadataVisible
      />
      {person.isCurrent ? null : <CapiroBadge>Former on this committee</CapiroBadge>}

      <p className="capiro-directory-rail__office">{unit.primary}</p>
      <span className="capiro-directory-rail__divider" aria-hidden="true" />

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Committee / Unit</p>
        <p className="capiro-directory-field__value">{unit.primary}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Email</p>
        <p className="capiro-directory-field__value">{person.email || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Phone</p>
        <p className="capiro-directory-field__value">{person.phone || 'Not provided'}</p>
      </div>

      <div className="capiro-directory-rail__actions">
        <CapiroButton variant="primary" size="compact" onClick={() => onOpenProfile(person.id)}>
          Open full profile
        </CapiroButton>
        <CapiroButton size="compact" onClick={() => void copyEmail()} disabled={!person.email}>
          {copyState === 'copied' ? 'Email copied' : copyState === 'failed' ? 'Copy failed' : 'Copy email'}
        </CapiroButton>
      </div>
      <p className="capiro-directory-field__label" role="status" aria-live="polite">
        {copyState === 'copied' ? 'Email copied to clipboard' : copyState === 'failed' ? 'Clipboard unavailable' : ''}
      </p>

      <div className="capiro-directory-workflows">
        <p className="capiro-directory-workflows__eyebrow">Connected workflows</p>
        <p className="capiro-directory-workflows__copy">
          This person keeps the same canonical identity across dependent Capiro workflows.
        </p>
        <div className="capiro-directory-workflows__badges">
          <CapiroBadge tone="info">Engagement</CapiroBadge>
          <CapiroBadge tone="info">Outreach</CapiroBadge>
          <CapiroBadge tone="info">Quick Log</CapiroBadge>
        </div>
      </div>
    </aside>
  );
}
