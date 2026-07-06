import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Input, Modal } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  feedQueryString,
  intelFeedKeys,
  intelFeedPaths,
  SOURCE_LABEL,
  type FeedFilter,
  type FeedItem,
  type FeedOrder,
  type FeedResponse,
  type FeedSeverity,
  type RecommendedAction,
} from './intel-feed-api.js';
import { useAddTalkingPoint, useSetReport } from './alert-actions-api.js';
import { MemoComposerDrawer } from './MemoComposerDrawer.js';

/**
 * Unified intel FEED panel (Phase 6 §9.7) — bill | hearing | combined alerts with
 * per-source counts, plus intelligent per-alert ACTIONS (draft memo / outreach /
 * pull quotes / add to weekly report / open source). The memo is generated in
 * apps/api (Memory-grounded) and auto-filed to the client's Documents; the alert
 * shows "memo drafted" once done. Gated by `tracker_v2`.
 */

const SEV_COLOR: Record<FeedSeverity, string> = {
  critical: 'var(--critical, #d64545)',
  notable: 'var(--notable, #d98324)',
  info: 'var(--info, #4a7bd6)',
};
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

/** Render one recommended action as a compact chip; the primary one is filled. */
function ActionChip({ a, item, onAction }: { a: RecommendedAction; item: FeedItem; onAction: (a: RecommendedAction, item: FeedItem) => void }) {
  const drafted = a.kind === 'draft_memo' && !!item.actions?.memo;
  const inReport = a.kind === 'add_to_report' && !!item.actions?.inReport;
  const label = drafted ? 'Redraft memo' : inReport ? 'In weekly report ✓' : a.label;
  return (
    <button
      className={a.primary ? 'btn btn-accent' : 'btn'}
      style={{ fontSize: 11.5, padding: '3px 9px' }}
      onClick={() => onAction(a, item)}
    >
      {label}
    </button>
  );
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
  const muted = 'var(--muted, #8a8a96)';

  return (
    <div
      style={{
        border: '1px solid var(--border, #e4e4ea)',
        // The ONLY severity cue (spec U2): the colored left edge. No severity word,
        // no filled badge.
        borderLeft: `3px solid ${SEV_COLOR[item.severity]}`,
        borderRadius: 8,
        background: 'var(--surface, #fff)',
        overflow: 'hidden',
      }}
    >
      {/* Collapsed head — the whole row toggles expansion. */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 14px', cursor: 'pointer' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.3,
              ...(open ? {} : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
            }}
          >
            {item.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
            {showClient &&
              (onScopeClient ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onScopeClient(item.clientId);
                  }}
                  title="View only this client"
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: 'var(--accent, #6b4fbb)',
                  }}
                >
                  {item.clientName ?? 'Client'}
                </button>
              ) : (
                <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent, #6b4fbb)' }}>
                  {item.clientName ?? 'Client'}
                </span>
              ))}
            <span style={{ fontSize: 11, color: muted }}>{SOURCE_LABEL[item.sourceType]}</span>
            {item.tag && (
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--text-2, #55555f)',
                  background: 'var(--surface-2, #f6f6f9)',
                  border: '1px solid var(--border, #e4e4ea)',
                  borderRadius: 4,
                  padding: '1px 7px',
                }}
                title="Matched watchlist tag"
              >
                #{item.tag}
              </span>
            )}
            {drafted && (
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--good, #2f7a57)' }}>memo drafted ✓</span>
            )}
            {inReport && (
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--good, #2f7a57)' }}>in weekly report</span>
            )}
            <span style={{ fontSize: 11, color: muted }}>{fmtDate(item.createdAt)}</span>
          </div>
        </div>
        {!open && primary && (
          <span onClick={(e) => e.stopPropagation()}>
            <ActionChip a={{ ...primary, primary: true }} item={item} onAction={onAction} />
          </span>
        )}
        <span style={{ fontSize: 12, color: muted, lineHeight: '22px' }}>{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px 14px 12px',
            borderTop: '1px solid var(--border, #e4e4ea)',
          }}
        >
          {ev.bill && (
            <button
              onClick={() =>
                onAction({ kind: 'open_bill', label: 'Open bill', target: { billId: ev.bill!.billId } }, item)
              }
              style={{
                textAlign: 'left',
                fontSize: 12,
                color: 'var(--text-2, #55555f)',
                background: 'var(--surface-2, #f6f6f9)',
                border: '1px solid var(--border, #e4e4ea)',
                borderRadius: 6,
                padding: '6px 8px',
                cursor: 'pointer',
              }}
              title="Open bill"
            >
              <b>{ev.bill.displayNum}</b> · {ev.bill.stage}
              {ev.bill.actionText ? ` — ${ev.bill.actionText}` : ''}
              {ev.bill.actionDate ? ` (${ev.bill.actionDate})` : ''}
            </button>
          )}

          {mentions.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-2, #55555f)' }}>
              {(showAllQuotes ? mentions : mentions.slice(0, 1)).map((m, i) => (
                <div key={m.segmentId ?? i} style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
                  <span style={{ color: muted, minWidth: 38 }}>{fmtTs(m.timestampMs)}</span>
                  <span>
                    {m.speakerName ? <b>{m.speakerName}: </b> : null}
                    {m.quote ? `“${m.quote}”` : <i style={{ color: muted }}>[encrypted — open hearing to view]</i>}
                  </span>
                </div>
              ))}
              {mentions.length > 1 && !showAllQuotes && (
                <button
                  className="btn"
                  style={{ fontSize: 11.5, padding: '2px 8px', marginTop: 4 }}
                  onClick={() => setShowAllQuotes(true)}
                >
                  +{mentions.length - 1} more quote{mentions.length - 1 === 1 ? '' : 's'}
                </button>
              )}
            </div>
          )}

          {actions.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
              {actions.map((a) => (
                <ActionChip key={a.kind} a={a} item={item} onAction={onAction} />
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
  const { message } = AntApp.useApp();
  const [source, setSource] = useState<FeedFilter>('all');
  const [order, setOrder] = useState<FeedOrder>('date');
  // LegiWatch v2 (L1): global feed arrangement — single stream (default) or grouped
  // by client. Never the default; only offered at the all-clients altitude.
  const [group, setGroup] = useState(false);
  const [composerItem, setComposerItem] = useState<FeedItem | null>(null);
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
      const bill = item.evidence?.bill;
      const actionText = bill
        ? `${bill.displayNum}${bill.actionText ? ` — ${bill.actionText}` : ''}`
        : null;
      const body = [item.whyItMatters, actionText].filter(Boolean).join(' · ');
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
        // Lossy projection the API stores at the top level so Meri generation
        // sees the alert as a context source (mirrors the wizard's contextPool).
        // Slice to the DTO bounds (title @Length(1,240), summary @Length(0,2000)):
        // intel_alert.title is unbounded and federal bill/hearing titles routinely
        // exceed 240, which would 400 the whole POST (review finding).
        contextPool: [
          {
            id: ctxId,
            sourceType: 'intel',
            title: item.title.slice(0, 240),
            summary: body.slice(0, 2000),
            note: '',
            scope: 'all',
          },
        ],
      });
      return res.data;
    },
    onSuccess: (record) => {
      message.success('Outreach draft created — opening the wizard');
      navigate(`/engagement/outreach/draft/${encodeURIComponent(record.id)}`);
    },
    onError: (e: unknown) => message.error(`Could not create outreach draft: ${(e as Error).message}`),
  });

  // P11: global mode reads the tenant-wide roll-up (`_all/feed`) under a distinct
  // cache key; per-client mode is unchanged. The path/key switch is the ONLY
  // difference — filters, keyset cursor, and page shape are identical.
  const query = useInfiniteQuery({
    queryKey: global ? intelFeedKeys.tenantFeed(source, order) : intelFeedKeys.feed(clientId!, source, order),
    queryFn: async ({ pageParam }) => {
      const path = global ? intelFeedPaths.tenantFeed() : intelFeedPaths.feed(clientId!);
      return (await api.get<FeedResponse>(`${path}?${feedQueryString(source, order, pageParam || undefined)}`)).data;
    },
    initialPageParam: '',
    getNextPageParam: (last: FeedResponse) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = query.data?.pages[0]?.counts ?? {};

  const onAction = (a: RecommendedAction, item: FeedItem) => {
    switch (a.kind) {
      case 'draft_memo':
        setComposerItem(item);
        break;
      case 'open_bill':
        if (a.target?.billId) {
          if (onOpenBill) onOpenBill(a.target.billId, item.clientId);
          else navigate(`/explorer?bill=${encodeURIComponent(a.target.billId)}`);
        }
        break;
      case 'open_hearing':
        if (a.target?.sessionId) navigate(`/intelligence/hearing-watch/${encodeURIComponent(a.target.sessionId)}`);
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
        setTpText(`${item.title}${item.whyItMatters ? ` — ${item.whyItMatters}` : ''}`.slice(0, 300));
        break;
      case 'add_to_report': {
        const on = !item.actions?.inReport;
        setReport.mutate(
          { clientId: item.clientId, alertId: item.id, on },
          { onSuccess: () => message.success(on ? 'Added to weekly report' : 'Removed from weekly report') },
        );
        break;
      }
    }
  };

  const chips: Array<{ v: FeedFilter; l: string; n?: number }> = [
    { v: 'all', l: 'All' },
    { v: 'bill', l: 'Bills', n: counts.bill },
    { v: 'hearing', l: 'Hearings', n: counts.hearing },
    { v: 'combined', l: 'Bill + Hearing', n: counts.combined },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {chips.map((c) => (
            <button
              key={c.v}
              className={source === c.v ? 'btn btn-accent' : 'btn'}
              onClick={() => setSource(c.v)}
              style={{ fontSize: 12 }}
            >
              {c.l}
              {c.n ? <span className="seg-badge" style={{ marginLeft: 6 }}>{c.n}</span> : null}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setOrder(order === 'date' ? 'score' : 'date')} style={{ fontSize: 12 }}>
          Sort: {order === 'date' ? 'Most recent' : 'Priority'}
        </button>
        {global && (
          <button
            className="btn"
            onClick={() => setGroup((g) => !g)}
            style={{ fontSize: 12 }}
            title="Arrange the all-clients stream"
          >
            {group ? 'Grouped by client' : 'Single stream'}
          </button>
        )}
      </div>

      {query.isLoading ? (
        <div className="trk-col-empty">Loading feed…</div>
      ) : query.isError ? (
        <div className="trk-col-empty">Feed unavailable.</div>
      ) : items.length === 0 ? (
        <div className="trk-empty">
          <h4>No intelligence yet</h4>
          <p>
            {global
              ? 'Bill changes, hearing mentions, and combined alerts across all your clients will appear here.'
              : 'Bill changes, hearing mentions, and combined alerts for this client will appear here.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {global && group
            ? groupByClient(items).map((g) => (
                <div key={g.clientId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                    <button
                      onClick={() => onScopeClient?.(g.clientId)}
                      style={{
                        border: 'none',
                        background: 'none',
                        padding: 0,
                        cursor: onScopeClient ? 'pointer' : 'default',
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: 'var(--accent, #6b4fbb)',
                      }}
                    >
                      {g.clientName}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--muted, #8a8a96)' }}>
                      {g.list.length} update{g.list.length === 1 ? '' : 's'}
                    </span>
                  </div>
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
              ))
            : items.map((it) => (
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
              className="trk-more"
              style={{ maxWidth: 240, margin: '2px auto 0' }}
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}

      {/* Client-scoped drawers derive their client from the alert itself so they
          work in both per-client and global (P11) mode. In the per-client feed the
          alert's clientId equals the panel's clientId; in global mode it's the
          alert's own client, with the roll-up-resolved name. */}
      <MemoComposerDrawer
        open={!!composerItem}
        onClose={() => setComposerItem(null)}
        clientId={composerItem?.clientId ?? clientId ?? ''}
        clientName={composerItem?.clientName ?? clientName ?? ''}
        item={composerItem}
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
