/**
 * Program Elements v2 — shared primitives: evidence marks, filter controls,
 * segmented controls, section headers. Visual vocabulary only from DS v2
 * (see pe-v2.css); no antd chrome on v2 surfaces.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { evMarkClass, type EvState } from './pe-v2-model.js';

/** Evidence glyph + mono label. Loud states (conflict/review) keep a bordered chip. */
export function EvMark({
  state,
  label,
  large,
  quiet,
}: {
  state: EvState;
  label: string;
  large?: boolean;
  /** quiet = glyph + mono text (healthy); default for conflict/review is chip */
  quiet?: boolean;
}) {
  const loud = state === 'CONFLICT' || state === 'REVIEW REQUIRED';
  if (loud && !quiet) {
    const cls = state === 'CONFLICT' ? 'conflict' : 'review';
    return <span className={`pe-v2-ev-chip ${cls}`}>{label}</span>;
  }
  return (
    <span className="pe-v2-ev" style={quiet ? { color: 'var(--pev2-secondary)' } : undefined}>
      <span className={`pe-v2-ev-mark ${evMarkClass(state)}${large ? ' lg' : ''}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

/** Segmented control: FEED|TABLE, STANDARD|COMPACT, BOTH|AUTH|APPR … */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <span className="pe-v2-seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? 'active' : ''}
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

/** Mono filter control with popover menu (Radix-free: local state + outside-click). */
export function FilterControl({
  label,
  value,
  options,
  onChange,
  formatValue,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
  formatValue?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const fmt = formatValue ?? ((v: string) => v);
  const active = value !== 'ANY';
  return (
    <span className="pe-v2-filter" ref={ref}>
      <button
        type="button"
        className={`pe-v2-filter-btn${active ? ' active' : ''}${open ? ' open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}: {fmt(value).toUpperCase()} ▾
      </button>
      {open ? (
        <span className="pe-v2-filter-menu" role="menu">
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              role="menuitemradio"
              aria-checked={opt === value}
              className={`pe-v2-filter-opt${opt === value ? ' sel' : ''}`}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              <span style={{ flex: 1 }}>{opt === value ? '■ ' : ''}{fmt(opt)}</span>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Card with header row — the v2 panel atom. */
export function V2Card({
  title,
  note,
  right,
  inkTop,
  rustTop,
  children,
  padding,
}: {
  title?: ReactNode;
  note?: ReactNode;
  right?: ReactNode;
  inkTop?: boolean;
  rustTop?: boolean;
  children: ReactNode;
  /** body padding override; default none (children provide their own) */
  padding?: string;
}) {
  return (
    <div className={`pe-v2-card${inkTop ? ' pe-v2-card-inktop' : ''}${rustTop ? ' pe-v2-card-rusttop' : ''}`}>
      {title != null || right != null ? (
        <div className="pe-v2-card-head">
          {title != null ? <div className="pe-v2-card-title">{title}</div> : null}
          {note != null ? (
            <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em', textTransform: 'none' }}>
              {note}
            </div>
          ) : null}
          <div style={{ flex: 1, minWidth: 8 }} />
          {right}
        </div>
      ) : null}
      <div style={padding ? { padding } : undefined}>{children}</div>
    </div>
  );
}
