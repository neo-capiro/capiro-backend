/**
 * Settings vNext — module-local building blocks over the shared vNext
 * primitives (vnext/components/**). These fill the gaps the primitive kit
 * deliberately does not cover (cards with heads, callouts, stats, bordered
 * descriptions, switch, segmented control, tag input, textarea with count,
 * confirm dialog, tiny pagination/sorting) so every Settings page composes the
 * same chrome instead of hand-rolling markup.
 */
import {
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import { CapiroModal } from '../../components/overlays/index.js';

// ── Section card ────────────────────────────────────────────────────────────

export function SvCard({
  title,
  description,
  extra,
  children,
  className = '',
  'aria-label': ariaLabel,
}: {
  title?: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <section className={`stv-card ${className}`.trim()} aria-label={ariaLabel}>
      {title || extra || description ? (
        <div className="stv-card__head">
          <div>
            {title ? <h2 className="stv-card__title">{title}</h2> : null}
            {description ? <p className="stv-card__desc">{description}</p> : null}
          </div>
          {extra ? <div className="stv-row">{extra}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ── Callout (antd Alert equivalent) ─────────────────────────────────────────

export function SvCallout({
  kind,
  title,
  description,
  action,
}: {
  kind: 'info' | 'success' | 'warning' | 'error';
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`stv-callout stv-callout--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="stv-callout__title">{title}</span>
      {description ? <span className="stv-callout__desc">{description}</span> : null}
      {action ? <span className="stv-row" style={{ marginTop: 6 }}>{action}</span> : null}
    </div>
  );
}

// ── Statistic ───────────────────────────────────────────────────────────────

export function SvStat({
  label,
  value,
  hint,
  danger,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="stv-stat">
      <span className="stv-stat__label">{label}</span>
      <span className={`stv-stat__value${danger ? ' stv-stat__value--danger' : ''}`}>{value}</span>
      {hint ? <span className="stv-muted stv-small">{hint}</span> : null}
    </div>
  );
}

// ── Bordered descriptions ───────────────────────────────────────────────────

export function SvDescriptions({
  items,
}: {
  items: ReadonlyArray<{ label: ReactNode; value: ReactNode }>;
}) {
  return (
    <dl className="stv-descriptions">
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Progress bar ────────────────────────────────────────────────────────────

export function SvProgress({
  percent,
  tone,
  label,
}: {
  percent: number;
  tone?: 'success' | 'warning' | 'danger';
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span
      className={`stv-progress${tone ? ` stv-progress--${tone}` : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${clamped}%` }} />
    </span>
  );
}

// ── Switch ──────────────────────────────────────────────────────────────────

export function SvSwitch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      className="stv-switch"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

// ── Segmented control ───────────────────────────────────────────────────────

export function SvSegmented<T extends string | number>({
  value,
  onChange,
  options,
  block,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ label: ReactNode; value: T; disabled?: boolean }>;
  block?: boolean;
  'aria-label'?: string;
}) {
  return (
    <div className={`stv-segmented${block ? ' stv-segmented--block' : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── Textarea with optional count ────────────────────────────────────────────

export interface SvTextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  showCount?: boolean;
  label?: string;
}

export function SvTextArea({ value, onChange, showCount, label, maxLength, ...props }: SvTextAreaProps) {
  return (
    <span style={{ display: 'block' }}>
      {label ? <span className="capiro-field__label" style={{ display: 'block', marginBottom: 6 }}>{label}</span> : null}
      <textarea
        className="stv-textarea"
        value={value}
        maxLength={maxLength}
        aria-label={props['aria-label'] ?? label}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
      {showCount && typeof maxLength === 'number' ? (
        <span className="stv-count">
          {value.length} / {maxLength}
        </span>
      ) : null}
    </span>
  );
}

// ── Tag input (antd Select mode="tags" equivalent) ──────────────────────────

export function SvTagInput({
  value,
  onChange,
  placeholder,
  'aria-label': ariaLabel,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  'aria-label'?: string;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = draft
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !value.includes(item));
    if (next.length) onChange([...value, ...next]);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="stv-taginput">
      {value.map((tag) => (
        <CapiroBadge key={tag}>
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((item) => item !== tag))}
          >
            ×
          </button>
        </CapiroBadge>
      ))}
      <input
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}

// ── Confirm dialog (antd Popconfirm / modal.confirm equivalent) ─────────────

export interface SvConfirmState {
  title: string;
  body?: ReactNode;
  okText: string;
  danger?: boolean;
  onOk: () => void | Promise<unknown>;
}

export function SvConfirmDialog({
  state,
  pending,
  onClose,
}: {
  state: SvConfirmState | null;
  pending?: boolean;
  onClose: () => void;
}) {
  if (!state) return null;
  return (
    <CapiroModal open title={state.title} onClose={onClose}>
      <div className="stv-stack">
        {state.body ? <div className="stv-muted">{state.body}</div> : null}
        <div className="stv-row stv-row--end">
          <CapiroButton variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </CapiroButton>
          <CapiroButton
            variant="primary"
            className={state.danger ? 'stv-confirm-danger' : undefined}
            loading={pending}
            onClick={() => {
              void state.onOk();
            }}
          >
            {state.okText}
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

/** Hook pairing SvConfirmDialog with a one-liner `confirm({...})` call. */
export function useSvConfirm(): {
  confirm: (state: SvConfirmState) => void;
  dialog: ReactNode;
  close: () => void;
} {
  const [state, setState] = useState<SvConfirmState | null>(null);
  const [pending, setPending] = useState(false);
  const close = () => {
    setState(null);
    setPending(false);
  };
  const dialog = (
    <SvConfirmDialog
      state={
        state
          ? {
              ...state,
              onOk: async () => {
                try {
                  setPending(true);
                  await state.onOk();
                  close();
                } catch {
                  // The mutation's own onError surfaced the failure; keep the
                  // dialog open so the user can retry or cancel.
                  setPending(false);
                }
              },
            }
          : null
      }
      pending={pending}
      onClose={close}
    />
  );
  return { confirm: setState, dialog, close };
}

// ── Client-side pagination (antd Table pagination equivalent) ───────────────

export function useSvPagination<T>(rows: readonly T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [rows, currentPage, pageSize],
  );
  return { pageRows, currentPage, pageCount, setPage };
}

export function SvPagination({
  currentPage,
  pageCount,
  onPage,
}: {
  currentPage: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="stv-pagination">
      <CapiroButton size="compact" disabled={currentPage <= 1} onClick={() => onPage(currentPage - 1)}>
        Previous
      </CapiroButton>
      <span>
        Page {currentPage} of {pageCount}
      </span>
      <CapiroButton
        size="compact"
        disabled={currentPage >= pageCount}
        onClick={() => onPage(currentPage + 1)}
      >
        Next
      </CapiroButton>
    </div>
  );
}

// ── Sortable header (antd Table sorter equivalent) ──────────────────────────

export function useSvSort<K extends string>(initial: K | null, initialDir: 'asc' | 'desc' = 'desc') {
  const [key, setKey] = useState<K | null>(initial);
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir);
  const toggle = (next: K) => {
    if (key === next) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setKey(next);
      setDir('desc');
    }
  };
  return { key, dir, toggle };
}

export function SvSortHeader({
  label,
  active,
  dir,
  onToggle,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onToggle: () => void;
}) {
  return (
    <button type="button" className="stv-sort" data-active={active} onClick={onToggle}>
      {label}
      <span aria-hidden="true">{active ? (dir === 'desc' ? '↓' : '↑') : '↕'}</span>
    </button>
  );
}

// ── Shared tone maps ────────────────────────────────────────────────────────

/** antd tag-color vocabulary → CapiroBadge tone, for ported color maps. */
export function svBadgeTone(color: string): CapiroBadgeTone {
  if (color === 'green' || color === 'success') return 'success';
  if (color === 'red' || color === 'volcano' || color === 'error' || color === 'danger') return 'danger';
  if (color === 'gold' || color === 'orange' || color === 'warning') return 'warning';
  if (color === 'blue' || color === 'geekblue' || color === 'processing' || color === 'info') return 'info';
  return 'neutral';
}
