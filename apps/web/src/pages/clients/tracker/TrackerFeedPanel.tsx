import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useBillTarget } from '../../bills/bill-target.js';
import { App as AntApp, Input, Modal } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  toCanonicalAlert,
  feedQueryString,
  intelFeedKeys,
  intelFeedPaths,
  SOURCE_LABEL,
  type FeedFilter,
  type FeedItem,
  type FeedOrder,
  type FeedResponse,
  type RecommendedAction,
} from './intel-feed-api.js';
import { useAddTalkingPoint, useSetReport } from './alert-actions-api.js';
import {
  actionTextOf,
  buildOutreachContextPoolItem,
  renderPacketSummary,
  type GovernmentAffairsAlertPacket,
} from './alert-packet.js';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';
import { DistrictBriefComposerDrawer } from './DistrictBriefComposerDrawer.js';

/**
 * Unified intel FEED panel (Phase 6 §9.7) — bill | hearing | combined alerts with
 * per-source counts, plus intelligent per-alert ACTIONS (draft memo / outreach /
 * pull quotes / add to weekly report / open source). The memo is generated in
 * apps/api (Memory-grounded) and auto-filed to the client's Documents; the alert
 * shows "memo drafted" once done. Gated by `tracker_v2`.
 *
 * LegiWatch v2 re-skin: the "calm design" — collapsible `.acard` cards (one
 * severity cue = the colored left edge), a right rail (Show / Arrange / At a
 * glance), Hanken/Newsreader/JetBrains type. Markup uses the shared calm classes
 * from `radar/legiwatch.css` (scoped under `.lw-root`).
 */

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || '•'
  );
}

/** Compact inline icon set (matches the prototype's action glyphs). */
function Ic({ n, size = 12 }: { n: string; size?: number }) {
  const paths: Record<string, string> = {
    doc: 'M6 2h7l5 5v15H6z M13 2v5h5',
    mail: 'M3 5h18v14H3z M3 6l9 7 9-7',
    check: 'M4 12l5 5L20 6',
    file: 'M6 2h7l5 5v15H6z',
    audio: 'M12 3v12 M8 7a4 4 0 0 0 8 0 M5 19h14',
    spark: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
    quote: 'M7 7H4v6h3l-1 4 M17 7h-3v6h3l-1 4',
    plus: 'M12 5v14 M5 12h14',
    chevR: 'M9 6l6 6-6 6',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[n] ?? paths.file} />
    </svg>
  );
}

const ACTION_ICON: Record<string, string> = {
  save_recap: 'spark',
  draft_memo: 'doc',
  district_brief: 'file',
  send_outreach: 'mail',
  draft_outreach: 'mail',
  add_to_report: 'check',
  open_bill: 'file',
  open_hearing: 'audio',
  open_program_element: 'file',
  pull_quotes: 'quote',
  add_talking_point: 'plus',
};

/** $X.XB / $XM for a millions figure — matches the dossier + PE formatters. */
function fmtMillionsShort(m: number): string {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

/** Group a flat, already-ordered feed page by client, preserving first-seen order
 *  (LegiWatch v2 "Grouped by client" arrangement at the all-clients altitude). */
function groupByClient(
  items: FeedItem[],
): Array<{ clientId: string; clientName: string; list: FeedItem[] }> {
  const order: string[] = [];
  const map = new Map<string, { clientId: string; clientName: string; list: FeedItem[] }>();
  for (const it of items) {
    let g = map.get(it.clientId);
    if (!g) {
      g = { clientId: it.clientId, clientName: it.clientName ?? 'Client', list: [] };
      map.set(it.clientId, g);
      order.push(it.clientId);
    }
    g.list.push(it);
  }
  return order.map((id) => map.get(id)!);
}

function actionLabel(a: RecommendedAction, item: FeedItem): string {
  if (a.kind === 'draft_memo' && item.actions?.memo) return 'Redraft memo';
  if (a.kind === 'add_to_report') return item.actions?.inReport ? 'In weekly report ✓' : a.label;
  return a.label;
}

function FeedCard({
  item,
  onAction,
  showClient = false,
  onScopeClient,
}: {
  item: FeedItem;
  onAction: (a: RecommendedAction, item: FeedItem) => void;
  /** P11 global feed: render a client label so cross-client alerts are attributable. */
  showClient?: boolean;
  /** LegiWatch v2: clicking the client label scopes the whole feature to it. */
  onScopeClient?: (clientId: string) => void;
}) {
  // LegiWatch v2 (L1): calm card — collapsed by default, expands on demand.
  const [open, setOpen] = useState(false);
  const [showAllQuotes, setShowAllQuotes] = useState(false);
  const ev = item.evidence ?? {};
  const mentions = ev.hearing?.mentions ?? [];
  const actions = item.recommendedActions ?? [];
  const primary = actions.find((a) => a.primary) ?? actions[0];
  const drafted = !!item.actions?.memo;
  const inReport = !!item.actions?.inReport;

  return (
    <div className={'acard' + (open ? ' open' : '')} data-sev={item.severity}>
      <div className="acard-head" onClick={() => setOpen((o) => !o)}>
        <div className="acard-main">
          <div className={'acard-title' + (open ? '' : ' clip')}>{item.title}</div>
          <div className="acard-meta">
            {showClient && (
              <button
                className="chip client"
                onClick={(e) => {
                  e.stopPropagation();
                  onScopeClient?.(item.clientId);
                }}
                title="View only this client"
              >
                <span className="cdot">{initials(item.clientName ?? 'Client')}</span>
                {item.clientName ?? 'Client'}
              </button>
            )}
            <span className="src-label">{SOURCE_LABEL[item.sourceType]}</span>
            {item.tag && (
              <span className="chip tag" title="Matched watchlist tag">
                #{item.tag}
              </span>
            )}
            {!toCanonicalAlert(item).complete && (
              <span
                className="chip"
                style={{ fontSize: 10.5, opacity: 0.65 }}
                title={`Incomplete alert — missing: ${toCanonicalAlert(item).missingFields.join(', ')}`}
              >
                incomplete
              </span>
            )}
            {drafted && (
              <span className="done-flag">
                <Ic n="check" size={10} /> memo drafted
              </span>
            )}
            {inReport && (
              <span className="chip success" style={{ fontSize: 10.5 }}>
                in weekly report
              </span>
            )}
            <span className="acard-date">{fmtDate(item.createdAt)}</span>
          </div>
        </div>
        {!open && primary && (
          <span className="acard-primary" onClick={(e) => e.stopPropagation()}>
            <button className="btn sm" onClick={() => onAction(primary, item)}>
              <Ic n={ACTION_ICON[primary.kind] ?? 'file'} /> {actionLabel(primary, item)}
            </button>
          </span>
        )}
        <span className="acard-chev">
          <Ic n="chevR" size={15} />
        </span>
      </div>

      {open && (
        <div className="acard-body">
          {ev.bill && (
            <div
              className="acard-evi"
              onClick={() =>
                onAction(
                  { kind: 'open_bill', label: 'Open bill', target: { billId: ev.bill!.billId } },
                  item,
                )
              }
            >
              <span className="evnum">{ev.bill.displayNum}</span>
              <span>
                {ev.bill.stage}
                {ev.bill.actionText ? ` — ${ev.bill.actionText}` : ''}{' '}
                {ev.bill.actionDate ? (
                  <span className="muted num">({ev.bill.actionDate})</span>
                ) : null}
              </span>
            </div>
          )}

          {/* R4 §4.3: a Program Element funding movement. Shows the PE code, the
              delta type, and the exact movement (both amounts in millions), and
              opens Program Element 360 — the line-level source of truth (§4.2). */}
          {ev.programElement && (
            <div
              className="acard-evi"
              onClick={() =>
                onAction(
                  {
                    kind: 'open_program_element',
                    label: 'Open Program Element',
                    target: { peCode: ev.programElement!.peCode },
                  },
                  item,
                )
              }
            >
              <span className="evnum">{ev.programElement.peCode}</span>
              <span>
                {ev.programElement.deltaTypeLabel}
                {ev.programElement.title ? ` — ${ev.programElement.title}` : ''}{' '}
                <span className="muted num">
                  (FY{ev.programElement.fiscalYear}
                  {ev.programElement.amountFromMillions != null &&
                  ev.programElement.amountToMillions != null
                    ? `, ${fmtMillionsShort(ev.programElement.amountFromMillions)} → ${fmtMillionsShort(ev.programElement.amountToMillions)}`
                    : ''}
                  )
                </span>
              </span>
            </div>
          )}

          {mentions.length > 0 && (
            <div>
              {(showAllQuotes ? mentions : mentions.slice(0, 1)).map((m, i) => (
                <div className="acard-quote" key={m.segmentId ?? i}>
                  <span className="qts">{fmtTs(m.timestampMs)}</span>
                  <span>
                    {m.speakerName ? <b>{m.speakerName}: </b> : null}
                    {m.quote ? (
                      `“${m.quote}”`
                    ) : (
                      <i className="muted">[encrypted — open hearing to view]</i>
                    )}
                  </span>
                </div>
              ))}
              {mentions.length > 1 && !showAllQuotes && (
                <div className="more-quotes" onClick={() => setShowAllQuotes(true)}>
                  +{mentions.length - 1} more quote{mentions.length - 1 === 1 ? '' : 's'}
                </div>
              )}
            </div>
          )}

          {actions.length > 0 && (
            <div className="acard-actions">
              {actions.map((a, i) => (
                <button
                  key={a.kind}
                  className={
                    'btn sm' +
                    (i === 0
                      ? ' btn-accent'
                      : a.kind === 'open_bill' || a.kind === 'open_hearing'
                        ? ' btn-ghost'
                        : '')
                  }
                  onClick={() => onAction(a, item)}
                >
                  <Ic n={ACTION_ICON[a.kind] ?? 'file'} /> {actionLabel(a, item)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TrackerFeedPanel({
  clientId,
  clientName,
  onOpenBill,
  onScopeClient,
  global = false,
}: {
  /** Per-client mode: the client to scope to. Omitted/ignored in `global` mode. */
  clientId?: string;
  clientName?: string;
  /**
   * LegiWatch v2 (L1): global feed only — clicking a card's client label scopes the
   * whole feature to that client. RadarPage passes a setter for the `client` URL param.
   */
  onScopeClient?: (clientId: string) => void;
  /**
   * P3/P9.1: when provided, `open_bill` alert actions open the bill in place
   * (the Radar/profile bill side-drawer) instead of navigating to Data Explorer.
   * Falls back to `/explorer?bill=` navigation for any other caller (back-compat).
   * The alert's own clientId is passed as the 2nd arg so the global feed (P11) can
   * open the drawer scoped to the right client.
   */
  onOpenBill?: (billId: string, clientId: string) => void;
  /**
   * P11 global altitude: render the TENANT-WIDE cross-client roll-up (each card
   * labels its client) instead of one client's feed. Actions still work — every
   * per-alert operation is scoped to `item.clientId`.
   */
  global?: boolean;
}) {
  const api = useApi();
  const navigate = useNavigate();
  // Bill 360 when the tenant has it, Explorer otherwise — never a dark surface.
  const billTarget = useBillTarget();
  const { message } = AntApp.useApp();
  const [source, setSource] = useState<FeedFilter>('all');
  // LegiWatch v2 leads with newest-first (the feed-lead copy says so); priority
  // ordering isn't surfaced as a control in the calm design.
  const order: FeedOrder = 'date';
  // LegiWatch v2 (L1): global feed arrangement — single stream (default) or grouped
  // by client. Never the default; only offered at the all-clients altitude.
  const [group, setGroup] = useState(false);
  const [composerItem, setComposerItem] = useState<FeedItem | null>(null);
  const [briefItem, setBriefItem] = useState<FeedItem | null>(null);
  const [tpItem, setTpItem] = useState<FeedItem | null>(null);
  const [tpText, setTpText] = useState('');

  const setReport = useSetReport();
  const addTalkingPoint = useAddTalkingPoint();

  // P10: acting on a feed alert = hand-off. "Draft outreach" creates a real
  // outreach DRAFT record seeded with the alert as a context item, then deep-links
  // the wizard's resume path (/engagement/outreach/draft/:id). The wizard hydrates
  // client/title/context from metadata and resumes at the Build Context step — no
  // wizard changes needed. Mirrors the DTO in engagement.controller.ts
  // (CreateOutreachRecordDto: type/clientId/title/direction/lastStep/metadata/contextPool).
  const draftOutreach = useMutation({
    mutationFn: async (item: FeedItem) => {
      // P1-13: the wizard used to open with `whyItMatters + one bill action`, dropping
      // every hearing quote and speaker, every PE funding delta, every regulation field,
      // the official source URL, the client's position/priority, the active strategy, and
      // the target offices. Fetch the server-built §4.1 packet instead.
      //
      // .catch(() => null) is load-bearing: a packet-fetch failure must NEVER block the
      // outreach draft, and the fallback is byte-identical to the old projection.
      const packet = await api
        .get<GovernmentAffairsAlertPacket>(
          `/intel-api/clients/${encodeURIComponent(item.clientId)}/alerts/${encodeURIComponent(item.id)}/packet`,
        )
        .then((r) => r.data)
        .catch(() => null);
      const body = packet ? renderPacketSummary(packet) : actionTextOf(item);
      const ctxId = `alert-${item.id}`;
      const contextItem = {
        id: ctxId,
        kind: 'intel' as const,
        title: item.title,
        body,
        tag: 'LegiWatch alert',
        scope: 'all' as const,
        note: '',
      };
      const res = await api.post<{ id: string }>('/api/engagement/outreach', {
        type: 'campaign',
        clientId: item.clientId, // scope to the alert's own client (global feed too)
        title: `Re: ${item.title}`.slice(0, 240),
        direction: 'on-behalf',
        lastStep: 4,
        metadata: {
          source: 'radar-alert',
          direction: 'on-behalf',
          lastStepId: 'context',
          tone: 'Professional',
          targets: [],
          contextItems: [contextItem],
        },
        // The projection the API stores at the top level so Meri generation sees the
        // alert as a context source (mirrors the wizard's contextPool). Since P1-13 this
        // carries the PACKET-derived context, not the old one-line summary.
        //
        // The packet is nested in `summary` rather than sent as its own key on purpose:
        // OutreachContextPoolItemDto is strictly typed and the global ValidationPipe runs
        // forbidNonWhitelisted, so an unwhitelisted `packet` key would 400 the whole POST
        // — and widening that DTO would touch a contract the outreach wizard also uses.
        // Slice to the DTO bounds (title @Length(1,240), summary @Length(0,2000)):
        // intel_alert.title is unbounded and federal bill/hearing titles routinely
        // exceed 240, which would 400 the whole POST (review finding).
        contextPool: [buildOutreachContextPoolItem(ctxId, item, body)],
      });
      return res.data;
    },
    onSuccess: (record) => {
      message.success('Outreach draft created — opening the wizard');
      navigate(`/engagement/outreach/draft/${encodeURIComponent(record.id)}`);
    },
    onError: (e: unknown) =>
      message.error(`Could not create outreach draft: ${(e as Error).message}`),
  });

  // P11: global mode reads the tenant-wide roll-up (`_all/feed`) under a distinct
  // cache key; per-client mode is unchanged. The path/key switch is the ONLY
  // difference — filters, keyset cursor, and page shape are identical.
  const query = useInfiniteQuery({
    queryKey: global
      ? intelFeedKeys.tenantFeed(source, order)
      : intelFeedKeys.feed(clientId!, source, order),
    queryFn: async ({ pageParam }) => {
      const path = global ? intelFeedPaths.tenantFeed() : intelFeedPaths.feed(clientId!);
      return (
        await api.get<FeedResponse>(
          `${path}?${feedQueryString(source, order, pageParam || undefined)}`,
        )
      ).data;
    },
    initialPageParam: '',
    getNextPageParam: (last: FeedResponse) =>
      last.hasMore && last.nextCursor ? last.nextCursor : undefined,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = query.data?.pages[0]?.counts ?? {};
  const sevCounts = query.data?.pages[0]?.severityCounts ?? {};
  const totalUpdates = Object.values(counts).reduce((n, v) => n + (v ?? 0), 0);

  const onAction = (a: RecommendedAction, item: FeedItem) => {
    switch (a.kind) {
      case 'draft_memo':
        setComposerItem(item);
        break;
      case 'district_brief':
        setBriefItem(item);
        break;
      case 'open_bill':
        if (a.target?.billId) {
          // Bill 360 (R2 §2.5): a feed action opens the dossier drawer in place when
          // the host provides one, and otherwise the canonical /bills/:id page. The
          // old fallback routed to the Explorer drill-in, which §2.5 removed as a
          // bill entry point.
          if (onOpenBill) onOpenBill(a.target.billId, item.clientId);
          else navigate(billTarget(a.target.billId));
        }
        break;
      case 'open_hearing':
        if (a.target?.sessionId)
          navigate(`/intelligence/hearing-watch/${encodeURIComponent(a.target.sessionId)}`);
        break;
      case 'open_program_element':
        // R4 §4.3: the PE alert deep-links to Program Element 360.
        if (a.target?.peCode)
          navigate(`/program-elements/${encodeURIComponent(a.target.peCode)}`);
        break;
      case 'pull_quotes': {
        const qs = (item.evidence?.hearing?.mentions ?? [])
          .map((m) => `${m.speakerName ? `${m.speakerName}: ` : ''}${m.quote ?? ''}`.trim())
          .filter(Boolean);
        if (qs.length) {
          void navigator.clipboard?.writeText(qs.join('\n'));
          message.success(`Copied ${qs.length} quote${qs.length === 1 ? '' : 's'}`);
        } else {
          message.info('No decrypted quotes available — open the hearing to view.');
        }
        break;
      }
      case 'draft_outreach':
        if (!draftOutreach.isPending) draftOutreach.mutate(item);
        break;
      case 'add_talking_point':
        setTpItem(item);
        setTpText(
          `${item.title}${item.whyItMatters ? ` — ${item.whyItMatters}` : ''}`.slice(0, 300),
        );
        break;
      case 'add_to_report': {
        const on = !item.actions?.inReport;
        setReport.mutate(
          { clientId: item.clientId, alertId: item.id, on },
          {
            onSuccess: () =>
              message.success(on ? 'Added to weekly report' : 'Removed from weekly report'),
          },
        );
        break;
      }
    }
  };

  // Right-rail "Show" options — source facet with tenant/client-scoped counts.
  const srcOpts: Array<{ v: FeedFilter; label: string; n?: number }> = [
    { v: 'all', label: 'All sources' },
    { v: 'bill', label: 'Bill moves', n: counts.bill ?? 0 },
    { v: 'state_bill', label: 'State bills', n: counts.state_bill ?? 0 },
    { v: 'hearing', label: 'Hearings', n: counts.hearing ?? 0 },
    { v: 'combined', label: 'Bill + Hearing', n: counts.combined ?? 0 },
    { v: 'regulation', label: 'Regulations', n: counts.regulation ?? 0 },
    // R4 §4.3: PE funding movements share the client feed with bills and hearings.
    { v: 'program_element', label: 'Program elements', n: counts.program_element ?? 0 },
  ];

  const body = (() => {
    if (query.isLoading) {
      return (
        <div className="feed">
          {[86, 64, 72].map((h, i) => (
            <div key={i} className="skel" style={{ height: h }} />
          ))}
        </div>
      );
    }
    if (query.isError) {
      return (
        <div className="guide plain">
          <h4>Feed unavailable</h4>
          <p>We couldn’t load the alert feed. Try again in a moment.</p>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="guide">
          <div className="gico">
            <Ic n="check" size={20} />
          </div>
          <h4>Nothing new right now</h4>
          <p>
            {global
              ? 'When a tracked bill moves or a hearing hits any client’s watchlist, it lands here — newest first.'
              : `When a tracked bill moves or a hearing mentions ${clientName ?? 'this client'}’s watchlist, it lands here.`}
          </p>
        </div>
      );
    }
    if (global && group) {
      return (
        <div className="feed">
          {groupByClient(items).map((g) => (
            <div key={g.clientId}>
              <div className="group-label">
                <button
                  className="chip client"
                  onClick={() => onScopeClient?.(g.clientId)}
                  title="View only this client"
                >
                  <span className="cdot">{initials(g.clientName)}</span>
                  {g.clientName}
                </button>
                <span className="muted mini">
                  {g.list.length} update{g.list.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="feed" style={{ marginTop: 6 }}>
                {g.list.map((it) => (
                  <FeedCard
                    key={it.id}
                    item={it}
                    onAction={onAction}
                    showClient={false}
                    onScopeClient={onScopeClient}
                  />
                ))}
              </div>
            </div>
          ))}
          {query.hasNextPage && (
            <button
              className="btn"
              style={{ margin: '4px auto 0' }}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="feed">
        {items.map((it) => (
          <FeedCard
            key={it.id}
            item={it}
            onAction={onAction}
            showClient={global}
            onScopeClient={onScopeClient}
          />
        ))}
        {query.hasNextPage && (
          <button
            className="btn"
            style={{ margin: '4px auto 0' }}
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    );
  })();

  return (
    <div className="feed-layout">
      <div className="feed-main">
        <div className="feed-lead">
          {global
            ? 'What changed across all clients'
            : `What changed for ${clientName ?? 'this client'}`}{' '}
          · {totalUpdates} update{totalUpdates === 1 ? '' : 's'}
        </div>
        {body}
      </div>

      <aside className="feed-rail">
        <div className="rail-card">
          <div className="rc-t">Show</div>
          {srcOpts.map((o) => (
            <button
              key={o.v}
              className={'rail-opt' + (source === o.v ? ' on' : '')}
              onClick={() => setSource(o.v)}
            >
              {o.label}
              {o.n != null && <span className="n">{o.n}</span>}
            </button>
          ))}
        </div>

        {global && (
          <div className="rail-card">
            <div className="rc-t">Arrange</div>
            <button className={'rail-opt' + (!group ? ' on' : '')} onClick={() => setGroup(false)}>
              Single stream
            </button>
            <button className={'rail-opt' + (group ? ' on' : '')} onClick={() => setGroup(true)}>
              Grouped by client
            </button>
          </div>
        )}

        <div className="rail-card">
          <div className="rc-t">At a glance</div>
          <div className="rail-stat">
            <span className="dot critical" />
            Critical
            <span className="n">{sevCounts.critical ?? 0}</span>
          </div>
          <div className="rail-stat">
            <span className="dot notable" />
            Notable
            <span className="n">{sevCounts.notable ?? 0}</span>
          </div>
          <div className="rail-stat">
            <span className="dot info" />
            Info
            <span className="n">{sevCounts.info ?? 0}</span>
          </div>
        </div>
      </aside>

      {/* Client-scoped drawers derive their client from the alert itself so they
          work in both per-client and global (P11) mode. */}
      <MemoComposerDrawer
        open={!!composerItem}
        onClose={() => setComposerItem(null)}
        clientId={composerItem?.clientId ?? clientId ?? ''}
        clientName={composerItem?.clientName ?? clientName ?? ''}
        item={composerItem}
      />

      <DistrictBriefComposerDrawer
        open={!!briefItem}
        onClose={() => setBriefItem(null)}
        clientId={briefItem?.clientId ?? clientId ?? ''}
        item={briefItem}
      />

      <Modal
        title="Add talking point"
        open={!!tpItem}
        onCancel={() => setTpItem(null)}
        okText="Save"
        confirmLoading={addTalkingPoint.isPending}
        onOk={() => {
          if (!tpItem || !tpText.trim()) return;
          addTalkingPoint.mutate(
            { clientId: tpItem.clientId, alertId: tpItem.id, text: tpText.trim() },
            {
              onSuccess: () => {
                message.success('Talking point saved');
                setTpItem(null);
              },
              onError: (e: unknown) => message.error((e as Error).message),
            },
          );
        }}
      >
        <Input.TextArea
          value={tpText}
          onChange={(e) => setTpText(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 6 }}
          placeholder="A concise, client-ready talking point"
        />
      </Modal>
    </div>
  );
}

export default TrackerFeedPanel;
