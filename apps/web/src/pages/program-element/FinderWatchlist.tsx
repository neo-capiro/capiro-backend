import { Empty, Skeleton } from 'antd';
import {
  BellOutlined,
  ClockCircleOutlined,
  FallOutlined,
  FileAddOutlined,
  RiseOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Sparkline, fmtMoneyM, signalMeta } from './charts/index.js';
import { BaBadge, PeCodeBadge, WatchStar, serviceLabel } from './pe-shared.js';
import { serviceColor } from './charts/index.js';
import type { ProgramElementListItem } from './types.js';
import type { IntelligenceChange } from '../intelligence/types.js';

interface Props {
  watchedRows: ProgramElementListItem[];
  watchingCount: number;
  feed: IntelligenceChange[];
  loading: boolean;
  feedLoading: boolean;
  onOpen: (peCode: string) => void;
  onToggleWatch: (row: ProgramElementListItem) => void;
  watchBusyCode?: string | null;
}

type Tone = 'critical' | 'notable' | 'info';

function tone(severity: string): Tone {
  if (severity === 'critical') return 'critical';
  if (severity === 'notable') return 'notable';
  return 'info';
}

function ChangeIcon({ changeType }: { changeType: string }) {
  switch (changeType) {
    case 'bill_pe_linked':
      return <FileAddOutlined />;
    case 'pe_value_increased':
      return <RiseOutlined />;
    case 'pe_value_decreased':
      return <FallOutlined />;
    case 'pe_mark_added':
    case 'pe_mark_changed':
      return <ThunderboltOutlined />;
    case 'pe_milestone_slip':
      return <ClockCircleOutlined />;
    default:
      return <BellOutlined />;
  }
}

/** "3d ago" / "2w ago" / "just now" from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 3_600_000) return 'just now';
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  const days = Math.round(diff / day);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function WatchCard({
  pe,
  onOpen,
  onToggleWatch,
  busy,
}: {
  pe: ProgramElementListItem;
  onOpen: (peCode: string) => void;
  onToggleWatch: (row: ProgramElementListItem) => void;
  busy?: boolean;
}) {
  const trendUp = pe.spark && pe.spark.length > 1 ? pe.spark[pe.spark.length - 1]! >= pe.spark[0]! : true;
  const signal = signalMeta(pe);
  return (
    <div
      className="pe-watch-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(pe.peCode)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(pe.peCode);
        }
      }}
    >
      <div className="pe-wc-head">
        <div className="pe-wc-id">
          <PeCodeBadge code={pe.peCode} />
          <BaBadge budgetActivity={pe.budgetActivity} />
        </div>
        <WatchStar watched onToggle={() => onToggleWatch(pe)} busy={busy} />
      </div>
      <div className="pe-wc-name" title={pe.title}>
        {pe.title}
      </div>
      <div className="pe-wc-svc">
        <span className="pe-svc-dot" style={{ background: serviceColor(pe.service) }} />
        {serviceLabel(pe.service)}
        {pe.appropriationType ? ` · ${pe.appropriationType}` : ''}
      </div>

      <div className="pe-wc-spark">
        {pe.spark && pe.spark.length > 1 ? (
          <Sparkline
            data={pe.spark}
            width={236}
            height={44}
            strokeWidth={2}
            color={trendUp ? 'var(--accent)' : 'var(--critical)'}
          />
        ) : (
          <span className="pe-dash">No funding history</span>
        )}
      </div>

      <div className="pe-wc-stats">
        <div className="pe-wc-stat">
          <div className="pe-wc-sl">Enacted</div>
          <div className="pe-wc-sv">{fmtMoneyM(pe.latestEnacted ?? null)}</div>
        </div>
        <div className="pe-wc-stat">
          <div className="pe-wc-sl">Δ vs req</div>
          <div className={`pe-wc-sv ${pe.deltaPct == null ? '' : pe.deltaPct >= 0 ? 'pe-up' : 'pe-down'}`}>
            {pe.deltaPct == null ? '—' : `${pe.deltaPct >= 0 ? '+' : ''}${pe.deltaPct.toFixed(1)}%`}
          </div>
        </div>
        <div className="pe-wc-stat">
          <div className="pe-wc-sl">Bills</div>
          <div className="pe-wc-sv">{pe.billCount ?? '—'}</div>
        </div>
      </div>

      {signal ? (
        <div className="pe-wc-alert">
          <span className={`pe-sig-pill tone-${signal.tone}`}>{signal.label}</span>
          <span className="pe-wc-alert-txt">Active budget signal this cycle</span>
        </div>
      ) : null}
    </div>
  );
}

export function FinderWatchlist({
  watchedRows,
  watchingCount,
  feed,
  loading,
  feedLoading,
  onOpen,
  onToggleWatch,
  watchBusyCode,
}: Props) {
  const needsAttention = feed.filter((c) => c.severity === 'critical' || c.severity === 'notable').length;

  return (
    <div className="pe-watchlist">
      <div className="pe-watch-top">
        <div className="pe-watch-kpis">
          <div className="pe-idx-kpi">
            <div className="pe-idx-kpi-l">Watching</div>
            <div className="pe-idx-kpi-v">{watchingCount}</div>
            <div className="pe-idx-kpi-d">program elements</div>
          </div>
          <div className="pe-idx-kpi">
            <div className="pe-idx-kpi-l">New signals</div>
            <div className="pe-idx-kpi-v">{feed.length}</div>
            <div className="pe-idx-kpi-d">unread on your watchlist</div>
          </div>
          <div className="pe-idx-kpi">
            <div className="pe-idx-kpi-l">Needs attention</div>
            <div className="pe-idx-kpi-v warn">{needsAttention}</div>
            <div className="pe-idx-kpi-d">markups &amp; cuts</div>
          </div>
        </div>

        <div className="pe-signal-feed">
          <div className="pe-signal-head">
            <h3>Signal feed</h3>
            <span className="pe-signal-sub">what changed on your watchlist</span>
          </div>
          <div className="pe-signal-list">
            {feedLoading ? (
              <div className="pe-signal-loading">
                <Skeleton active paragraph={{ rows: 3 }} />
              </div>
            ) : feed.length === 0 ? (
              <div className="pe-signal-empty">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No recent changes on your watched PEs"
                />
              </div>
            ) : (
              feed.map((c) => {
                const code = c.relatedPeCodes?.[0];
                return (
                  <div
                    key={c.id}
                    className="pe-signal-row"
                    role={code ? 'button' : undefined}
                    tabIndex={code ? 0 : undefined}
                    onClick={code ? () => onOpen(code) : undefined}
                    onKeyDown={
                      code
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpen(code);
                            }
                          }
                        : undefined
                    }
                  >
                    <span className={`pe-signal-ico tone-${tone(c.severity)}`}>
                      <ChangeIcon changeType={c.changeType} />
                    </span>
                    <div className="pe-signal-main">
                      <div className="pe-signal-title">{c.title}</div>
                      <div className="pe-signal-meta">
                        {code ? <PeCodeBadge code={code} size="sm" /> : null}
                        {c.description ? <span className="pe-signal-desc">{c.description}</span> : null}
                      </div>
                    </div>
                    <div className="pe-signal-when">{relativeTime(c.detectedAt)}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="pe-watchlist-head">
        <h3>Your watchlist</h3>
        <span className="pe-signal-sub">{watchingCount} program elements</span>
      </div>

      {loading && watchedRows.length === 0 ? (
        <div className="pe-watch-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="pe-watch-card">
              <Skeleton active paragraph={{ rows: 3 }} />
            </div>
          ))}
        </div>
      ) : watchedRows.length === 0 ? (
        <Empty
          description="You're not watching any program elements yet. Open a PE from All elements and tap the star to track it."
          style={{ padding: '32px 0' }}
        />
      ) : (
        <div className="pe-watch-grid">
          {watchedRows.map((pe) => (
            <WatchCard
              key={pe.peCode}
              pe={pe}
              onOpen={onOpen}
              onToggleWatch={onToggleWatch}
              busy={watchBusyCode === pe.peCode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
