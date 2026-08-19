import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DIRECTORY_ROUTES } from '../../directory/directory-routes.js';
import {
  Card,
  CardHead,
  Eyebrow,
  PfButton,
  PfEmptyState,
  PfSkeleton,
  Pill,
  PILL,
  TabPageHead,
  Tile,
  UIcon,
  type PillTone,
} from '../portfolio-primitives.js';
import { GOV_ROWS, TARGETS } from '../portfolio-fixtures.js';
import { formatDateShort, humanizeEnumToken } from '../../../lib/labels.js';
import { initialsFor } from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import { useApi } from '../../../../lib/use-api.js';
import {
  addClientTarget,
  getClientTargets,
  getOfficeRecommendations,
  refreshOfficeRecommendations,
  type ClientTarget,
  type OfficeRecommendation,
  type OfficeRecommendationsResult,
  type TargetDirectory,
} from '../../../../pages/clients/targets-api.js';
import { profileHref } from '../../../../pages/clients/targets-normalize.js';
import { TargetDrawer, type TargetRecord } from '../portfolio-overlays.js';
import { AddRelationshipModal } from '../AddRelationshipModal.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Relationships / Government sub-tab (spec §8.2).
 *
 * Current targets and the relationships table bind to the real targets backend
 * (`pages/clients/targets-api.ts`) — the same `['client-targets', clientId]`
 * cache entry the canonical TargetsTab uses, so an edit in either surface is
 * seen by the other. The design's TARGETS / GOV_ROWS fixtures still render
 * while the query is loading or errored, keeping the surface pixel-reviewable
 * (the convention this file family already follows — see WorkTab §9).
 *
 * The side rail is the office recommender from app Targets ("Suggested by Meri"),
 * not the retired relationship-network card. Same query keys and mutations as
 * `TargetsTab` so add/refresh stay cache-coherent across surfaces.
 */

const DISPOSITION_TONE: Record<string, PillTone> = {
  Supportive: 'success',
  Neutral: 'gray',
  Opposed: 'error',
};

const GROUP_FILTERS = ['All', 'Congress', 'Agencies', 'Committees', 'Current targets'] as const;
type GroupFilter = (typeof GROUP_FILTERS)[number];

/** Real directories the targets backend actually distinguishes (item 14). The
 *  fixture's Agencies/Committees groups have no equivalent — a `ClientTarget`
 *  is always a person from one of these three directories. */
const REAL_FILTERS = ['All', 'Congress', 'State', 'Staff'] as const;
type RealFilter = (typeof REAL_FILTERS)[number];

const DIRECTORY_LABEL: Record<TargetDirectory, string> = {
  congress: 'Member of Congress',
  state: 'State legislator',
  staff: 'Congressional staff',
};

const DIRECTORY_FILTER: Record<TargetDirectory, RealFilter> = {
  congress: 'Congress',
  state: 'State',
  staff: 'Staff',
};

const PAGE_SIZE = 10;

const targetName = (t: ClientTarget) => t.memberName ?? t.memberId;

function targetRole(t: ClientTarget): string {
  const parts = [t.chamber, t.committee].filter(Boolean);
  return parts.length ? parts.join(' · ') : DIRECTORY_LABEL[t.sourceDirectory];
}

/** Real `ClientTarget` → the drawer's record. Only fields with a real column
 *  are supplied; the drawer omits the rest rather than inventing them. */
function toTargetRecord(t: ClientTarget): TargetRecord {
  return {
    kind: 'person',
    init: initialsFor(targetName(t)),
    name: targetName(t),
    role: targetRole(t),
    tier: t.tier,
    addedAt: t.addedAt,
    addedVia: t.source,
    facilities: (t.representedFacilities ?? []).map((f) => f.name),
    profileHref: profileHref(t.sourceDirectory, t.memberId),
  };
}

export function ClientCrmGovernmentProto({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();
  const [drawerTarget, setDrawerTarget] = useState<ClientTarget | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Same query key as the canonical TargetsTab — one shared cache entry (§10).
  const targetsQ = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });
  const realTargets = targetsQ.isSuccess ? targetsQ.data : null;

  /**
   * Item 11: the real create flow is a debounced tri-directory search +
   * `addClientTarget`. This used to navigate to `?tab=targets` on the reasoning
   * that the antd TargetsTab owned that flow and `src/vnext` must stay
   * antd-free — but on os.capiro.ai that navigation is a NO-OP:
   * `client-crm-routing`'s LEGACY_TABS maps `tab=targets` back to
   * `relationships/government`, the view already on screen. So the button did
   * nothing. `AddRelationshipModal` is that same flow, native to vNext, on the
   * same endpoints and the same `['client-targets', clientId]` cache entry.
   */
  const openAddRelationship = () => setAddOpen(true);

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Government relationships"
        sub="Current targets from Strategies, plus the broader offices and officials connected to this client."
        actions={
          <PfButton variant="primary" onClick={openAddRelationship}>
            Add relationship
          </PfButton>
        }
      />

      {realTargets ? (
        <RealCurrentTargetsPanel targets={realTargets} onOpen={setDrawerTarget} />
      ) : (
        <CurrentTargetsPanel />
      )}

      <div className="cap-pf-grid-side-380">
        {realTargets ? (
          <RealRelationshipsTableCard targets={realTargets} onOpen={setDrawerTarget} />
        ) : (
          <RelationshipsTableCard />
        )}
        <TargetRecommendationsCard client={client} targets={realTargets ?? []} />
      </div>

      <AddRelationshipModal open={addOpen} clientId={client.id} onClose={() => setAddOpen(false)} />

      {drawerTarget ? (
        <TargetDrawer
          target={toTargetRecord(drawerTarget)}
          onClose={() => setDrawerTarget(null)}
          onOpenProfile={() => navigate(profileHref(drawerTarget.sourceDirectory, drawerTarget.memberId))}
        />
      ) : null}
    </div>
  );
}

/* ── Current targets — real (items 12 + 13) ───────────────────────────────── */

function RealCurrentTargetsPanel({
  targets,
  onOpen,
}: {
  targets: ClientTarget[];
  onOpen: (t: ClientTarget) => void;
}) {
  // Tiered targets first (1 is highest), untiered last; stable by name after.
  const ordered = useMemo(
    () =>
      [...targets].sort((a, b) => {
        const at = a.tier ?? 99;
        const bt = b.tier ?? 99;
        if (at !== bt) return at - bt;
        return targetName(a).localeCompare(targetName(b));
      }),
    [targets],
  );

  return (
    <section
      style={{
        background: '#F9FAFB',
        borderRadius: 12,
        boxShadow: 'inset 0 0 0 1px #EAECF0',
        padding: '20px 20px 22px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>Current targets</h3>
        <span style={{ flex: 1 }} />
        <Eyebrow>
          {ordered.length} target{ordered.length === 1 ? '' : 's'}
        </Eyebrow>
      </div>

      {ordered.length === 0 ? (
        <div style={{ padding: '18px 4px 6px' }}>
          {/* The page header already carries the one "Add relationship" button —
              a second one here was a duplicate call to the same action. */}
          <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
            No government targets yet — add one from the header.
          </p>
        </div>
      ) : (
        <div className="cap-pf-grid-targets">
          {ordered.slice(0, 6).map((t, i) => (
            <RealTargetCard key={t.id} target={t} slot={`Target 0${i + 1}`} onOpen={() => onOpen(t)} />
          ))}
        </div>
      )}
    </section>
  );
}

function RealTargetCard({
  target: t,
  slot,
  onOpen,
}: {
  target: ClientTarget;
  slot: string;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 10,
        boxShadow: 'inset 0 0 0 1px #EAECF0',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <Eyebrow tight>{slot}</Eyebrow>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <button
          type="button"
          onClick={onOpen}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            gap: 10,
            padding: 10,
            borderRadius: 8,
            textAlign: 'left',
            background: hover ? '#F9FAFB' : 'transparent',
            boxShadow: hover ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0',
          }}
        >
          <Tile initials={initialsFor(targetName(t))} size={40} dark round />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
              {DIRECTORY_LABEL[t.sourceDirectory]}
            </span>
            <span style={{ display: 'block', marginTop: 3, fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {targetName(t)}
            </span>
            <span style={{ display: 'block', fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {targetRole(t)}
            </span>
            {t.party || t.state ? (
              <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: '#667085' }}>
                {[t.party, t.state].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </span>
        </button>
        <span style={{ flex: '0 0 auto' }}>
          <Pill tone={t.tier === 1 ? 'brand' : 'gray'} size="lg">
            {t.tier == null ? 'Untiered' : `Tier ${t.tier}`}
          </Pill>
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid #EAECF0' }}>
        <TargetField
          label="Represents"
          value={
            t.representedFacilities?.length
              ? t.representedFacilities.map((f) => f.name).join(', ')
              : 'No facility in this district'
          }
        />
        {/* Unknown source tokens are humanized, not silently collapsed to
            "Manual"; the date carries its year when it is not the current one. */}
        <TargetField
          label="Added"
          value={`${t.source === 'meri' ? 'Meri' : humanizeEnumToken(t.source)} · ${formatDateShort(t.addedAt) ?? '—'}`}
        />
      </div>

      <PfButton variant="link" style={{ alignSelf: 'flex-end' }} onClick={onOpen}>
        Open target →
      </PfButton>
    </div>
  );
}

/* ── All government relationships — real (item 14) ────────────────────────── */

function RealRelationshipsTableCard({
  targets,
  onOpen,
}: {
  targets: ClientTarget[];
  onOpen: (t: ClientTarget) => void;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RealFilter>('All');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return targets.filter((t) => {
      if (filter !== 'All' && DIRECTORY_FILTER[t.sourceDirectory] !== filter) return false;
      if (!q) return true;
      return `${targetName(t)} ${t.chamber ?? ''} ${t.state ?? ''} ${t.committee ?? ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [targets, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const filterActive = filter !== 'All' || query.trim() !== '';

  return (
    <Card>
      <CardHead
        withDesc
        title="All government relationships"
        action={
          <PfButton variant="link" onClick={() => navigate(DIRECTORY_ROUTES.congressionalStaff)}>
            View directory
          </PfButton>
        }
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px 12px', flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 12px',
            flex: 1,
            minWidth: 200,
            borderRadius: 8,
            boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
          }}
        >
          <UIcon name="SearchLg" size={20} color="#667085" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            aria-label="Search relationships"
            placeholder="Search targets by name, chamber, state or committee"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: '#101828' }}
          />
        </div>
        {REAL_FILTERS.map((g) => (
          <FilterChip
            key={g}
            label={g}
            active={filter === g}
            onClick={() => {
              setFilter(g);
              setPage(0);
            }}
          />
        ))}
      </div>

      <div style={{ width: '100%', overflowX: 'auto' }}>
        <div style={{ minWidth: 800 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 24px',
              background: '#F9FAFB',
              borderTop: '1px solid #EAECF0',
              borderBottom: '1px solid #EAECF0',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: '#667085',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Name</span>
            <span style={{ flex: '0 0 auto', width: 124 }}>Type</span>
            <span style={{ flex: '0 0 auto', width: 104 }}>Jurisdiction</span>
            <span style={{ flex: '0 0 auto', width: 148 }}>Committee / office</span>
            <span style={{ flex: '0 0 auto', width: 112 }}>Tier</span>
          </div>
          {rows.length === 0 ? (
            <p style={{ margin: 0, padding: '16px 24px', fontSize: 14, color: '#475467' }}>
              {targets.length === 0
                ? 'No government targets have been added for this client yet.'
                : 'No target matches this search.'}
            </p>
          ) : (
            rows.map((t) => <RealGovRow key={t.id} target={t} onOpen={() => onOpen(t)} />)
          )}
        </div>
      </div>

      <TableFooter
        shown={rows.length}
        filteredCount={filtered.length}
        totalCount={targets.length}
        filterActive={filterActive}
        page={safePage}
        pageCount={pageCount}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
      />
    </Card>
  );
}

/**
 * Shared table footer (real + fixture tables). "Showing N of M" counts the
 * FILTERED set — "Showing 3 of 47" while a filter hid 44 rows was a lie; the
 * unfiltered total moves into an explicit "filtered from" suffix. Pagination
 * disappears entirely when there is nothing to page.
 */
function TableFooter({
  shown,
  filteredCount,
  totalCount,
  filterActive,
  page,
  pageCount,
  onPrev,
  onNext,
}: {
  shown: number;
  filteredCount: number;
  totalCount: number;
  filterActive: boolean;
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px' }}>
      <span style={{ fontSize: 14, color: '#475467' }}>
        Showing {shown} of {filteredCount} relationship{filteredCount === 1 ? '' : 's'}
        {filterActive && filteredCount !== totalCount ? ` · filtered from ${totalCount}` : ''}
      </span>
      <span style={{ flex: 1 }} />
      {shown > 0 ? (
        <>
          <PagerLink label="← Previous" ariaLabel="Previous page" disabled={page === 0} onClick={onPrev} />
          <PagerLink label="Next →" ariaLabel="Next page" disabled={page >= pageCount - 1} onClick={onNext} />
        </>
      ) : null}
    </div>
  );
}

/** Link-styled pager button. Local because the primitive's link variant does
 *  not forward `ariaLabel`, and these arrows need accessible names. */
function PagerLink({
  label,
  ariaLabel,
  disabled,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 14,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        color: disabled ? '#98A2B3' : hover ? '#0E141C' : '#101828',
      }}
    >
      {label}
    </button>
  );
}

function RealGovRow({ target: t, onOpen }: { target: ClientTarget; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 12,
        padding: '13px 24px',
        borderBottom: '1px solid #EAECF0',
        textAlign: 'left',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {targetName(t)}
      </span>
      <span style={{ flex: '0 0 auto', width: 124, fontSize: 13, color: '#475467' }}>{DIRECTORY_LABEL[t.sourceDirectory]}</span>
      <span
        title={t.state ? undefined : 'Not on file'}
        style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467' }}
      >
        {t.state ?? '—'}
      </span>
      <span
        title={t.committee ? undefined : 'Not on file'}
        style={{ flex: '0 0 auto', width: 148, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {t.committee ?? '—'}
      </span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={t.tier === 1 ? 'brand' : 'gray'}>{t.tier == null ? 'Untiered' : `Tier ${t.tier}`}</Pill>
      </span>
    </button>
  );
}

/* ── Current targets (tinted panel) — design fixture ──────────────────────── */

function CurrentTargetsPanel() {
  return (
    <section
      style={{
        background: '#F9FAFB',
        borderRadius: 12,
        boxShadow: 'inset 0 0 0 1px #EAECF0',
        padding: '20px 20px 22px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>Current targets</h3>
        <span style={{ flex: 1 }} />
        <Eyebrow>3 active · from Strategies</Eyebrow>
      </div>

      <div className="cap-pf-grid-targets">
        {TARGETS.map((t, i) => (
          <TargetCard key={t.id} target={t} slot={`Target 0${i + 1}`} />
        ))}
      </div>
    </section>
  );
}

function TargetCard({ target: t, slot }: { target: (typeof TARGETS)[number]; slot: string }) {
  const tone = DISPOSITION_TONE[t.disposition] ?? 'gray';
  const [, , dispFg, dispDot] = PILL[tone];
  return (
    <div
      style={{
        background: '#ffffff',
        borderRadius: 10,
        boxShadow: 'inset 0 0 0 1px #EAECF0',
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <Eyebrow tight>{slot}</Eyebrow>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <TargetMiniCard target={t} dispFg={dispFg} dispDot={dispDot} />
        <span style={{ flex: '0 0 auto' }}>
          <Pill tone="gray" size="lg">
            {t.date}
          </Pill>
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid #EAECF0' }}>
        <TargetField label="Linked strategy" value={t.strategy} />
        <TargetField label="Current ask" value={t.ask} />
      </div>

      <PfButton variant="link" style={{ alignSelf: 'flex-end' }}>
        Open target →
      </PfButton>
    </div>
  );
}

/** Fixture-only mini card. Non-interactive on purpose: the design's people
 *  are not records, so a button here promised a drawer that never opened. */
function TargetMiniCard({
  target: t,
  dispFg,
  dispDot,
}: {
  target: (typeof TARGETS)[number];
  dispFg: string;
  dispDot: string;
}) {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        gap: 10,
        padding: 10,
        borderRadius: 8,
        textAlign: 'left',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
      }}
    >
      <Tile initials={t.init} size={40} dark round={t.kind === 'person'} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: dispFg,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: dispDot }} aria-hidden />
          {t.disposition}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 3,
            fontSize: 14,
            fontWeight: 600,
            color: '#101828',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.name}
        </span>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            color: '#475467',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.role}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: 12,
            color: '#667085',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.confirm}
        </span>
      </span>
    </span>
  );
}

function TargetField({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <span
        style={{
          flex: '0 0 auto',
          width: 112,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '.05em',
          textTransform: 'uppercase',
          color: '#667085',
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{value}</span>
    </span>
  );
}

/* ── All government relationships (table) ─────────────────────────────────── */

function RelationshipsTableCard() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<GroupFilter>('Congress');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GOV_ROWS.filter((r) => {
      const inGroup =
        filter === 'All' ? true : filter === 'Current targets' ? r.target === 'Current' : r.group === filter;
      if (!inGroup) return false;
      if (!q) return true;
      return `${r.name} ${r.type} ${r.jurisdiction} ${r.office}`.toLowerCase().includes(q);
    });
  }, [filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const choose = (next: GroupFilter) => {
    setFilter(next);
    setPage(0);
  };

  return (
    <Card>
      <CardHead
        withDesc
        title="All government relationships"
        action={
          <PfButton variant="link" onClick={() => navigate(DIRECTORY_ROUTES.congressionalStaff)}>
            View directory
          </PfButton>
        }
      />

      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px 12px', flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 12px',
            flex: 1,
            minWidth: 200,
            borderRadius: 8,
            boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
          }}
        >
          <UIcon name="SearchLg" size={20} color="#667085" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            aria-label="Search relationships"
            placeholder="Search officials, committees, offices"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 14, color: '#101828' }}
          />
        </div>
        {GROUP_FILTERS.map((g) => (
          <FilterChip key={g} label={g} active={filter === g} onClick={() => choose(g)} />
        ))}
      </div>

      {/* table */}
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <div style={{ minWidth: 800 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 24px',
              background: '#F9FAFB',
              borderTop: '1px solid #EAECF0',
              borderBottom: '1px solid #EAECF0',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: '#667085',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>Name</span>
            <span style={{ flex: '0 0 auto', width: 124 }}>Type</span>
            <span style={{ flex: '0 0 auto', width: 104 }}>Jurisdiction</span>
            <span style={{ flex: '0 0 auto', width: 148 }}>Committee / office</span>
            <span style={{ flex: '0 0 auto', width: 112 }}>Target</span>
          </div>
          {rows.map((r) => (
            <GovRow key={r.name} row={r} />
          ))}
        </div>
      </div>

      {/* footer */}
      <TableFooter
        shown={rows.length}
        filteredCount={filtered.length}
        totalCount={GOV_ROWS.length}
        filterActive={filter !== 'All' || query.trim() !== ''}
        page={safePage}
        pageCount={pageCount}
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
      />
    </Card>
  );
}

/** Fixture-only row. Non-interactive on purpose: it had button semantics and a
 *  pointer cursor but no handler — a click promise the row could not keep. */
function GovRow({ row: r }: { row: (typeof GOV_ROWS)[number] }) {
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 12,
        padding: '13px 24px',
        borderBottom: '1px solid #EAECF0',
        textAlign: 'left',
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: 500,
          color: '#101828',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {r.name}
      </span>
      <span style={{ flex: '0 0 auto', width: 124, fontSize: 13, color: '#475467' }}>{r.type}</span>
      <span style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467' }}>{r.jurisdiction}</span>
      <span
        style={{
          flex: '0 0 auto',
          width: 148,
          fontSize: 13,
          color: '#475467',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {r.office}
      </span>
      <span style={{ flex: '0 0 auto', width: 112 }}>
        <Pill tone={r.target === 'Current' ? 'brand' : 'gray'}>{r.target}</Pill>
      </span>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        background: active ? '#F2F4F7' : hover ? '#F9FAFB' : 'transparent',
        boxShadow: active ? 'inset 0 0 0 1px #D0D5DD' : 'none',
        color: active ? '#101828' : '#667085',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

/* ── Target recommendations (office recommender / Suggested by Meri) ─────── */

/** Compact "updated X ago" — same cadence as legacy TargetsTab. */
function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const PARTY_TONE: Record<string, PillTone> = {
  R: 'error',
  D: 'blue',
  I: 'gray',
};

/**
 * Side rail: office recommendations from
 * GET/POST `/api/clients/:id/target-recommendations`. Same cache keys as
 * TargetsTab so a refresh from the client shell or an add here is shared.
 * Styled with portfolio Card / PfButton / Pill primitives (UUI gray + dark
 * gradient primary) — not the legacy antd meri-panel classes.
 */
function TargetRecommendationsCard({
  client,
  targets,
}: {
  client: Client;
  targets: ClientTarget[];
}) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const clientId = client.id;

  const recsQ = useQuery<OfficeRecommendationsResult>({
    queryKey: ['client-target-recommendations', clientId],
    queryFn: () => getOfficeRecommendations(api, clientId),
    enabled: Boolean(clientId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const refreshMutation = useMutation({
    mutationFn: () => refreshOfficeRecommendations(api, clientId),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['client-target-recommendations', clientId] });
    },
    onSuccess: (data) => {
      qc.setQueryData(['client-target-recommendations', clientId], data);
    },
  });

  const addMutation = useMutation({
    mutationFn: (memberId: string) => addClientTarget(api, clientId, memberId, 'meri', 'congress'),
    onMutate: async (memberId) => {
      await qc.cancelQueries({ queryKey: ['client-targets', clientId] });
      const prev = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]);
      const optimistic: ClientTarget = {
        id: `optimistic-${memberId}`,
        clientId,
        memberId,
        memberName: null,
        sourceDirectory: 'congress',
        party: null,
        state: null,
        chamber: null,
        committee: null,
        tier: null,
        source: 'meri',
        addedByUserId: null,
        addedAt: new Date().toISOString(),
        representedFacilities: null,
      };
      qc.setQueryData<ClientTarget[]>(['client-targets', clientId], [...(prev ?? []), optimistic]);
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['client-targets', clientId], ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['client-targets', clientId] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  const suggestions = useMemo(
    () =>
      (recsQ.data?.recommendations ?? [])
        .filter((r): r is OfficeRecommendation => typeof r?.memberId === 'string' && r.memberId.length > 0)
        .slice(0, 6),
    [recsQ.data],
  );

  const addedIds = useMemo(() => new Set(targets.map((t) => t.memberId)), [targets]);
  const computedAt = recsQ.data?.computedAt ?? null;
  const recsLoading = recsQ.isLoading || (recsQ.isFetching && !recsQ.data);
  const refreshing = refreshMutation.isPending;
  const openIntel = () =>
    navigate(`/clients?clientId=${encodeURIComponent(clientId)}&tab=intelligence&view=legislative`);

  return (
    <Card>
      <CardHead
        withDesc
        title="Suggested by Meri"
        description="Ranked by committee jurisdiction over tracked bills, with issue overlap and facility-district nexus when available."
        action={
          <PfButton
            variant="secondary"
            size="sm"
            busy={refreshing}
            disabled={refreshing || recsLoading}
            onClick={() => refreshMutation.mutate()}
            title="Recompute recommendations from the latest tracked bills and facilities"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </PfButton>
        }
      />

      {computedAt && !recsLoading ? (
        <div style={{ padding: '0 24px 12px', fontSize: 12, fontWeight: 500, color: '#667085' }}>
          Updated {relativeTime(computedAt)}
          <span style={{ color: '#98A2B3' }}> · top 6 · weighted score</span>
        </div>
      ) : null}

      {recsLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 24px 24px' }} aria-busy="true" aria-label="Loading recommendations">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <PfSkeleton width={28} height={28} style={{ borderRadius: 8 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <PfSkeleton width="70%" height={14} />
                <PfSkeleton width="45%" height={12} />
              </div>
              <PfSkeleton width={52} height={28} style={{ borderRadius: 8 }} />
            </div>
          ))}
        </div>
      ) : recsQ.isError || refreshMutation.isError ? (
        <PfEmptyState
          title="Couldn't load recommendations"
          hint="Try again, or confirm tracked bills and facilities are set for this client."
          action={
            <PfButton variant="secondary" size="sm" onClick={() => refreshMutation.mutate()} disabled={refreshing} busy={refreshing}>
              Try again
            </PfButton>
          }
        />
      ) : suggestions.length === 0 ? (
        <PfEmptyState
          title="No Meri suggestions yet"
          hint="Confirm this client's LDA match and add tracked bills in Intelligence, then refresh to get recommendations."
          action={
            <PfButton variant="secondary" size="sm" onClick={openIntel}>
              Open Intelligence
            </PfButton>
          }
        />
      ) : (
        <div role="list" aria-label="Suggested targets">
          {suggestions.map((m, idx) => {
            const added = addedIds.has(m.memberId);
            const adding = addMutation.isPending && addMutation.variables === m.memberId;
            const partyTone = PARTY_TONE[m.party ?? ''] ?? 'gray';
            const partyLabel = [m.party, m.state].filter(Boolean).join('-') || '—';
            return (
              <div
                key={m.memberId}
                role="listitem"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '14px 24px',
                  borderTop: idx === 0 ? '1px solid #EAECF0' : undefined,
                  borderBottom: '1px solid #EAECF0',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flex: '0 0 auto',
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    background: '#F2F4F7',
                    color: '#475467',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 2,
                  }}
                >
                  {idx + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => navigate(profileHref('congress', m.memberId))}
                    style={{
                      textAlign: 'left',
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#101828',
                      lineHeight: '20px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={m.office}
                  >
                    {m.office || m.memberId}
                  </button>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    <Pill tone={partyTone} style={{ height: 22 }}>
                      {partyLabel}
                    </Pill>
                    {m.chamber ? (
                      <span style={{ fontSize: 12, color: '#667085' }}>{m.chamber}</span>
                    ) : null}
                    {m.committee ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: '#667085',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          maxWidth: 160,
                        }}
                        title={m.committee}
                      >
                        {m.committee}
                      </span>
                    ) : null}
                  </div>
                  <span style={{ fontSize: 12, color: '#667085' }}>
                    {m.billCount} tracked bill{m.billCount === 1 ? '' : 's'}
                    <span style={{ color: '#D0D5DD' }}> · </span>
                    score {Number(m.score ?? 0).toFixed(2)}
                  </span>
                </div>
                <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                  {added ? (
                    <Pill tone="success" style={{ height: 28 }}>
                      Added
                    </Pill>
                  ) : (
                    <PfButton
                      variant="secondary"
                      size="sm"
                      busy={adding}
                      disabled={adding || addMutation.isPending}
                      onClick={() => addMutation.mutate(m.memberId)}
                      style={{ height: 32, padding: '0 12px', fontSize: 13 }}
                    >
                      + Add
                    </PfButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '12px 24px 16px',
        }}
      >
        <PfButton variant="link" onClick={openIntel}>
          View all in Intelligence →
        </PfButton>
      </div>
    </Card>
  );
}
