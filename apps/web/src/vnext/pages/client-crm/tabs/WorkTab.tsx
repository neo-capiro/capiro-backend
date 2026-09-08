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
  PfButton,
  PfSkeleton,
  Pill,
  TabPageHead,
  type PillTone,
} from '../portfolio-primitives.js';
import { formatDateShort, formatNumber, humanizeEnumToken } from '../../../lib/labels.js';
import './work-tab.css';

/**
 * Work tab (spec §9, Figma geometry from `dom-tab-work.txt`).
 *
 * §10 constraint honoured: **Strategies is the source of truth — there is NO
 * parallel CRM task model.** Every strategy/node row reads through the SAME
 * query keys the Strategies module uses (`['strategy','strategies']`,
 * `['strategy','strategy',id]`, `['strategy','tenant-members']`), so an edit
 * in Strategies is the same cache entry seen here.
 *
 * Data binding — every rendered figure is one of four honest states, and the
 * design fixtures NEVER render for a real client:
 *  - loading   → skeleton band + skeleton cards
 *  - error     → an error card with Retry (the fixture used to render here
 *                forever, which put "FY27 Ground Robotics Funding" and
 *                "Sarah Martinez" on screen as if they were this client's)
 *  - empty     → a real empty state ("No strategies yet for this client")
 *  - loaded    → the client's real strategies
 *  - The `On track` pill and the secondary readiness percentages have no
 *    honest backing signal — the Strategy API carries no completion state (see
 *    useClientCrmOverviewModel) — so neither renders anywhere (wire-audit
 *    "4 New capability" rows 8-9).
 */

/* ── view-models ──────────────────────────────────────────────────────────── */

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
  /** Null when the strategy has no target date — rendered as "No target date". */
  target: string | null;
  /** Null when nothing is scheduled — rendered as "Nothing scheduled". */
  next: string | null;
}

interface UpcomingModel {
  id: string;
  date: string;
  title: string;
  strategy: string;
  init: string;
  /** Human status label — the colour dot alone is not an accessible status. */
  status: string;
  tone: PillTone;
}

interface RiskModel {
  id: string;
  title: string;
  body: string;
}

const BAND_LABELS = [
  'Current strategies',
  'Live plan steps',
  'Next 30 days',
  'Open risks',
  'Linked artifacts',
] as const;



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
  completed: ['Completed', 'success'],
};

/* A new server enum value must degrade to a readable label, never blank the
 * tab (C17): every lookup falls back to a humanized token / gray tone. */
const typeLabel = (type: StrategyType): string =>
  (TYPE_LABEL as Record<string, string>)[type] ?? humanizeEnumToken(String(type));
const kindLabel = (kind: NodeKind): string =>
  (KIND_LABEL as Record<string, string>)[kind] ?? humanizeEnumToken(String(kind));
const statusPill = (status: NodeStatus): [string, PillTone] =>
  (STATUS_PILL as Record<string, [string, PillTone]>)[status] ?? [
    humanizeEnumToken(String(status)),
    'gray',
  ];

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
  const kind = kindLabel(node.kind);
  const [status, tone] = statusPill(node.status);
  return {
    id: node.id,
    mark: kind.charAt(0),
    kind,
    title: node.title,
    init: initialsOf(owner),
    owner,
    date: formatDateShort(node.endsOn ?? node.startsOn) ?? '—',
    status,
    tone,
  };
}

function featuredOf(detail: StrategyDetail, members: TenantMember[] | undefined): FeaturedModel {
  const owner = memberName(members, detail.ownerUserId, 'Team member');
  const committed = detail.nodes.filter(isCommitted).sort((a, b) => dateOf(a) - dateOf(b));
  return {
    id: detail.id,
    eyebrow: `${typeLabel(detail.type)}${detail.draftedByMeri ? ' · drafted with Meri' : ''}`,
    title: detail.title,
    body: detail.goal ?? '',
    owner,
    init: initialsOf(owner),
    // "No target date" over an uppercase dash: a dash reads as broken data,
    // while an absent target is a real, common state.
    target: formatDateShort(detail.targetDate) ?? 'No target date',
    nodes: committed.slice(0, 3).map((node) => nodeRowOf(node, members, detail.ownerUserId)),
  };
}

function secondaryOf(detail: StrategyDetail, members: TenantMember[] | undefined): SecondaryModel {
  const owner = memberName(members, detail.ownerUserId, 'Team member');
  const next = detail.nodes
    .filter(isCommitted)
    .filter((node) => withinDays(node.endsOn ?? node.startsOn, 365))
    .sort((a, b) => dateOf(a) - dateOf(b))[0];
  return {
    id: detail.id,
    title: detail.title,
    type: typeLabel(detail.type),
    body: detail.goal ?? '',
    owner,
    init: initialsOf(owner),
    target: formatDateShort(detail.targetDate),
    next: next ? `${next.title} · ${formatDateShort(next.endsOn ?? next.startsOn) ?? '—'}` : null,
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

export function ClientCrmWorkProto({ client, drawer = false }: { client: Client; drawer?: boolean }) {
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
  /**
   * Honest state machine (C1 + item 13, wire-audit "3 Compose extend"):
   * loading → skeletons, error → error card with Retry, empty → real empty
   * state, loaded → real figures. The design fixtures used to render on
   * loading AND on error — forever, for a real client — which put
   * "FY27 Ground Robotics Funding" and "Sarah Martinez" on screen as if real.
   *
   * A source that failed is not zero and is not a fixture — it is unknown. And
   * when only SOME details fail, the counts below are real but short, which
   * the strip states rather than quietly under-reporting.
   */
  const detailErrors = details.filter((query) => query.isError).length;
  const detailsSettled = details.every((query) => !query.isPending);
  const allDetailsFailed = mine.length > 0 && detailsSettled && loaded.length === 0;
  const real = list.data !== undefined && !list.isError && mine.length > 0 && loaded.length > 0;
  // The list itself (not each strategy's detail) is enough to know honestly
  // that this client has zero strategies — no need to wait on detail queries
  // that will never exist to fetch.
  const listLoaded = list.data !== undefined && !list.isError;
  const genuinelyEmpty = listLoaded && mine.length === 0;
  const listError = list.isError;
  const loading = list.isPending || (listLoaded && mine.length > 0 && !detailsSettled);

  const retry = () => {
    if (list.isError) void list.refetch();
    details.forEach((query) => {
      if (query.isError) void query.refetch();
    });
  };

  const detailNodes = loaded.flatMap((detail) => detail.nodes.map((node) => ({ detail, node })));
  const committed = detailNodes.filter(({ node }) => isCommitted(node));
  const next30 = committed.filter(({ node }) => withinDays(node.endsOn ?? node.startsOn, 30));
  const riskNodes = committed.filter(({ node }) => node.kind === 'risk');
  const artifactCount = loaded.reduce((total, d) => total + d.artifacts.length, 0);

  const band = [
    formatNumber(mine.length),
    formatNumber(committed.length),
    formatNumber(next30.length),
    formatNumber(riskNodes.length),
    formatNumber(artifactCount),
  ];

  const featured: FeaturedModel | null = useMemo(() => {
    const first = loaded[0];
    if (real && first) return featuredOf(first, members);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, loaded, members]);

  const secondaries: SecondaryModel[] = real ? loaded.slice(1, 3).map((d) => secondaryOf(d, members)) : [];

  const upcoming: UpcomingModel[] = real
    ? committed
        .filter(({ node }) => withinDays(node.endsOn ?? node.startsOn, 365))
        .sort((a, b) => dateOf(a.node) - dateOf(b.node))
        .slice(0, 5)
        .map(({ detail, node }) => {
          const owner = memberName(members, node.ownerUserId ?? detail.ownerUserId, 'Team member');
          const [status, tone] = statusPill(node.status);
          return {
            id: node.id,
            date: formatDateShort(node.endsOn ?? node.startsOn) ?? '—',
            title: node.title,
            strategy: detail.title,
            init: initialsOf(owner),
            status,
            tone,
          };
        })
    : [];

  const risks: RiskModel[] = real
    ? riskNodes.slice(0, 2).map(({ node }) => ({
        id: node.id,
        title: node.title,
        body: `${node.openEnded ? 'Open-ended Strategy risk' : 'Strategy risk'} · owner ${memberName(members, node.ownerUserId, 'Team member')}`,
      }))
    : [];

  const openStrategy = (id: string | null) => {
    if (id && UUID_RE.test(id)) navigate(`/strategies/${id}`);
    else navigate('/strategies');
  };

  if (drawer) {
    const rows = loaded.map((detail) => {
      const owner = memberName(members, detail.ownerUserId, 'Team member');
      const committedNodes = detail.nodes.filter(isCommitted);
      const hasActive = committedNodes.some((node) => node.status === 'active');
      const hasInFlight = committedNodes.some(
        (node) => node.status === 'in_progress' || node.status === 'internal_review',
      );
      const status = detail.archivedAt ? 'Archived' : hasActive ? 'Active' : hasInFlight ? 'In progress' : 'Planned';
      const tone: PillTone = detail.archivedAt ? 'gray' : hasActive ? 'success' : hasInFlight ? 'blue' : 'warning';
      return {
        id: detail.id,
        title: detail.title,
        kind: typeLabel(detail.type),
        owner,
        init: initialsOf(owner),
        steps: committedNodes.length,
        target: formatDateShort(detail.targetDate) ?? '—',
        status,
        tone,
      };
    });

    return (
      <div className="cap-pf-work-drawer">
        <div className="cap-pf-work-drawer__scroll">
          <div className="cap-pf-work-drawer__table">
            <div className="cap-pf-work-drawer__head" aria-hidden>
              <span>Strategy</span>
              <span>Owner</span>
              <span>Steps</span>
              <span>Target</span>
              <span>Status</span>
            </div>
            {loading ? (
              <div className="cap-pf-work-drawer__state" aria-busy="true">Loading strategies…</div>
            ) : listError || allDetailsFailed ? (
              <div className="cap-pf-work-drawer__state cap-pf-work-drawer__state--error">
                <span>Strategies could not be loaded.</span>
                <button type="button" onClick={retry}>Retry</button>
              </div>
            ) : rows.length === 0 ? (
              <div className="cap-pf-work-drawer__state">No strategies yet for this client.</div>
            ) : (
              rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="cap-pf-work-drawer__row"
                  onClick={() => openStrategy(row.id)}
                >
                  <span className="cap-pf-work-drawer__strategy">
                    <strong>{row.title}</strong>
                    <small>{row.kind}</small>
                  </span>
                  <span className="cap-pf-work-drawer__owner">
                    <Avatar initials={row.init} size={24} />
                    <span>{row.owner}</span>
                  </span>
                  <span className="cap-pf-work-drawer__number">{row.steps}</span>
                  <span className="cap-pf-work-drawer__target">{row.target}</span>
                  <span className="cap-pf-work-drawer__status"><Pill tone={row.tone}>{row.status}</Pill></span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="cap-pf-work-drawer__footer">
          <span className="cap-pf-work-drawer__truth"><i />Source of truth · Strategies</span>
          <button type="button" onClick={() => navigate('/strategies')}>Open Strategies →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cap-pf-anim-rise cap-pf-work">
      <TabPageHead
        title="Client work"
        sub="A client-specific view of live Strategies and Strategy nodes. Changes sync both ways."
        actions={
          <>
            <span className="cap-pf-work__truth-pill">
              <span className="cap-pf-work__truth-dot" />
              Source of truth · Strategies
            </span>
            <PfButton variant="secondary" onClick={() => navigate('/strategies')}>
              Open Strategies
            </PfButton>
            {/* `?new=1` at least states the intent — the Strategies module
                ignores unknown params safely, so this differentiates "create"
                from "browse" until a real create route exists. */}
            <PfButton variant="primary" onClick={() => navigate('/strategies?new=1')}>
              New strategy
            </PfButton>
          </>
        }
      />

      {/* §9.1 deep stat band */}
      <section className="cap-pf-work__band">
        <span className="cap-pf-work__band-title">Client strategy portfolio</span>
        {loading ? (
          BAND_LABELS.map((label) => (
            <span key={label} className="cap-pf-work__band-cell is-loading">
              <PfSkeleton style={{ width: 40, height: 28 }} />
              <span className="cap-pf-work__band-sublabel">{label}</span>
            </span>
          ))
        ) : genuinelyEmpty || listError ? (
          // A client with no work yet gets one honest sentence, not a row of
          // five zeros; an unread list gets the error treatment below.
          <span className="cap-pf-work__band-empty">
            {listError
              ? 'Strategies could not be loaded.'
              : 'No strategies yet — the stat band appears once work is planned.'}
          </span>
        ) : allDetailsFailed ? (
          <>
            <span className="cap-pf-work__band-cell">
              <span className="cap-pf-work__band-value">{formatNumber(mine.length)}</span>
              <span className="cap-pf-work__band-sublabel">{BAND_LABELS[0]}</span>
            </span>
            {/* Unknown is not zero and is not a dash farm: the strategy count
                is known from the list; everything else lives in details that
                did not answer, which the strip says in words, with a Retry
                right where the reader is looking. */}
            <span className="cap-pf-work__band-warn">
              Some strategy details failed to load
              <PfButton variant="link" style={{ color: 'var(--pf-surface)', fontSize: 13 }} onClick={retry}>
                Retry
              </PfButton>
            </span>
          </>
        ) : (
          BAND_LABELS.map((label, i) => (
            <span key={label} className="cap-pf-work__band-cell">
              <span className="cap-pf-work__band-value">{band[i] ?? '—'}</span>
              <span className="cap-pf-work__band-sublabel">{label}</span>
            </span>
          ))
        )}
        <span className="cap-pf-work__band-spacer" />
        {!loading && real ? (
          <span className="cap-pf-work__band-note">
            {/* A partly-read portfolio produces real but SHORT figures. Saying
                so is the difference between a number that is low and a number
                that is wrong. */}
            {detailErrors > 0
              ? `${detailErrors} of ${mine.length} strategies could not be read — figures below exclude them.`
              : 'Live view of Strategies — edits sync both ways.'}
            {detailErrors > 0 ? (
              <PfButton variant="link" style={{ color: 'var(--pf-surface)', fontSize: 13 }} onClick={retry}>
                Retry
              </PfButton>
            ) : null}
          </span>
        ) : null}
      </section>

      {/* §9.2 + §9.3 */}
      {listError ? (
        <Card style={{ padding: '32px 24px' }}>
          <h3 className="cap-pf-work__state-title">Strategies could not be loaded</h3>
          <p className="cap-pf-work__state-body">
            {list.error instanceof Error ? list.error.message : 'The Strategies service did not answer.'}
          </p>
          <PfButton variant="primary" onClick={retry}>
            Retry
          </PfButton>
        </Card>
      ) : loading ? (
        <div className={`cap-pf-work__grid${narrow ? ' is-narrow' : ''}`}>
          <div className="cap-pf-work__col">
            <Card style={{ padding: '22px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <PfSkeleton style={{ width: '40%', height: 14 }} />
              <PfSkeleton style={{ width: '70%', height: 24 }} />
              <PfSkeleton style={{ width: '100%', height: 40 }} />
              <PfSkeleton style={{ width: '100%', height: 40 }} />
            </Card>
            <Card style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <PfSkeleton style={{ width: '55%', height: 18 }} />
              <PfSkeleton style={{ width: '100%', height: 36 }} />
            </Card>
          </div>
          <div className="cap-pf-work__col">
            <Card style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <PfSkeleton style={{ width: '45%', height: 18 }} />
              <PfSkeleton style={{ width: '100%', height: 32 }} />
              <PfSkeleton style={{ width: '100%', height: 32 }} />
            </Card>
          </div>
        </div>
      ) : (
      <div className={`cap-pf-work__grid${narrow ? ' is-narrow' : ''}`}>
        <div className="cap-pf-work__col">
          {/* featured strategy — selected-card ring §1.5 */}
          {allDetailsFailed ? (
            <Card style={{ padding: '32px 24px' }}>
              <h3 className="cap-pf-work__state-title">Strategy details could not be read</h3>
              <p className="cap-pf-work__state-body">
                {`This client has ${mine.length} strateg${mine.length === 1 ? 'y' : 'ies'}, but none of the details answered.`}
              </p>
              <PfButton variant="primary" onClick={retry}>
                Retry
              </PfButton>
            </Card>
          ) : featured ? (
            <section className="cap-pf-work__featured">
              <div className="cap-pf-work__featured-head">
                <div className="cap-pf-work__featured-top">
                  <span className="cap-pf-work__eyebrow">{featured.eyebrow}</span>
                  <span className="cap-pf-work__spacer" />
                  {/* Row 8, wire-audit "4 New capability": there is no completion
                      state anywhere in the Strategy API, so "On track" was an
                      assertion about a real strategy that nothing backed. It
                      stays only over the design fixture. */}
                  {real ? null : (
                    <Pill tone="success" size="lg" style={{ height: 24 }}>
                      On track
                    </Pill>
                  )}
                </div>
                <div className="cap-pf-work__featured-body-row">
                  <div className="cap-pf-work__featured-main">
                    <h3 className="cap-pf-work__featured-title">{featured.title}</h3>
                    <p className="cap-pf-work__featured-desc">{featured.body}</p>
                  </div>
                  <div className="cap-pf-work__featured-side">
                    <PfButton variant="link" onClick={() => openStrategy(featured.id)}>
                      Open strategy →
                    </PfButton>
                    <span className="cap-pf-work__meta-row">
                      <span className="cap-pf-work__eyebrow">Owner</span>
                      <Avatar initials={featured.init} size={24} />
                      <span className="cap-pf-work__meta-value">{featured.owner}</span>
                    </span>
                    <span className="cap-pf-work__meta-row">
                      <span className="cap-pf-work__eyebrow">Target date</span>
                      <span className="cap-pf-work__meta-value">{featured.target}</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="cap-pf-work__featured-foot">
                <span className="cap-pf-work__eyebrow">Next strategy nodes</span>
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
              <div className="cap-pf-work__sec-row">
                <div className="cap-pf-work__sec-main">
                  <div className="cap-pf-work__sec-title-row">
                    <h3 className="cap-pf-work__sec-title">{st.title}</h3>
                    <span className="cap-pf-work__sec-type">{st.type}</span>
                  </div>
                  <p className="cap-pf-work__sec-desc">{st.body}</p>
                </div>
                <span className="cap-pf-work__sec-owner">
                  <span className="cap-pf-work__eyebrow">Owner</span>
                  <Avatar initials={st.init} size={24} />
                  <span className="cap-pf-work__meta-value">{st.owner}</span>
                </span>
              </div>
              <div className="cap-pf-work__sec-foot">
                {/* No readiness meter on a real strategy — nothing measures it. */}
                <span className="cap-pf-work__sec-foot-spacer" />
                <span className="cap-pf-work__sec-foot-label">{`Target ${st.target}`}</span>
                <span className="cap-pf-work__sec-foot-label">{`Next ${st.next}`}</span>
              </div>
            </Card>
          ))}
        </div>

        <div className="cap-pf-work__col">
          {/* §9.3 Upcoming work */}
          <Card>
            <div className="cap-pf-work__panel-head">
              <span className="cap-pf-work__panel-head-main">
                <span className="cap-pf-work__panel-title">Upcoming work</span>
                <span className="cap-pf-work__panel-sub">Live Strategy nodes ordered by date</span>
              </span>
              <PfButton variant="link" onClick={() => openStrategy(featured?.id ?? null)}>
                View timeline
              </PfButton>
            </div>
            {upcoming.length === 0 ? (
              <p className="cap-pf-work__empty-note">Nothing scheduled in the next year.</p>
            ) : (
              upcoming.map((row, i) => (
                <UpcomingRow
                  key={row.id}
                  row={row}
                  bg={i % 2 === 1 ? 'var(--pf-subtle-bg)' : 'var(--pf-surface)'}
                  onOpen={() => navigate('/strategies')}
                />
              ))
            )}
          </Card>

          {/* §9.3 Risks & blockers */}
          <Card>
            <CardHead title="Risks & blockers" />
            <div className="cap-pf-work__risks-body">
              {risks.length === 0 ? (
                <p className="cap-pf-work__risks-empty">No open risks recorded.</p>
              ) : (
                risks.map((risk) => <RiskPanel key={risk.id} risk={risk} onOpen={() => navigate('/strategies')} />)
              )}
            </div>
          </Card>
        </div>
      </div>
      )}
    </div>
  );
}

/* ── empty state (spec §9.2 — no fabricated strategy when there is none) ──── */

function EmptyFeaturedCard({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="cap-pf-work__empty-card">
      <h3 className="cap-pf-work__state-title">No strategies yet for this client</h3>
      <p className="cap-pf-work__state-body is-flush">
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
      className={`cap-pf-work__node-row${hover ? ' is-hover' : ''}`}
    >
      <span aria-hidden className="cap-pf-work__node-mark">
        {row.mark}
      </span>
      <span className="cap-pf-work__node-main">
        <span className="cap-pf-work__node-kind">{row.kind}</span>
        <span className="cap-pf-work__node-title">{row.title}</span>
      </span>
      <span className="cap-pf-work__node-owner">
        <Avatar initials={row.init} size={24} />
        <span className="cap-pf-work__node-owner-name">{row.owner}</span>
      </span>
      <span className="cap-pf-work__node-date">{row.date}</span>
      <span className="cap-pf-work__node-status">
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
      className="cap-pf-work__up-row"
      style={{ background: hover ? 'var(--pf-subtle-bg)' : bg }}
    >
      <span className="cap-pf-work__up-date">{row.date}</span>
      <span className="cap-pf-work__up-main">
        <span className="cap-pf-work__up-title">{row.title}</span>
        <span className="cap-pf-work__up-strategy">{row.strategy}</span>
      </span>
      <Avatar initials={row.init} size={24} />
      <span className={`cap-pf-work__up-dot is-tone-${row.tone}`} />
    </button>
  );
}

function RiskPanel({ risk, onOpen }: { risk: RiskModel; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div className="cap-pf-work__risk">
      <div className="cap-pf-work__risk-top">
        <span className="cap-pf-work__risk-dot" />
        <div className="cap-pf-work__risk-main">
          <div className="cap-pf-work__risk-title">{risk.title}</div>
          <div className="cap-pf-work__risk-body">{risk.body}</div>
        </div>
      </div>
      <div className="cap-pf-work__risk-foot">
        <button
          type="button"
          onClick={onOpen}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          className={`cap-pf-work__risk-link${hover ? ' is-hover' : ''}`}
        >
          Open risk →
        </button>
      </div>
    </div>
  );
}
