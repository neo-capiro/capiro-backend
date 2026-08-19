import { message } from 'antd';
import { StarFilled, StarOutlined } from '@ant-design/icons';
import type { ProgramElementListItem } from './types.js';
import { serviceColor, signalMeta } from './charts/index.js';
import {
  ACTION_SIGNAL_META,
  LINE_TYPES,
  TIER_COLOR,
  baShort,
  serviceLabel,
  useWatchToggleCore,
} from './pe-shared-model.js';

// UI-free logic + data registries extracted to pe-shared-model.ts so the vNext
// module can consume them without reaching antd; re-exported here so this
// file's public API is unchanged.
export { serviceLabel, baShort, LINE_TYPES };

export function PeCodeBadge({ code, size }: { code: string; size?: 'sm' }) {
  return <span className={`pe-code-badge${size === 'sm' ? ' sm' : ''}`}>{code}</span>;
}

export function ServiceCell({ service }: { service: string | null }) {
  return (
    <span className="pe-svc">
      <span className="pe-svc-dot" style={{ background: serviceColor(service) }} />
      {serviceLabel(service)}
    </span>
  );
}

export function BaBadge({ budgetActivity }: { budgetActivity: string | null }) {
  const short = baShort(budgetActivity);
  if (!short) return <span className="pe-dash">—</span>;
  return <span className="pe-ba-badge">{short}</span>;
}

export function SignalPill({ item }: { item: ProgramElementListItem }) {
  const meta = signalMeta(item);
  if (!meta) return <span className="pe-dash">—</span>;
  return <span className={`pe-sig-pill tone-${meta.tone}`}>{meta.label}</span>;
}

// ── BL-1: money-graph registries + badges ─────────────────────────────────────

export function LineTypeBadge({ lineType, small }: { lineType: string | null | undefined; small?: boolean }) {
  const t = lineType ? LINE_TYPES[lineType] : undefined;
  if (!t) return <span className="pe-dash">—</span>;
  return (
    <span
      className={`pe-linetype-badge${small ? ' sm' : ''}`}
      style={{ color: t.color, background: `${t.color}18` }}
      title={t.label}
    >
      {t.short}
    </span>
  );
}

/** Compact 0-5 transition-maturity pips (F19). Null = not applicable. */
export function MaturityMini({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="pe-dash" title="Not applicable">—</span>;
  const color = value >= 4 ? 'var(--success)' : value >= 2 ? 'var(--notable)' : 'var(--accent)';
  return (
    <span className="pe-mat-mini" title={`Transition maturity ${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="pe-mm-pip"
          style={{ background: i <= value ? color : 'var(--border-1)' }}
        />
      ))}
      <span className="pe-mm-n" style={{ color }}>
        {value}
      </span>
    </span>
  );
}

/** Appropriability tier badge (F27). `label` overrides the tier text (e.g. score). */
export function TierBadge({ tier, label }: { tier: string | null | undefined; label?: string }) {
  if (!tier) return <span className="pe-dash">—</span>;
  const color = TIER_COLOR[tier] ?? 'var(--ink-3)';
  const text = label ?? (tier === 'high' ? 'High' : tier === 'med' ? 'Medium' : 'Low');
  return (
    <span className="pe-tier-badge" style={{ color, background: `${color}18` }} title={`Appropriability: ${tier}`}>
      {text}
    </span>
  );
}

export function ActionSignalChip({
  type,
  tone,
}: {
  type: string | null | undefined;
  tone?: string | null;
}) {
  if (!type) return null;
  const meta = ACTION_SIGNAL_META[type] ?? { label: type, tone: tone ?? 'info' };
  return <span className={`pe-sig-pill tone-${tone ?? meta.tone}`}>{meta.label}</span>;
}

export function WatchStar({
  watched,
  onToggle,
  busy,
}: {
  watched: boolean;
  onToggle: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`pe-watch-star${watched ? ' on' : ''}`}
      title={watched ? 'Watching — click to stop' : 'Add to watchlist'}
      aria-pressed={watched}
      aria-label={watched ? 'Stop watching' : 'Add to watchlist'}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {watched ? <StarFilled /> : <StarOutlined />}
    </button>
  );
}

/**
 * Optimistic watch toggle shared by the finder table, the watchlist cards, and the
 * detail hero. Flips the `watched` flag across any cached finder lists and the PE
 * detail immediately, rolls back on error, and invalidates the finder/summary/detail
 * queries on settle so counts + the watchlist membership reconcile with the server.
 *
 * Logic lives in pe-shared-model.ts (UI-free); this wrapper binds the antd
 * message toast for the canonical surface.
 */
export function useWatchToggle() {
  return useWatchToggleCore((text) => {
    message.error(text);
  });
}
