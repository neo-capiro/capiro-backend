import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
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
} from './intel-feed-api.js';

/**
 * Unified intel FEED panel (Phase 6 §9.7) — bill | hearing | combined alerts in
 * one keyset-paginated stream, with per-source count badges. Rendered inside the
 * Tracker tab only when `tracker_v2` is enabled (self-contained; additive — the
 * legacy Board/Recs/Configure are untouched). Read-only surface.
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

function FeedCard({ item, onOpenBill }: { item: FeedItem; onOpenBill: (billId: string) => void }) {
  const ev = item.evidence ?? {};
  const mentions = ev.hearing?.mentions ?? [];
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
          onClick={() => onOpenBill(ev.bill!.billId)}
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

      {item.recommendedAction && (
        <div style={{ fontSize: 12, color: 'var(--accent, #6b4fbb)', fontStyle: 'italic' }}>→ {item.recommendedAction}</div>
      )}
    </div>
  );
}

export function TrackerFeedPanel({ clientId }: { clientId: string; clientName: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const [source, setSource] = useState<FeedFilter>('all');
  const [order, setOrder] = useState<FeedOrder>('date');

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
  const openBill = (billId: string) => navigate(`/explorer?bill=${encodeURIComponent(billId)}`);

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
            <FeedCard key={it.id} item={it} onOpenBill={openBill} />
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
    </div>
  );
}

export default TrackerFeedPanel;
