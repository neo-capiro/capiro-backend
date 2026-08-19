/**
 * Program Elements vNext profile — shared primitives.
 *
 * Native re-implementations of the tiny v2 vocabulary pieces (evidence marks,
 * the card atom) on the vNext token layer (pe-profile.css). Everything
 * data-shaped comes from the UI-free pe-v2-model.ts, imported directly — the
 * legacy pe-v2-primitives.tsx is never reached from here.
 */
import type { ReactNode } from 'react';
import { evMarkClass, type EvState } from '../../../../pages/program-element/v2/pe-v2-model.js';

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
    return <span className={`pe-pf-ev-chip ${cls}`}>{label}</span>;
  }
  return (
    <span className={`pe-pf-ev${quiet ? ' quiet' : ''}`}>
      <span className={`pe-pf-ev-mark ${evMarkClass(state)}${large ? ' lg' : ''}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

/** Card with header row — the profile panel atom on vNext card chrome. */
export function PfCard({
  title,
  right,
  inkTop,
  rustTop,
  className,
  headPadding,
  children,
}: {
  title?: ReactNode;
  right?: ReactNode;
  inkTop?: boolean;
  rustTop?: boolean;
  className?: string;
  headPadding?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`pe-pf-card${inkTop ? ' pe-pf-card-inktop' : ''}${rustTop ? ' pe-pf-card-rusttop' : ''}${className ? ` ${className}` : ''}`}
    >
      {title != null || right != null ? (
        <div className="pe-pf-card-head" style={headPadding ? { padding: headPadding } : undefined}>
          {title != null ? <div className="pe-pf-card-title">{title}</div> : null}
          <div style={{ flex: 1, minWidth: 8 }} />
          {right}
        </div>
      ) : null}
      {children}
    </div>
  );
}
