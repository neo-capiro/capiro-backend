import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import {
  initialsOf,
  memberName,
  useTenantMembers,
  type TenantMember,
} from '../../../../pages/strategy/members.js';
import type {
  NodeKind,
  NodeStatus,
  StrategyDetail,
  StrategyListItem,
  StrategyNode,
  StrategyType,
} from '../../../../pages/strategy/types.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import {
  Avatar,
  Card,
  CardHead,
  GRADIENT_DARK,
  PILL,
  PfButton,
  Pill,
  TabPageHead,
  type PillTone,
} from '../portfolio-primitives.js';
import { NODES, UPCOMING } from '../portfolio-fixtures.js';

/**
 * Work tab (spec §9, Figma geometry from `dom-tab-work.txt`).
 *
 * §10 constraint honoured: **Strategies is the source of truth — there is NO
 * parallel CRM task model.** Every strategy/node row reads through the SAME
 * query keys the Strategies module uses (`['strategy','strategies']`,
 * `['strategy','strategy',id]`, `['strategy','tenant-members']`), so an edit
 * in Strategies is the same cache entry seen here.
 *
 * Data binding:
 *  - When the Strategies service returns rows for this client, the band
 *    figures, featured card, node list, secondary cards, upcoming rail and
 *    risks all bind to those real records.
 *  - While loading, on error, or when the client has no strategies, the
 *    design's fixtures render so the surface stays pixel-reviewable (flagged
 *    UI-only in the ship report).
 *  - The `On track` pill and the secondary readiness percentages have no
 *    honest backing signal (the Strategy API has no completion state — see
 *    useClientCrmOverviewModel) and are design elements in every mode.
 */

/* ── fixture view-models (design literals; used when no real data) ────────── */

interface NodeRowModel {
  id: string;
  mark: string;
  kind: string;
  title: string;
  init: string;
  owner: string;
  date: string;
  status: string;
  tone: PillTone;
}

interface FeaturedModel {
  id: string | null;
  eyebrow: string;
  title: string;
  body: string;
  owner: string;
  init: string;
  target: string;
  nodes: NodeRowModel[];
}

interface SecondaryModel {
  id: string;
  title: string;
  type: string;
  body: string;
  owner: string;
  init: string;
  pct: string;
  target: string;
  next: string;
}

interface UpcomingModel {
  id: string;
  date: string;
  title: string;
  strategy: string;
  init: string;
  tone: PillTone;
}

interface RiskModel {
  id: string;
  title: string;
  body: string;
}

const TONE_OF: Record<string, PillTone> = {
  gray: 'gray',
  brand: 'brand',
  blue: 'blue',
  error: 'error',
  warning: 'warning',
  success: 'success',
};
const toneOf = (ui: string): PillTone => TONE_OF[ui] ?? 'gray';

const FEATURED_FIXTURE: FeaturedModel = {
  id: null,
  eyebrow: 'Appropriations · drafted with Meri',
  title: 'FY27 Ground Robotics Funding',
  body: 'Protect Ground Robotics funding through FY27 appropriations and prepare a conference-stage advocacy path.',
  owner: 'Sarah Martinez',
  init: 'SM',
  target: 'Sep 30',
  nodes: NODES.map((n) => ({
    id: `fx-${n.mark}-${n.title}`,
    mark: n.mark,
    kind: n.kind,
    title: n.title,
    init: n.init,
    owner: n.owner,
    date: n.date,
    status: n.status,
    tone: toneOf(n.ui),
  })),
};

/* Prototype literals (portfolio-extracted.html `otherStrategies`). The
 * readiness pct is a designed element — the Strategy API has no completion
 * signal, so no honest percentage exists. */
const SECONDARY_FIXTURES: SecondaryModel[] = [
  {
    id: 'fx-army',
    title: 'Army Procurement Positioning',
    type: 'Procurement',
    body: 'Position ULTRA for an Army procurement pathway and validate resourcing offices.',
    owner: 'Jordan Clayton',
    init: 'JC',
    pct: '54%',
    target: 'Oct 15',
    next: 'Army G-8 meeting · Aug 25',
  },
  {
    id: 'fx-reg',
    title: 'Autonomous Systems Regulatory Readiness',
    type: 'Regulatory',
    body: 'Track rulemaking and prepare a coordinated comment strategy for autonomy standards.',
    owner: 'Sarah Martinez',
    init: 'SM',
    pct: '38%',
    target: 'Nov 01',
    next: 'Comment draft · Sep 10',
  },
];

const RISK_FIXTURES: RiskModel[] = [
  {
    id: 'fx-risk-1',
    title: 'Conference timing remains uncertain',
    body: 'Open-ended Strategy risk · owner Jordan Clayton',
  },
  {
    id: 'fx-risk-2',
    title: 'Committee outreach milestone is due',
    body: 'Strategy milestone · due Aug 14 · owner Sarah Martinez',
  },
];

const BAND_LABELS = [
  'Current strategies',
  'Live plan steps',
  'Next 30 days',
  'Open risks',
  'Linked artifacts',
] as const;
/** Design fixture figures (spec §9.1). */
const BAND_FIXTURE = ['3', '12', '4', '2', '9'];

/** Readiness percentages for real secondary cards — UI-only (see header). */
const SECONDARY_PCT = ['54%', '38%'];

/* ── real-data mapping helpers ────────────────────────────────────────────── */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const TYPE_LABEL: Record<StrategyType, string> = {
  appropriations: 'Appropriations',
  authorization: 'Authorization',
  regulatory: 'Regulatory',
  coalition: 'Coalition',
  procurement: 'Procurement',
  earmark: 'Earmark',
};

const KIND_LABEL: Record<NodeKind, string> = {
  action: 'Action',
  decision: 'Decision',
  gate: 'Gate',
  milestone: 'Milestone',
  risk: 'Risk',
};

const STATUS_PILL: Record<NodeStatus, [string, PillTone]> = {
  draft: ['Draft', 'gray'],
  suggested: ['Suggested', 'gray'],
  in_progress: ['In progress', 'blue'],
  internal_review: ['In review', 'warning'],
  active: ['Active', 'success'],
};

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dateOf(node: StrategyNode): number {
  const time = new Date(node.endsOn ?? node.startsOn).getTime();
  return Number.isFinite(time) ? time : 0;
}

function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return false;
  const now = Date.now();
  return time >= now && time <= now + days * 86_400_000;
}

const isCommitted = (node: StrategyNode) => node.status !== 'draft' && node.status !== 'suggested';

function nodeRowOf(
  node: StrategyNode,
  members: TenantMember[] | undefined,
  fallbackOwner: string | null,
): NodeRowModel {
  const owner = memberName(members, node.ownerUserId ?? fallbackOwner, 'Team member');
  const [status, tone] = STATUS_PILL[node.status];
  return {
    id: node.id,
    mark: KIND_LABEL[node.kind].charAt(0),
    kind: KIND_LABEL[node.kind],
    title: node.title,
    init: initialsOf(owner),
    owner,
    date: shortDate(node.endsOn ?? node.startsOn),
    status,
    tone,
  };
}

function featuredOf(detail: StrategyDetail, members: TenantMember[] | undefined): FeaturedModel {
  const owner = memberName(members, detail.ownerUserId, 'Team member');
  const committed = detail.nodes.filter(isCommitted).sort((a, b) => dateOf(a) - dateOf(b));
  return {
    id: detail.id,
    eyebrow: `${TYPE_LABEL[detail.type]}${detail.draftedByMeri ? ' · drafted with Meri' : ''}`,
    title: detail.title,
    body: detail.goal ?? '',
    owner,
    init: initialsOf(owner),
    target: detail.targetDate ? shortDate(detail.targetDate) : '—',
    nodes: committed.slice(0, 3).map((node) => nodeRowOf(node, members, detail.ownerUserId)),
  };
}

function secondaryOf(
  detail: StrategyDetail,
  members: TenantMember[] | undefined,
  index: number,
): SecondaryModel {
  const owner = memberName(members, detail.ownerUserId, 'Team member');
  const next = detail.nodes
    .filter(isCommitted)
    .filter((node) => withinDays(node.endsOn ?? node.startsOn, 365))
    .sort((a, b) => dateOf(a) - dateOf(b))[0];
  return {
    id: detail.id,
    title: detail.title,
    type: TYPE_LABEL[detail.type],
    body: detail.goal ?? '',
    owner,
    init: initialsOf(owner),
    pct: SECONDARY_PCT[index] ?? SECONDARY_PCT[SECONDARY_PCT.length - 1] ?? '0%',
    target: detail.targetDate ? shortDate(detail.targetDate) : '—',
    next: next ? `${next.title} · ${shortDate(next.endsOn ?? next.startsOn)}` : '—',
  };
}

/* ── narrow flag (spec §1.6: narrow = w<1200; flips workCols to one column) ─ */

function usePfNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1199px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return narrow;
}

/* ── the tab ──────────────────────────────────────────────────────────────── */

export function ClientCrmWorkProto({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();
  const narrow = usePfNarrow();

  // Same keys/fns as the Strategies module — one shared cache entry (§10).
  const list = useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data,
    staleTime: 30_000,
  });
  const mine = useMemo(
    () => (list.data ?? []).filter((entry) => entry.clientId === client.id),
    [list.data, client.id],
  );
  const details = useQueries({
    queries: mine.map((entry) => ({
      queryKey: ['strategy', 'strategy', entry.id],
      queryFn: async () =>
        (await api.get<StrategyDetail>(`/strategy-api/strategies/${entry.id}`)).data,
      staleTime: 30_000,
    })),
  });
  const membersQuery = useTenantMembers();
  const members = membersQuery.data;

  const loaded = details.map((query) => query.data).filter((d): d is StrategyDetail => Boolean(d));
  const real = list.data !== undefined && !list.isError && mine.length > 0 && loaded.length > 0;
  // The list itself (not each strategy's detail) is enough to know honestly
  // that this client has zero strategies — no need to wait on detail queries
  // that will never exist to fetch.
  const listLoaded = list.data !== undefined && !list.isError;
  const genuinelyEmpty = listLoaded && mine.length === 0;

  const detailNodes = loaded.flatMap((detail) => detail.nodes.map((node) => ({ detail, node })));
  const committed = detailNodes.filter(({ node }) => isCommitted(node));
  const next30 = committed.filter(({ node }) => withinDays(node.endsOn ?? node.startsOn, 30));
  const riskNodes = committed.filter(({ node }) => node.kind === 'risk');
  const artifactCount = loaded.reduce((total, d) => total + d.artifacts.length, 0);

  const band = real
    ? [
        String(mine.length),
        String(committed.length),
        String(next30.length),
        String(riskNodes.length),
        String(artifactCount),
      ]
    : genuinelyEmpty
      ? ['0', '0', '0', '0', '0']
      : BAND_FIXTURE;

  const featured: FeaturedModel | null = useMemo(() => {
    const first = loaded[0];
    if (real && first) return featuredOf(first, members);
    if (genuinelyEmpty) return null;
    return FEATURED_FIXTURE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, genuinelyEmpty, loaded, members]);

  const secondaries: SecondaryModel[] = real
    ? loaded.slice(1, 3).map((d, i) => secondaryOf(d, members, i))
    : genuinelyEmpty
      ? []
      : SECONDARY_FIXTURES;

  const upcoming: UpcomingModel[] = real
    ? committed
        .filter(({ node }) => withinDays(node.endsOn ?? node.startsOn, 365))
        .sort((a, b) => dateOf(a.node) - dateOf(b.node))
        .slice(0, 5)
        .map(({ detail, node }) => {
          const owner = memberName(members, node.ownerUserId ?? detail.ownerUserId, 'Team member');
          return {
            id: node.id,
            date: shortDate(node.endsOn ?? node.startsOn),
            title: node.title,
            strategy: detail.title,
            init: initialsOf(owner),
            tone: STATUS_PILL[node.status][1],
          };
        })
    : genuinelyEmpty
      ? []
      : UPCOMING.map((u) => ({
          id: `fx-${u.date}-${u.title}`,
          date: u.date,
          title: u.title,
          strategy: u.strategy,
          init: u.init,
          tone: toneOf(u.ui),
        }));

  const risks: RiskModel[] = real
    ? riskNodes.slice(0, 2).map(({ node }) => ({
        id: node.id,
        title: node.title,
        body: `${node.openEnded ? 'Open-ended Strategy risk' : 'Strategy risk'} · owner ${memberName(members, node.ownerUserId, 'Team member')}`,
      }))
    : genuinelyEmpty
      ? []
      : RISK_FIXTURES;

  const openStrategy = (id: string | null) => {
    if (id && UUID_RE.test(id)) navigate(`/strategies/${id}`);
    else navigate('/strategies');
  };

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Client work"
        sub="A client-specific view of live Strategies and Strategy nodes. Changes sync both ways."
        actions={
          <>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: '0 12px 0 10px',
                borderRadius: 9999,
                background: '#F2F4F7',
                boxShadow: 'inset 0 0 0 1px #D0D5DD',
                color: '#101828',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '.03em',
                textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: GRADIENT_DARK }} />
              Source of truth · Strategies
            </span>
            <PfButton variant="secondary" onClick={() => navigate('/strategies')}>
              Open Strategies
            </PfButton>
            <PfButton variant="primary" onClick={() => navigate('/strategies')}>
              New strategy
            </PfButton>
          </>
        }
      />

      {/* §9.1 deep stat band */}
      <section
        style={{
          background: GRADIENT_DARK,
          borderRadius: 12,
          padding: '22px 28px',
          display: 'flex',
          alignItems: 'center',
          gap: 32,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: '#98A2B3',
            flex: '0 0 auto',
          }}
        >
          Client strategy portfolio
        </span>
        {BAND_LABELS.map((label, i) => (
          <span key={label} style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: '#ffffff', lineHeight: 1.2 }}>
              {band[i] ?? '—'}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: '.04em',
                textTransform: 'uppercase',
                color: '#98A2B3',
              }}
            >
              {label}
            </span>
          </span>
        ))}
        <span style={{ flex: 1, minWidth: 12 }} />
        <span style={{ flex: '0 0 auto', maxWidth: 220, fontSize: 13, color: '#98A2B3', textWrap: 'pretty' }}>
          No separate CRM tasks are created here.
        </span>
      </section>

      {/* §9.2 + §9.3 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'minmax(0,1.55fr) minmax(0,1fr)',
          gap: 24,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* featured strategy — selected-card ring §1.5 */}
          {featured ? (
            <section style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 0 0 1.5px #101828', overflow: 'hidden' }}>
              <div style={{ padding: '22px 24px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '.05em',
                      textTransform: 'uppercase',
                      color: '#667085',
                    }}
                  >
                    {featured.eyebrow}
                  </span>
                  <span style={{ flex: 1 }} />
                  {/* Designed status pill — no completion signal in the API (UI-only). */}
                  <Pill tone="success" size="lg" style={{ height: 24 }}>
                    On track
                  </Pill>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, marginTop: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 280 }}>
                    <h3 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>
                      {featured.title}
                    </h3>
                    <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
                      {featured.body}
                    </p>
                  </div>
                  <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
                    <PfButton variant="link" onClick={() => openStrategy(featured.id)}>
                      Open strategy →
                    </PfButton>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
                        Owner
                      </span>
                      <Avatar initials={featured.init} size={24} />
                      <span style={{ fontSize: 14, color: '#101828', whiteSpace: 'nowrap' }}>{featured.owner}</span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
                        Target date
                      </span>
                      <span style={{ fontSize: 14, color: '#101828' }}>{featured.target}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div style={{ borderTop: '1px solid #EAECF0', padding: '16px 24px 8px' }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '.05em',
                    textTransform: 'uppercase',
                    color: '#667085',
                  }}
                >
                  Next strategy nodes
                </span>
              </div>
              {featured.nodes.map((node) => (
                <NodeRow key={node.id} row={node} onOpen={() => openStrategy(featured.id)} />
              ))}
            </section>
          ) : (
            <EmptyFeaturedCard onCreate={() => navigate('/strategies')} />
          )}

          {/* secondary strategy cards */}
          {secondaries.map((st) => (
            <Card key={st.id} style={{ padding: '20px 24px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>{st.title}</h3>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 6,
                        background: '#F9FAFB',
                        boxShadow: 'inset 0 0 0 1px #EAECF0',
                        color: '#344054',
                        fontSize: 12,
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {st.type}
                    </span>
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
                    {st.body}
                  </p>
                </div>
                <span style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>
                    Owner
                  </span>
                  <Avatar initials={st.init} size={24} />
                  <span style={{ fontSize: 14, color: '#101828', whiteSpace: 'nowrap' }}>{st.owner}</span>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 180, display: 'block', height: 8, borderRadius: 4, background: '#F2F4F7', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: 8, width: st.pct, borderRadius: 4, background: GRADIENT_DARK }} />
                </span>
                <span style={{ flex: '0 0 auto', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#344054' }}>
                  {`${st.pct} ready`}
                </span>
                <span style={{ flex: '0 0 auto', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                  {`Target ${st.target}`}
                </span>
                <span style={{ flex: '0 0 auto', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                  {`Next ${st.next}`}
                </span>
              </div>
            </Card>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* §9.3 Upcoming work */}
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 24px', borderBottom: '1px solid #EAECF0' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Upcoming work</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 14, color: '#475467' }}>
                  Live Strategy nodes ordered by date
                </span>
              </span>
              <PfButton variant="link" onClick={() => openStrategy(featured?.id ?? null)}>
                View timeline
              </PfButton>
            </div>
            {upcoming.length === 0 ? (
              <p style={{ margin: 0, padding: '20px 24px', fontSize: 14, color: '#475467' }}>
                Nothing scheduled in the next year.
              </p>
            ) : (
              upcoming.map((row, i) => (
                <UpcomingRow
                  key={row.id}
                  row={row}
                  bg={i % 2 === 1 ? '#FCFCFD' : '#ffffff'}
                  onOpen={() => navigate('/strategies')}
                />
              ))
            )}
          </Card>

          {/* §9.3 Risks & blockers */}
          <Card>
            <CardHead title="Risks & blockers" />
            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {risks.length === 0 ? (
                <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>No open risks recorded.</p>
              ) : (
                risks.map((risk) => <RiskPanel key={risk.id} risk={risk} onOpen={() => navigate('/strategies')} />)
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ── empty state (spec §9.2 — no fabricated strategy when there is none) ──── */

function EmptyFeaturedCard({ onCreate }: { onCreate: () => void }) {
  return (
    <section
      style={{
        background: '#ffffff',
        borderRadius: 12,
        boxShadow: '0 0 0 1px #EAECF0',
        padding: '40px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>No strategies yet for this client</h3>
      <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
        Create a Strategy to start tracking plan steps, milestones, and risk against this account.
      </p>
      <PfButton variant="primary" onClick={onCreate}>
        New strategy
      </PfButton>
    </section>
  );
}

/* ── rows ─────────────────────────────────────────────────────────────────── */

function NodeRow({ row, onOpen }: { row: NodeRowModel; onOpen: () => void }) {
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
        gap: 14,
        padding: '12px 24px',
        borderTop: '1px solid #F2F4F7',
        background: hover ? '#F9FAFB' : 'transparent',
      }}
    >
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          borderRadius: 6,
          background: GRADIENT_DARK,
          color: '#ffffff',
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {row.mark}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.05em',
            textTransform: 'uppercase',
            color: '#667085',
          }}
        >
          {row.kind}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: 14,
            fontWeight: 500,
            color: '#101828',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.title}
        </span>
      </span>
      <span style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, width: 160, minWidth: 0 }}>
        <Avatar initials={row.init} size={24} />
        <span style={{ fontSize: 14, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.owner}
        </span>
      </span>
      <span style={{ flex: '0 0 auto', width: 64, fontSize: 14, color: '#475467' }}>{row.date}</span>
      <span style={{ flex: '0 0 auto', width: 118, display: 'flex', justifyContent: 'flex-end' }}>
        <Pill tone={row.tone} size="lg" style={{ height: 24 }}>
          {row.status}
        </Pill>
      </span>
    </button>
  );
}

function UpcomingRow({ row, bg, onOpen }: { row: UpcomingModel; bg: string; onOpen: () => void }) {
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
        gap: 14,
        padding: '13px 24px',
        borderBottom: '1px solid #F2F4F7',
        background: hover ? '#F9FAFB' : bg,
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          width: 56,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: '#667085',
        }}
      >
        {row.date}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            color: '#101828',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 2,
            fontSize: 13,
            color: '#667085',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {row.strategy}
        </span>
      </span>
      <Avatar initials={row.init} size={24} />
      <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: PILL[row.tone][3] }} />
    </button>
  );
}

function RiskPanel({ risk, onOpen }: { risk: RiskModel; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ padding: '14px 16px', borderRadius: 10, background: '#FFFAEB', boxShadow: 'inset 0 0 0 1px #FEDF89' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ flex: '0 0 auto', marginTop: 5, width: 8, height: 8, borderRadius: '50%', background: '#F79009' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#93370D', textWrap: 'pretty' }}>{risk.title}</div>
          <div style={{ marginTop: 4, fontSize: 13, color: '#B54708', textWrap: 'pretty' }}>{risk.body}</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button
          type="button"
          onClick={onOpen}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ fontSize: 14, fontWeight: 600, color: '#93370D', opacity: hover ? 0.8 : 1 }}
        >
          Open risk →
        </button>
      </div>
    </div>
  );
}
