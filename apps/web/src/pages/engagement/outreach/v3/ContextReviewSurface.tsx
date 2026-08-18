import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  BookOpenCheck,
  Check,
  ExternalLink,
  FileCheck2,
  FileWarning,
  Fingerprint,
  Loader2,
  LockKeyhole,
  Search,
  ShieldCheck,
  UserRoundCheck,
  X,
} from 'lucide-react';
import {
  acceptContextCommand,
  excludeContextCommand,
} from './commands.js';
import {
  contextCandidateKey,
  contextPurposeOptions,
  contextSelectionFor,
  defaultContextPurpose,
  type OutreachV3ContextPurpose,
} from './context-selection.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import type {
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextReviewResponse,
  OutreachV3ResolvedContextRef,
} from './contracts.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';
import './context-review-surface.css';

export type ContextReviewSurfaceProps = Pick<
  DecisionSurfacesProps,
  | 'session'
  | 'busy'
  | 'applyCommands'
  | 'searchContext'
  | 'contextCandidates'
  | 'contextSearchPending'
  | 'contextSearchError'
  | 'contextSourceFailures'
  | 'contextSearchSkipped'
  | 'contextReview'
  | 'contextReviewPending'
  | 'contextReviewError'
>;

/**
 * Tabs filter results BY WHERE THEY CAME FROM, never by context class.
 *
 * The old tab row doubled as a hidden search filter — opening "Government" also
 * rewrote the class you were about to search for. One query now feeds them all,
 * so a tab is a pure view over the same result set and switching tabs cannot
 * change what gets searched or how an item may be used.
 */
type ContextTab = 'all' | 'memory' | 'government' | 'documents' | 'accepted' | 'excluded';

const TABS: Array<{ key: ContextTab; label: string }> = [
  { key: 'all', label: 'All results' },
  { key: 'memory', label: 'Institutional memory' },
  { key: 'government', label: 'Government' },
  { key: 'documents', label: 'Documents' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'excluded', label: 'Excluded' },
];

const CANDIDATE_TABS = new Set<ContextTab>(['all', 'memory', 'government', 'documents']);

const SOURCE_KIND_BY_TAB: Partial<Record<ContextTab, OutreachV3ContextCandidate['sourceKind']>> = {
  memory: 'memory',
  government: 'government',
  documents: 'document',
};

const CLASS_OPTIONS: Array<{
  value: OutreachV3ContextClass;
  label: string;
  description: string;
  kind: 'policy' | 'guidance' | 'evidence' | 'target' | 'group';
}> = [
  {
    value: 'required_policy',
    label: 'Required policy',
    description: 'Locked compliance or playbook rules.',
    kind: 'policy',
  },
  {
    value: 'writing_guidance',
    label: 'Writing guidance',
    description: 'Shapes tone; never supports a factual claim.',
    kind: 'guidance',
  },
  {
    value: 'campaign_fact',
    label: 'Campaign fact',
    description: 'Source-backed fact usable across the campaign.',
    kind: 'evidence',
  },
  {
    value: 'target_specific',
    label: 'Target-specific',
    description: 'May apply only to one named selected target.',
    kind: 'target',
  },
  {
    value: 'group_safe',
    label: 'Group-safe',
    description: 'Reserved for a named audience group.',
    kind: 'group',
  },
];

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
}) {
  return <span className={cx('ov3-badge', tone !== 'neutral' && `is-${tone}`)}>{children}</span>;
}

function candidateTitle(candidate: OutreachV3ContextCandidate): string {
  return candidate.title;
}

const SOURCE_LABEL: Record<OutreachV3ContextCandidate['sourceKind'], string> = {
  memory: 'Institutional memory',
  government: 'Government record',
  document: 'Client document',
};

function sourceLabel(candidate: OutreachV3ContextCandidate): string {
  return SOURCE_LABEL[candidate.sourceKind];
}

function candidateSummary(candidate: OutreachV3ContextCandidate): string {
  if (candidate.sourceKind === 'memory') return candidate.summary;
  if (candidate.sourceKind === 'document') {
    return `Stored document for ${candidate.clientName}. Text is extracted when the draft is generated.`;
  }
  return candidate.subtitle || `${sentence(candidate.category)} government record`;
}

function candidateDate(candidate: OutreachV3ContextCandidate): string | null {
  return candidate.sourceKind === 'memory' ? candidate.lastVerifiedAt : candidate.date;
}

function candidateHref(candidate: OutreachV3ContextCandidate): string | null {
  return candidate.sourceKind === 'government' ? candidate.href : null;
}

function sameLocator(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left.source !== right.source) return false;
  const leftId = left.id ?? left.memoryItemId ?? left.documentId;
  const rightId = right.id ?? right.memoryItemId ?? right.documentId;
  return leftId === rightId;
}

function acceptedRefs(review: OutreachV3ContextReviewResponse | undefined): OutreachV3ResolvedContextRef[] {
  if (!review) return [];
  return [
    ...review.accepted.requiredPolicyRefs,
    ...review.accepted.writingGuidanceRefs,
    ...review.accepted.campaignFactRefs,
    ...review.accepted.targetSpecificRefs,
    ...review.accepted.groupSafeRefs,
  ];
}

function classTone(contextClass: OutreachV3ContextClass): 'neutral' | 'info' | 'success' | 'warning' {
  if (contextClass === 'required_policy') return 'warning';
  if (contextClass === 'writing_guidance') return 'info';
  if (contextClass === 'target_specific') return 'success';
  return 'neutral';
}

export function ContextReviewSurface({
  session,
  busy,
  applyCommands,
  searchContext,
  contextCandidates,
  contextSearchPending,
  contextSearchError,
  contextSourceFailures,
  contextSearchSkipped,
  contextReview,
  contextReviewPending,
  contextReviewError,
}: ContextReviewSurfaceProps) {
  const selectedTargets = session.spec.targeting.selectedTargetRefs;
  const soleSponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  const [tab, setTab] = useState<ContextTab>('all');
  const [query, setQuery] = useState(session.spec.goal.topic ?? '');
  /**
   * Per-candidate purpose and target scope, keyed by `contextCandidateKey`.
   *
   * Held per item rather than once for the whole search, because the class is a
   * judgement about one source — two results from the same query routinely want
   * different answers.
   */
  const [purposeByCandidate, setPurposeByCandidate] = useState<
    Record<string, OutreachV3ContextPurpose>
  >({});
  const [targetByCandidate, setTargetByCandidate] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const accepted = useMemo(() => acceptedRefs(contextReview), [contextReview]);
  // Matched on LOCATOR alone, not locator + class. The class is no longer fixed
  // when a candidate is fetched, so keying on it would show an already-accepted
  // source as still addable whenever the user's chosen purpose differed from the
  // placeholder the search stamped on it.
  const acceptedByCandidate = useMemo(() => {
    const map = new Map<string, OutreachV3ResolvedContextRef>();
    for (const candidate of contextCandidates) {
      const found = accepted.find((entry) =>
        sameLocator(entry.locator, candidate.selection.locator),
      );
      if (found) map.set(contextCandidateKey(candidate), found);
    }
    return map;
  }, [accepted, contextCandidates]);
  const targetNames = useMemo(
    () => new Map(selectedTargets.map((target) => [target.targetKey, target.displayName])),
    [selectedTargets],
  );
  const revalidationByKey = useMemo(
    () =>
      new Map(
        (contextReview?.snapshotRevalidation ?? []).map((entry) => [
          String(entry.contextKey ?? ''),
          entry,
        ]),
      ),
    [contextReview?.snapshotRevalidation],
  );

  const runSearch = async (searchTerm: string) => {
    setError(null);
    try {
      await searchContext({
        query: searchTerm,
        clientId: soleSponsorClientId,
        limit: 20,
      });
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const performSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    await runSearch(query.trim());
  };

  // Load results on stage entry, seeded from the campaign topic, so the stage is
  // never blank on arrival — the same thing the Targets stage already does.
  //
  // Safe because every leg is a read-only capability: this calls searchContext
  // and NEVER applyCommands, so merely opening the stage cannot accept context
  // or otherwise mutate the canonical Campaign Spec.
  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (didAutoSearch.current) return;
    didAutoSearch.current = true;
    void runSearch((session.spec.goal.topic ?? '').trim());
    // Deliberately mount-only: `query` changes per keystroke, and re-running on
    // it is exactly what the Search control exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptCandidate = async (
    candidate: OutreachV3ContextCandidate,
    purpose: OutreachV3ContextPurpose,
    targetKey: string | null,
  ) => {
    setError(null);
    try {
      await applyCommands([
        acceptContextCommand([contextSelectionFor(candidate, purpose, targetKey)]),
      ]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const excludeAccepted = async (entry: OutreachV3ResolvedContextRef) => {
    if (entry.contextClass === 'required_policy') return;
    setError(null);
    try {
      await applyCommands([
        excludeContextCommand([{ contextKey: entry.contextKey, reason: 'user_excluded' }]),
      ]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const visibleAccepted = tab === 'excluded' ? [] : accepted;
  const showCandidates = CANDIDATE_TABS.has(tab);
  const visibleCandidates = useMemo(() => {
    const wanted = SOURCE_KIND_BY_TAB[tab];
    return wanted
      ? contextCandidates.filter((candidate) => candidate.sourceKind === wanted)
      : contextCandidates;
  }, [contextCandidates, tab]);

  return (
    <section className="ov3-decision-panel ov3-context-review">
      <header className="ov3-panel-header">
        <div>
          <span className="ov3-eyebrow">Context · 4 of 6</span>
          <h2>Review what Meri may use</h2>
          <p>
            Every source keeps its purpose, verification, sensitivity, freshness, and exact
            campaign or target scope.
          </p>
        </div>
        <Badge tone={contextReview?.summary.unverifiedEvidenceCount ? 'warning' : 'success'}>
          {accepted.length} accepted
        </Badge>
      </header>

      <div className="ov3-context-class-guide" aria-label="Context classifications">
        {CLASS_OPTIONS.map((entry) => (
          <article
            key={entry.value}
            className={cx(
              entry.kind === 'guidance' && 'is-guidance',
              entry.kind === 'evidence' && 'is-evidence',
              entry.kind === 'target' && 'is-target',
              entry.kind === 'group' && 'is-disabled',
            )}
          >
            <strong>{entry.label}</strong>
            <p>{entry.description}</p>
          </article>
        ))}
      </div>

      {contextReview?.summary.unverifiedEvidenceCount ? (
        <div className="ov3-recovery is-warning" role="status">
          <FileWarning size={18} aria-hidden="true" />
          <div>
            <strong>Unverified evidence blocks strategy readiness</strong>
            <p>
              {contextReview.summary.unverifiedEvidenceCount} accepted factual source
              {contextReview.summary.unverifiedEvidenceCount === 1 ? '' : 's'} cannot currently
              support a claim. Exclude or replace them with verified evidence.
            </p>
          </div>
        </div>
      ) : null}

      <div className="ov3-tab-row" role="tablist" aria-label="Context views">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={tab === entry.key ? 'is-selected' : ''}
            onClick={() => {
              // A tab is a view, never a search filter — it must not touch what
              // was searched or how any result may be used.
              setTab(entry.key);
              setError(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {showCandidates ? (
        <>
          {/* One box, every source. No class or source to declare up front —
              each result carries its own "Use as" control instead. */}
          <form className="ov3-context-search is-unified" onSubmit={performSearch}>
            <label className="ov3-search-control">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search context</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search institutional memory, government records, and documents"
              />
            </label>
            <button
              type="submit"
              className="ov3-button is-secondary"
              disabled={contextSearchPending}
            >
              {contextSearchPending ? <Loader2 className="ov3-spin" size={16} /> : null}
              Search
            </button>
          </form>
          {contextSearchSkipped ? (
            <div className="ov3-recovery is-info" role="status">
              <Search size={17} aria-hidden="true" />
              <div>
                <strong>Type at least two characters to search</strong>
                <p>
                  Institutional memory and government records need a search term. Stored client
                  documents are listed below and filter by title as you type.
                </p>
              </div>
            </div>
          ) : null}
          {contextSourceFailures?.length ? (
            <div className="ov3-recovery is-warning" role="status">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>Some context sources could not be searched</strong>
                {contextSourceFailures.map((failure) => (
                  <p key={failure.source}>
                    {sentence(failure.source)}: {failure.message}
                  </p>
                ))}
              </div>
            </div>
          ) : null}
          {!soleSponsorClientId ? (
            <div className="ov3-recovery is-info" role="status">
              <LockKeyhole size={17} aria-hidden="true" />
              <div>
                <strong>Client-specific context is unavailable for this sponsor scope</strong>
                <p>
                  Institutional memory and stored documents belonging to a client require exactly
                  one explicit client sponsor. Government records remain searchable.
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="ov3-work-grid is-context">
        <div className="ov3-context-results">
          {showCandidates ? (
            contextSearchPending ? (
              <div className="ov3-loading-list"><span /><span /><span /></div>
            ) : visibleCandidates.length ? (
              <div className="ov3-card-list">
                {visibleCandidates.map((candidate) => {
                  const key = contextCandidateKey(candidate);
                  const acceptedEntry = acceptedByCandidate.get(key);
                  const purposes = contextPurposeOptions(candidate);
                  const purpose = purposeByCandidate[key] ?? defaultContextPurpose(candidate);
                  const chosenTargetKey =
                    purpose === 'evidence' ? (targetByCandidate[key] ?? '') : '';
                  const scopeTarget = chosenTargetKey
                    ? targetNames.get(chosenTargetKey)
                    : null;
                  const guidance = purpose === 'guidance';
                  const targetSpecific = Boolean(scopeTarget);
                  const href = candidateHref(candidate);
                  const activePurpose = purposes.find((entry) => entry.value === purpose);
                  return (
                    <article
                      key={key}
                      className={cx(
                        'ov3-context-card',
                        guidance && 'is-guidance',
                        !guidance && 'is-evidence',
                        targetSpecific && 'is-target-specific',
                      )}
                    >
                      <header>
                        <div>
                          <span className="ov3-eyebrow">{sourceLabel(candidate)}</span>
                          <h3>{candidateTitle(candidate)}</h3>
                        </div>
                        <Badge tone={guidance ? 'info' : targetSpecific ? 'success' : 'neutral'}>
                          {guidance ? 'Guidance' : targetSpecific ? 'Target scoped' : 'Candidate'}
                        </Badge>
                      </header>
                      <p>{candidateSummary(candidate)}</p>
                      <div className="ov3-context-card__scope">
                        <span>{sourceLabel(candidate)}</span>
                        <span>
                          {scopeTarget ? `Applies to ${scopeTarget} only` : 'Campaign-wide'}
                        </span>
                        {candidate.sourceKind === 'memory' ? (
                          <span>{sentence(candidate.verificationClass)}</span>
                        ) : null}
                      </div>
                      <div className="ov3-context-source-row">
                        <span>Verified {formatDate(candidateDate(candidate))}</span>
                        <span>{activePurpose?.hint ?? 'Choose how this source may be used.'}</span>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            Open source <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : null}
                      </div>
                      {!acceptedEntry ? (
                        <div className="ov3-context-use-as">
                          <fieldset>
                            <legend>Use as</legend>
                            {purposes.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={cx(
                                  'ov3-chip',
                                  purpose === option.value && 'is-selected',
                                )}
                                aria-pressed={purpose === option.value}
                                disabled={!option.allowed || busy}
                                title={option.blockedReason ?? option.hint}
                                onClick={() =>
                                  setPurposeByCandidate((current) => ({
                                    ...current,
                                    [key]: option.value,
                                  }))
                                }
                              >
                                {option.label}
                              </button>
                            ))}
                          </fieldset>
                          {/* Target scope is offered only for evidence: the server
                              treats guidance and policy as campaign-wide. */}
                          {purpose === 'evidence' && selectedTargets.length ? (
                            <label>
                              <span>Applies to</span>
                              <select
                                value={chosenTargetKey}
                                onChange={(event) =>
                                  setTargetByCandidate((current) => ({
                                    ...current,
                                    [key]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">The whole campaign</option>
                                {selectedTargets.map((target) => (
                                  <option key={target.targetKey} value={target.targetKey}>
                                    Only {target.displayName}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      ) : null}
                      <footer>
                        {/* The source row above already carries the active
                            purpose's hint, so this only fills the gap while no
                            purpose has been chosen yet. */}
                        <span>{acceptedEntry || purpose ? null : 'Choose a purpose to continue.'}</span>
                        {acceptedEntry ? (
                          <button type="button" className="ov3-button is-secondary" disabled>
                            <Check size={15} /> Accepted
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ov3-button is-primary"
                            // No purpose means the choice is genuinely ambiguous
                            // (the source could be guidance OR evidence). Refuse
                            // rather than pick one silently.
                            disabled={busy || !purpose}
                            onClick={() =>
                              purpose &&
                              void acceptCandidate(candidate, purpose, chosenTargetKey || null)
                            }
                          >
                            Accept context
                          </button>
                        )}
                      </footer>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="ov3-empty-state">
                <BookOpenCheck size={24} aria-hidden="true" />
                <strong>No context matched that search</strong>
                <p>
                  One search covers institutional memory, government records, and stored client
                  documents. Try a broader term. The campaign remains usable without Meri.
                </p>
              </div>
            )
          ) : tab === 'excluded' ? (
            session.spec.context.excludedRefs.length ? (
              <div className="ov3-card-list">
                {session.spec.context.excludedRefs.map((entry) => (
                  <article key={entry.contextKey} className="ov3-context-card is-conflict">
                    <header>
                      <div><span className="ov3-eyebrow">Excluded context</span><h3>{entry.contextKey}</h3></div>
                      <Badge tone="warning">Excluded</Badge>
                    </header>
                    <p>{sentence(entry.reason ?? entry.reasonCode ?? 'user excluded')}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="ov3-empty-state"><FileCheck2 size={24} /><strong>No excluded context</strong><p>Nothing has been excluded from this campaign.</p></div>
            )
          ) : (
            <AcceptedList
              entries={visibleAccepted}
              targetNames={targetNames}
              revalidationByKey={revalidationByKey}
              busy={busy}
              onExclude={excludeAccepted}
            />
          )}
        </div>

        <aside className="ov3-inspector">
          <header>
            <span className="ov3-eyebrow">Context health</span>
            {contextReviewPending ? <Loader2 className="ov3-spin" size={16} /> : null}
          </header>
          <div className="ov3-context-summary-grid">
            <article><strong>{contextReview?.summary.requiredPolicyCount ?? 0}</strong><span>Required policy</span></article>
            <article><strong>{contextReview?.summary.writingGuidanceCount ?? 0}</strong><span>Writing guidance</span></article>
            <article><strong>{contextReview?.summary.campaignFactCount ?? 0}</strong><span>Campaign facts</span></article>
            <article><strong>{contextReview?.summary.targetSpecificCount ?? 0}</strong><span>Target-specific</span></article>
            <article><strong>{contextReview?.summary.groupSafeCount ?? 0}</strong><span>Group-safe</span></article>
            <article><strong>{contextReview?.summary.excludedCount ?? 0}</strong><span>Excluded</span></article>
          </div>

          <div className="ov3-guidance-card">
            <Fingerprint size={18} aria-hidden="true" />
            <span className="ov3-eyebrow">Writing guidance</span>
            <h3>Style is not evidence</h3>
            <p>
              User voice, firm playbooks, preferred tone, and approved positioning may shape the
              writing. They cannot substantiate a factual statement.
            </p>
          </div>

          <div className="ov3-guidance-card is-strategy">
            <ShieldCheck size={18} aria-hidden="true" />
            <span className="ov3-eyebrow">Source-backed facts</span>
            <h3>Claims keep provenance and scope</h3>
            <p>
              Factual evidence remains tied to its source, date, verification class, sensitivity,
              and campaign or target scope.
            </p>
          </div>

          {selectedTargets.length ? (
            <div className="ov3-guidance-card">
              <UserRoundCheck size={18} aria-hidden="true" />
              <span className="ov3-eyebrow">Target isolation</span>
              <h3>{selectedTargets.length} selected target{selectedTargets.length === 1 ? '' : 's'}</h3>
              <p>
                Target-specific context visibly names the only person it may influence and cannot
                silently become campaign-wide.
              </p>
            </div>
          ) : null}

          <div className="ov3-recovery is-info">
            <LockKeyhole size={17} aria-hidden="true" />
            <div>
              <strong>Institutional memory remains governed</strong>
              <p>
                Context is proposed and accepted for this campaign. The conversation never commits
                new institutional memory automatically.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {(error || contextSearchError || contextReviewError) ? (
        <div className="ov3-recovery is-danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Context action failed</strong>
            <p>{error ?? contextSearchError ?? contextReviewError}</p>
          </div>
        </div>
      ) : null}

      <footer className="ov3-panel-footer">
        <span>
          {accepted.length} accepted · {contextReview?.summary.unverifiedEvidenceCount ?? 0}{' '}
          unverified evidence · review remains open until you explicitly continue
        </span>
      </footer>
    </section>
  );
}

function AcceptedList({
  entries,
  targetNames,
  revalidationByKey,
  busy,
  onExclude,
}: {
  entries: OutreachV3ResolvedContextRef[];
  targetNames: Map<string, string>;
  revalidationByKey: Map<string, Record<string, unknown>>;
  busy: boolean;
  onExclude: (entry: OutreachV3ResolvedContextRef) => Promise<void>;
}) {
  if (!entries.length) {
    return (
      <div className="ov3-empty-state">
        <FileCheck2 size={24} />
        <strong>No accepted context in this view</strong>
        <p>Search and accept only the sources the campaign may use.</p>
      </div>
    );
  }
  const byClass = CLASS_OPTIONS.map((option) => ({
    ...option,
    entries: entries.filter((entry) => entry.contextClass === option.value),
  })).filter((group) => group.entries.length);

  return (
    <div className="ov3-context-accepted-section">
      {byClass.map((group) => (
        <section key={group.value}>
          <header>
            <div>
              <span className="ov3-section-label">{group.label}</span>
              <p>{group.description}</p>
            </div>
            <Badge tone={classTone(group.value)}>{group.entries.length}</Badge>
          </header>
          <div className="ov3-accepted-list">
            {group.entries.map((entry) => {
              const revalidation = revalidationByKey.get(entry.contextKey);
              const status = String(revalidation?.status ?? 'current');
              const targetName =
                entry.scope.kind === 'target'
                  ? targetNames.get(entry.scope.targetKey ?? '') ?? 'Selected target'
                  : null;
              return (
                <article key={entry.contextKey}>
                  <div>
                    <span className="ov3-eyebrow">{group.label}</span>
                    <strong>{entry.title}</strong>
                    <p>{entry.summary}</p>
                    <div className="ov3-context-source-row">
                      <span>{sentence(entry.sourceSnapshot?.system ?? entry.locator.source)}</span>
                      <span>Verified {formatDate(entry.sourceSnapshot?.lastVerifiedAt)}</span>
                      <span className={targetName ? 'ov3-context-scope-name' : ''}>
                        {targetName ? `Applies to ${targetName} only` : sentence(entry.scope.kind)}
                      </span>
                    </div>
                  </div>
                  <Badge tone={status === 'current' ? 'success' : 'warning'}>{sentence(status)}</Badge>
                  {entry.contextClass === 'required_policy' ? (
                    <Badge tone="warning"><LockKeyhole size={12} /> Locked</Badge>
                  ) : (
                    <button
                      type="button"
                      className="ov3-icon-button"
                      aria-label={`Exclude ${entry.title} from this campaign`}
                      title="Exclude for this campaign"
                      disabled={busy}
                      onClick={() => void onExclude(entry)}
                    >
                      <X size={15} />
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

