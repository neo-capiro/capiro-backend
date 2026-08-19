/**
 * Data Explorer vNext — filter-bar controls.
 *
 * Re-skins of the canonical DataExplorerPage filter primitives onto the vNext
 * component library (CapiroInput/CapiroSelect/CapiroPopover/CapiroButton).
 * Behavior is contract: search commits on Enter (never as-you-type), clear
 * resets both the draft and the committed query, multi-selects toggle values
 * and expose a Clear action (antd's allowClear), and the number inputs commit
 * `number | null` with the same digit-stripping the canonical page applies.
 * All labels, placeholders and option copy arrive verbatim from the callers.
 */
import type { ReactNode } from 'react';
import { CapiroInput, CapiroSelect } from '../../components/fields/index.js';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroPopover } from '../../components/menus/index.js';
import { CapiroSearchIcon } from '../../components/icons/index.js';

/* ── Filter bar shell ────────────────────────────────────────────────────── */

export function XpFilterBar({
  searchPlaceholder,
  searchInput,
  onSearchInput,
  onSearchSubmit,
  onClearSearch,
  controls,
}: {
  searchPlaceholder: string;
  searchInput: string;
  onSearchInput: (value: string) => void;
  onSearchSubmit: () => void;
  onClearSearch: () => void;
  controls: ReactNode;
}) {
  return (
    <div className="xp-filter-bar">
      <div className="xp-search">
        <span className="xp-search__icon" aria-hidden="true">
          <CapiroSearchIcon />
        </span>
        <CapiroInput
          label="Search"
          type="search"
          value={searchInput}
          placeholder={searchPlaceholder}
          onChange={(event) => onSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearchSubmit();
          }}
        />
        {searchInput ? (
          <CapiroIconButton
            className="xp-search__clear"
            label="Clear search"
            icon="×"
            onClick={onClearSearch}
          />
        ) : null}
      </div>
      <div className="xp-filter-controls">{controls}</div>
    </div>
  );
}

/* ── Multi select (facet filter) ─────────────────────────────────────────── */

export function XpMultiSelect({
  label,
  placeholder,
  options,
  values,
  onChange,
  loading,
}: {
  label: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (values: string[]) => void;
  loading?: boolean;
}) {
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };
  const summary =
    values.length === 0
      ? placeholder
      : values.length === 1
        ? (options.find((o) => o.value === values[0])?.label ?? values[0]!)
        : `${values.length} selected`;

  return (
    <div className={`xp-filter${values.length ? ' xp-filter--active' : ''}`}>
      <span className="xp-filter__label">{label}</span>
      <CapiroPopover
        label={label}
        trigger={
          <>
            <span className={`xp-filter__summary${values.length ? '' : ' xp-filter__summary--placeholder'}`}>
              {summary}
            </span>
            {values.length ? <span className="xp-filter__count">{values.length}</span> : null}
            <span className="xp-filter__chevron" aria-hidden="true">
              ▾
            </span>
          </>
        }
      >
        <div className="xp-filter__menu" role="listbox" aria-label={label} aria-multiselectable="true">
          {loading && options.length === 0 ? (
            <p className="xp-filter__note">Loading…</p>
          ) : options.length === 0 ? (
            <p className="xp-filter__note">No options available.</p>
          ) : (
            options.map((option) => {
              const selected = values.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`xp-filter__option${selected ? ' xp-filter__option--selected' : ''}`}
                  onClick={() => toggle(option.value)}
                >
                  <span className="xp-filter__optionmark" aria-hidden="true">
                    {selected ? '✓' : ''}
                  </span>
                  <span className="xp-filter__optionlabel">{option.label}</span>
                </button>
              );
            })
          )}
          {values.length ? (
            <div className="xp-filter__menufoot">
              <CapiroButton size="compact" variant="quiet" onClick={() => onChange([])}>
                Clear
              </CapiroButton>
            </div>
          ) : null}
        </div>
      </CapiroPopover>
    </div>
  );
}

/* ── Single select ───────────────────────────────────────────────────────── */

export function XpSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="xp-filter">
      <CapiroSelect
        label={label}
        className="xp-filter__select"
        options={options}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function XpSortControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return <XpSelect label="Sort" value={value} onChange={onChange} options={options} />;
}

/* ── Number range (min/max money) ────────────────────────────────────────── */

function formatRangeValue(value: number | null): string {
  // Matches the canonical antd InputNumber formatter: falsy (null or 0)
  // renders empty, everything else as $-prefixed thousands-grouped digits.
  return value ? `$${value.toLocaleString('en-US')}` : '';
}

function parseRangeInput(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
}

export function XpNumberRange({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  label: string;
  minValue: number | null;
  maxValue: number | null;
  onMinChange: (value: number | null) => void;
  onMaxChange: (value: number | null) => void;
}) {
  return (
    <div className="xp-filter">
      <span className="xp-filter__label">{label}</span>
      <span className="xp-range">
        <input
          className="capiro-input xp-range__input"
          inputMode="numeric"
          placeholder="Min"
          aria-label={`${label} minimum`}
          value={formatRangeValue(minValue)}
          onChange={(event) => onMinChange(parseRangeInput(event.target.value))}
        />
        <span className="xp-range__dash" aria-hidden="true">
          –
        </span>
        <input
          className="capiro-input xp-range__input"
          inputMode="numeric"
          placeholder="Max"
          aria-label={`${label} maximum`}
          value={formatRangeValue(maxValue)}
          onChange={(event) => onMaxChange(parseRangeInput(event.target.value))}
        />
      </span>
    </div>
  );
}

/** String-valued amount range — mirrors the canonical FEC / Federal Awards
 *  bare-Input pair: raw digit strings, no $ formatting while typing. */
export function XpAmountRangeText({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  label: string;
  minValue: string;
  maxValue: string;
  onMinChange: (value: string) => void;
  onMaxChange: (value: string) => void;
}) {
  return (
    <div className="xp-filter">
      <span className="xp-filter__label">{label}</span>
      <span className="xp-range">
        <input
          className="capiro-input xp-range__input"
          inputMode="numeric"
          placeholder="Min"
          aria-label={`${label} minimum`}
          value={minValue}
          onChange={(event) => onMinChange(event.target.value.replace(/[^\d]/g, ''))}
        />
        <span className="xp-range__dash" aria-hidden="true">
          –
        </span>
        <input
          className="capiro-input xp-range__input"
          inputMode="numeric"
          placeholder="Max"
          aria-label={`${label} maximum`}
          value={maxValue}
          onChange={(event) => onMaxChange(event.target.value.replace(/[^\d]/g, ''))}
        />
      </span>
    </div>
  );
}

/* ── Short free-text filter (NAICS / PSC / District) ─────────────────────── */

export function XpTextFilter({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  width = 110,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
  width?: number;
}) {
  return (
    <div className="xp-filter">
      <CapiroInput
        label={label}
        className="xp-range__input"
        style={{ width }}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/* ── Toggle chip ─────────────────────────────────────────────────────────── */

export function XpToggleChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="xp-filter xp-filter--chip">
      <button
        type="button"
        aria-pressed={active}
        className={`xp-toggle-chip${active ? ' xp-toggle-chip--active' : ''}`}
        onClick={onToggle}
      >
        <span className="xp-toggle-chip__box" aria-hidden="true">
          {active ? '✓' : ''}
        </span>
        {label}
      </button>
    </div>
  );
}
