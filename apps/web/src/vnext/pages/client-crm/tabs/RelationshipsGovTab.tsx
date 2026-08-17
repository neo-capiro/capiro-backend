import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DIRECTORY_ROUTES } from '../../directory/directory-routes.js';
import {
  Card,
  CardHead,
  Eyebrow,
  PfButton,
  Pill,
  PILL,
  TabPageHead,
  Tile,
  UIcon,
  type PillTone,
} from '../portfolio-primitives.js';
import { GOV_ROWS, TARGETS } from '../portfolio-fixtures.js';
import { initialsFor } from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import { useApi } from '../../../../lib/use-api.js';
import {
  getClientTargets,
  type ClientTarget,
  type TargetDirectory,
} from '../../../../pages/clients/targets-api.js';
import { profileHref } from '../../../../pages/clients/targets-normalize.js';
import { TargetDrawer, type TargetRecord } from '../portfolio-overlays.js';
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
 * The network card stays fixture-only: "access path via <person>" has no
 * backing record anywhere, and no wire-audit row claims it does.
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

  // Same query key as the canonical TargetsTab — one shared cache entry (§10).
  const targetsQ = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });
  const realTargets = targetsQ.isSuccess ? targetsQ.data : null;

  // Item 11: the real create flow is TargetsTab's debounced tri-directory
  // search + `addClientTarget`. That component is antd-based and `src/vnext` is
  // deliberately antd-free, so this navigates to the real, maintained flow
  // rather than forking a second one (same call as item 3's Manage facilities).
  const openAddRelationship = () =>
    navigate(`/clients?clientId=${encodeURIComponent(client.id)}&tab=targets`);

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
        <RealCurrentTargetsPanel targets={realTargets} onOpen={setDrawerTarget} onAdd={openAddRelationship} />
      ) : (
        <CurrentTargetsPanel />
      )}

      <div className="cap-pf-grid-side-380">
        {realTargets ? (
          <RealRelationshipsTableCard targets={realTargets} onOpen={setDrawerTarget} />
        ) : (
          <RelationshipsTableCard />
        )}
        <NetworkCard client={client} />
      </div>

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
  onAdd,
}: {
  targets: ClientTarget[];
  onOpen: (t: ClientTarget) => void;
  onAdd: () => void;
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
          <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
            No government targets have been added for this client yet.
          </p>
          <div style={{ marginTop: 12 }}>
            <PfButton variant="primary" onClick={onAdd}>
              Add relationship
            </PfButton>
          </div>
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
        <TargetField label="Added" value={`${t.source === 'meri' ? 'Meri' : 'Manual'} · ${new Date(t.addedAt).toLocaleDateString()}`} />
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px' }}>
        <span style={{ fontSize: 14, color: '#475467' }}>
          Showing {rows.length} of {targets.length} relationship{targets.length === 1 ? '' : 's'}
        </span>
        <span style={{ flex: 1 }} />
        <PfButton
          variant="link"
          disabled={safePage === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          style={{ color: safePage === 0 ? '#98A2B3' : undefined }}
        >
          ← Previous
        </PfButton>
        <PfButton
          variant="link"
          disabled={safePage >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          style={{ color: safePage >= pageCount - 1 ? '#98A2B3' : undefined }}
        >
          Next →
        </PfButton>
      </div>
    </Card>
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
      <span style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467' }}>{t.state ?? '—'}</span>
      <span style={{ flex: '0 0 auto', width: 148, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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

function TargetMiniCard({
  target: t,
  dispFg,
  dispDot,
}: {
  target: (typeof TARGETS)[number];
  dispFg: string;
  dispDot: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
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
    </button>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px' }}>
        <span style={{ fontSize: 14, color: '#475467' }}>Showing {rows.length} of {GOV_ROWS.length} relationships</span>
        <span style={{ flex: 1 }} />
        <PfButton
          variant="link"
          disabled={safePage === 0}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          style={{ color: safePage === 0 ? '#98A2B3' : undefined }}
        >
          ← Previous
        </PfButton>
        <PfButton
          variant="link"
          disabled={safePage >= pageCount - 1}
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          style={{ color: safePage >= pageCount - 1 ? '#98A2B3' : undefined }}
        >
          Next →
        </PfButton>
      </div>
    </Card>
  );
}

function GovRow({ row: r }: { row: (typeof GOV_ROWS)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
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
    </button>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
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

/* ── Relationship network card ────────────────────────────────────────────── */

/**
 * Wire-audit "3 Compose extend" item 4: the relationship network card was a
 * pure fixture (NETWORK_TOP / NETWORK_BOTTOM hardcoded names + "access path
 * via <person>" text). No backing record exists for "access paths" — this
 * product has no such table. The honest treatment is an explicit empty state
 * that names the gap, rather than fixture names that imply real relationships.
 *
 * The targets table (real ClientTargets) IS wired and renders in the table
 * above; this card is the only fixture-only piece on this tab.
 */
function NetworkCard({ client }: { client: Client }) {
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '20px 24px',
          borderBottom: '1px solid #EAECF0',
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Relationship network</span>
          <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
            Active access paths around the client
          </span>
        </span>
      </div>

      <div style={{ padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <Tile initials={initialsFor(client.name)} size={44} dark />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{client.name}</span>
        <span style={{ fontSize: 13, color: '#98A2B3', textAlign: 'center', maxWidth: 320, textWrap: 'pretty' }}>
          Access-path mapping is not available yet. Tracked targets above show the real relationships this client has on file.
        </span>
      </div>
    </Card>
  );
}
