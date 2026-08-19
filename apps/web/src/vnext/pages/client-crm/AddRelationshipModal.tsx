import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type { DirectoryApiResponse } from '../../../pages/directory/directoryData.js';
import type { StateLegislatorRow } from '../../../pages/directory/StateLegislatorDirectory.js';
import { searchPeople, type PeopleResponse } from '../../../pages/directory/directory-api.js';
import {
  addClientTarget,
  type ClientTarget,
  type TargetDirectory,
} from '../../../pages/clients/targets-api.js';
import {
  normalizeCongress,
  normalizeStaff,
  normalizeState,
  type NormalizedPerson,
} from '../../../pages/clients/targets-normalize.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroModal } from '../../components/overlays/index.js';
import { CapiroInput } from '../../components/fields/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { initialsFor } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import './add-relationship-modal.css';

/**
 * "Add relationship" — vNext government-target picker.
 *
 * The button used to `navigate('/clients?clientId=…&tab=targets')`, on the
 * reasoning that the antd `TargetsTab` owned the only real create flow. On
 * os.capiro.ai that is a NO-OP: `client-crm-routing`'s LEGACY_TABS maps
 * `tab=targets` straight back to `relationships/government`, i.e. the view the
 * user is already looking at. So the button did nothing at all.
 *
 * This is that flow, native to vNext. Same contract as `TargetsTab`:
 *  - Debounced (250ms) search across the THREE directories a `ClientTarget` can
 *    come from, each query independent so one directory being slow or down never
 *    blanks the others:
 *      congress → `/api/directory/contacts`          (members of Congress)
 *      staff    → `/api/directory/people`            (personal-office AND
 *                                                     committee staff — the
 *                                                     LegiStorm snapshot indexes
 *                                                     both under `staff`)
 *      state    → `/api/explorer/state-legislators`  (OpenStates legislators)
 *  - Rows are normalized to ONE shape through the shared, UI-free
 *    `targets-normalize.ts` before render, so the three very different payloads
 *    (fullName vs name, 'R' vs 'Democratic', House/Senate vs upper/lower) can
 *    never reach the JSX mixed.
 *  - Adds via `addClientTarget` and writes the `['client-targets', clientId]`
 *    cache entry — the SAME key this tab and the canonical tab both read, so an
 *    add here is immediately visible in both.
 */

const SCOPES = [
  { id: 'all', label: 'All' },
  { id: 'congress', label: 'Members' },
  { id: 'staff', label: 'Staff' },
  { id: 'state', label: 'State' },
] as const;
type Scope = (typeof SCOPES)[number]['id'];

const DIR_BADGE: Record<TargetDirectory, string> = {
  congress: 'Member',
  staff: 'Staff',
  state: 'State',
};

const MAX_ROWS = 40;

export function AddRelationshipModal({
  open,
  clientId,
  onClose,
}: {
  open: boolean;
  clientId: string;
  onClose: () => void;
}) {
  return (
    <CapiroModal open={open} title="Add relationship" onClose={onClose}>
      <AddRelationshipBody clientId={clientId} onClose={onClose} />
    </CapiroModal>
  );
}

function AddRelationshipBody({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [debounced, setDebounced] = useState('');

  // Search off the DEBOUNCED term, never the raw input: typing a name should not
  // fire three directory reads per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const wantCongress = scope === 'all' || scope === 'congress';
  const wantStaff = scope === 'all' || scope === 'staff';
  const wantState = scope === 'all' || scope === 'state';
  const active = debounced.length > 0;

  const congressQ = useQuery<DirectoryApiResponse>({
    queryKey: ['targets-congress-search', debounced],
    enabled: active && wantCongress,
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: { q: debounced, pageSize: 25, sort: 'name-asc' },
        })
      ).data,
    retry: 1,
  });

  const staffQ = useQuery<PeopleResponse>({
    queryKey: ['targets-staff-search', debounced],
    enabled: active && wantStaff,
    queryFn: () => searchPeople(api, { q: debounced, personType: 'staff', pageSize: 25 }),
    retry: 1,
  });

  const stateQ = useQuery<{ rows: StateLegislatorRow[]; total: number }>({
    queryKey: ['targets-state-search', debounced],
    enabled: active && wantState,
    queryFn: async () =>
      (
        await api.get<{ rows: StateLegislatorRow[]; total: number }>('/api/explorer/state-legislators', {
          params: { q: debounced, pageSize: 25 },
        })
      ).data,
    retry: 1,
  });

  // Already-added members are shown as added rather than hidden, so a repeat
  // search does not silently look like the person is missing from the directory.
  const targets = qc.getQueryData<ClientTarget[]>(['client-targets', clientId]) ?? [];
  const addedIds = useMemo(() => new Set(targets.map((t) => t.memberId)), [targets]);

  const debouncePending = query.trim() !== debounced;

  /**
   * Normalize whatever each source has returned so far, then cap. Wrapped so one
   * malformed row cannot throw during render, and gated only on the debounce —
   * a source that already answered renders immediately even while a sibling is
   * still in flight.
   */
  const rows = useMemo<NormalizedPerson[]>(() => {
    if (!active || debouncePending) return [];
    const out: NormalizedPerson[] = [];
    try {
      if (wantCongress) {
        for (const entry of congressQ.data?.contacts ?? []) {
          if (entry && typeof entry.id === 'string') out.push(normalizeCongress(entry));
        }
      }
      if (wantStaff) {
        for (const person of staffQ.data?.people ?? []) {
          if (person && typeof person.id === 'string' && person.personType === 'staff') {
            out.push(normalizeStaff(person));
          }
        }
      }
      if (wantState) {
        for (const row of stateQ.data?.rows ?? []) {
          if (row && typeof row.id === 'string') out.push(normalizeState(row));
        }
      }
    } catch {
      return [];
    }
    return out.slice(0, MAX_ROWS);
  }, [
    active,
    debouncePending,
    wantCongress,
    wantStaff,
    wantState,
    congressQ.data,
    staffQ.data,
    stateQ.data,
  ]);

  const congressPending = wantCongress && congressQ.isFetching && !congressQ.data;
  const staffPending = wantStaff && staffQ.isFetching && !staffQ.data;
  const statePending = wantState && stateQ.isFetching && !stateQ.data;
  const searching = active && (debouncePending || ((congressPending || staffPending || statePending) && rows.length === 0));

  // A directory that errored contributes zero rows through the `?? []` above, so
  // "No matches" would otherwise be indistinguishable from an exhaustive search.
  const failed = [
    wantCongress && congressQ.isError ? 'members' : null,
    wantStaff && staffQ.isError ? 'staff' : null,
    wantState && stateQ.isError ? 'state legislators' : null,
  ].filter(Boolean) as string[];

  const add = useMutation({
    mutationFn: (person: NormalizedPerson) =>
      addClientTarget(api, clientId, person.id, 'manual', person.sourceDirectory),
    onSuccess: (target, person) => {
      toast.success(`${person.name} added`);
      // Seed the shared cache entry so the row flips to "Added" without waiting
      // for the refetch, then reconcile from the server.
      qc.setQueryData<ClientTarget[]>(['client-targets', clientId], (prev) =>
        prev ? [...prev.filter((t) => t.memberId !== target.memberId), target] : [target],
      );
      void qc.invalidateQueries({ queryKey: ['client-targets', clientId] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="capiro-addrel">
      <p className="capiro-addrel__hint">
        Search everyone in the Capiro directory — members of Congress, personal-office and committee
        staff, and state legislators — and add them as a government target for this client.
      </p>

      <CapiroInput
        label="Search the directory"
        placeholder="Name, e.g. Cornyn"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="capiro-addrel__scopes" role="group" aria-label="Directory">
        {SCOPES.map((option) => (
          <button
            type="button"
            key={option.id}
            className={`capiro-addrel__scope${scope === option.id ? ' is-active' : ''}`}
            aria-pressed={scope === option.id}
            onClick={() => setScope(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="capiro-addrel__results" aria-busy={searching || undefined}>
        {!active ? (
          <p className="capiro-addrel__empty">Type a name to search the directory.</p>
        ) : searching ? (
          <p className="capiro-addrel__empty">Searching…</p>
        ) : rows.length === 0 ? (
          <p className="capiro-addrel__empty">
            No matches for “{debounced}”.
            {failed.length ? ` The ${failed.join(' and ')} directory could not be reached, so this may be incomplete.` : ''}
          </p>
        ) : (
          <>
            {failed.length ? (
              <p className="capiro-addrel__warn">
                The {failed.join(' and ')} directory could not be reached — these results are incomplete.
              </p>
            ) : null}
            <ul className="capiro-addrel__list">
              {rows.map((person) => (
                <ResultRow
                  key={`${person.sourceDirectory}:${person.id}`}
                  person={person}
                  added={addedIds.has(person.id)}
                  adding={add.isPending && add.variables?.id === person.id}
                  onAdd={() => add.mutate(person)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="capiro-addrel__footer">
        <CapiroButton variant="secondary" size="compact" onClick={onClose}>
          Done
        </CapiroButton>
      </div>
    </div>
  );
}

function ResultRow({
  person,
  added,
  adding,
  onAdd,
}: {
  person: NormalizedPerson;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
}) {
  // Every one of these is omitted when the source did not supply it — a staffer
  // has no chamber, a state legislator has no committee. None are invented.
  const meta = [
    person.chamberLabel,
    person.stateLabel,
    person.partyShort,
    person.committee,
  ].filter(Boolean);

  return (
    <li className="capiro-addrel__row">
      <span className="capiro-addrel__avatar" aria-hidden>
        {initialsFor(person.name)}
      </span>
      <span className="capiro-addrel__who">
        <span className="capiro-addrel__name">{person.name}</span>
        <span className="capiro-addrel__meta">
          <span className="capiro-addrel__dir">{DIR_BADGE[person.sourceDirectory]}</span>
          {meta.length ? ` · ${meta.join(' · ')}` : ''}
        </span>
      </span>
      {added ? (
        <span className="capiro-addrel__added">Added</span>
      ) : (
        <CapiroButton variant="secondary" size="compact" loading={adding} onClick={onAdd}>
          Add
        </CapiroButton>
      )}
    </li>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Could not add the target';
}
