import { useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useShellClientContext } from '../../adapters/legacy/useShellClientContext.js';
import { useShellNavigation } from '../../adapters/legacy/useShellNavigation.js';
import { useShellOverlay } from '../overlay-manager.js';

/**
 * Intelligence destination rail (`869:2571`).
 *
 * Ruling 1: the two navigation layers coexist. The sidebar keeps Intelligence
 * with its chevron and anchored flyout as the **global** entry/switcher; once the
 * user is inside the family, this rail is the **persistent local** navigation.
 * They are not alternatives — do not remove one in favour of the other.
 *
 * Destinations come from the already-gated `useShellNavigation` output, so
 * feature-flagged entries (Funding Opportunities, District Nexus) obey the same
 * deny-by-default rules as the sidebar. No gating is re-implemented here.
 */
function IntelligenceRail({
  destinations,
}: {
  destinations: readonly { id: string; label: string; path: string | null }[];
}) {
  return (
    <div className="capiro-vnext-contextbar capiro-vnext-contextbar--rail" role="region" aria-label="Intelligence destinations">
      <span className="capiro-vnext-contextbar__eyebrow">INTELLIGENCE</span>
      <nav className="capiro-vnext-intel-rail" aria-label="Intelligence">
        {destinations.map((destination) =>
          destination.path ? (
            <NavLink
              key={destination.id}
              to={destination.path}
              className={({ isActive }) =>
                `capiro-vnext-intel-rail__item${isActive ? ' is-current' : ''}`
              }
            >
              {destination.label}
            </NavLink>
          ) : null,
        )}
      </nav>
    </div>
  );
}

/**
 * Context bar (`722:2589`). CLIENT is backed by the canonical client filter.
 * JURISDICTION and BUDGET YEAR have no shell-level contract, so they render the
 * designed not-enabled state instead of fabricating a value.
 */
export function CapiroContextBar() {
  const client = useShellClientContext();
  const navigation = useShellNavigation();
  const location = useLocation();

  // Inside the Intelligence family the context row carries the destination rail
  // instead of the client chips — that is what `869:2571` renders.
  const intelligence = navigation.primary.find((route) => route.id === 'intelligence');
  const destinations = intelligence?.children ?? [];
  const insideIntelligence = destinations.some(
    (destination) => destination.path && location.pathname.startsWith(destination.path),
  );

  if (insideIntelligence && destinations.length) {
    return <IntelligenceRail destinations={destinations} />;
  }
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
