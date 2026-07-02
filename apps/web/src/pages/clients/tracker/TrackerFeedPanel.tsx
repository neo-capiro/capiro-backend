import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
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
const SEV_LABEL: Record<FeedSeverity, string> = { critical: 'Critical', notable: 'Notable', info: 'Info' };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function SourceBadge({ t }: { t: FeedItem['sourceType'] }) {
  const bg = t === 'combined' ? 'var(--accent, #6b4fbb)' : t === 'hearing' ? 'var(--info, #4a7bd6)' : 'var(--notable, #d98324)';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: '#fff',
        background: bg,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {SOURCE_LABEL[t]}
    </span>
  );
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

function FeedCard({ item, onAction }: { item: FeedItem; onAction: (a: RecommendedAction, item: FeedItem) => void }) {
  const ev = item.evidence ?? {};
  const mentions = ev.hearing?.mentions ?? [];
  const actions = item.recommendedActions ?? [];
  return (
    <div
      style={{
        border: '1px solid var(--border, #e4e4ea)',
        borderLeft: `3px solid ${SEV_COLOR[item.severity]}`,
        borderRadius: 8,
        padding: '12px 14px',
        background: 'var(--surface, #fff)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <SourceBadge t={item.sourceType} />
        <span style={{ fontSize: 11, fontWeight: 600, color: SEV_COLOR[item.severity] }}>{SEV_LABEL[item.severity]}</span>
        {item.actions?.memo && <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--good, #2f7a57)' }}>memo drafted ✓</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--muted, #8a8a96)' }} title="Priority score (0–1)">
          score {item.score.toFixed(2)}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted, #8a8a96)' }}>{fmtDate(item.createdAt)}</span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{item.title}</div>
      {item.whyItMatters && (
        <div style={{ fontSize: 12.5, color: 'var(--text-2, #55555f)', lineHeight: 1.4 }}>{item.whyItMatters}</div>
      )}

      {ev.bill && (
        <button
          onClick={() => onAction({ kind: 'open_bill', label: 'Open bill', target: { billId: ev.bill!.billId } }, item)}
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
          title="Open in Explorer"
        >
          <b>{ev.bill.displayNum}</b> · {ev.bill.stage}
          {ev.bill.actionText ? ` — ${ev.bill.actionText}` : ''}
          {ev.bill.actionDate ? ` (${ev.bill.actionDate})` : ''}
        </button>
      )}

      {ev.hearing && (
        <div style={{ fontSize: 12, color: 'var(--text-2, #55555f)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {ev.hearing.title ?? 'Hearing'}
            {mentions.length ? ` · ${mentions.length} mention${mentions.length === 1 ? '' : 's'}` : ''}
          </div>
          {mentions.slice(0, 3).map((m, i) => (
            <div key={m.segmentId ?? i} style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
              <span style={{ color: 'var(--muted, #8a8a96)', minWidth: 38 }}>{fmtTs(m.timestampMs)}</span>
              <span>
                {m.speakerName ? <b>{m.speakerName}: </b> : null}
                {m.quote ? `“${m.quote}”` : <i style={{ color: 'var(--muted, #8a8a96)' }}>[encrypted — open hearing to view]</i>}
              </span>
            </div>
          ))}
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
  );
}

export function TrackerFeedPanel({ clientId, clientName }: { clientId: string; clientName: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [source, setSource] = useState<FeedFilter>('all');
  const [order, setOrder] = useState<FeedOrder>('date');
  const [composerItem, setComposerItem] = useState<FeedItem | null>(null);
  const [tpItem, setTpItem] = useState<FeedItem | null>(null);
  const [tpText, setTpText] = useState('');

  const setReport = useSetReport();
  const addTalkingPoint = useAddTalkingPoint();

  const query = useInfiniteQuery({
    queryKey: intelFeedKeys.feed(clientId, source, order),
    queryFn: async ({ pageParam }) =>
      (await api.get<FeedResponse>(`${intelFeedPaths.feed(clientId)}?${feedQueryString(source, order, pageParam || undefined)}`))
        .data,
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
        if (a.target?.billId) navigate(`/explorer?bill=${encodeURIComponent(a.target.billId)}`);
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
      case 'draft_outreach': {
        const opener = `Re: ${item.title}${item.whyItMatters ? ` — ${item.whyItMatters}` : ''}`;
        void navigator.clipboard?.writeText(opener);
        message.success('Outreach opener copied — opening Outreach');
        navigate('/engagement/outreach');
        break;
      }
      case 'add_talking_point':
        setTpItem(item);
        setTpText(`${item.title}${item.whyItMatters ? ` — ${item.whyItMatters}` : ''}`.slice(0, 300));
        break;
      case 'add_to_report': {
        const on = !item.actions?.inReport;
        setReport.mutate(
          { clientId, alertId: item.id, on },
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
      </div>

      {query.isLoading ? (
        <div className="trk-col-empty">Loading feed…</div>
      ) : query.isError ? (
        <div className="trk-col-empty">Feed unavailable.</div>
      ) : items.length === 0 ? (
        <div className="trk-empty">
          <h4>No intelligence yet</h4>
          <p>Bill changes, hearing mentions, and combined alerts for this client will appear here.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it) => (
            <FeedCard key={it.id} item={it} onAction={onAction} />
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

      <MemoComposerDrawer
        open={!!composerItem}
        onClose={() => setComposerItem(null)}
        clientId={clientId}
        clientName={clientName}
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
            { clientId, alertId: tpItem.id, text: tpText.trim() },
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
