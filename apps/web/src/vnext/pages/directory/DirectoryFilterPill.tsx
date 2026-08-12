import { useEffect, useId, useRef, useState } from 'react';

export interface DirectoryFilterOption {
  value: string;
  label: string;
}

export interface DirectoryFilterPillProps {
  label: string;
  options: readonly DirectoryFilterOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  /**
   * Set when the canonical API cannot filter on this dimension. The control still
   * renders and is still reachable, and it says why — silently filtering only the
   * page in hand would report a wrong result set.
   */
  unavailableReason?: string;
}

/**
 * Directory vNext / Filter Pill (`937:2721`) — "label text is a component
 * property". Real button + listbox rather than decorative text, so it is
 * keyboard-operable and announces its state.
 */
export function DirectoryFilterPill({
  label,
  options,
  selected,
  onChange,
  multiple = true,
  unavailableReason,
}: DirectoryFilterPillProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  // Escape and outside click close, and focus returns to the invoking control —
  // the shell's documented overlay dismissal contract (730:2573).
  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        pillRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const isUnavailable = Boolean(unavailableReason);
  const count = selected.length;

  function toggle(value: string) {
    if (!multiple) {
      onChange(selected[0] === value ? [] : [value]);
      setOpen(false);
      pillRef.current?.focus();
      return;
    }
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div className="capiro-directory-filter" ref={containerRef}>
      <button
        ref={pillRef}
        type="button"
        className={`capiro-directory-filter__pill${
          count ? ' capiro-directory-filter__pill--selected' : ''
        }${isUnavailable ? ' capiro-directory-filter__pill--unavailable' : ''}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? menuId : undefined}
        aria-describedby={isUnavailable ? `${menuId}-note` : undefined}
        onClick={() => setOpen((prev) => !prev)}
      >
        {label}
        {count ? <span className="capiro-directory-filter__count">{count}</span> : null}
      </button>

      {open ? (
        <div className="capiro-directory-filter__menu" id={menuId} role="listbox" aria-label={label}>
          {isUnavailable ? (
            <p className="capiro-directory-filter__note" id={`${menuId}-note`}>
              {unavailableReason}
            </p>
          ) : options.length === 0 ? (
            <p className="capiro-directory-filter__note">No {label.toLowerCase()} values available.</p>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-checked={selected.includes(option.value)}
                aria-selected={selected.includes(option.value)}
                className="capiro-directory-filter__option"
                onClick={() => toggle(option.value)}
              >
                <span aria-hidden="true">{selected.includes(option.value) ? '●' : '○'}</span>
                {option.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
