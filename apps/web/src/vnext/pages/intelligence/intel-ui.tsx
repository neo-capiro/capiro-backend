import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, SVGProps } from 'react';
import { CapiroSkeleton } from '../../components/feedback/index.js';

/**
 * Intelligence deep-link module — module-local compositions over the shared
 * Capiro primitives (Phase 3 old-UI purge).
 *
 * Same contract as funding-opportunities/fov-ui.tsx: these exist to give the
 * ported pages a mechanical translation target for the antd vocabulary the
 * canonical surfaces use (`Tag`, `Alert`, `Card title=`, `Segmented`,
 * `Statistic`), while the real controls stay the shared primitives. Copy is
 * never composed here — every sentence a component renders arrives from the
 * caller unchanged.
 */

/* ── Pills (antd Tag) ────────────────────────────────────────────────────── */

/**
 * The canonical intelligence surfaces' antd colour vocabulary, preserved so
 * the ported pages keep passing the exact colour words the legacy pages used
 * (SEVERITY_COLOR blue/gold/red, "NEW" red, shared-lobbyist orange,
 * relationship green/gold). Mapped onto this module's Untitled UI tone table
 * in intelligence-vnext.css.
 */
const PILL_TONE_CLASS: Record<string, string> = {
  default: '',
  green: 'intel-pill--success',
  red: 'intel-pill--error',
  orange: 'intel-pill--warning',
  volcano: 'intel-pill--warning',
  blue: 'intel-pill--blue',
  gold: 'intel-pill--gold',
  cyan: 'intel-pill--cyan',
  purple: 'intel-pill--purple',
};

export function IntelPill({
  tone = 'default',
  title,
  children,
  className = '',
  testId,
  onClick,
}: {
  /** An antd colour word from the canonical surface. Unknown values render neutral. */
  tone?: string;
  /** Plain-text tooltip, exactly where the canonical surface used a Tooltip. */
  title?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  /** Canonical clickable Tags (PE codes) become real buttons. */
  onClick?: () => void;
}) {
  const classes = `intel-pill ${PILL_TONE_CLASS[tone] ?? ''} ${className}`.trim();
  if (onClick) {
    return (
      <button type="button" className={`${classes} intel-pill--action`} title={title} data-testid={testId} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <span className={classes} title={title} data-testid={testId}>
      {children}
    </span>
  );
}

/* ── Alerts (antd Alert) ─────────────────────────────────────────────────── */

export function IntelAlert({
  tone = 'info',
  message,
  description,
  action,
  onClose,
  testId,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success';
  message: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onClose?: () => void;
  testId?: string;
}) {
  return (
    <div className={`intel-alert intel-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>
      <span className="intel-alert__rail" aria-hidden="true" />
      <div className="intel-alert__body">
        <span className="intel-alert__message">{message}</span>
        {description != null ? <div className="intel-alert__description">{description}</div> : null}
      </div>
      {action != null ? <div className="intel-alert__action">{action}</div> : null}
      {onClose ? (
        <button type="button" className="intel-alert__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}

/* ── Section card (antd Card size="small" title=…) ───────────────────────── */

export function IntelCard({
  title,
  extra,
  children,
  className = '',
  testId,
  ariaLabel,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={`intel-card ${className}`.trim()} data-testid={testId} aria-label={ariaLabel}>
      {title != null || extra != null ? (
        <header className="intel-card__header">
          {title != null ? <h3 className="intel-card__heading">{title}</h3> : <span />}
          {extra}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/* ── Stat tile (antd Statistic inside a small Card) ──────────────────────── */

export function IntelStat({
  label,
  value,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  /** Canonical valueStyle colours (red for new entrants, orange for overlap). */
  tone?: 'danger' | 'warning';
}) {
  return (
    <div className="intel-stat">
      <span className="intel-stat__label">{label}</span>
      <span className={`intel-stat__value${tone ? ` intel-stat__value--${tone}` : ''}`}>{value}</span>
    </div>
  );
}

/* ── Skeleton stack (antd Skeleton paragraph={{ rows: n }}) ──────────────── */

export function IntelSkeletonRows({ rows, testId }: { rows: number; testId?: string }) {
  return (
    <div className="intel-skeleton-rows" data-testid={testId} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <CapiroSkeleton key={index} width={index === rows - 1 ? '61%' : '100%'} height={14} />
      ))}
    </div>
  );
}

/* ── Segmented switch (antd Segmented) ───────────────────────────────────── */

export interface IntelSegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

export function IntelSegmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<IntelSegmentedOption<T>>;
  ariaLabel: string;
}) {
  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const list = event.currentTarget.parentElement;
    if (!list) return;
    const enabled = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = enabled.indexOf(event.currentTarget);
    if (currentIndex < 0 || enabled.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % enabled.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = enabled.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = enabled[nextIndex]!;
    next.focus();
    const nextValue = next.dataset.segValue as T | undefined;
    if (nextValue != null) onChange(nextValue);
  };

  return (
    <div className="intel-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            className="intel-seg__option"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-seg-value={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={moveFocus}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Module icons (inline, stroke = currentColor) ────────────────────────── */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function iconBase({ size = 16, ...props }: IconProps, children: ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IntelArrowLeftIcon(props: IconProps) {
  return iconBase(props, <path d="M19 12H5m7-7-7 7 7 7" />);
}

export function IntelRefreshIcon(props: IconProps) {
  return iconBase(
    props,
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
  );
}

export function IntelFilterIcon(props: IconProps) {
  return iconBase(props, <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />);
}

export function IntelTrophyIcon(props: IconProps) {
  return iconBase(
    props,
    <>
      <path d="M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0V4z" />
      <path d="M7 6H4a1 1 0 0 0-1 1 4 4 0 0 0 4 4M17 6h3a1 1 0 0 1 1 1 4 4 0 0 1-4 4" />
    </>,
  );
}

export function IntelBellIcon(props: IconProps) {
  return iconBase(
    props,
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>,
  );
}

export function IntelExternalIcon(props: IconProps) {
  return iconBase(
    props,
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </>,
  );
}
