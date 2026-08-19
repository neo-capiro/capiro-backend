/*
 * Scope bar — sticky strip under the shell header, present on every Strategies
 * view (design handoff 2026-08-16, "Layout" + "Scope bar" sections).
 *
 * The handoff draws THREE dropdown chips (Client, Calendar, Horizon) plus a
 * view-aware live-status pill. Only two of the three chips have anything real
 * behind them here:
 *
 *  - Client: the shared cross-app client-scope control (`useShellClientContext`,
 *    already driving the topbar on every vNext page) — this bar just renders
 *    it as the handoff's chip instead of inventing a second client selector.
 *  - Horizon: real — `buildFiscalAxis(start, end)` already takes an arbitrary
 *    fiscal-year window, so this literally changes what's rendered. Editor-only:
 *    no other view has a windowed timeline to narrow.
 *
 * The handoff's "Calendar: Federal · Federal + state · State only" chip is
 * OMITTED. `ReferenceCalendars` (strategies-api.ts) only ever carries `congress`
 * and `ppbeLanes` — there is no state-legislative-calendar concept anywhere in
 * this domain, so a working chip cannot be built without fabricating a filter
 * that would silently do nothing. Add it back once/if that data exists.
 *
 * The live-status pill is passed in as `status` rather than computed here:
 * each view already holds the real signal behind its own copy (last fetch
 * time, context health, pending-approval count) and this component has no
 * business re-fetching it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { CapiroCheckIcon } from '../../components/icons/index.js';
import './scope-bar.css';

export type HorizonKey = '3fy' | '2fy' | '1fy';

/** Fiscal years each horizon spans. */
export const HORIZON_YEARS: Record<HorizonKey, number> = { '1fy': 1, '2fy': 2, '3fy': 3 };

const fyShort = (fy: number) => `FY${String(fy).slice(2)}`;

/**
 * Horizon options labelled from the window the editor is ACTUALLY drawing.
 *
 * These were three frozen strings ('FY27–FY29', 'FY27 only', 'FY27–FY28')
 * matching an axis that was itself hard-coded to start at FY27. The axis is now
 * anchored on the live fiscal year (lib/timeline.ts currentFiscalYear — the same
 * rule api-strategy uses to date every reference row it generates), so the
 * labels have to be derived from that same `startFy` or the chip advertises a
 * window the timeline does not show.
 */
export function horizonOptions(
  startFy: number,
): ReadonlyArray<{ key: HorizonKey; label: string; sub: string }> {
  const label = (key: HorizonKey) => {
    const years = HORIZON_YEARS[key];
    return years === 1 ? `${fyShort(startFy)} only` : `${fyShort(startFy)}–${fyShort(startFy + years - 1)}`;
  };
  return [
    { key: '3fy', label: label('3fy'), sub: '36 months' },
    { key: '1fy', label: label('1fy'), sub: '12 months' },
    { key: '2fy', label: label('2fy'), sub: '24 months' },
  ];
}

export interface ScopeBarStatus {
  tone: 'success' | 'warning' | 'error' | 'gray';
  label: string;
}

function ChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScopeChip({
  label,
  value,
  disabled,
  children,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  children?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const close = () => setOpen(false);

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
  }, [open]);

  return (
    <div className="st-scopechip" ref={rootRef}>
      <button
        type="button"
        className="st-scopechip__trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="st-scopechip__label">{label}</span>
        <span className="st-scopechip__value">{value}</span>
        {disabled ? null : <ChevronDown />}
      </button>
      {open && children ? (
        <div id={panelId} role="menu" aria-label={label} className="st-scopechip__menu">
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

function ScopeChipRow({ selected, label, sub, onSelect }: { selected: boolean; label: string; sub?: string; onSelect: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} className="st-scopechip__row" onClick={onSelect}>
      <span>
        <span className="st-scopechip__row-label">{label}</span>
        {sub ? <span className="st-scopechip__row-sub">{sub}</span> : null}
      </span>
      {selected ? <CapiroCheckIcon /> : null}
    </button>
  );
}

export function ScopeBar({
  clientLabel = 'CLIENT',
  fixedClientName,
  horizon,
  status,
}: {
  /** "CLIENT" with the strategy's own client name in the editor, "PORTFOLIO" elsewhere. */
  clientLabel?: string;
  /** Editor only: the strategy's own client is fixed, not a scope the editor can change. */
  fixedClientName?: string;
  /** Editor only — no other view has a windowed timeline to narrow. */
  horizon?: { value: HorizonKey; onChange: (value: HorizonKey) => void; startFy: number };
  status: ScopeBarStatus;
}) {
  const clientContext = useShellClientContext();

  return (
    <div className="st-scopebar">
      <div className="st-scopebar__chips">
        {fixedClientName ? (
          <ScopeChip label={clientLabel} value={fixedClientName} disabled />
        ) : (
          <ScopeChip label={clientLabel} value={clientContext.selectedClientName ?? 'All clients'}>
            {(close) => (
              <>
                <ScopeChipRow
                  selected={!clientContext.selectedClientId}
                  label="All clients"
                  onSelect={() => {
                    clientContext.setSelectedClientId(null);
                    close();
                  }}
                />
                {clientContext.options.map((option) => (
                  <ScopeChipRow
                    key={option.id}
                    selected={clientContext.selectedClientId === option.id}
                    label={option.name}
                    onSelect={() => {
                      clientContext.setSelectedClientId(option.id);
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </ScopeChip>
        )}

        {horizon ? (
          <ScopeChip
            label="HORIZON"
            value={horizonOptions(horizon.startFy).find((o) => o.key === horizon.value)?.label ?? ''}
          >
            {(close) => (
              <>
                {horizonOptions(horizon.startFy).map((option) => (
                  <ScopeChipRow
                    key={option.key}
                    selected={horizon.value === option.key}
                    label={option.label}
                    sub={option.sub}
                    onSelect={() => {
                      horizon.onChange(option.key);
                      close();
                    }}
                  />
                ))}
              </>
            )}
          </ScopeChip>
        ) : null}
      </div>

      <span className={`st-pill${status.tone === 'gray' ? '' : ` st-pill--${status.tone}`}`}>
        {status.label}
      </span>
    </div>
  );
}
