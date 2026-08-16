import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DIRECTORY_ROUTES } from '../../directory/directory-routes.js';
import {
  Avatar,
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
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Relationships / Government sub-tab (spec §8.2).
 *
 * Current targets, the relationships table and the network card render the
 * design's fixtures (TARGETS / GOV_ROWS) — the canonical targets backend stays
 * with TargetsTab, so this surface is flagged UI-only. The segmented sub-tab
 * bar is owned by the parent page.
 */

const DISPOSITION_TONE: Record<string, PillTone> = {
  Supportive: 'success',
  Neutral: 'gray',
  Opposed: 'error',
};

const GROUP_FILTERS = ['All', 'Congress', 'Agencies', 'Committees', 'Current targets'] as const;
type GroupFilter = (typeof GROUP_FILTERS)[number];

const PAGE_SIZE = 10;

export function ClientCrmGovernmentProto({ client }: { client: Client }) {
  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Government relationships"
        sub="Current targets from Strategies, plus the broader offices and officials connected to this client."
        actions={<PfButton variant="primary">Add relationship</PfButton>}
      />

      <CurrentTargetsPanel />

      <div className="cap-pf-grid-side-380">
        <RelationshipsTableCard />
        <NetworkCard client={client} />
      </div>
    </div>
  );
}

/* ── Current targets (tinted panel) ───────────────────────────────────────── */

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

/** UI-only fixture: active access paths around the client (spec §8.2). */
const NETWORK_TOP = [
  { init: 'JD', name: 'Rep. Jane Doe', path: 'HASC · member path via Sarah Martinez' },
  { init: 'G8', name: 'Army G-8', path: 'Resourcing path via Jordan Clayton' },
];
const NETWORK_BOTTOM = [
  { init: 'SA', name: 'Senate Armed Services', path: 'Authorization path via Jordan Clayton' },
  { init: 'ONR', name: 'Office of Naval Research', path: 'Agency path via Sarah Martinez' },
];

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
        <PfButton variant="link">Expand</PfButton>
      </div>

      <div style={{ padding: '22px 20px 24px', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {NETWORK_TOP.map((n) => (
            <NetworkNode key={n.name} node={n} />
          ))}
        </div>

        <span style={{ display: 'block', height: 22, width: 1, background: '#EAECF0', margin: '0 auto' }} aria-hidden />

        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 10,
            background: '#F2F4F7',
            boxShadow: 'inset 0 0 0 1px #D0D5DD',
          }}
        >
          <Tile initials={initialsFor(client.name)} size={44} dark />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: '#101828' }}>{client.name}</span>
            <span style={{ display: 'block', fontSize: 12, color: '#101828' }}>3 active target paths</span>
          </span>
        </span>

        <span style={{ display: 'block', height: 22, width: 1, background: '#EAECF0', margin: '0 auto' }} aria-hidden />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {NETWORK_BOTTOM.map((n) => (
            <NetworkNode key={n.name} node={n} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function NetworkNode({ node: n }: { node: { init: string; name: string; path: string } }) {
  return (
    <span
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        background: '#F9FAFB',
        boxShadow: 'inset 0 0 0 1px #EAECF0',
        minWidth: 0,
      }}
    >
      <Avatar initials={n.init} size={32} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            fontWeight: 600,
            color: '#101828',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {n.name}
        </span>
        <span style={{ display: 'block', fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{n.path}</span>
      </span>
    </span>
  );
}
