import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { OpportunitySearchCriteriaV2, SavedSearchSummaryV2 } from '@capiro/shared';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';
import { FundingOpportunitiesV2ClientModal } from './FundingOpportunitiesV2ClientModal.js';
import type {
  FundingOpportunityV2Api,
  SavedSearchRecordV2,
} from './FundingOpportunitiesV2Adapter.js';
import {
  TYPE_OPTIONS,
  V2_FILTER_GROUPS,
  updateCriteria,
} from './funding-opportunities-v2-state.js';
import './funding-opportunities-v2-saved-searches.css';

type ClientLite = { id: string; name: string; status?: string; meta?: string };
type Visibility = 'private' | 'tenant';

type Props = {
  api: FundingOpportunityV2Api;
  criteria: OpportunitySearchCriteriaV2;
  clientName?: string;
  clients: ClientLite[];
  currentUserId?: string | null;
  currentUserRole?: string | null;
  searches: SavedSearchRecordV2[];
  loading: boolean;
  error: boolean;
  open: boolean;
  saveOpen: boolean;
  onClose: (keepParent?: boolean) => void;
  onOpenSave: (fromSaved?: boolean) => void;
  onSaved: () => Promise<void> | void;
  onApplyCriteria: (
    criteria: OpportunitySearchCriteriaV2,
    response?: unknown,
    savedSearchId?: string,
  ) => void;
  onApplyAndRefresh: (
    criteria: OpportunitySearchCriteriaV2,
    response?: unknown,
    savedSearchId?: string,
  ) => Promise<void> | void;
  activeSavedSearchId?: string | null;
  saveOpenedFromSaved?: boolean;
  onToast: (kind: 'success' | 'error', message: string) => void;
};

function semanticCriteria(criteria: OpportunitySearchCriteriaV2): string {
  const value = { ...criteria, page: 1 } as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (Array.isArray(value[key])) value[key] = [...(value[key] as unknown[])].map(String).sort();
  return JSON.stringify(value, Object.keys(value).sort());
}
function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '—'
  );
}
function relativeDate(value: string | null | undefined) {
  if (!value) return 'Not run yet';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'Last run unavailable';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 60) return `Last run ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last run ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Last run ${days === 1 ? 'yesterday' : `${days}d ago`}`;
}
function optionLabel(group: string, value: string): string {
  const options = V2_FILTER_GROUPS.find((item) => item.key === group)?.options;
  return options?.find((item) => item.value === value)?.label ?? value.replaceAll('_', ' ');
}
function listLabel(group: string, values: readonly string[], fallback: string): string {
  return values.length ? values.map((value) => optionLabel(group, value)).join(' and ') : fallback;
}
function savedCriteriaSentence(
  criteria: OpportunitySearchCriteriaV2,
  clientName?: string | null,
): string {
  const lifecycle = criteria.lifecycle.length
    ? criteria.lifecycle
        .map((value) =>
          value === 'active'
            ? 'Active'
            : value === 'forecast'
              ? 'Forecasted'
              : optionLabel('lifecycle', value),
        )
        .join(' and ')
    : 'Any lifecycle';
  const types = criteria.types.length
    ? criteria.types
        .map((value) =>
          value === 'solicitation'
            ? 'contracts'
            : (TYPE_OPTIONS.find((item) => item.value === value)?.label.toLowerCase() ??
              optionLabel('types', value)),
        )
        .join(' and ')
    : 'opportunities';
  const client = criteria.clientId ? (clientName ?? 'this client') : 'all clients';
  const sectors = criteria.sectors.length
    ? criteria.sectors.map((value) => optionLabel('sectors', value).toLowerCase()).join(' and ')
    : 'any sector';
  const agency = criteria.agencies.length
    ? criteria.agencies
        .map((value) => optionLabel('agencies', value).replace('Department of the ', 'the '))
        .join(' and ')
    : 'any agency';
  const codes = [
    ...criteria.naicsCodes.map((value) => `NAICS ${value}`),
    ...criteria.pscCodes.map((value) => `PSC ${value}`),
    ...criteria.codes.map((value) => optionLabel('codes', value)),
  ];
  const details = [
    criteria.posted.length ? `posted ${listLabel('posted', criteria.posted, '')}` : '',
    criteria.applicantTypes.length
      ? `applicant type ${listLabel('applicantTypes', criteria.applicantTypes, '')}`
      : '',
    criteria.funding.length ? listLabel('funding', criteria.funding, '') : '',
    criteria.costShare.length ? `cost share ${listLabel('costShare', criteria.costShare, '')}` : '',
    criteria.methods.length ? `response by ${listLabel('methods', criteria.methods, '')}` : '',
    criteria.disbursement.length
      ? `disbursement ${listLabel('disbursement', criteria.disbursement, '')}`
      : '',
    criteria.grantPrerequisites.length
      ? listLabel('grantPrerequisites', criteria.grantPrerequisites, '')
      : '',
    criteria.setAsideCodes.length
      ? `set-aside ${listLabel('setAsideCodes', criteria.setAsideCodes, '')}`
      : '',
  ].filter(Boolean);
  const deadline =
    criteria.deadlineWindow !== 'any'
      ? `deadlines within ${criteria.deadlineWindow.replace('d', ' days')}`
      : criteria.deadlineFrom || criteria.deadlineTo
        ? `deadlines ${criteria.deadlineFrom ? `from ${criteria.deadlineFrom.slice(0, 10)}` : ''}${criteria.deadlineTo ? ` to ${criteria.deadlineTo.slice(0, 10)}` : ''}`
        : 'any deadline';
  const geography = criteria.geography.length
    ? `${listLabel('geography', criteria.geography, '')} only`
    : '';
  const eligibility = criteria.eligibility.length
    ? criteria.eligibility
        .map((value) =>
          value === 'eligible'
            ? 'the client meets stated eligibility'
            : value === 'unknown'
              ? 'eligibility is unresolved'
              : optionLabel('eligibility', value),
        )
        .join(' or ')
    : 'any eligibility';
  return `${lifecycle} ${types} for ${client} in ${sectors}, from ${agency}${codes.length ? `, ${codes.join(' and ')}` : ''}${details.length ? `, ${details.join(', ')}` : ''}${geography ? `, ${geography}` : ''}, ${deadline}, ${eligibility}.`;
}
function changedCriteriaNote(
  saved: OpportunitySearchCriteriaV2,
  current: OpportunitySearchCriteriaV2,
): string | null {
  const fields: Array<[keyof OpportunitySearchCriteriaV2, string]> = [
    ['lifecycle', 'lifecycle'],
    ['types', 'type'],
    ['agencies', 'agency'],
    ['sectors', 'sector'],
    ['naicsCodes', 'NAICS code'],
    ['pscCodes', 'PSC code'],
    ['posted', 'posted window'],
    ['geography', 'geography'],
    ['applicantTypes', 'applicant type'],
    ['funding', 'funding'],
    ['costShare', 'cost share'],
    ['methods', 'response method'],
    ['disbursement', 'disbursement'],
    ['grantPrerequisites', 'prerequisite'],
    ['setAsideCodes', 'set-aside'],
    ['codes', 'classification code'],
    ['sources', 'source'],
    ['eligibility', 'eligibility'],
  ];
  const additions: string[] = [];
  for (const [key, label] of fields) {
    const before = new Set(Array.isArray(saved[key]) ? saved[key].map(String) : []);
    const added = (Array.isArray(current[key]) ? current[key].map(String) : []).filter(
      (value) => !before.has(value),
    );
    additions.push(...added.map((value) => `${label} “${value.replaceAll('_', ' ')}”`));
  }
  if (current.deadlineWindow !== saved.deadlineWindow)
    additions.push(`deadline window “${current.deadlineWindow}”`);
  if (current.query !== saved.query && current.query) additions.push(`keyword “${current.query}”`);
  return additions.length
    ? `Current criteria differ: added ${additions.slice(0, 3).join(', ')}${additions.length > 3 ? ` and ${additions.length - 3} more` : ''}.`
    : 'Current criteria differ from this saved search.';
}
function warningText(search: SavedSearchRecordV2) {
  return search.warnings.length
    ? `This search needs migration before it can be applied. Original criteria are preserved (${search.warnings.length} warning${search.warnings.length === 1 ? '' : 's'}).`
    : '';
}

export function FundingOpportunitiesV2SavedSearches({
  api,
  criteria,
  clientName,
  clients,
  currentUserId,
  currentUserRole,
  searches,
  loading,
  error,
  open,
  saveOpen,
  onClose,
  onOpenSave,
  onSaved,
  onApplyCriteria,
  onApplyAndRefresh,
  onToast,
  activeSavedSearchId,
  saveOpenedFromSaved = false,
}: Props) {
  const [selected, setSelected] = useState<SavedSearchRecordV2 | null>(null);
  const [nested, setNested] = useState<'rename' | 'archive' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [saveClientId, setSaveClientId] = useState(criteria.clientId);
  const [saveCriteria, setSaveCriteria] = useState(criteria);
  const [keywordRemoved, setKeywordRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const savedRootRef = useRef<HTMLDivElement>(null);
  const saveRootRef = useRef<HTMLDivElement>(null);
  const nestedRootRef = useRef<HTMLDivElement>(null);
  const savedCloseRef = useRef<HTMLButtonElement>(null);
  const saveNameRef = useRef<HTMLInputElement>(null);
  const clientTriggerRef = useRef<HTMLButtonElement>(null);
  const savedRestoreFocus = useRef<HTMLElement | null>(null);
  const savedSaveTriggerFocus = useRef<HTMLElement | null>(null);
  const saveRestoreFocus = useRef<HTMLElement | null>(null);
  const nestedRestoreFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const wasSaveOpen = useRef(false);
  const previousNested = useRef<typeof nested>(null);
  const changed = useMemo(() => semanticCriteria(criteria), [criteria]);

  useEffect(() => {
    if (saveOpen) {
      setName('');
      setDescription('');
      setVisibility('private');
      setSaveClientId(criteria.clientId);
      setSaveCriteria(criteria);
      setKeywordRemoved(false);
    } else setClientPickerOpen(false);
  }, [saveOpen]);
  useEffect(() => {
    if (open && !wasOpen.current) {
      savedRestoreFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      savedCloseRef.current?.focus();
    }
    if (saveOpen && !wasSaveOpen.current) {
      saveRestoreFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      saveNameRef.current?.focus();
    }
    if (nested === null && previousNested.current !== null) nestedRestoreFocus.current?.focus();
    if (wasOpen.current && !open && !saveOpen && !nested) {
      savedRestoreFocus.current?.focus();
      savedRestoreFocus.current = null;
    }
    if (saveOpenedFromSaved && !saveOpen && open && wasOpen.current) {
      savedSaveTriggerFocus.current?.focus();
    }
    if (wasSaveOpen.current && !saveOpen && !saveOpenedFromSaved && !open && !nested) {
      saveRestoreFocus.current?.focus();
      saveRestoreFocus.current = null;
    }
    wasOpen.current = open;
    wasSaveOpen.current = saveOpen;
    previousNested.current = nested;
  }, [open, saveOpen, nested, saveOpenedFromSaved]);
  useEffect(() => {
    if (!open && !saveOpen && !nested) return;
    const onKey = (event: KeyboardEvent) => {
      const root = nested
        ? nestedRootRef.current
        : saveOpen
          ? saveRootRef.current
          : open
            ? savedRootRef.current
            : null;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (nested) setNested(null);
        else if (saveOpen && clientPickerOpen) {
          setClientPickerOpen(false);
          clientTriggerRef.current?.focus();
        } else if (saveOpen) onClose(saveOpenedFromSaved);
        else onClose(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = root
        ? [
            ...root.querySelectorAll<HTMLElement>('button,input,textarea,select,[href],[tabindex]'),
          ].filter(
            (item) =>
              item.tabIndex >= 0 &&
              !item.hasAttribute('disabled') &&
              !item.hidden &&
              item.getAttribute('aria-hidden') !== 'true' &&
              !item.closest('[inert]'),
          )
        : [];
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, saveOpen, nested, clientPickerOpen, onClose, saveOpenedFromSaved]);

  function rememberFocus() {
    savedSaveTriggerFocus.current = document.activeElement as HTMLElement;
  }
  function rememberNestedFocus() {
    nestedRestoreFocus.current = document.activeElement as HTMLElement;
  }
  async function apply(search: SavedSearchRecordV2, refresh: boolean) {
    if (search.archivedAt) {
      onToast('error', 'Archived saved searches cannot be applied.');
      return;
    }
    if (search.warnings.length) {
      onToast('error', 'This saved search needs migration before it can be applied.');
      return;
    }
    setBusy(true);
    try {
      const response = await api.applySearch(search.id);
      const next = response.criteria ?? search.criteria;
      if (refresh) await onApplyAndRefresh(next, response, search.id);
      else onApplyCriteria(next, response, search.id);
      onClose();
      onToast('success', 'Saved search applied.');
    } catch {
      onToast('error', 'The saved search could not be applied.');
    } finally {
      setBusy(false);
    }
  }
  async function mutate(work: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true);
    try {
      await work();
      await onSaved();
      setNested(null);
      onToast('success', success);
      return true;
    } catch {
      onToast('error', 'The saved search could not be updated.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!name.trim()) return;
    const ok = await mutate(
      () =>
        api.saveSearch({
          name: name.trim(),
          description: description.trim() || undefined,
          visibility,
          clientId: saveClientId,
          criteria: saveCriteria,
        }),
      'Search saved.',
    );
    if (ok) onClose(false);
  }
  const openSearch = (search: SavedSearchRecordV2) => {
    setSelected(search);
    setName(search.name);
    setDescription(search.description ?? '');
    setVisibility(search.visibility);
    rememberNestedFocus();
    setNested('rename');
  };
  const canWrite = (search: SavedSearchRecordV2) =>
    Boolean(currentUserId) &&
    (search.ownerId === currentUserId ||
      search.createdByUserId === currentUserId ||
      currentUserRole === 'user_admin' ||
      currentUserRole === 'capiro_admin');
  const scopeNote = `Scoped to ${clientName ?? 'the selected client'} by default, in matched and all-opportunities mode alike. Tenant-wide searches are marked and read-only unless you own them.`;

  if (!open && !saveOpen) return null;
  return (
    <>
      {open ? (
        <div
          ref={savedRootRef}
          className="fo-saved-overlay"
          data-saved-search-overlay="true"
          role="dialog"
          aria-modal="true"
          aria-label="Saved searches"
        >
          <button
            tabIndex={-1}
            className="fo-saved-backdrop"
            aria-label="Close saved searches"
            onClick={() => onClose()}
          />
          <aside className="fo-saved-drawer">
            <header className="fo-saved-header">
              <div>
                <h2>Saved searches</h2>
                <p>{scopeNote}</p>
              </div>
              <button
                ref={savedCloseRef}
                className="fo-saved-icon"
                aria-label="Close"
                onClick={() => onClose()}
              >
                <FundingOpportunityV2Icon name="XClose" size={20} />
              </button>
            </header>
            <div className="fo-saved-scroll">
              {loading ? (
                <div className="fo-saved-state" aria-busy="true">
                  Loading saved searches…
                </div>
              ) : error ? (
                <div className="fo-saved-state fo-saved-state--error">
                  <strong>Saved searches could not be loaded</strong>
                  <p>No stale list is shown after a failed request.</p>
                </div>
              ) : searches.length === 0 ? (
                <div className="fo-saved-state">
                  <strong>No saved searches yet</strong>
                  <p>Save the current typed criteria to use it again.</p>
                </div>
              ) : (
                searches.map((search) => {
                  const isActive = activeSavedSearchId === search.id;
                  const isChanged = isActive && semanticCriteria(search.criteria) !== changed;
                  const readOnly = !canWrite(search);
                  return (
                    <section className="fo-saved-card" key={search.id}>
                      <div className="fo-saved-card-body">
                        <div className="fo-saved-card-title">
                          <strong>{search.name}</strong>
                          <span className={`fo-saved-pill fo-saved-pill--${search.visibility}`}>
                            {search.isTenantWide
                              ? 'Tenant-wide'
                              : search.visibility === 'tenant'
                                ? 'Shared with tenant'
                                : 'Private'}
                          </span>
                          {search.archivedAt ? (
                            <span className="fo-saved-pill fo-saved-pill--archived">Archived</span>
                          ) : null}
                          {isChanged ? (
                            <span className="fo-saved-pill fo-saved-pill--changed">
                              Criteria changed
                            </span>
                          ) : null}
                        </div>
                        <p className="fo-saved-sentence">
                          {savedCriteriaSentence(
                            search.criteria,
                            search.clientName ?? (search.criteria.clientId ? clientName : null),
                          )}
                        </p>
                        <div className="fo-saved-keywords">
                          <span>KEYWORDS</span>
                          <code>
                            {search.criteria.query
                              ? `“${search.criteria.query}”`
                              : 'No keywords — filters only'}
                          </code>
                        </div>
                        <div className="fo-saved-meta">
                          <span>{relativeDate(search.lastAppliedAt)}</span>
                          <i />{' '}
                          <span>
                            {search.lastRunResultCount == null
                              ? '? results at last run'
                              : `${search.lastRunResultCount} results at last run`}
                          </span>
                          <i />{' '}
                          <span>
                            {search.clientName ??
                              (search.isTenantWide ? 'Tenant-wide' : 'Client scope')}
                          </span>
                        </div>
                        {isChanged ? (
                          <p className="fo-saved-warning">
                            {changedCriteriaNote(search.criteria, criteria)}
                          </p>
                        ) : null}
                        {search.warnings.length ? (
                          <p className="fo-saved-warning">{warningText(search)}</p>
                        ) : null}
                        {search.archivedAt ? (
                          <p className="fo-saved-warning">
                            This record remains readable and retains its original client scope.
                          </p>
                        ) : null}
                      </div>
                      <footer className="fo-saved-card-footer">
                        <button
                          disabled={
                            busy || Boolean(search.archivedAt) || search.warnings.length > 0
                          }
                          onClick={() => void apply(search, false)}
                        >
                          Apply
                        </button>
                        <button
                          className="fo-saved-refresh"
                          disabled={
                            busy || Boolean(search.archivedAt) || search.warnings.length > 0
                          }
                          onClick={() => void apply(search, true)}
                        >
                          <FundingOpportunityV2Icon name="RefreshCw01" size={16} />
                          Apply and refresh
                        </button>
                        <span />
                        <button
                          disabled={busy || readOnly}
                          title={readOnly ? 'Read-only tenant search' : 'Rename'}
                          aria-label={`Rename ${search.name}`}
                          onClick={() => openSearch(search)}
                        >
                          <FundingOpportunityV2Icon name="Edit01" size={16} />
                        </button>
                        <button
                          disabled={busy || readOnly}
                          title="Duplicate"
                          aria-label={`Duplicate ${search.name}`}
                          onClick={() =>
                            void mutate(
                              () => api.duplicateSearch(search.id, `${search.name} copy`),
                              'Search duplicated.',
                            )
                          }
                        >
                          <FundingOpportunityV2Icon name="Copy01" size={16} />
                        </button>
                        <button
                          disabled={busy || readOnly}
                          title="Archive"
                          aria-label={`Archive ${search.name}`}
                          onClick={() => {
                            rememberNestedFocus();
                            setSelected(search);
                            setNested('archive');
                          }}
                        >
                          <FundingOpportunityV2Icon name="Archive" size={16} />
                        </button>
                        <button
                          disabled={busy || readOnly}
                          title="Delete"
                          aria-label={`Delete ${search.name}`}
                          onClick={() => {
                            rememberNestedFocus();
                            setSelected(search);
                            setNested('delete');
                          }}
                        >
                          <FundingOpportunityV2Icon name="Trash01" size={16} />
                        </button>
                      </footer>
                    </section>
                  );
                })
              )}
              <section className="fo-saved-alerts">
                <div>
                  <strong>Alerts</strong>
                  <span>Not in this release</span>
                </div>
                <p>
                  Cadence, channels, deadline threshold and new-versus-changed preference are stored
                  on every saved search so alerts can be switched on later. Nothing is delivered
                  until unsubscribe, deduplication and audit logging are specified.
                </p>
              </section>
            </div>
            <footer className="fo-saved-footer">
              <span>Switching client never applies another client's criteria.</span>
              <button
                onClick={() => {
                  rememberFocus();
                  onOpenSave(true);
                }}
              >
                Save current search
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
      {saveOpen ? (
        <SaveDialog
          rootRef={saveRootRef}
          nameRef={saveNameRef}
          clientTriggerRef={clientTriggerRef}
          clientPickerOpen={clientPickerOpen}
          setClientPickerOpen={setClientPickerOpen}
          criteria={saveCriteria}
          clients={clients}
          clientId={saveClientId}
          name={name}
          description={description}
          visibility={visibility}
          keywordRemoved={keywordRemoved}
          busy={busy}
          onName={setName}
          onDescription={setDescription}
          onVisibility={setVisibility}
          onClient={(id) => {
            setSaveClientId(id);
            setSaveCriteria(
              updateCriteria(saveCriteria, { clientId: id, mode: id ? saveCriteria.mode : 'all' }),
            );
          }}
          onRemoveKeywords={() => {
            setKeywordRemoved(true);
            setSaveCriteria(updateCriteria(saveCriteria, { query: '' }));
          }}
          onClose={() => onClose(true)}
          onSave={() => void save()}
        />
      ) : null}
      {nested && selected ? (
        <ConfirmDialog
          rootRef={nestedRootRef}
          search={selected}
          mode={nested}
          busy={busy}
          onClose={() => setNested(null)}
          onRename={(next) =>
            void mutate(
              () => api.updateSearch(selected.id, { name: next.trim() }),
              'Search renamed.',
            )
          }
          onConfirm={() =>
            void mutate(
              () =>
                nested === 'archive'
                  ? api.updateSearch(selected.id, { archived: true })
                  : api.deleteSearch(selected.id),
              nested === 'archive' ? 'Search archived.' : 'Search deleted.',
            )
          }
        />
      ) : null}
    </>
  );
}

function SaveDialog({
  rootRef,
  nameRef,
  clientTriggerRef,
  clientPickerOpen,
  setClientPickerOpen,
  criteria,
  clients,
  clientId,
  name,
  description,
  visibility,
  keywordRemoved,
  busy,
  onName,
  onDescription,
  onVisibility,
  onClient,
  onRemoveKeywords,
  onClose,
  onSave,
}: {
  rootRef: RefObject<HTMLDivElement>;
  nameRef: RefObject<HTMLInputElement>;
  clientTriggerRef: RefObject<HTMLButtonElement>;
  clientPickerOpen: boolean;
  setClientPickerOpen: (open: boolean) => void;
  criteria: OpportunitySearchCriteriaV2;
  clients: ClientLite[];
  clientId: string | null;
  name: string;
  description: string;
  visibility: Visibility;
  keywordRemoved: boolean;
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onVisibility: (value: Visibility) => void;
  onClient: (id: string | null) => void;
  onRemoveKeywords: () => void;
  onClose: (keepParent?: boolean) => void;
  onSave: () => void;
}) {
  const selectedClient = clients.find((client) => client.id === clientId);
  const chips = criteriaChips(criteria);
  if (criteria.query) chips.unshift(`“${criteria.query}”`);
  return (
    <div
      ref={rootRef}
      className="fo-saved-modal"
      data-saved-search-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label="Save search"
    >
      <div className="fo-saved-modal-card">
        <header className="fo-saved-header">
          <div>
            <span className="fo-saved-eyebrow">Saved search</span>
            <h2>Save current search</h2>
            <p>
              {selectedClient
                ? `Stored against ${selectedClient.name} only. Switching client never applies another client’s criteria.`
                : 'Stored tenant-wide. Switching client never applies another client’s criteria.'}
            </p>
          </div>
          <button className="fo-saved-icon" aria-label="Close" onClick={() => onClose()}>
            <FundingOpportunityV2Icon name="XClose" size={20} />
          </button>
        </header>
        <div className="fo-saved-form">
          <label>
            <span>Name — required</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => onName(event.target.value)}
            />
          </label>
          <label>
            <span>Description — optional</span>
            <textarea
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              placeholder="Why this search exists, for whoever applies it next."
            />
          </label>
          <section className="fo-saved-criteria">
            <span className="fo-saved-eyebrow">Criteria to be stored</span>
            <div className="fo-saved-keywords">
              <span>KEYWORDS</span>
              <code>
                {criteria.query
                  ? `“${criteria.query}”`
                  : 'None — this search would match on filters alone'}
              </code>
              {criteria.query ? (
                <button onClick={onRemoveKeywords}>Save without keywords</button>
              ) : null}
            </div>
            <div className="fo-saved-chips">
              {chips.map((chip) => (
                <span key={chip}>{chip}</span>
              ))}
            </div>
            <p>
              {keywordRemoved
                ? 'Saved without keywords. The current discovery query remains unchanged.'
                : 'The keyword query is stored alongside the typed filter fields, sort and page size, under schema version 2. The sentence and the URL are generated from them.'}
            </p>
          </section>
          <section className="fo-saved-client">
            <b>{initials(selectedClient?.name ?? 'Tenant-wide')}</b>
            <span>
              <strong>{selectedClient?.name ?? 'Tenant-wide search'}</strong>
              <small>
                {selectedClient?.meta ??
                  (clientId ? 'Client criteria and metadata' : 'Tenant-wide criteria and metadata')}
              </small>
            </span>
            <button
              ref={clientTriggerRef}
              type="button"
              onClick={() => setClientPickerOpen(!clientPickerOpen)}
            >
              Change
            </button>
            {clientPickerOpen ? (
              <FundingOpportunitiesV2ClientModal
                clients={clients}
                selected={clientId}
                onChoose={(id) => {
                  onClient(id);
                  setClientPickerOpen(false);
                }}
                onClose={() => setClientPickerOpen(false)}
                returnFocusRef={clientTriggerRef}
              />
            ) : null}
          </section>
          <fieldset>
            <legend>Visibility</legend>
            <label>
              <input
                type="radio"
                name="saved-search-visibility"
                checked={visibility === 'private'}
                onChange={() => onVisibility('private')}
              />
              <span className="fo-saved-visibility-dot" aria-hidden="true" />
              <span className="fo-saved-visibility-copy">
                <span className="fo-saved-visibility-title">Private to me</span>
                <span className="fo-saved-visibility-description">
                  Only you can apply, edit or delete it.
                </span>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="saved-search-visibility"
                checked={visibility === 'tenant'}
                onChange={() => onVisibility('tenant')}
              />
              <span className="fo-saved-visibility-dot" aria-hidden="true" />
              <span className="fo-saved-visibility-copy">
                <span className="fo-saved-visibility-title">Shared with the tenant</span>
                <span className="fo-saved-visibility-description">
                  Anyone on this workspace with client access can apply it.
                </span>
              </span>
            </label>
          </fieldset>
        </div>
        <footer className="fo-saved-footer">
          <span>
            A client-specific search needs a client. Tenant-wide searches are restricted to
            workspace admins.
          </span>
          <button onClick={() => onClose()}>Cancel</button>
          <button disabled={busy || !name.trim()} onClick={onSave}>
            Save search
          </button>
        </footer>
      </div>
    </div>
  );
}

function ConfirmDialog({
  rootRef,
  search,
  mode,
  busy,
  onClose,
  onRename,
  onConfirm,
}: {
  rootRef: RefObject<HTMLDivElement>;
  search: SavedSearchRecordV2;
  mode: 'rename' | 'archive' | 'delete';
  busy: boolean;
  onClose: (keepParent?: boolean) => void;
  onRename: (name: string) => void;
  onConfirm: () => void;
}) {
  const [name, setName] = useState(search.name);
  const archive = mode === 'archive';
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode !== 'rename') cancelRef.current?.focus();
  }, [mode]);
  return (
    <div
      ref={rootRef}
      className="fo-saved-nested"
      data-saved-search-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-label={
        mode === 'rename'
          ? `Rename ${search.name}`
          : `${archive ? 'Archive' : 'Delete'} ${search.name}`
      }
    >
      <div className="fo-saved-confirm">
        <h2>
          {mode === 'rename'
            ? 'Rename saved search'
            : `${archive ? 'Archive' : 'Delete'} saved search`}
        </h2>
        {mode === 'rename' ? (
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        ) : (
          <p>
            {archive ? 'Archive' : 'Delete'} <strong>{search.name}</strong>?{' '}
            {archive ? 'It will remain readable but cannot be applied.' : 'This cannot be undone.'}
          </p>
        )}
        <footer>
          <button ref={cancelRef} onClick={() => onClose()}>
            Cancel
          </button>
          {mode === 'rename' ? (
            <button disabled={busy || !name.trim()} onClick={() => onRename(name)}>
              Rename
            </button>
          ) : (
            <button disabled={busy} onClick={onConfirm}>
              {archive ? 'Archive' : 'Delete'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function criteriaChips(criteria: OpportunitySearchCriteriaV2): string[] {
  const chips: string[] = [];
  const lists: Array<[keyof OpportunitySearchCriteriaV2, string]> = [
    ['lifecycle', 'lifecycle'],
    ['types', 'types'],
    ['sectors', 'sectors'],
    ['posted', 'posted'],
    ['geography', 'geography'],
    ['applicantTypes', 'applicantTypes'],
    ['funding', 'funding'],
    ['costShare', 'costShare'],
    ['methods', 'methods'],
    ['disbursement', 'disbursement'],
    ['grantPrerequisites', 'grantPrerequisites'],
    ['setAsideCodes', 'setAsideCodes'],
    ['sources', 'sources'],
  ];
  for (const [key, group] of lists)
    for (const value of criteria[key] as string[]) {
      const raw = value === 'solicitation' ? 'contracts' : optionLabel(group, value);
      const readable =
        value === 'eligible'
          ? 'the client meets stated eligibility'
          : value === 'active'
            ? 'active'
            : value === 'logistics' || value === 'logistics_and_sealift'
              ? 'logistics'
              : raw.toLowerCase();
      chips.push(readable);
    }
  if (criteria.deadlineWindow !== 'any') {
    const label = optionLabel('deadlineWindow', criteria.deadlineWindow);
    chips.push(label.replace(/^Within /, 'within '));
  }
  if (criteria.deadlineFrom) chips.push(`from ${criteria.deadlineFrom.slice(0, 10)}`);
  if (criteria.deadlineTo) chips.push(`to ${criteria.deadlineTo.slice(0, 10)}`);
  for (const value of criteria.eligibility) {
    chips.push(
      value === 'eligible'
        ? 'the client meets stated eligibility'
        : value === 'unknown'
          ? 'eligibility is unresolved'
          : optionLabel('eligibility', value).toLowerCase(),
    );
  }
  for (const value of criteria.naicsCodes) chips.push(`NAICS ${value}`);
  for (const value of criteria.pscCodes) chips.push(`PSC ${value}`);
  for (const value of criteria.codes) chips.push(optionLabel('codes', value));
  return chips;
}
