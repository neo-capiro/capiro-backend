import { useRef } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { useShellOverlay } from '../overlay-manager.js';

/**
 * Context bar (`722:2589`). CLIENT is backed by the canonical client filter.
 * JURISDICTION and BUDGET YEAR have no shell-level contract, so they render the
 * designed not-enabled state instead of fabricating a value.
 */
export function CapiroContextBar() {
  const client = useShellClientContext();
  const { isOpen, containerRef, toggle, close } = useShellOverlay('client-context');
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="capiro-vnext-contextbar" role="region" aria-label="Working context">
      <div className="capiro-vnext-context-control" ref={containerRef}>
        <button
          ref={triggerRef}
          type="button"
          className="capiro-vnext-context-chip capiro-elevation-control"
          aria-expanded={isOpen}
          aria-haspopup="menu"
          disabled={!client.enabled}
          // The Dashboard rule is a scope guarantee, not just a disabled control.
          title={client.enabled ? undefined : 'Dashboard is always all-client'}
          onClick={() => toggle(triggerRef.current)}
        >
          <span className="capiro-vnext-context-chip__label">CLIENT</span>
          <span className="capiro-vnext-context-chip__value">
            {client.enabled ? (client.selectedClientName ?? 'All clients') : 'All clients'}
          </span>
          {client.enabled ? <ChevronDown size={12} strokeWidth={2} aria-hidden="true" /> : null}
        </button>

        {isOpen && client.enabled ? (
          <div className="capiro-vnext-flyout capiro-elevation-popover" role="menu" aria-label="Client context">
            <div className="capiro-vnext-flyout__header">
              <p className="capiro-vnext-flyout__eyebrow">CLIENT</p>
              <p className="capiro-vnext-flyout__description">Scopes the current working surface</p>
            </div>

            {client.unavailable ? (
              <p className="capiro-vnext-flyout__state">Client list unavailable</p>
            ) : client.loading ? (
              <p className="capiro-vnext-flyout__state">Loading clients…</p>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="capiro-vnext-flyout__item"
                  onClick={() => {
                    client.setSelectedClientId(null);
                    close();
                  }}
                >
                  <span className="capiro-vnext-flyout__check" aria-hidden="true">
                    {client.selectedClientId === null ? <Check size={14} strokeWidth={2} /> : null}
                  </span>
                  <span className="capiro-vnext-flyout__item-copy">
                    <span className="capiro-vnext-flyout__name">All clients</span>
                    <span className="capiro-vnext-flyout__meta">Portfolio-wide</span>
                  </span>
                </button>

                {client.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    className="capiro-vnext-flyout__item"
                    onClick={() => {
                      client.setSelectedClientId(option.id);
                      close();
                    }}
                  >
                    <span className="capiro-vnext-flyout__check" aria-hidden="true">
                      {client.selectedClientId === option.id ? <Check size={14} strokeWidth={2} /> : null}
                    </span>
                    <span className="capiro-vnext-flyout__item-copy">
                      <span className="capiro-vnext-flyout__name">{option.name}</span>
                      {option.meta ? (
                        <span className="capiro-vnext-flyout__meta">{option.meta}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : null}
      </div>

      <span className="capiro-vnext-context-chip capiro-vnext-context-chip--unavailable">
        <span className="capiro-vnext-context-chip__label">JURISDICTION</span>
        <span className="capiro-vnext-context-chip__value">Not enabled</span>
      </span>

      <span className="capiro-vnext-context-chip capiro-vnext-context-chip--unavailable">
        <span className="capiro-vnext-context-chip__label">BUDGET YEAR</span>
        <span className="capiro-vnext-context-chip__value">Not enabled</span>
      </span>

      {/* SCOPE contract (`730:2589`): the bar states its scope explicitly. */}
      <span className="capiro-vnext-contextbar__scope">{client.scopeLabel}</span>
    </div>
  );
}
