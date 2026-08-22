import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Background,
  Controls,
  Handle,
  Position,
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
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { StaffProfileModalVNext } from './StaffProfileModalVNext.js';
import {
  useCommitteeStaffModel,
  type CommitteeStaffGroup,
  type CommitteeStaffModel,
} from './useCommitteeStaffModel.js';

/**
 * Committee Staff (DIRECTORY-HANDOFF §7.2/§7.3).
 *
 * One route, one committee dataset, two peer views — both now organized the
 * same way: staff are GROUPED BY THE COMMITTEE OFFICE the source attributes
 * them to (parent committee, then each subcommittee), not pooled into one
 * undifferentiated list. See `CommitteeStaffGroup` for why per-unit placement
 * is source-backed after all.
 *
 * A card is a contact card: name, role, unit, email, phone and office, so the
 * chart answers "who do I call about this" without a round trip. Clicking any
 * person opens their canonical profile — the same `/directory/staff/:staffId`
 * record the roster row opens, in a modal so you keep your place on the canvas.
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
  const { total, isInitialLoading, isRefetching } = results;
  // Clicking a person shows their profile without leaving the diagram/roster —
  // a modal, not the navigate-away `selection.onOpenProfile` the model exposes
  // (that's kept for callers that still want a real route, e.g. a bookmark).
  const [modalStaffId, setModalStaffId] = useState<string | null>(null);

  return (
    <DirectoryShell
      eyebrow="Directory · Committee Staff"
      title="Committee Staff"
      subtitle="Committee & subcommittee staff · Grouped by unit · One canonical staff identity."
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
            ) : (
              <GroupedRoster
                model={model}
                onOpenStaffProfile={(id) => {
                  selection.onToggle(id);
                  setModalStaffId(id);
                }}
              />
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
 * Roster, sectioned by the SAME unit grouping the hierarchy canvas uses — the
 * two views are one dataset seen two ways, so a person sits under the same
 * heading in both. Units with no one on record still render their heading:
 * "this subcommittee has no staff in the source" is information, and silently
 * dropping the section would make it look like the unit doesn't exist.
 */
function GroupedRoster({
  model,
  onOpenStaffProfile,
}: {
  model: CommitteeStaffModel;
  onOpenStaffProfile: (id: string) => void;
}) {
  const { filters, results, selection } = model;
  const populated = results.groups.filter((group) => group.staff.length > 0);

  if (populated.length === 0) {
    return (
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
    );
  }

  return (
    <>
      {results.groups.map((group) => (
        <div className="capiro-directory-rostergroup" key={group.committeeId}>
          <div className="capiro-directory-rostergroup__header">
            <p className="capiro-directory-rostergroup__name">
              <span className="capiro-directory-rostergroup__kind">
                {group.kind === 'subcommittee' ? 'Subcommittee' : 'Full committee'}
              </span>
              {group.shortName}
            </p>
            <p className="capiro-directory-rostergroup__count">
              {group.isLoading
                ? 'Loading…'
                : `${group.currentCount} current${group.formerCount ? ` · ${group.formerCount} former` : ''}`}
            </p>
          </div>

          {group.isLoading ? (
            <CapiroSkeleton height={48} />
          ) : group.staff.length === 0 ? (
            <p className="capiro-directory-rostergroup__empty">No staff on record for this unit.</p>
          ) : (
            group.staff.map((staffer) => {
              const isSelected = staffer.id === selection.selectedId;
              return (
                <button
                  type="button"
                  key={`${group.committeeId}-${staffer.id}`}
                  aria-pressed={isSelected}
                  className={`capiro-directory-row capiro-directory-row-grid--roster${
                    isSelected ? ' capiro-directory-row--selected' : ''
                  }`}
                  onClick={() => onOpenStaffProfile(staffer.id)}
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
                    <span className="capiro-directory-cell__primary">{group.shortName}</span>
                    <span className="capiro-directory-cell__secondary">
                      {[group.chamber, group.kind === 'subcommittee' ? 'Subcommittee' : 'Full committee']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
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
      ))}
    </>
  );
}

// ------------------------------------------------------------------ Org chart

type OrgChartNodeData = {
  label: string;
  kind: 'committee' | 'leadership' | 'unit' | 'staff' | 'more';
  /** Small uppercase eyebrow above the name. */
  eyebrow: string;
  meta?: string;
  initials?: string;
  /** Contact-card lines: role, email, phone, office. */
  role?: string;
  email?: string;
  phone?: string;
  office?: string;
  countLine?: string;
  staffId?: string;
  memberId?: string;
  unitId?: string;
  former?: boolean;
};

type OrgChartNode = Node<OrgChartNodeData>;

const COL_W = 320;
const CARD_W = 268;
const ROOT_W = 360;
const ROOT_Y = 0;
const TIER_GAP = 52;
const CARD_GAP = 20;
/** Cards shown per unit before the chart offers to expand the rest. */
const COLLAPSED_PER_UNIT = 6;

/**
 * Card heights must be known at LAYOUT time — XYFlow positions nodes by
 * absolute y, and a contact card's height varies with how many contact lines
 * the source actually has for that person. Measuring after mount would mean a
 * visible reflow, so heights are estimated from the same box model the CSS
 * declares. Overestimating is safe (extra whitespace); underestimating is not
 * (cards overlap), so every wrap estimate rounds up.
 */
const CARD_PAD_Y = 24;
const LINE_EYEBROW = 14;
const LINE_NAME = 18;
const LINE_META = 16;
const LINE_COUNTS = 15;
const LINE_CONTACT = 16;
const CONTACT_BLOCK_CHROME = 17; // 8px margin + 8px padding + 1px rule
const OPEN_LINE = 24; // 8px margin + 16px line

/** Wrapped-line count for `text` at `charsPerLine`, floored at one line. */
function wrappedLines(text: string | undefined, charsPerLine: number): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

function cardHeight(data: OrgChartNodeData, width: number): number {
  // Body width = card width − horizontal padding − mark − gap.
  const bodyWidth = width - 28 - 30 - 10;
  const nameChars = Math.max(12, Math.floor(bodyWidth / 7));
  const metaChars = Math.max(14, Math.floor(bodyWidth / 6.2));
  let height = CARD_PAD_Y;
  // The eyebrow is clamped to one line in CSS, so it never contributes more.
  height += LINE_EYEBROW;
  height += wrappedLines(data.label, nameChars) * LINE_NAME;
  height += wrappedLines(data.role, metaChars) * LINE_META;
  height += wrappedLines(data.meta, metaChars) * LINE_META;
  if (data.countLine) height += LINE_COUNTS;
  const contactLines =
    wrappedLines(data.email, metaChars) +
    wrappedLines(data.phone, metaChars) +
    wrappedLines(data.office, metaChars);
  if (contactLines > 0) height += CONTACT_BLOCK_CHROME + contactLines * LINE_CONTACT;
  if (data.staffId) height += OPEN_LINE;
  // A card is at least as tall as its 30px mark plus padding.
  return Math.max(height, 30 + CARD_PAD_Y);
}

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
  const isInteractive = Boolean(data.staffId || data.memberId || data.kind === 'more');
  const hasContact = Boolean(data.email || data.phone || data.office);
  return (
    <div
      className={`capiro-directory-node capiro-directory-flow-node capiro-directory-node--${data.kind}${
        data.former ? ' capiro-directory-node--former' : ''
      }${isInteractive ? ' capiro-directory-node--clickable' : ''}`}
      role={isInteractive ? 'button' : undefined}
      aria-label={isInteractive && data.staffId ? `Open profile for ${data.label}` : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.currentTarget.click();
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className={`capiro-directory-node__mark capiro-directory-node__mark--${isPerson ? 'person' : 'place'}`}>
        {data.initials ?? data.label.slice(0, 2).toUpperCase()}
      </span>
      <span className="capiro-directory-node__body">
        <span className="capiro-directory-node__kind">{data.eyebrow}</span>
        <span className="capiro-directory-node__name">
          {data.label}
          {data.former ? <CapiroBadge>Former</CapiroBadge> : null}
        </span>
        {data.role ? <span className="capiro-directory-node__meta">{data.role}</span> : null}
        {data.meta ? <span className="capiro-directory-node__meta">{data.meta}</span> : null}
        {data.countLine ? (
          <span className="capiro-directory-node__counts">{data.countLine}</span>
        ) : null}
        {hasContact ? (
          <span className="capiro-directory-node__contact">
            {data.email ? (
              <span className="capiro-directory-node__contactline">{data.email}</span>
            ) : null}
            {data.phone ? (
              <span className="capiro-directory-node__contactline">{data.phone}</span>
            ) : null}
            {data.office ? (
              <span className="capiro-directory-node__contactline capiro-directory-node__contactline--muted">
                {data.office}
              </span>
            ) : null}
          </span>
        ) : null}
        {data.staffId ? (
          <span className="capiro-directory-node__open" aria-hidden="true">
            Open profile →
          </span>
        ) : null}
      </span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const ORG_NODE_TYPES = {
  committee: OrgChartNodeView,
  leadership: OrgChartNodeView,
  unit: OrgChartNodeView,
  staff: OrgChartNodeView,
  more: OrgChartNodeView,
};

function unitEyebrow(group: CommitteeStaffGroup): string {
  return group.kind === 'subcommittee' ? 'Subcommittee' : 'Full committee';
}

function CommitteeOrgChart({
  detail,
  leaders,
  groups,
  selectedId,
  onSelectStaff,
  onOpenMember,
}: {
  detail: NonNullable<CommitteeStaffModel['committee']['detail']>;
  leaders: Array<{ role: string; memberRef: { id: string; name?: string | null } | null }>;
  groups: CommitteeStaffGroup[];
  selectedId: string | null;
  onSelectStaff: (id: string) => void;
  onOpenMember: (id: string) => void;
}) {
  // Which units have had their full roster revealed. Collapsed by default so a
  // 60-person committee still reads as an org chart rather than a wall.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleUnit = useCallback(
    (unitId: string) => setExpanded((prev) => ({ ...prev, [unitId]: !prev[unitId] })),
    [],
  );

  const { nodes, edges } = useMemo(() => {
    const nextNodes: OrgChartNode[] = [];
    const nextEdges: Edge[] = [];
    const columns = Math.max(groups.length, 1);
    const canvasWidth = columns * COL_W;
    const center = canvasWidth / 2;

    const rootData: OrgChartNodeData = {
      kind: 'committee',
      eyebrow: detail.kind === 'subcommittee' ? 'Subcommittee' : 'Committee',
      label: detail.name,
      initials: detail.committeeCode ?? detail.name.slice(0, 2).toUpperCase(),
      meta: [detail.chamber, detail.committeeCode].filter(Boolean).join(' · '),
      phone: detail.phone || undefined,
      office: detail.officeLocation || undefined,
      countLine: `${groups.reduce((sum, group) => sum + group.currentCount, 0)} current staff · ${
        groups.filter((group) => group.kind === 'subcommittee').length
      } subcommittees`,
    };
    nextNodes.push({
      id: 'committee',
      type: 'committee',
      position: { x: Math.max(0, center - ROOT_W / 2), y: ROOT_Y },
      data: rootData,
    });

    // Every tier starts below the tallest card of the tier above it, so no
    // amount of real contact data can make two cards collide.
    const leaderY = ROOT_Y + cardHeight(rootData, ROOT_W) + TIER_GAP;
    const leaderSpan = CARD_W + 32;
    let leaderBottom = leaderY;
    leaders.forEach((leader, index) => {
      const id = `leader-${leader.role}`;
      const data: OrgChartNodeData = {
        kind: 'leadership',
        eyebrow: 'Leadership',
        label: leader.memberRef?.name ?? 'Not recorded',
        initials: initialsFor(leader.memberRef?.name),
        role: leader.role,
        memberId: leader.memberRef?.id,
      };
      nextNodes.push({
        id,
        type: 'leadership',
        position: {
          x: center - (leaders.length * leaderSpan) / 2 + index * leaderSpan + (leaderSpan - CARD_W) / 2,
          y: leaderY,
        },
        data,
      });
      leaderBottom = Math.max(leaderBottom, leaderY + cardHeight(data, CARD_W));
      nextEdges.push({ id: `committee-${id}`, source: 'committee', target: id, type: 'smoothstep' });
    });

    const unitY = (leaders.length ? leaderBottom : ROOT_Y + cardHeight(rootData, ROOT_W)) + TIER_GAP;

    // Unit headers share one baseline (they are peers), so the staff tier below
    // starts under the TALLEST header rather than each column's own.
    const unitData = groups.map<OrgChartNodeData>((group) => ({
      kind: 'unit',
      eyebrow: unitEyebrow(group),
      label: group.shortName,
      initials: group.shortName.slice(0, 2).toUpperCase(),
      meta: group.chamber ?? undefined,
      countLine: group.isLoading
        ? 'Loading staff…'
        : `${group.currentCount} current${group.formerCount ? ` · ${group.formerCount} former` : ''}`,
      unitId: group.committeeId,
    }));
    const staffY =
      unitY + Math.max(0, ...unitData.map((data) => cardHeight(data, CARD_W))) + TIER_GAP;

    groups.forEach((group, columnIndex) => {
      const unitNodeId = `unit-${group.committeeId}`;
      const columnX = columnIndex * COL_W + (COL_W - CARD_W) / 2;
      nextNodes.push({
        id: unitNodeId,
        type: 'unit',
        position: { x: columnX, y: unitY },
        data: unitData[columnIndex]!,
      });
      nextEdges.push({
        id: `committee-${unitNodeId}`,
        source: 'committee',
        target: unitNodeId,
        type: 'smoothstep',
      });

      const isExpanded = Boolean(expanded[group.committeeId]);
      const visible = isExpanded ? group.staff : group.staff.slice(0, COLLAPSED_PER_UNIT);
      let cursorY = staffY;
      visible.forEach((person) => {
        // Namespaced by unit: the same person can hold a position on the full
        // committee AND a subcommittee, which is two placements of one identity
        // — the node id must be unique, the staffId it opens must not be.
        const id = `staff-${group.committeeId}-${person.id}`;
        const data: OrgChartNodeData = {
          kind: 'staff',
          eyebrow: group.shortName,
          label: person.fullName,
          initials: initialsFor(person.fullName),
          role: person.title || 'Staff',
          email: person.email || undefined,
          phone: person.phone || undefined,
          office: person.officeLocation || undefined,
          staffId: person.id,
          unitId: group.committeeId,
          former: !person.isCurrent,
        };
        nextNodes.push({ id, type: 'staff', position: { x: columnX, y: cursorY }, data });
        cursorY += cardHeight(data, CARD_W) + CARD_GAP;
        nextEdges.push({
          id: `${unitNodeId}-${id}`,
          source: unitNodeId,
          target: id,
          type: 'smoothstep',
        });
      });

      const hidden = group.staff.length - visible.length;
      if (hidden > 0 || (isExpanded && group.staff.length > COLLAPSED_PER_UNIT)) {
        const id = `more-${group.committeeId}`;
        nextNodes.push({
          id,
          type: 'more',
          position: { x: columnX, y: cursorY },
          data: {
            kind: 'more',
            eyebrow: unitEyebrow(group),
            label: hidden > 0 ? `Show ${hidden} more` : 'Show fewer',
            initials: hidden > 0 ? `+${hidden}` : '−',
            unitId: group.committeeId,
          },
        });
        nextEdges.push({
          id: `${unitNodeId}-${id}`,
          source: unitNodeId,
          target: id,
          type: 'smoothstep',
        });
      }
    });

    return { nodes: nextNodes, edges: nextEdges };
  }, [detail, leaders, groups, expanded]);

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, node: OrgChartNode) => {
      if (node.data.kind === 'more' && node.data.unitId) {
        toggleUnit(node.data.unitId);
        return;
      }
      if (node.data.staffId) onSelectStaff(node.data.staffId);
      if (node.data.memberId) onOpenMember(node.data.memberId);
    },
    [onOpenMember, onSelectStaff, toggleUnit],
  );

  return (
    <div
      className="capiro-directory-flow-wrap"
      data-testid="committee-org-chart"
      aria-label="Committee organization chart"
    >
      <ReactFlow
        nodes={nodes.map((node) => ({
          ...node,
          selected: Boolean(node.data.staffId) && node.data.staffId === selectedId,
          className: node.data.former ? 'capiro-directory-node--former' : undefined,
        }))}
        edges={edges}
        nodeTypes={ORG_NODE_TYPES}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <p className="capiro-directory-flow-note">
        <strong>Grouped by committee office</strong> · Each person sits under the committee or
        subcommittee the source records their position against. Click a card to open their profile.
      </p>
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

  return (
    <div className="capiro-directory-hierarchy">
      <div className="capiro-directory-results__header">
        <p className="capiro-directory-results__eyebrow">{detail?.name ?? 'Committee'} · Hierarchy</p>
        <p className="capiro-directory-results__count">
          {results.isInitialLoading
            ? 'Loading…'
            : `${results.groups.reduce((sum, group) => sum + group.staff.length, 0)} staff · ${
                results.groups.length
              } unit${results.groups.length === 1 ? '' : 's'}${
                results.isLoadingGroups ? ' · loading units…' : ''
              }`}
        </p>
      </div>
      {results.isInitialLoading ? (
        <CapiroSkeleton height={320} />
      ) : !detail ? (
        <CapiroEmptyState title="No committee selected" description="Choose a committee to see its structure." />
      ) : (
        <div className="capiro-directory-canvas">
          <ReactFlowProvider>
            <CommitteeOrgChart
              detail={detail}
              leaders={leaders}
              groups={results.groups}
              selectedId={selection.selectedId}
              onSelectStaff={(id) => {
                selection.onToggle(id);
                onOpenStaffProfile(id);
              }}
              onOpenMember={(id) => navigate(`/directory/members/${id}`)}
            />
          </ReactFlowProvider>
          <div className="capiro-directory-legend">
            <span className="capiro-directory-legend__item">Solid · formal committee structure</span>
            <span className="capiro-directory-legend__item">
              Each column is one committee office roster
            </span>
            <span className="capiro-directory-legend__item capiro-directory-legend__item--disabled">
              Person-to-person reporting lines · not source-backed
            </span>
          </div>
        </div>
      )}
    </div>
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
