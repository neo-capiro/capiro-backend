import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

/**
 * Funding Opportunities vNext — module-local compositions over the shared
 * Capiro primitives.
 *
 * Everything here exists to give the ported pages a mechanical translation
 * target for the antd vocabulary the canonical surface uses (`Tag`, `Alert`,
 * `Card title=`, `Segmented`, `Dropdown menu`, `Collapse ghost`,
 * `Modal onOk`), while the actual controls stay the shared primitives
 * (CapiroButton, CapiroModal, CapiroSkeleton). Copy is never composed here —
 * every sentence a component renders arrives from the caller unchanged.
 */

/* ── Pills (antd Tag) ────────────────────────────────────────────────────── */

/**
 * The canonical surface's colour vocabulary, preserved so the ported pages can
 * keep passing the exact values from the shared *_COLORS maps
 * (funding-opportunities-api.ts / opportunity-explanations.ts). Mapped onto
 * this module's Untitled UI tone table in funding-opportunities-vnext.css.
 */
const PILL_TONE_CLASS: Record<string, string> = {
  default: '',
  green: 'fov-pill--success',
  red: 'fov-pill--error',
  orange: 'fov-pill--warning',
  blue: 'fov-pill--blue',
  geekblue: 'fov-pill--indigo',
  purple: 'fov-pill--purple',
  cyan: 'fov-pill--cyan',
  gold: 'fov-pill--gold',
};

export function FovPill({
  tone = 'default',
  title,
  children,
  className = '',
  testId,
  ariaLabel,
}: {
  /** An antd colour word from the shared *_COLORS maps. Unknown values render neutral. */
  tone?: string;
  /** Plain-text tooltip, exactly where the canonical surface wrapped the tag in a Tooltip. */
  title?: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <span
      className={`fov-pill ${PILL_TONE_CLASS[tone] ?? ''} ${className}`.trim()}
      title={title}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}

/* ── Alerts (antd Alert) ─────────────────────────────────────────────────── */

export function FovAlert({
  tone = 'info',
  message,
  description,
  action,
  testId,
  className = '',
}: {
  tone?: 'info' | 'warning' | 'error' | 'success';
  message: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      className={`fov-alert fov-alert--${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid={testId}
    >
      <span className="fov-alert__rail" aria-hidden="true" />
      <div className="fov-alert__body">
        <span className="fov-alert__message">{message}</span>
        {description != null ? <div className="fov-alert__description">{description}</div> : null}
      </div>
      {action != null ? <div className="fov-alert__action">{action}</div> : null}
    </div>
  );
}

/* ── Section card (antd Card size="small" title=…) ───────────────────────── */

export function FovCard({
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
    <section className={`fov-card ${className}`.trim()} data-testid={testId} aria-label={ariaLabel}>
      {title != null || extra != null ? (
        <header className="fov-card__header">
          {title != null ? <h3 className="fov-card__heading">{title}</h3> : <span />}
          {extra}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/* ── Fact (label over value) ─────────────────────────────────────────────── */

export function FovFact({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <span className="fov-fact">
      <span className="fov-fact__label">{label}</span>
      <span className="fov-fact__value">{value}</span>
    </span>
  );
}

/* ── Skeleton stack (antd Skeleton paragraph={{ rows: n }}) ──────────────── */

export function FovSkeletonRows({ rows, testId }: { rows: number; testId?: string }) {
  return (
    <div className="fov-skeleton-rows" data-testid={testId} aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <CapiroSkeleton key={index} width={index === rows - 1 ? '61%' : '100%'} height={14} />
      ))}
    </div>
  );
}

/* ── Segmented switch (antd Segmented) ───────────────────────────────────── */

export interface FovSegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Plain-text tooltip, where the canonical control wrapped labels in Tooltips. */
  title?: string;
}

export function FovSegmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  block = false,
}: {
  value: T;
  onChange: (next: T) => void;
  options: ReadonlyArray<FovSegmentedOption<T>>;
  ariaLabel: string;
  block?: boolean;
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
    <div className={`fov-seg${block ? ' fov-seg--block' : ''}`} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            className="fov-seg__option"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={option.title}
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

/* ── Closable client chip (antd Tag closable) ────────────────────────────── */

export function FovChip({
  children,
  onClose,
  closeLabel,
  ariaLabel,
  testId,
}: {
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
  ariaLabel?: string;
  testId?: string;
}) {
  return (
    <span className="fov-chip" aria-label={ariaLabel} data-testid={testId}>
      {children}
      <button type="button" className="fov-chip__close" aria-label={closeLabel} onClick={onClose}>
        ×
      </button>
    </span>
  );
}

/* ── Disclosure (antd Collapse ghost) ────────────────────────────────────── */

export function FovDisclosure({
  summary,
  children,
  className = '',
  testId,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <details className={`fov-disclosure ${className}`.trim()} data-testid={testId}>
      <summary>{summary}</summary>
      <div className="fov-disclosure__body">{children}</div>
    </details>
  );
}

/* ── Shared popover-anchor behaviour (menu + multiselect) ────────────────── */

function usePopanchor(open: boolean, close: () => void) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);
  return rootRef;
}

/* ── Actions menu (antd Dropdown menu, click trigger) ────────────────────── */

export interface FovMenuAction {
  key: string;
  label: string;
  disabled?: boolean;
}

export function FovActionsMenu({
  label,
  items,
  onSelect,
  testId,
}: {
  /** Accessible name for the trigger, e.g. `More actions for {title}`. */
  label: string;
  items: ReadonlyArray<FovMenuAction>;
  onSelect: (key: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = usePopanchor(open, () => setOpen(false));

  return (
    <span className="fov-popanchor" ref={rootRef} data-testid={testId}>
      <CapiroButton
        size="compact"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </CapiroButton>
      {open ? (
        <div id={panelId} className="fov-popanchor__panel" role="menu" aria-label={label}>
          <ul className="fov-menu">
            {items.map((item) => (
              <li key={item.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    onSelect(item.key);
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </span>
  );
}

/* ── Multi-select (antd Select mode="multiple") ──────────────────────────── */

export function FovMultiSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
}: {
  /** Accessible name — the same aria-label the canonical control carried. */
  label: string;
  placeholder: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = usePopanchor(open, () => setOpen(false));

  const summary =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? (options.find((option) => option.value === value[0])?.label ?? placeholder)
        : `${placeholder} (${value.length})`;

  return (
    <span className="fov-popanchor" ref={rootRef}>
      <CapiroButton
        size="compact"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {summary} ▾
      </CapiroButton>
      {open ? (
        <div
          id={panelId}
          className="fov-popanchor__panel fov-popanchor__panel--left"
          role="dialog"
          aria-label={label}
        >
          <div className="fov-checklist">
            {options.map((option) => (
              <label key={option.value}>
                <input
                  type="checkbox"
                  checked={value.includes(option.value)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, option.value]
                        : value.filter((entry) => entry !== option.value),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
          {value.length > 0 ? (
            <CapiroButton size="compact" variant="quiet" onClick={() => onChange([])}>
              Clear
            </CapiroButton>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/* ── Modal with a confirm footer (antd Modal onOk/okText) ────────────────── */

export function FovModal({
  open,
  title,
  onCancel,
  onOk,
  okText = 'OK',
  okDisabled = false,
  okLoading = false,
  children,
  testId,
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onOk: () => void;
  okText?: string;
  okDisabled?: boolean;
  okLoading?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <CapiroModal open={open} title={title} onClose={onCancel}>
      <div className="fov" data-testid={testId}>
        {children}
        <div className="fov-modal-footer">
          <CapiroButton size="compact" onClick={onCancel}>
            Cancel
          </CapiroButton>
          <CapiroButton
            size="compact"
            variant="primary"
            disabled={okDisabled}
            loading={okLoading}
            onClick={onOk}
          >
            {okText}
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}
