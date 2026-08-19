/**
 * Shared presentation glue for the PE fallback module (old-UI purge Phase 3).
 *
 * Re-skin only: every component here replaces an antd primitive used by the
 * canonical finder/watch surfaces (Card, Tag, Empty, Alert, Skeleton, the
 * pe-shared chips) with vNext primitives + token-layer CSS. Copy, testids and
 * empty/error semantics are IDENTICAL to canonical — data honesty is owned by
 * the shared model modules under `pages/program-element/`.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroEmptyState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { serviceColor, signalMeta } from '../../../../pages/program-element/charts/index.js';
import {
  ACTION_SIGNAL_META,
  LINE_TYPES,
  TIER_COLOR,
  serviceLabel,
} from '../../../../pages/program-element/pe-shared-model.js';
import type { ProgramElementListItem } from '../../../../pages/program-element/types.js';

// The vNext binding of the shared optimistic watch toggle is the module-level
// one PE-CORE shipped (same mutation, Capiro toast transport).
export { useWatchToggle as useWatchToggleVNext } from '../pe-watch-toggle.js';

/* ── antd Tag replacement ──────────────────────────────────────────────────── */

/** antd Tag `color` → the fallback tag tone class. Presentation-only mapping. */
export function tagTone(color?: string | null): string {
  switch (color) {
    case 'green':
    case 'success':
      return 'success';
    case 'gold':
    case 'orange':
    case 'warning':
      return 'warning';
    case 'red':
    case 'volcano':
    case 'error':
    case 'danger':
      return 'danger';
    case 'blue':
    case 'geekblue':
    case 'cyan':
    case 'purple':
    case 'processing':
      return 'info';
    default:
      return 'neutral';
  }
}

export function PeFbTag({
  color,
  title,
  children,
  ...rest
}: {
  color?: string | null;
  title?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'color' | 'title' | 'children'>) {
  return (
    <span className={`pe-fb-tag tone-${tagTone(color)}`} title={title} {...rest}>
      {children}
    </span>
  );
}

/* ── antd Card replacement ─────────────────────────────────────────────────── */

export function PeFbPanel({
  title,
  extra,
  className,
  children,
  testId,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className={`pe-fb-panel${className ? ` ${className}` : ''}`} data-testid={testId}>
      {title != null || extra != null ? (
        <div className="pe-fb-panel-head">
          {title != null ? <h3>{title}</h3> : null}
          {extra != null ? <div className="pe-fb-panel-extra">{extra}</div> : null}
        </div>
      ) : null}
      <div className="pe-fb-panel-body">{children}</div>
    </section>
  );
}

/* ── antd Skeleton / Empty / Alert replacements ────────────────────────────── */

export function PeFbSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="pe-fb-skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_item, index) => (
        <CapiroSkeleton key={index} height={14} width={`${100 - (index % 3) * 14}%`} />
      ))}
    </div>
  );
}

/** antd `<Empty description=… />` equivalent — identical copy, vNext primitive. */
export function PeFbEmpty({ description }: { description: string }) {
  return <CapiroEmptyState title={description} />;
}

/**
 * antd error `<Alert message action=Retry />` equivalent. Hand-built on the
 * `capiro-feedback` frame (rather than CapiroErrorState) so the retry button
 * can carry the canonical stable testid.
 */
export function PeFbErrorState({
  message,
  description,
  onRetry,
  retryLabel = 'Retry',
  testId,
  retryTestId,
}: {
  message: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  testId?: string;
  retryTestId?: string;
}) {
  return (
    <div data-testid={testId}>
      <section className="capiro-feedback" role="alert">
        <strong>{message}</strong>
        {description ? <span>{description}</span> : null}
        {onRetry ? (
          <CapiroButton size="compact" onClick={onRetry} data-testid={retryTestId}>
            {retryLabel}
          </CapiroButton>
        ) : null}
      </section>
    </div>
  );
}

/** Informational / warning strip (antd `<Alert type="info|warning" />`). */
export function PeFbNotice({
  tone,
  message,
  description,
  action,
  style,
  testId,
}: {
  tone: 'info' | 'warning';
  message: string;
  description?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div className={`pe-fb-notice tone-${tone}`} role="status" style={style} data-testid={testId}>
      <div className="pe-fb-notice-body">
        <strong>{message}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {action ? <div className="pe-fb-notice-action">{action}</div> : null}
    </div>
  );
}

/**
 * Phase 5 — failed secondary sections must never render as a success Empty.
 * Port of `PeSecondaryFailed` (identical copy + testids).
 */
export function PeFbSecondaryFailed({
  label,
  onRetry,
  testId = 'pe-secondary-failed',
}: {
  label: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <PeFbErrorState
      testId={testId}
      message={`Failed to load ${label}`}
      description="This is not an empty result — the request failed. Retry before treating this section as empty."
      onRetry={onRetry}
      retryTestId="pe-secondary-retry"
    />
  );
}

/**
 * antd `Typography.Paragraph ellipsis={{ expandable }}` replacement: clamps to
 * `rows` lines and reveals in place on demand. Same copy ("Read more" default).
 */
export function PeFbExpandableText({
  text,
  rows = 3,
  symbol = 'Read more',
  className,
}: {
  text: string;
  rows?: number;
  symbol?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`pe-fb-expandable${className ? ` ${className}` : ''}`}>
      <p
        className={expanded ? '' : 'pe-fb-clamped'}
        style={expanded ? undefined : ({ WebkitLineClamp: rows } as CSSProperties)}
      >
        {text}
      </p>
      {!expanded ? (
        <button type="button" className="pe-fb-expand-btn" onClick={() => setExpanded(true)}>
          {symbol}
        </button>
      ) : null}
    </div>
  );
}

/* ── pe-shared chip ports (identical semantics; token-layer styling) ───────── */

export function PeCodeBadgeVNext({ code, size }: { code: string; size?: 'sm' }) {
  return <span className={`pe-fb-code-badge${size === 'sm' ? ' sm' : ''}`}>{code}</span>;
}

export function ServiceCellVNext({ service }: { service: string | null }) {
  return (
    <span className="pe-fb-svc">
      <span className="pe-fb-dot" style={{ background: serviceColor(service) }} />
      {serviceLabel(service)}
    </span>
  );
}

export function SignalPillVNext({ item }: { item: ProgramElementListItem }) {
  const meta = signalMeta(item);
  if (!meta) return <span className="pe-fb-dash">—</span>;
  return <span className={`pe-fb-sig-pill tone-${meta.tone}`}>{meta.label}</span>;
}

export function ActionSignalChipVNext({
  type,
  tone,
}: {
  type: string | null | undefined;
  tone?: string | null;
}) {
  if (!type) return null;
  const meta = ACTION_SIGNAL_META[type] ?? { label: type, tone: tone ?? 'info' };
  return <span className={`pe-fb-sig-pill tone-${tone ?? meta.tone}`}>{meta.label}</span>;
}

export function LineTypeBadgeVNext({
  lineType,
  small,
}: {
  lineType: string | null | undefined;
  small?: boolean;
}) {
  const t = lineType ? LINE_TYPES[lineType] : undefined;
  if (!t) return <span className="pe-fb-dash">—</span>;
  return (
    <span
      className={`pe-fb-linetype-badge${small ? ' sm' : ''}`}
      style={{ color: t.color, background: `${t.color}18` }}
      title={t.label}
    >
      {t.short}
    </span>
  );
}

/** Compact 0-5 transition-maturity pips (F19). Null = not applicable. */
export function MaturityMiniVNext({ value }: { value: number | null | undefined }) {
  if (value == null) {
    return (
      <span className="pe-fb-dash" title="Not applicable">
        —
      </span>
    );
  }
  const color =
    value >= 4
      ? 'var(--capiro-color-success)'
      : value >= 2
        ? 'var(--capiro-color-warning)'
        : 'var(--capiro-color-action-accent-default)';
  return (
    <span className="pe-fb-mat-mini" title={`Transition maturity ${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="pe-fb-mm-pip"
          style={{ background: i <= value ? color : 'var(--capiro-color-border-default)' }}
        />
      ))}
      <span className="pe-fb-mm-n" style={{ color }}>
        {value}
      </span>
    </span>
  );
}

/** Appropriability tier badge (F27). `label` overrides the tier text (e.g. score). */
export function TierBadgeVNext({
  tier,
  label,
}: {
  tier: string | null | undefined;
  label?: string;
}) {
  if (!tier) return <span className="pe-fb-dash">—</span>;
  const color = TIER_COLOR[tier] ?? 'var(--capiro-color-text-muted)';
  const text = label ?? (tier === 'high' ? 'High' : tier === 'med' ? 'Medium' : 'Low');
  return (
    <span
      className="pe-fb-tier-badge"
      style={{ color, background: `${color}18` }}
      title={`Appropriability: ${tier}`}
    >
      {text}
    </span>
  );
}

/** Retry button used inside error strips that canonical renders as antd Button. */
export function PeFbRetryButton({ onClick, testId }: { onClick: () => void; testId?: string }) {
  return (
    <CapiroButton size="compact" onClick={onClick} data-testid={testId}>
      Retry
    </CapiroButton>
  );
}
