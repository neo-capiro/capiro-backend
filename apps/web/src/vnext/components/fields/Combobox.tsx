import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DashboardIcon } from '../untitledui/dashboard-icons.js';

export interface ComboboxOption {
  value: string;
  label: string;
  meta?: string;
}

export interface ComboboxProps {
  value: string | undefined;
  valueLabel?: string;
  onChange: (option: ComboboxOption) => void;
  options: readonly ComboboxOption[];
  loading?: boolean;
  disabled?: boolean;
  placeholder: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  emptyMessage: string;
  leadingIcon: ReactNode;
}

/**
 * Searchable single-select. Filtering is the caller's job — pass already
 * client-side-filtered options for a small static list, or server-filtered
 * options driven by `onSearchChange` for an async lookup. Keeps this
 * component ignorant of which mode it's in.
 */
export function Combobox({
  value,
  valueLabel,
  onChange,
  options,
  loading,
  disabled,
  placeholder,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  emptyMessage,
  leadingIcon,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <div className="capiro-combobox" ref={containerRef}>
      <button
        type="button"
        className="capiro-combobox__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="capiro-icon">{leadingIcon}</span>
        <span className={`capiro-combobox__value${valueLabel ? '' : ' is-placeholder'}`}>
          {valueLabel ?? placeholder}
        </span>
        <span className="capiro-icon capiro-combobox__chevron">
          <DashboardIcon name="ChevronRight" size={16} />
        </span>
      </button>

      {open ? (
        <div className="capiro-combobox__panel capiro-elevation-control">
          <div className="capiro-combobox__search">
            <DashboardIcon name="SearchLg" size={16} />
            <input
              ref={inputRef}
              className="capiro-combobox__input"
              type="text"
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>

          {loading ? (
            <div className="capiro-combobox__list" aria-hidden="true">
              <span className="capiro-skeleton" style={{ display: 'block', height: 36, margin: '4px 6px' }} />
              <span className="capiro-skeleton" style={{ display: 'block', height: 36, margin: '4px 6px' }} />
            </div>
          ) : options.length === 0 ? (
            <p className="capiro-combobox__empty">{emptyMessage}</p>
          ) : (
            <ul className="capiro-combobox__list" role="listbox">
              {options.map((option) => (
                <li key={option.value} role="option" aria-selected={option.value === value}>
                  <button
                    type="button"
                    className="capiro-combobox__option"
                    onClick={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    <span className="capiro-combobox__option-copy">
                      <span className="capiro-combobox__option-label">{option.label}</span>
                      {option.meta ? <span className="capiro-combobox__option-meta">{option.meta}</span> : null}
                    </span>
                    <span className="capiro-icon capiro-combobox__check">
                      <DashboardIcon name="Check" size={16} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
