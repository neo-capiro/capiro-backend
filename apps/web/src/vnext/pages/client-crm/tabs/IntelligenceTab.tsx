import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Card,
  CardHead,
  FitChip,
  Pill,
  SegmentedTabs,
  TabPageHead,
  Tile,
  Avatar,
  UIcon,
  GRADIENT_DARK,
  type PillTone,
} from '../portfolio-primitives.js';
import {
  DOMAIN_STATS,
  DOMAINS,
  INTEL_ATTN,
  BILLS,
  RECS,
  STAGES,
  MATTERS,
  DEADLINES,
  OPPS,
  PROGRAMS,
  LDA,
  DISTRICTS,
  FACILITIES,
  SPARK,
} from '../portfolio-fixtures.js';
import { DistrictNexusMap } from '../DistrictNexusMap.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { IntelligenceView } from '../client-crm-routing.js';

/**
 * Intelligence tab (spec §10). Six domains via a segmented bar: Overview ·
 * Legislative · Regulatory · Funding & Budget · Federal Footprint · District
 * Nexus. Every domain except Overview opens with the 5-cell domain stats strip.
 *
 * The precise records are designed fixtures (§14); where a real client-scoped
 * aggregate exists it would override, but the domain bodies render the design's
 * contract. Fixture-backed sections are flagged UI-only in the ship report.
 */

const INTEL_TONE: Record<string, PillTone> = {
  gray: 'gray', brand: 'brand', blue: 'blue', error: 'error', warning: 'warning', success: 'success',
};

export function ClientCrmIntelligenceProto({ client, view }: { client: Client; view: IntelligenceView }) {
  const domain = DOMAIN_META[view] ?? DOMAIN_META.overview!;
  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead title={domain.title} sub={domain.sub} actions={domain.actions} />
      {view !== 'overview' ? <DomainStatsStrip view={view} /> : null}
      {view === 'overview' ? <IntelOverview /> : null}
      {view === 'legislative' ? <LegislativePanel /> : null}
      {view === 'regulatory' ? <RegulatoryPanel /> : null}
      {view === 'funding' ? <FundingPanel /> : null}
      {view === 'footprint' ? <FootprintPanel /> : null}
      {view === 'district' ? <DistrictPanel /> : null}
    </div>
  );
}

const DOMAIN_META: Record<string, { title: string; sub: string; actions?: ReactNode }> = {
  overview: {
    title: 'Client intelligence',
    sub: 'External signals organized around this client, not a wall of raw database counters.',
    actions: <SecondaryBtn>Sync intelligence</SecondaryBtn>,
  },
  legislative: {
    title: 'Legislative',
    sub: 'Tracked bills, client-fit recommendations, hearings, and material changes from LegiWatch.',
    actions: (
      <>
        <SecondaryBtn>Configure</SecondaryBtn>
        <PrimaryBtn>Track bill</PrimaryBtn>
      </>
    ),
  },
  regulatory: {
    title: 'Regulatory',
    sub: 'Federal Register matters shown as decision-oriented lifecycle rails with client deadlines.',
    actions: <PrimaryBtn>Track matter</PrimaryBtn>,
  },
  funding: {
    title: 'Funding & Budget',
    sub: 'Grant and contract opportunities, active pursuits, and relevant defense budget programs in one domain.',
    actions: <SecondaryBtn>Sync sources</SecondaryBtn>,
  },
  footprint: {
    title: 'Federal footprint',
    sub: 'Lobbying activity, federal awards, political giving, and the government entities connected to the client.',
    actions: <SecondaryBtn>Export profile</SecondaryBtn>,
  },
  district: {
    title: 'District Nexus',
    sub: 'Facilities, employees, contracts, grants, and representatives translated into a defensible congressional footprint.',
    actions: <SecondaryBtn>Manage facilities</SecondaryBtn>,
  },
};

/* ── shared buttons ───────────────────────────────────────────────────────── */

function SecondaryBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, padding: '0 16px', borderRadius: 8, background: hover ? '#F9FAFB' : '#ffffff', color: hover ? '#101828' : '#344054', fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)' }}>
      {children}
    </button>
  );
}
function PrimaryBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, padding: '0 16px', borderRadius: 8, background: hover ? 'linear-gradient(180deg,#4A5462 0%,#252F3C 46%,#161D26 100%)' : GRADIENT_DARK, color: '#ffffff', fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', boxShadow: '0px 1px 2px rgba(16,24,40,.05)' }}>
      {children}
    </button>
  );
}
function LinkBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ fontSize: 14, fontWeight: 600, color: hover ? '#0E141C' : '#101828', whiteSpace: 'nowrap' }}>
      {children}
    </button>
  );
}

/* ── Domain stats strip (§10 — all domains except Overview) ──────────────── */

function DomainStatsStrip({ view }: { view: IntelligenceView }) {
  const cells = (DOMAIN_STATS as unknown as Record<string, Array<[string, string]>>)[view] ?? [];
  return (
    <section style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 0 0 1px #EAECF0,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)', display: 'flex', flexWrap: 'wrap', overflow: 'hidden' }}>
      {cells.map(([value, label], i) => (
        <span key={label} style={{ flex: 1, minWidth: 168, padding: '20px 24px', boxShadow: i === 0 ? 'none' : 'inset 1px 0 0 #EAECF0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828', lineHeight: 1.2 }}>{value}</span>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>{label}</span>
        </span>
      ))}
    </section>
  );
}

/* ═════════════════════════════ §10.1 Overview ══════════════════════════════ */

function IntelOverview() {
  return (
    <>
      {/* Client intelligence pulse — deep band */}
      <div style={{ background: GRADIENT_DARK, borderRadius: 12, padding: '22px 28px', display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#98A2B3', flex: '0 0 auto' }}>Client intelligence pulse</span>
        {[['12', 'Tracked bills'], ['7', 'Funding matches'], ['8', 'Districts'], ['2', 'Deadlines < 14 days']].map(([v, l]) => (
          <span key={l} style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: '#ffffff', lineHeight: 1.2 }}>{v}</span>
            <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '.04em', textTransform: 'uppercase', color: '#98A2B3' }}>{l}</span>
          </span>
        ))}
        <span style={{ flex: 1, minWidth: 12 }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', fontSize: 12, fontWeight: 500, letterSpacing: '.04em', textTransform: 'uppercase', color: '#98A2B3' }}>
          <span className="cap-pf-anim-pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: '#32D583' }} />
          Refreshed 2h ago
        </span>
      </div>

      <div className="cap-pf-grid-intel">
        {/* Needs attention */}
        <Card>
          <CardHead title="Needs attention" action={<LinkBtn>View unified feed</LinkBtn>} />
          <div>
            {INTEL_ATTN.map((a) => (
              <AttentionRow key={a.title} a={a} />
            ))}
          </div>
        </Card>

        {/* Intelligence domains */}
        <Card>
          <CardHead title="Intelligence domains" />
          <div style={{ padding: 12 }}>
            {DOMAINS.map((d) => (
              <DomainRow key={d.id} d={d} />
            ))}
            <p style={{ margin: '10px 6px 6px', fontSize: 13, lineHeight: '19px', color: '#667085', textWrap: 'pretty' }}>
              Source mapping is complete for LDA, contracts, grants, and FEC/PAC. One facility needs an employee count.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}

function AttentionRow({ a }: { a: (typeof INTEL_ATTN)[number] }) {
  const [hover, setHover] = useState(false);
  const tone = INTEL_TONE[a.ui] ?? 'gray';
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 16, padding: '15px 24px', borderBottom: '1px solid #EAECF0', background: hover ? '#F9FAFB' : 'transparent', textAlign: 'left' }}>
      <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: tone === 'error' ? '#F04438' : tone === 'warning' ? '#F79009' : tone === 'success' ? '#12B76A' : tone === 'blue' ? '#344054' : '#667085' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{a.title}</span>
        <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>{a.body}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 116, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <Pill tone={tone} dotless>{a.kind}</Pill>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{a.due}</span>
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>Open →</span>
    </button>
  );
}

function DomainRow({ d }: { d: (typeof DOMAINS)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 10, background: hover ? '#F2F4F7' : '#F9FAFB', marginBottom: 6, textAlign: 'left' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: '#101828' }}>{d.label}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>{d.sub}</span>
      </span>
      <span style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: '#101828' }}>{d.value}</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{d.unit}</span>
      </span>
      <span style={{ flex: '0 0 auto', color: '#98A2B3' }}>
        <UIcon name="ChevronRight" size={20} />
      </span>
    </button>
  );
}

/* ═══════════════════════════ §10.2 Legislative ═════════════════════════════ */

const LEG_NESTED = [
  { key: 'tracked', label: 'Tracked' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'activity', label: 'Activity' },
  { key: 'hearings', label: 'Hearings' },
];

function LegislativePanel() {
  const [nested, setNested] = useState('tracked');
  const [boardView, setBoardView] = useState(true);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ alignSelf: 'flex-start' }}>
        <SegmentedTabs ariaLabel="Legislative views" options={LEG_NESTED} value={nested} onChange={setNested} />
      </div>
      <div className="cap-pf-grid-intel">
        {/* Board card */}
        <Card>
          <CardHead title={nested === 'tracked' ? 'Tracked bills' : nested} action={<LinkBtn onClick={() => setBoardView((v) => !v)}>{boardView ? 'Table view' : 'Board view'}</LinkBtn>} />
          {boardView ? <BillBoard /> : <BillTable />}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px 18px' }}>
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>6 more tracked bills</span>
            <span style={{ flex: 1 }} />
            <LinkBtn>Open full board →</LinkBtn>
          </div>
        </Card>

        {/* Recommendations */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 14px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Recommendations</span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
                New matches generated from capabilities, committees, districts, and Strategy targets.
              </span>
            </span>
            <LinkBtn>View all</LinkBtn>
          </div>
          <div style={{ padding: '0 16px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {RECS.map((r) => (
              <RecCard key={r.number} r={r} />
            ))}
          </div>
          <div style={{ marginTop: 10, padding: '14px 24px 20px', borderTop: '1px solid #EAECF0' }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Upcoming hearing</div>
            <div style={{ marginTop: 4, fontSize: 14, color: '#101828' }}>HASC · Autonomous Systems · Aug 13</div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function BillBoard() {
  return (
    <div style={{ padding: '20px 20px 12px', overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(188px,1fr))', gap: 14, minWidth: 800, alignItems: 'start' }}>
        {STAGES.map((stage) => {
          const bills = BILLS.filter((b) => b.stage === stage.id);
          return (
            <span key={stage.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid #EAECF0' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{stage.label}</span>
                <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 7px', borderRadius: 9999, background: GRADIENT_DARK, color: '#ffffff', fontSize: 11, fontWeight: 600 }}>{stage.count}</span>
              </span>
              {bills.map((b) => (
                <BillCard key={b.number} b={b} />
              ))}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function BillCard({ b }: { b: (typeof BILLS)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: 12, borderRadius: 8, background: hover ? '#F9FAFB' : '#ffffff', boxShadow: hover ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0', textAlign: 'left' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>{b.number}</span>
        <FitChip score={b.fit} suffix="" />
      </span>
      <span style={{ fontSize: 13, lineHeight: '18px', color: '#344054', textWrap: 'pretty' }}>{b.title}</span>
      <span style={{ fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{b.latest}</span>
    </button>
  );
}

function BillTable() {
  return (
    <div>
      {BILLS.map((r) => (
        <button key={r.number} type="button" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: '1px solid #EAECF0', textAlign: 'left' }}>
          <span style={{ flex: '0 0 auto', width: 88, fontSize: 14, fontWeight: 600, color: '#101828' }}>{r.number}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{r.title}</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>{r.latest}</span>
          </span>
          <span style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467', textTransform: 'capitalize' }}>{r.stage}</span>
          <span style={{ flex: '0 0 auto', width: 56, display: 'flex', justifyContent: 'flex-end' }}>
            <FitChip score={r.fit} suffix="" />
          </span>
        </button>
      ))}
    </div>
  );
}

function RecCard({ r }: { r: (typeof RECS)[number] }) {
  const [tracked, setTracked] = useState(false);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14, borderRadius: 10, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#101828' }}>{r.number}</span>
        <Pill tone="success" dotless>{r.fit}</Pill>
      </span>
      <span style={{ fontSize: 14, color: '#344054', textWrap: 'pretty' }}>{r.title}</span>
      <span style={{ fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{r.why}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 6 }}>
        <button type="button" onClick={() => setTracked(true)} style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: '#101828' }}>
          {tracked ? 'Tracked' : 'Track'}
        </button>
        <button type="button" style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: '#667085' }}>
          Dismiss
        </button>
      </span>
    </span>
  );
}

/* ═══════════════════════════ §10.3 Regulatory ══════════════════════════════ */

function RegulatoryPanel() {
  return (
    <div className="cap-pf-grid-intel">
      {/* Active matters */}
      <Card>
        <CardHead title="Active matters" action={<LinkBtn>View all</LinkBtn>} />
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {MATTERS.map((m) => (
            <MatterCard key={m.title} m={m} />
          ))}
        </div>
      </Card>

      {/* Deadline rail */}
      <Card>
        <CardHead title="Deadline rail" action={<LinkBtn>Calendar</LinkBtn>} />
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {DEADLINES.map((d) => (
            <span key={d.title} style={{ display: 'flex', gap: 14, padding: '14px 16px', borderRadius: 10, background: d.urgent ? '#FFFAEB' : '#F9FAFB', boxShadow: d.urgent ? 'inset 0 0 0 1px #FEDF89' : 'inset 0 0 0 1px #EAECF0' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: d.urgent ? '#B54708' : '#667085' }}>{d.date}</span>
                <span style={{ display: 'block', marginTop: 4, fontSize: 14, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>{d.title}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>{d.ask}</span>
              </span>
            </span>
          ))}
          <div style={{ marginTop: 4, padding: '14px 4px 6px', borderTop: '1px solid #EAECF0' }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Source & evidence</div>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
              Federal Register lifecycle data is current. Detailed evidence and provenance open inside each matter.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

const MATTER_STAGE_TONE: Record<string, PillTone> = { warning: 'warning', blue: 'blue', brand: 'brand' };

function MatterCard({ m }: { m: (typeof MATTERS)[number] }) {
  return (
    <div style={{ padding: '16px 18px', borderRadius: 10, boxShadow: 'inset 0 0 0 1px #EAECF0', background: '#FCFCFD' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180 }}>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>{m.title}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#475467' }}>{m.agency}</span>
            <span style={{ fontSize: 13, color: '#667085' }}>{m.docket}</span>
          </span>
        </span>
        <Pill tone={MATTER_STAGE_TONE[m.ui] ?? 'gray'} size="lg">{m.stage}</Pill>
      </div>
      <MatterRail steps={m.steps as Array<[string, string]>} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18, paddingTop: 14, borderTop: '1px solid #F2F4F7', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180, fontSize: 14, fontWeight: 500, color: '#101828' }}>{m.detail}</span>
        <span style={{ flex: '0 0 auto', fontSize: 12, color: '#667085' }}>Linked {m.linked}</span>
        <LinkBtn>Open matter →</LinkBtn>
      </div>
    </div>
  );
}

/** Four-step regulatory lifecycle rail (§2.14 at 24px nodes). */
function MatterRail({ steps }: { steps: Array<[string, string]> }) {
  return (
    <div style={{ position: 'relative', margin: '22px 8px 0' }}>
      <span style={{ position: 'absolute', top: 11, left: 48, right: 48, height: 2, background: '#EAECF0' }} />
      <span style={{ position: 'relative', display: 'flex', justifyContent: 'space-between' }}>
        {steps.map(([label, st]) => {
          const done = st === 'done';
          const now = st === 'now';
          return (
            <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 96 }}>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: done ? GRADIENT_DARK : '#ffffff',
                  boxShadow: now ? 'inset 0 0 0 2px #101828' : done ? 'none' : 'inset 0 0 0 1px #D0D5DD',
                  color: done ? '#ffffff' : now ? '#101828' : '#98A2B3',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {done ? '✓' : now ? '!' : '·'}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: done || now ? '#101828' : '#98A2B3', textAlign: 'center' }}>
                {label}
              </span>
            </span>
          );
        })}
      </span>
    </div>
  );
}

/* ══════════════════════════ §10.4 Funding & Budget ═════════════════════════ */

const FUND_NESTED = [
  { key: 'overview', label: 'Overview' },
  { key: 'opportunities', label: 'Opportunities' },
  { key: 'programs', label: 'Budget programs' },
  { key: 'pursuits', label: 'Pursuits' },
];

function FundingPanel() {
  const [nested, setNested] = useState('opportunities');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ alignSelf: 'flex-start' }}>
        <SegmentedTabs ariaLabel="Funding views" options={FUND_NESTED} value={nested} onChange={setNested} />
      </div>
      <div className="cap-pf-grid-intel">
        {/* Opportunities */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Opportunities</span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
                Matches use capabilities, facilities, eligibility, agencies, and Strategy context.
              </span>
            </span>
            <LinkBtn>View all 7</LinkBtn>
          </div>
          <div style={{ padding: '0 16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {OPPS.map((o) => (
              <OppRow key={o.title} o={o} />
            ))}
          </div>
        </Card>

        {/* Relevant budget programs */}
        <Card>
          <CardHead title="Relevant budget programs" action={<LinkBtn>Open budget</LinkBtn>} />
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {PROGRAMS.map((p) => (
              <ProgramCard key={p.code} p={p} />
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 4px 4px', borderTop: '1px solid #EAECF0', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>Pursuit pipeline</span>
              <Pill tone="brand" size="lg">Army AGV · Qualifying</Pill>
              <Pill tone="gray" size="lg" dotless>ONR Autonomy · Saved</Pill>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function OppRow({ o }: { o: (typeof OPPS)[number] }) {
  const [hover, setHover] = useState(false);
  const statusTone = o.status === 'Pursuing' ? 'brand' : 'gray';
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 10, background: hover ? '#F2F4F7' : '#F9FAFB', boxShadow: hover ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0', textAlign: 'left' }}>
      <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 78, height: 26, borderRadius: 6, background: '#ffffff', boxShadow: 'inset 0 0 0 1px #D0D5DD', color: '#344054', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>
        {o.type}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{o.title}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>{o.agency}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 92, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#101828' }}>{o.amount}</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: o.soon ? '#B54708' : '#667085' }}>Due {o.due}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 100, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <Pill tone="gray" dotless>{o.fit}% fit</Pill>
        <Pill tone={statusTone as PillTone} dotless={o.status === 'Match'}>{o.status}</Pill>
      </span>
    </button>
  );
}

function ProgramCard({ p }: { p: (typeof PROGRAMS)[number] }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 10, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#101828', padding: '2px 6px', borderRadius: 6, background: '#F2F4F7' }}>{p.code}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{p.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
        {([['PB', p.pb], ['Auth', p.auth], ['Approp', p.approp]] as const).map(([label, value], i) => (
          <span key={label} style={{ display: 'flex', alignItems: 'flex-end', gap: 18 }}>
            {i > 0 ? <span style={{ color: '#98A2B3' }}>—</span> : null}
            <span style={{ flex: '0 0 auto' }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{label}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 16, fontWeight: 600, color: '#101828' }}>{value}</span>
            </span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <LinkBtn>Open PE →</LinkBtn>
        <span style={{ flex: 1 }} />
        <Pill tone={p.down ? 'error' : 'success'}>{p.delta}</Pill>
      </div>
    </div>
  );
}

/* ══════════════════════════ §10.5 Federal Footprint ════════════════════════ */

function FootprintPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="cap-pf-grid-3">
        {/* Lobbying activity */}
        <FootCard title="Lobbying activity" action={<LinkBtn>Open LDA</LinkBtn>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$1.8M</span>
            <Pill tone="success">▲ 18% YoY</Pill>
          </div>
          <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Trailing 12 months</div>
          <Sparkline />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#667085' }}>
            <span>Q3 24</span><span>Q4 24</span><span>Q1 25</span><span>Q2 25</span>
          </div>
        </FootCard>

        {/* Federal awards */}
        <FootCard title="Federal awards" action={<LinkBtn>View awards</LinkBtn>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$84.2M</span>
            <Pill tone="gray" dotless>14 awards</Pill>
          </div>
          <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Obligations · trailing 12 months</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
            {([['Army', '$51.4M', '86%'], ['Navy · ONR', '$18.6M', '31%'], ['DARPA', '$14.2M', '24%']] as const).map(([label, value, w]) => (
              <span key={label} style={{ display: 'block' }}>
                <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: '#344054' }}>{label}</span>
                  <span style={{ fontWeight: 600, color: '#101828' }}>{value}</span>
                </span>
                <span style={{ display: 'block', marginTop: 6, height: 8, borderRadius: 4, background: '#F2F4F7', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: 8, width: w, borderRadius: 4, background: GRADIENT_DARK }} />
                </span>
              </span>
            ))}
          </div>
        </FootCard>

        {/* Political giving */}
        <FootCard title="Political giving" action={<LinkBtn>Open FEC / PAC</LinkBtn>}>
          <div style={{ marginTop: 16, fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$380K</div>
          <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>PAC disbursements · current cycle</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
            {([['Incumbent members', '$214K', '90%'], ['Leadership PACs', '$102K', '43%'], ['Party committees', '$64K', '27%']] as const).map(([label, value, w]) => (
              <span key={label} style={{ display: 'block' }}>
                <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: '#344054' }}>{label}</span>
                  <span style={{ fontWeight: 600, color: '#101828' }}>{value}</span>
                </span>
                <span style={{ display: 'block', marginTop: 6, height: 8, borderRadius: 4, background: '#F2F4F7', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: 8, width: w, borderRadius: 4, background: '#98A2B3' }} />
                </span>
              </span>
            ))}
          </div>
        </FootCard>
      </div>

      {/* Lobbying disclosure history */}
      <Card>
        <CardHead title="Lobbying disclosure history" action={<LinkBtn>View all filings</LinkBtn>} />
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: 880 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px', background: '#F9FAFB', borderBottom: '1px solid #EAECF0', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
              <span style={{ flex: '0 0 auto', width: 84 }}>Period</span>
              <span style={{ flex: '0 0 auto', width: 64 }}>Type</span>
              <span style={{ flex: 1, minWidth: 0 }}>Registrant</span>
              <span style={{ flex: '0 0 auto', width: 84, textAlign: 'right' }}>Amount</span>
              <span style={{ flex: '0 0 auto', width: 148 }}>Issues</span>
              <span style={{ flex: '0 0 auto', width: 196 }}>Entities contacted</span>
              <span style={{ flex: '0 0 auto', width: 56 }}>Source</span>
            </div>
            {LDA.map((r) => (
              <div key={`${r.period}-${r.registrant}`} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 24px', borderBottom: '1px solid #EAECF0' }}>
                <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 500, color: '#101828' }}>{r.period}</span>
                <span style={{ flex: '0 0 auto', width: 64, fontSize: 13, color: '#475467' }}>{r.type}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.registrant}</span>
                <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 600, color: '#101828', textAlign: 'right' }}>{r.amount}</span>
                <span style={{ flex: '0 0 auto', width: 148, fontSize: 13, color: '#475467' }}>{r.issues}</span>
                <span style={{ flex: '0 0 auto', width: 196, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.entities}</span>
                <button type="button" style={{ flex: '0 0 auto', width: 56, fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: '#101828' }}>View</button>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

function FootCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 0 0 1px #EAECF0,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)', padding: '20px 24px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>{title}</h3>
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </section>
  );
}

function Sparkline() {
  const max = Math.max(...SPARK);
  const w = 240;
  const h = 76;
  const step = w / (SPARK.length - 1);
  const points = SPARK.map((v, i) => `${i * step},${h - (v / max) * (h - 8)}`).join(' ');
  return (
    <svg style={{ display: 'block', width: '100%', height: 76, marginTop: 16 }} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke="#101828" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ═══════════════════════════ §10.6 District Nexus ══════════════════════════ */

function DistrictPanel() {
  const [selected, setSelected] = useState('WA-07');
  const sel = (DISTRICTS as any[]).find((d) => d.code === selected) ?? (DISTRICTS as any[])[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* District footprint (map + rail) */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>District footprint</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
              Nexus score combines facilities, employees, contracts, grants, partners, and policy context. Select a district on the map or in the list.
            </span>
          </span>
          <Pill tone="gray" dotless>8 districts · 92% coverage</Pill>
        </div>
        <div className="cap-pf-map-cols">
          <div className="cap-pf-map-frame">
            <DistrictNexusMap
              districts={DISTRICTS as any}
              selected={selected}
              onSelect={setSelected}
            />
          </div>
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(DISTRICTS as any[]).map((d) => (
              <DistrictRailRow key={d.code} d={d} selected={selected === d.code} onSelect={() => setSelected(d.code)} />
            ))}
          </div>
        </div>
      </Card>

      <div className="cap-pf-grid-dist">
        {/* Selected district */}
        <Card>
          <CardHead title="Selected district" action={<LinkBtn>Open {sel.code}</LinkBtn>} />
          <div style={{ padding: '20px 24px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>{sel.code}</span>
              <Pill tone={INTEL_TONE[sel.ui] ?? 'gray'} size="lg">{sel.strength} nexus</Pill>
            </div>
            <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Federal representative</div>
            <div style={{ marginTop: 3, fontSize: 16, color: '#101828' }}>{sel.rep} · {sel.chamber}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: 10, marginTop: 18 }}>
              {sel.tiles.map(([label, value]: [string, string]) => (
                <span key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 10px', borderRadius: 8, background: '#F9FAFB', boxShadow: 'inset 0 0 0 1px #EAECF0' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{label}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{value}</span>
                </span>
              ))}
            </div>
          </div>
        </Card>

        {/* Facilities & representation */}
        <Card>
          <CardHead title="Facilities & representation" action={<LinkBtn>View all</LinkBtn>} />
          <div>
            {FACILITIES.map((f) => (
              <button key={f.name} type="button" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, padding: '13px 24px', borderBottom: '1px solid #F2F4F7', textAlign: 'left' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                <span style={{ flex: '0 0 auto', width: 60, fontSize: 13, color: '#475467' }}>{f.district}</span>
                <span style={{ flex: '0 0 auto', width: 40, fontSize: 13, color: '#475467', textAlign: 'right' }}>{f.employees}</span>
                <span style={{ flex: '0 0 auto', width: 118, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.rep}</span>
                <span style={{ flex: '0 0 auto', width: 118, display: 'flex', justifyContent: 'flex-end' }}>
                  <Pill tone={INTEL_TONE[f.ui] ?? 'gray'}>{f.status}</Pill>
                </span>
              </button>
            ))}
          </div>
          <div style={{ padding: '14px 24px 18px' }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>Reviewed grant relationship</div>
            <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: '19px', color: '#475467', textWrap: 'pretty' }}>
              ONR autonomy award · Direct recipient · $4.2M attributable · External-use approved.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function DistrictRailRow({ d, selected, onSelect }: { d: any; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  const dot = d.score >= 80 ? '#101828' : d.score >= 60 ? '#475467' : '#98A2B3';
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 12px',
        borderRadius: 10,
        textAlign: 'left',
        background: selected ? '#F9FAFB' : hover ? '#F2F4F7' : '#ffffff',
        boxShadow: selected ? 'inset 0 0 0 1.5px #101828' : hover ? 'inset 0 0 0 1px #D0D5DD' : 'inset 0 0 0 1px #EAECF0',
      }}
    >
      <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: dot }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.02em', color: '#101828' }}>{d.code}</span>
          <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
        </span>
        <span style={{ display: 'block', marginTop: 4, height: 5, borderRadius: 3, background: '#F2F4F7', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: 5, width: `${d.score}%`, borderRadius: 3, background: GRADIENT_DARK }} />
        </span>
        <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#667085' }}>{d.meta}</span>
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 600, color: '#101828' }}>{d.score}</span>
    </button>
  );
}
