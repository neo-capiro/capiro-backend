import { useEffect, useRef, useState } from 'react';
import { useShellOverlay } from '../overlay-manager.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';

export interface GlobalSearchProps {
  placeholder?: string;
  shortcut?: string;
  /**
   * SCOPE contract (`730:2589`). Supplied by the shell from the canonical client
   * context so this component stays presentational and harness-renderable.
   */
  scopeLabel?: string;
}

/**
 * Global search (`722:2510`, popover `726:2569`).
 *
 * The popover mechanics are implemented in full — open, Escape, outside click,
 * focus return and an explicit scope statement. The canonical web app has no
 * cross-entity search endpoint returning the designed `Kind / Name / Meta`
 * shape, so results render the honest not-enabled state rather than fabricated
 * rows. The missing contract is recorded in IMPLEMENTATION_CONTRACT.md §5.
 */
export function GlobalSearch({
  placeholder = 'Search clients, issues, programs, people',
  shortcut = '⌘K',
  scopeLabel = 'All clients',
}: GlobalSearchProps) {
  const [value, setValue] = useState('');
  const { isOpen, containerRef, open, close } = useShellOverlay('search');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Global shortcut for the search trigger, matching the canonical shell.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open(triggerRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  return (
    <div className="capiro-global-search" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="capiro-global-search__trigger capiro-elevation-control"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => open(triggerRef.current)}
      >
        <DashboardIcon name="SearchLg" size={20} />
        <span className="capiro-global-search__placeholder">{placeholder}</span>
        <span className="capiro-global-search__shortcut" aria-hidden="true">{shortcut}</span>
      </button>

      {isOpen ? (
        <div
          className="capiro-global-search__popover capiro-elevation-popover"
          role="dialog"
          aria-label="Global search"
        >
          <div className="capiro-global-search__input-row">
            <DashboardIcon name="SearchLg" size={20} />
            <input
              ref={inputRef}
              className="capiro-global-search__input"
              type="search"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              aria-label="Search"
            />
            <button
              type="button"
              className="capiro-global-search__escape"
              onClick={close}
              aria-label="Close search"
            >
              ESC
            </button>
          </div>

          <div className="capiro-global-search__results">
            <p className="capiro-global-search__state-title">Search is not enabled yet</p>
            <p className="capiro-global-search__state-body">
              Cross-entity search has no backend contract on this surface. Use the
              destination pages until it is available.
            </p>
          </div>

          <div className="capiro-global-search__footer">{scopeLabel}</div>
        </div>
      ) : null}
    </div>
  );
}
