import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import type {
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextReviewResponse,
  OutreachV3ContextScope,
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
  | 'contextReview'
  | 'contextReviewPending'
  | 'contextReviewError'
>;

type ContextTab = 'recommended' | 'memory' | 'government' | 'target' | 'accepted' | 'excluded';
type SearchSource = 'memory' | 'government';

const TABS: Array<{ key: ContextTab; label: string }> = [
  { key: 'recommended', label: 'Recommended' },
  { key: 'memory', label: 'Institutional memory' },
  { key: 'government', label: 'Government' },
  { key: 'target', label: 'Target-specific' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'excluded', label: 'Excluded' },
];

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

function candidateSummary(candidate: OutreachV3ContextCandidate): string {
  return candidate.sourceKind === 'memory'
    ? candidate.summary
    : candidate.subtitle || `${sentence(candidate.category)} government record`;
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

function classDescription(contextClass: OutreachV3ContextClass): string {
  return CLASS_OPTIONS.find((entry) => entry.value === contextClass)?.description ?? '';
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
  contextReview,
  contextReviewPending,
  contextReviewError,
}: ContextReviewSurfaceProps) {
  const selectedTargets = session.spec.targeting.selectedTargetRefs;
  const soleSponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  const [tab, setTab] = useState<ContextTab>('recommended');
  const [source, setSource] = useState<SearchSource>(soleSponsorClientId ? 'memory' : 'government');
  const [query, setQuery] = useState(session.spec.goal.topic ?? '');
  const [contextClass, setContextClass] = useState<OutreachV3ContextClass>(
    soleSponsorClientId ? 'writing_guidance' : 'campaign_fact',
  );
  const [targetKey, setTargetKey] = useState(selectedTargets[0]?.targetKey ?? '');
  const [error, setError] = useState<string | null>(null);
  const accepted = useMemo(() => acceptedRefs(contextReview), [contextReview]);
  const acceptedByCandidate = useMemo(() => {
    const map = new Map<string, OutreachV3ResolvedContextRef>();
    for (const candidate of contextCandidates) {
      const found = accepted.find(
        (entry) =>
          entry.contextClass === candidate.selection.contextClass &&
          sameLocator(entry.locator, candidate.selection.locator),
      );
      if (found) map.set(candidateKey(candidate), found);
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

  const effectiveScope: OutreachV3ContextScope =
    contextClass === 'target_specific'
      ? { kind: 'target', targetKey }
      : { kind: 'campaign' };

  const performSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) {
      setError('Enter a context question or topic.');
      return;
    }
    if (contextClass === 'target_specific' && !targetKey) {
      setError('Choose the target this context may apply to.');
      return;
    }
    if (contextClass === 'group_safe') {
      setError('Group-safe context requires a named audience group, which is not available in Phase 6.');
      return;
    }
    if (source === 'memory' && !soleSponsorClientId && session.spec.sponsor.kind !== 'firm') {
      // Tenant-neutral firm memory remains searchable without a client id. Other
      // sponsor kinds can still receive neutral results through the backend.
    }
    if (source === 'government' && contextClass === 'writing_guidance') {
      setError('Government records are factual sources, not writing guidance.');
      return;
    }
    setError(null);
    try {
      await searchContext({
        source,
        query: query.trim(),
        clientId: source === 'memory' ? soleSponsorClientId : null,
        intendedClass: contextClass,
        scope: effectiveScope,
        limit: 20,
      });
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const acceptCandidate = async (candidate: OutreachV3ContextCandidate) => {
    setError(null);
    try {
      await applyCommands([acceptContextCommand([candidate.selection])]);
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

  const visibleAccepted = (() => {
    if (tab === 'excluded') return [];
    if (tab === 'target') return accepted.filter((entry) => entry.contextClass === 'target_specific');
    if (tab === 'memory') {
      return accepted.filter((entry) => entry.locator.source === 'memory_item');
    }
    if (tab === 'government') {
      return accepted.filter((entry) => entry.locator.source === 'government_record');
    }
    return accepted;
  })();
  const showCandidates = !['accepted', 'excluded'].includes(tab);

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
              setTab(entry.key);
              if (entry.key === 'memory') setSource('memory');
              if (entry.key === 'government') {
                setSource('government');
                if (contextClass === 'writing_guidance') setContextClass('campaign_fact');
              }
              if (entry.key === 'target') setContextClass('target_specific');
              setError(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {showCandidates ? (
        <form className="ov3-context-search" onSubmit={performSearch}>
          <label>
            <span>Source</span>
            <select
              value={source}
              onChange={(event) => {
                const next = event.target.value as SearchSource;
                setSource(next);
                if (next === 'government' && contextClass === 'writing_guidance') {
                  setContextClass('campaign_fact');
                }
              }}
            >
              <option value="memory">Institutional memory</option>
              <option value="government">Government records</option>
            </select>
          </label>
          <label>
            <span>Use as</span>
            <select
              value={contextClass}
              onChange={(event) => setContextClass(event.target.value as OutreachV3ContextClass)}
            >
              {CLASS_OPTIONS.map((entry) => (
                <option
                  key={entry.value}
                  value={entry.value}
                  disabled={
                    entry.value === 'group_safe' ||
                    (source === 'government' && entry.value === 'writing_guidance')
                  }
                >
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {contextClass === 'target_specific' ? (
            <label>
              <span>Applies to</span>
              <select value={targetKey} onChange={(event) => setTargetKey(event.target.value)}>
                <option value="">Choose target</option>
                {selectedTargets.map((target) => (
                  <option key={target.targetKey} value={target.targetKey}>
                    {target.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="ov3-search-control">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search context</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search approved memory or government records"
            />
          </label>
          <button type="submit" className="ov3-button is-secondary" disabled={contextSearchPending}>
            {contextSearchPending ? <Loader2 className="ov3-spin" size={16} /> : null}
            Search
          </button>
        </form>
      ) : null}

      <div className="ov3-work-grid is-context">
        <div className="ov3-context-results">
          {showCandidates ? (
            contextSearchPending ? (
              <div className="ov3-loading-list"><span /><span /><span /></div>
            ) : contextCandidates.length ? (
              <div className="ov3-card-list">
                {contextCandidates.map((candidate) => {
                  const key = candidateKey(candidate);
                  const acceptedEntry = acceptedByCandidate.get(key);
                  const scopeTarget = candidate.selection.scope.kind === 'target'
                    ? targetNames.get(candidate.selection.scope.targetKey ?? '')
                    : null;
                  const guidance = candidate.selection.contextClass === 'writing_guidance';
                  const targetSpecific = candidate.selection.contextClass === 'target_specific';
                  const href = candidateHref(candidate);
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
                          <span className="ov3-eyebrow">
                            {sentence(candidate.selection.contextClass)}
                          </span>
                          <h3>{candidateTitle(candidate)}</h3>
                        </div>
                        <Badge tone={guidance ? 'info' : targetSpecific ? 'success' : 'neutral'}>
                          {guidance ? 'Guidance' : targetSpecific ? 'Target scoped' : 'Candidate'}
                        </Badge>
                      </header>
                      <p>{candidateSummary(candidate)}</p>
                      <div className="ov3-context-card__scope">
                        <span>{sentence(candidate.sourceKind)}</span>
                        <span>
                          {scopeTarget
                            ? `Applies to ${scopeTarget} only`
                            : candidate.selection.scope.kind === 'campaign'
                              ? 'Campaign-wide'
                              : sentence(candidate.selection.scope.kind)}
                        </span>
                        {candidate.sourceKind === 'memory' ? (
                          <span>{sentence(candidate.verificationClass)}</span>
                        ) : null}
                      </div>
                      <div className="ov3-context-source-row">
                        <span>Verified {formatDate(candidateDate(candidate))}</span>
                        <span>{classDescription(candidate.selection.contextClass)}</span>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">
                            Open source <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : null}
                      </div>
                      <footer>
                        <span />
                        {acceptedEntry ? (
                          <button type="button" className="ov3-button is-secondary" disabled>
                            <Check size={15} /> Accepted
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ov3-button is-primary"
                            disabled={busy}
                            onClick={() => void acceptCandidate(candidate)}
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
                <strong>No context candidates loaded</strong>
                <p>
                  Search approved institutional memory or source-backed government records. The
                  campaign remains usable without Meri.
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

function candidateKey(candidate: OutreachV3ContextCandidate): string {
  const locator = candidate.selection.locator;
  return [
    candidate.sourceKind,
    String(locator.source ?? ''),
    String(locator.id ?? locator.memoryItemId ?? locator.documentId ?? candidate.title),
    candidate.selection.contextClass,
    candidate.selection.scope.kind,
    candidate.selection.scope.targetKey ?? '',
  ].join(':');
}
