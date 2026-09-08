import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../../lib/use-api.js';
import './report-target-directory.css';

/** The member identity is also the identity returned for staff email activity. */
export interface DirectoryContactOption {
  id: string;
  fullName: string;
  title?: string;
  chamber?: string;
  state?: string;
  district?: string;
  committees?: string[];
  officeLocation?: string;
  staff?: Array<{ fullName?: string; name?: string }>;
}

export function directoryTargetDefaults(contact: DirectoryContactOption) {
  return {
    memberPrincipal: contact.fullName.slice(0, 240),
    committee: (contact.committees ?? []).join('; ').slice(0, 120),
    building: (contact.officeLocation ?? '').slice(0, 120),
    // Several staffers are not a single responsible contact. Let the user choose.
    staffer:
      contact.staff?.length === 1
        ? (contact.staff[0]?.fullName ?? contact.staff[0]?.name ?? '').slice(0, 160)
        : '',
  };
}

export function reportClientLabel(row: {
  clientId: string | null;
  clientName: string | null;
  scopeKey: string;
}) {
  return (
    row.clientName ||
    (row.clientId
      ? `Client ${row.clientId}`
      : row.scopeKey !== 'all'
        ? `Client ${row.scopeKey}`
        : 'Unassigned · select a client')
  );
}

export function ReportTargetDirectory({
  value,
  onSelect,
  onClear,
  disabled = false,
}: {
  value: DirectoryContactOption | null;
  onSelect: (contact: DirectoryContactOption) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const api = useApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const listId = useId();
  const [query, setQuery] = useState(value?.fullName ?? '');
  const [options, setOptions] = useState<DirectoryContactOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searchRevision, setSearchRevision] = useState(0);
  const sequence = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  function dismiss() {
    sequence.current += 1;
    setOpen(false);
    setSearching(false);
    setActive(-1);
  }

  useEffect(() => {
    if (value) {
      sequence.current += 1;
      setQuery(value.fullName);
      setOpen(false);
      setSearching(false);
      setOptions([]);
    }
  }, [value]);

  useEffect(() => {
    const current = ++sequence.current;
    if (value || query.trim().length < 2 || !open) return;
    setSearching(true);
    setError(false);
    const timer = window.setTimeout(() => {
      void apiRef.current
        .get<{ contacts: DirectoryContactOption[] }>('/api/directory/contacts', {
          params: { q: query.trim(), limit: 20 },
        })
        .then(({ data }) => {
          if (current !== sequence.current) return;
          setOptions(data.contacts ?? []);
          setSearching(false);
        })
        .catch(() => {
          if (current !== sequence.current) return;
          setOptions([]);
          setSearching(false);
          setError(true);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      sequence.current += 1;
    };
  }, [query, value, open, searchRevision]);

  useEffect(() => {
    function outside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    }
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
      sequence.current += 1;
    };
  }, []);

  function choose(contact: DirectoryContactOption) {
    dismiss();
    setQuery(contact.fullName);
    setOptions([]);
    onSelect(contact);
  }

  return (
    <div ref={rootRef} className="engagement-dialog__field is-full report-target-directory">
      <label htmlFor={`${listId}-input`}>Find member / principal in Directory</label>
      <input
        id={`${listId}-input`}
        role="combobox"
        autoComplete="off"
        disabled={disabled}
        aria-autocomplete="list"
        aria-expanded={open && !value}
        aria-controls={open && !value ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={query}
        placeholder="Search name, chamber or district"
        onChange={(event) => {
          sequence.current += 1; // Invalidate before the next debounce or React effect.
          onClear();
          setQuery(event.target.value);
          setOptions([]);
          setActive(-1);
          setError(false);
          setSearching(event.target.value.trim().length >= 2);
          setOpen(event.target.value.trim().length >= 2);
        }}
        onFocus={() => {
          if (!value && query.trim().length >= 2) {
            setOpen(true);
            setSearchRevision((n) => n + 1);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!value) setOpen(query.trim().length >= 2);
            setActive((index) =>
              options.length
                ? index < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : options.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
                : -1,
            );
          }
          if (event.key === 'Enter' && open) {
            event.preventDefault();
            if (options[active]) choose(options[active]);
          }
          if (event.key === 'Tab') dismiss();
        }}
      />
      {open && !value && (
        <div className="report-target-directory__results">
          {searching && <p role="status">Searching Directory…</p>}
          {error && (
            <p role="alert">
              Directory search failed.{' '}
              <button
                type="button"
                disabled={disabled}
                onClick={() => setSearchRevision((n) => n + 1)}
              >
                Retry search
              </button>
            </p>
          )}
          {!searching && !error && !options.length && (
            <p role="status">
              No matching Directory records. Try another name, or explicitly save a manual-only
              target below.
            </p>
          )}
          <div
            id={listId}
            role="listbox"
            aria-label="Directory matches"
            className="report-target-directory__list"
          >
            {options.map((contact, index) => (
              <button
                id={`${listId}-${index}`}
                key={contact.id}
                type="button"
                role="option"
                className="report-target-directory__option"
                disabled={disabled}
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(contact)}
              >
                <strong>{contact.fullName}</strong>
                {' · '}
                {[
                  contact.chamber,
                  contact.district || contact.state,
                  contact.title,
                  ...(contact.committees ?? []),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </button>
            ))}
          </div>
        </div>
      )}
      {value && (
        <span className="report-target-directory__selection">
          Linked to Directory · {value.fullName}{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              dismiss();
              setQuery('');
              setOptions([]);
              onClear();
            }}
          >
            Clear selection
          </button>
        </span>
      )}
    </div>
  );
}
