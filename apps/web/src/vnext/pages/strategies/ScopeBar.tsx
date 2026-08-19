/*
 * Scope bar — sticky strip under the shell header, present on every Strategies
 * view (design handoff 2026-08-16, "Layout" + "Scope bar" sections).
 *
 * The handoff draws THREE dropdown chips (Client, Calendar, Horizon) plus a
 * view-aware live-status pill. Only Client has anything real behind it here:
 * the shared cross-app client-scope control (`useShellClientContext`, already
 * driving the topbar on every vNext page) — this bar just renders it as the
 * handoff's chip instead of inventing a second client selector.
 *
 * Horizon was removed (2026-08-19, Neo): the editor's timeline always shows
 * the rolling 3-FY window now, matching `app.capiro.ai/strategies/:id`, which
 * has never had a narrowable horizon either — see StrategyEditorVNext.tsx's
 * `calendar` comment. There is no other view with a windowed timeline to
 * narrow, so this chip has no remaining reason to exist.
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
  status,
}: {
  /** "CLIENT" with the strategy's own client name in the editor, "PORTFOLIO" elsewhere. */
  clientLabel?: string;
  /** Editor only: the strategy's own client is fixed, not a scope the editor can change. */
  fixedClientName?: string;
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
      </div>

      <span className={`st-pill${status.tone === 'gray' ? '' : ` st-pill--${status.tone}`}`}>
        {status.label}
      </span>
    </div>
  );
}
