import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  ContactRound,
  History,
  Loader2,
  Mail,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { useApi } from '../../../../lib/use-api.js';
import {
  addTargetCommand,
  rejectTargetRecommendationCommand,
  removeTargetCommand,
  targetCriteriaCommand,
} from './commands.js';
import type { DecisionSurfacesProps } from './DecisionSurfaces.js';
import type {
  OutreachV3ResolvedTargetRef,
  OutreachV3TargetCandidate,
  OutreachV3TargetLocator,
} from './contracts.js';
import {
  getOutreachV3TargetRelationships,
  safeOutreachV3Error,
} from './outreach-v3-api.js';
import type {
  OutreachV3RelationshipResponse,
  OutreachV3TargetProfileResponse,
  OutreachV3TargetProfileSection,
} from './target-intelligence-contracts.js';

export type TargetWorkspaceProps = Pick<
  DecisionSurfacesProps,
  | 'session'
  | 'busy'
  | 'applyCommands'
  | 'searchTargets'
  | 'targetCandidates'
  | 'targetSearchPending'
  | 'targetSearchError'
  | 'getTargetProfile'
  | 'targetProfile'
  | 'targetProfilePending'
  | 'coverage'
  | 'coveragePending'
>;

type TargetSourceKey =
  | 'recommended'
  | 'directory'
  | 'client'
  | 'recent'
  | 'selected'
  | 'saved'
  | 'manual';

const SOURCE_OPTIONS: Array<{
  key: TargetSourceKey;
  label: string;
  sources: string[];
  requiresClient?: boolean;
  unavailable?: boolean;
}> = [
  { key: 'recommended', label: 'Recommended', sources: [] },
  {
    key: 'directory',
    label: 'Directory',
    sources: ['directory_member', 'directory_staff', 'state_legislator'],
  },
  {
    key: 'client',
    label: 'Client contacts',
    sources: ['client_person', 'client_recommendation'],
    requiresClient: true,
  },
  {
    key: 'recent',
    label: 'Recent contacts',
    sources: ['engagement_contact'],
    requiresClient: true,
  },
  { key: 'selected', label: 'Selected', sources: [] },
  { key: 'saved', label: 'Saved audiences', sources: [], unavailable: true },
  { key: 'manual', label: 'Manual', sources: [] },
];

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(parsed);
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function PanelHeader({ selectedCount }: { selectedCount: number }) {
  return (
    <header className="ov3-panel-header">
      <div>
        <span className="ov3-eyebrow">Targets · 2 of 6</span>
        <h2>Choose the people and offices to contact</h2>
        <p>
          Search authorized sources, inspect role and relationship health, and add every target
          explicitly.
        </p>
      </div>
      <span className="ov3-badge is-success">{selectedCount} selected</span>
    </header>
  );
}

function ErrorNotice({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="ov3-recovery is-danger" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div><strong>This action could not complete</strong><p>{message}</p></div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  multiline,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email';
  multiline?: boolean;
  required?: boolean;
}) {
  return (
    <label className="ov3-field">
      <span>{label}{required ? <em>Required</em> : null}</span>
      {multiline ? (
        <textarea rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function StatusPill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}) {
  return <span className={cx('ov3-badge', tone !== 'neutral' && `is-${tone}`)}>{children}</span>;
}

function ProfileSection({
  label,
  section,
}: {
  label: string;
  section: OutreachV3TargetProfileSection;
}) {
  return (
    <div className="ov3-target-intel-section">
      <div>
        <span className="ov3-section-label">{label}</span>
        <StatusPill tone={section.status === 'available' ? 'success' : 'neutral'}>
          {sentence(section.status)}
        </StatusPill>
      </div>
      {section.values.length ? (
        <p>{section.values.join(' · ')}</p>
      ) : (
        <p className="ov3-muted-copy">{section.reason ?? 'No verified values are available.'}</p>
      )}
    </div>
  );
}

export function TargetWorkspace(props: TargetWorkspaceProps) {
  const {
    session,
    busy,
    applyCommands,
    searchTargets,
    targetCandidates,
    targetSearchPending,
    targetSearchError,
    getTargetProfile,
    targetProfile,
    targetProfilePending,
    coverage,
    coveragePending,
  } = props;
  const api = useApi();
  const selected = session.spec.targeting.selectedTargetRefs;
  const sponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  const [source, setSource] = useState<TargetSourceKey>('recommended');
  const [query, setQuery] = useState(
    session.spec.targeting.criteria?.notes ?? session.spec.goal.topic ?? '',
  );
  const [relationshipPreference, setRelationshipPreference] = useState<
    'any' | 'existing' | 'new' | 'mixed'
  >(session.spec.targeting.criteria?.relationshipPreference ?? 'any');
  const [includeStaff, setIncludeStaff] = useState(
    session.spec.targeting.criteria?.includeStaff ?? true,
  );
  const [includePrincipals, setIncludePrincipals] = useState(
    session.spec.targeting.criteria?.includePrincipals ?? true,
  );
  const [error, setError] = useState<string | null>(null);
  const [activeLocator, setActiveLocator] = useState<OutreachV3TargetLocator | null>(null);
  const [manual, setManual] = useState({
    name: '',
    email: '',
    title: '',
    organization: '',
    note: '',
  });
  const searched = useRef(false);

  const profile = targetProfile as OutreachV3TargetProfileResponse | undefined;
  const profileData = profile?.data;
  const profileTarget = profileData?.target;
  const profileStatus = profile?.selectionSnapshot.status;

  const relationships = useMutation({
    mutationFn: async (input: { locator: OutreachV3TargetLocator; clientId: string }) =>
      getOutreachV3TargetRelationships(
        api,
        session.session.id,
        input.locator,
        input.clientId,
      ),
  });

  const selectedByKey = useMemo(
    () => new Map(selected.map((target) => [target.targetKey, target])),
    [selected],
  );
  const visibleCandidates = useMemo(() => {
    if (source === 'selected') return [];
    return targetCandidates;
  }, [source, targetCandidates]);
  const highConfidence = useMemo(
    () => visibleCandidates.filter(
      (candidate) => candidate.score >= 0.75 && !selectedByKey.has(candidate.targetKey),
    ),
    [selectedByKey, visibleCandidates],
  );

  const criteriaCommand = () =>
    targetCriteriaCommand({
      notes: query,
      governmentLevels: ['federal', 'state'],
      relationshipPreference,
      includeStaff,
      includePrincipals,
    });

  const selectedOption = () => SOURCE_OPTIONS.find((entry) => entry.key === source);

  const targetSearchInput = (option: (typeof SOURCE_OPTIONS)[number]) => ({
    query: query.trim() || undefined,
    clientId:
      source === 'recommended' || option.requiresClient
        ? sponsorClientId ?? undefined
        : undefined,
    sources: [...option.sources],
    limit: 20,
  });

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const option = selectedOption();
    if (!option || option.unavailable || source === 'selected' || source === 'manual') return;
    if (option.requiresClient && !sponsorClientId) {
      setError('This source requires one explicit client sponsor.');
      return;
    }
    setError(null);
    try {
      // Search is an explicit commit point for the edited criteria. Merely
      // entering the stage never mutates the canonical Campaign Spec.
      await applyCommands([criteriaCommand()]);
      await searchTargets(targetSearchInput(option));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  useEffect(() => {
    if (searched.current) return;
    searched.current = true;
    const option = SOURCE_OPTIONS[0]!;
    // Read-only recommendations are allowed to load automatically. They do not
    // add targets or commit inferred criteria.
    void searchTargets({
      query: query.trim() || undefined,
      clientId: sponsorClientId ?? undefined,
      sources: [...option.sources],
      limit: 20,
    }).catch((caught) => setError(safeOutreachV3Error(caught)));
  }, [query, searchTargets, sponsorClientId]);

  const openProfile = async (locator: OutreachV3TargetLocator) => {
    setActiveLocator(locator);
    relationships.reset();
    setError(null);
    try {
      await getTargetProfile(locator);
      if (sponsorClientId) {
        void relationships.mutateAsync({ locator, clientId: sponsorClientId }).catch(() => undefined);
      }
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addCandidate = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([addTargetCommand(candidate)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addHighConfidence = async () => {
    if (!highConfidence.length) return;
    setError(null);
    try {
      await applyCommands(highConfidence.map(addTargetCommand));
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const removeTarget = async (targetKey: string) => {
    setError(null);
    try {
      await applyCommands([removeTargetCommand(targetKey)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const dismissCandidate = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([
        rejectTargetRecommendationCommand({
          recommendationRef: candidate.recommendationRef,
          targetKey: candidate.targetKey,
        }),
      ]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const addManual = async () => {
    if (!manual.name.trim()) {
      setError('Enter the target name.');
      return;
    }
    if (manual.email.trim() && !validEmail(manual.email.trim())) {
      setError('Enter a valid email address or leave the email blank.');
      return;
    }
    const locator: OutreachV3TargetLocator = {
      source: 'manual',
      id: crypto.randomUUID(),
      name: manual.name.trim(),
      email: manual.email.trim() || null,
      phone: null,
      title: manual.title.trim() || null,
      organization: manual.organization.trim() || null,
      note: manual.note.trim() || null,
    };
    setError(null);
    try {
      await applyCommands([addTargetCommand(locator)]);
      setManual({ name: '', email: '', title: '', organization: '', note: '' });
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const activeSelected = activeLocator
    ? selected.find(
        (target) =>
          target.locator.source === activeLocator.source && target.locator.id === activeLocator.id,
      )
    : undefined;
  const relationship = relationships.data as OutreachV3RelationshipResponse | undefined;
  const snapshotChanged = profile?.selectionSnapshot.status === 'changed';
  const coverageSelectedCount = coverage?.coverage.selectedCount ?? selected.length;
  const coverageSendReadyCount =
    coverage?.coverage.sendReadyCount ?? selected.filter((target) => Boolean(target.email)).length;

  return (
    <section className="ov3-decision-panel ov3-target-workspace">
      <PanelHeader selectedCount={selected.length} />

      <div className="ov3-tab-row" role="tablist" aria-label="Target sources">
        {SOURCE_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={source === option.key}
            disabled={option.unavailable}
            title={option.unavailable ? 'Saved-audience integration is not available in Phase 6.' : undefined}
            className={source === option.key ? 'is-selected' : ''}
            onClick={() => {
              setSource(option.key);
              setError(null);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="ov3-target-criteria">
        <form className="ov3-search-bar" onSubmit={runSearch}>
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, committees, offices, states, or issue areas"
            aria-label="Search targets"
            disabled={source === 'selected' || source === 'manual' || source === 'saved'}
          />
          <button
            className="ov3-button is-secondary"
            type="submit"
            disabled={
              targetSearchPending ||
              source === 'selected' ||
              source === 'manual' ||
              source === 'saved'
            }
          >
            {targetSearchPending ? <Loader2 className="ov3-spin" size={16} /> : null}
            Search
          </button>
        </form>
        <div className="ov3-target-criteria__controls" aria-label="Target criteria">
          <button
            type="button"
            className={includeStaff ? 'is-selected' : ''}
            aria-pressed={includeStaff}
            onClick={() => setIncludeStaff((value) => !value)}
          >
            Staff
          </button>
          <button
            type="button"
            className={includePrincipals ? 'is-selected' : ''}
            aria-pressed={includePrincipals}
            onClick={() => setIncludePrincipals((value) => !value)}
          >
            Principals
          </button>
          <label>
            <span className="sr-only">Relationship preference</span>
            <select
              value={relationshipPreference}
              onChange={(event) =>
                setRelationshipPreference(
                  event.target.value as 'any' | 'existing' | 'new' | 'mixed',
                )
              }
            >
              <option value="any">Any relationship</option>
              <option value="existing">Existing relationships</option>
              <option value="new">New relationships</option>
              <option value="mixed">Mixed audience</option>
            </select>
          </label>
          {source === 'recommended' && highConfidence.length > 0 ? (
            <button
              type="button"
              className="ov3-button is-primary"
              disabled={busy}
              onClick={() => void addHighConfidence()}
            >
              Add {highConfidence.length} high-confidence
            </button>
          ) : null}
        </div>
      </div>

      <div className="ov3-work-grid is-targets">
        <div className="ov3-target-column">
          {source === 'manual' ? (
            <section className="ov3-manual-entry">
              <header>
                <div>
                  <span className="ov3-section-label">Manual target</span>
                  <p>
                    Adds the target to this campaign only. Saving to the shared Directory remains
                    off.
                  </p>
                </div>
                <StatusPill tone="info">Campaign only</StatusPill>
              </header>
              <div className="ov3-field-grid">
                <Field label="Name" required value={manual.name} onChange={(name) => setManual({ ...manual, name })} />
                <Field label="Email" type="email" value={manual.email} onChange={(email) => setManual({ ...manual, email })} />
                <Field label="Title" value={manual.title} onChange={(title) => setManual({ ...manual, title })} />
                <Field label="Organization" value={manual.organization} onChange={(organization) => setManual({ ...manual, organization })} />
              </div>
              <Field label="Target note" value={manual.note} onChange={(note) => setManual({ ...manual, note })} multiline />
              <button
                type="button"
                className="ov3-button is-primary"
                disabled={busy}
                onClick={() => void addManual()}
              >
                Add target to campaign
              </button>
            </section>
          ) : source === 'selected' ? (
            <SelectedTargetList
              selected={selected}
              busy={busy}
              onProfile={openProfile}
              onRemove={removeTarget}
            />
          ) : targetSearchPending ? (
            <div className="ov3-loading-list" aria-label="Searching targets"><span /><span /><span /></div>
          ) : visibleCandidates.length === 0 ? (
            <div className="ov3-empty-state">
              <UsersRound size={24} aria-hidden="true" />
              <strong>No matching targets</strong>
              <p>Broaden the criteria, use the Directory, or add a target manually.</p>
              <button type="button" className="ov3-button is-secondary" onClick={() => setSource('manual')}>
                Add manually
              </button>
            </div>
          ) : (
            <div className="ov3-card-list">
              {visibleCandidates.map((candidate) => {
                const selectedTarget = selectedByKey.get(candidate.targetKey);
                return (
                  <article
                    key={candidate.recommendationRef}
                    className={cx('ov3-target-card', selectedTarget && 'is-selected')}
                  >
                    <header>
                      <span className="ov3-avatar">{candidate.displayName.slice(0, 2).toUpperCase()}</span>
                      <div>
                        <strong>{candidate.displayName}</strong>
                        <p>{candidate.title || candidate.organization || 'Government-affairs target'}</p>
                      </div>
                      <StatusPill tone={candidate.roleStatus === 'current' ? 'success' : 'warning'}>
                        {sentence(candidate.roleStatus)}
                      </StatusPill>
                    </header>
                    <p className="ov3-target-card__why">
                      {candidate.signals.map((signal) => signal.label).slice(0, 2).join(' · ') ||
                        'Matches the current target criteria.'}
                    </p>
                    <div className="ov3-target-card__meta">
                      <span>{candidate.organization || candidate.jurisdiction.chamber || 'Directory'}</span>
                      <span>{candidate.emailStatus === 'available' ? 'Email ready' : 'Email missing'}</span>
                      <span>{Math.round(candidate.score * 100)}% match</span>
                    </div>
                    <footer>
                      <button type="button" className="ov3-button is-quiet" onClick={() => void openProfile(candidate.locator)}>
                        View profile
                      </button>
                      {!selectedTarget ? (
                        <button type="button" className="ov3-button is-quiet" onClick={() => void dismissCandidate(candidate)}>
                          Not relevant
                        </button>
                      ) : null}
                      <span />
                      {selectedTarget ? (
                        <>
                          <button type="button" className="ov3-button is-secondary" disabled>
                            <Check size={15} aria-hidden="true" /> Added
                          </button>
                          <button type="button" className="ov3-button is-quiet" disabled={busy} onClick={() => void removeTarget(candidate.targetKey)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button type="button" className="ov3-button is-primary" disabled={busy} onClick={() => void addCandidate(candidate)}>
                          Add target
                        </button>
                      )}
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="ov3-inspector ov3-target-inspector">
          <header>
            <span className="ov3-eyebrow">Target profile</span>
            {profileStatus ? (
              <StatusPill tone={profileStatus === 'current' ? 'success' : 'warning'}>
                {sentence(profileStatus)}
              </StatusPill>
            ) : null}
          </header>
          {targetProfilePending ? (
            <div className="ov3-centered"><Loader2 className="ov3-spin" /></div>
          ) : profileTarget && profileData && profile ? (
            <>
              <div className="ov3-inspector__identity">
                <span className="ov3-avatar is-large">{profileTarget.displayName.slice(0, 2).toUpperCase()}</span>
                <div>
                  <h3>{profileTarget.displayName}</h3>
                  <p>{profileData.role.title || profileData.role.organization || 'Target'}</p>
                </div>
              </div>
              <div className="ov3-profile-status-row">
                <StatusPill tone={profileData.role.status === 'current' ? 'success' : 'warning'}>
                  Role {profileData.role.status}
                </StatusPill>
                <StatusPill tone={profileData.contact.emailStatus === 'available' ? 'info' : 'warning'}>
                  Email {profileData.contact.emailStatus}
                </StatusPill>
                {activeSelected ? <StatusPill tone="success">Selected</StatusPill> : null}
              </div>

              {snapshotChanged ? (
                <div className="ov3-recovery is-warning">
                  <History size={17} aria-hidden="true" />
                  <div>
                    <strong>The selected target snapshot changed</strong>
                    <p>{profile.selectionSnapshot.changedFields.join(', ') || 'One or more profile fields changed.'}</p>
                  </div>
                </div>
              ) : null}

              <dl className="ov3-detail-list">
                <div><dt>Office</dt><dd>{profileData.role.organization || 'Not listed'}</dd></div>
                <div><dt>Email</dt><dd>{profileData.contact.email || 'Not available'}</dd></div>
                <div><dt>Phone</dt><dd>{profileData.contact.phone || 'Not available'}</dd></div>
                <div><dt>Committees</dt><dd>{profileData.jurisdiction.committees.join(', ') || 'Not listed'}</dd></div>
                <div><dt>Issue areas</dt><dd>{profileData.jurisdiction.issueAreas.join(', ') || 'Not listed'}</dd></div>
                <div><dt>Source</dt><dd>{sentence(profileData.dataQuality.sourceSystem)}</dd></div>
                <div><dt>Verified</dt><dd>{formatDate(profileData.dataQuality.lastVerifiedAt)}</dd></div>
              </dl>

              {profileData.warnings.length ? (
                <div className="ov3-target-warning-list">
                  {profileData.warnings.map((warning) => (
                    <div key={warning.code} className="ov3-recovery is-warning">
                      <CircleAlert size={16} aria-hidden="true" />
                      <div><strong>{sentence(warning.code)}</strong><p>{warning.message}</p></div>
                    </div>
                  ))}
                </div>
              ) : null}

              <section className="ov3-profile-facts">
                <span className="ov3-section-label">Personalization facts</span>
                {profileData.personalizationFacts.length ? (
                  profileData.personalizationFacts.map((fact) => (
                    <article key={fact.code}>
                      <div>
                        <strong>{fact.label}</strong>
                        <p>{Array.isArray(fact.value) ? fact.value.join(', ') : fact.value || 'Not available'}</p>
                      </div>
                      <StatusPill tone={fact.usableForPersonalization ? 'success' : 'warning'}>
                        {fact.usableForPersonalization ? 'Usable' : sentence(fact.status)}
                      </StatusPill>
                    </article>
                  ))
                ) : (
                  <p className="ov3-muted-copy">No approved personalization facts are available.</p>
                )}
              </section>

              <ProfileSection label="Known interests" section={profileData.positioning.knownInterests} />
              <ProfileSection label="District and state" section={profileData.governmentNexus.districtState} />

              <section className="ov3-relationship-panel">
                <div className="ov3-relationship-panel__header">
                  <div>
                    <span className="ov3-section-label">Relationship intelligence</span>
                    <p>
                      {sponsorClientId
                        ? 'Client-scoped meeting, email-envelope, and open-task metadata.'
                        : 'Choose one client sponsor to inspect client-scoped relationships.'}
                    </p>
                  </div>
                  {relationships.isPending ? <Loader2 className="ov3-spin" size={17} /> : null}
                </div>
                {relationship ? (
                  <>
                    <div className="ov3-relationship-metrics">
                      <span><strong>{relationship.data.interactionCount}</strong>Interactions</span>
                      <span><strong>{relationship.data.meetingCount}</strong>Meetings</span>
                      <span><strong>{relationship.data.emailCount}</strong>Emails</span>
                    </div>
                    <StatusPill tone={relationship.data.status === 'none' ? 'neutral' : 'success'}>
                      {sentence(relationship.data.status)} relationship
                    </StatusPill>
                    {relationship.data.lastInteractionAt ? (
                      <p className="ov3-muted-copy">
                        Last interaction {formatDate(relationship.data.lastInteractionAt)}
                      </p>
                    ) : null}
                    {relationship.data.recentInteractions.slice(0, 3).map((interaction) => (
                      <div key={`${interaction.type}-${interaction.occurredAt}-${interaction.label}`} className="ov3-relationship-event">
                        {interaction.type === 'meeting' ? <CalendarClock size={15} /> : <Mail size={15} />}
                        <div><strong>{interaction.label}</strong><span>{formatDate(interaction.occurredAt)}</span></div>
                      </div>
                    ))}
                    {relationship.data.openCommitments.slice(0, 3).map((commitment) => (
                      <div key={commitment.id} className="ov3-relationship-event">
                        <BadgeCheck size={15} />
                        <div><strong>{commitment.title}</strong><span>{commitment.dueDate || commitment.status}</span></div>
                      </div>
                    ))}
                  </>
                ) : relationships.isError ? (
                  <p className="ov3-muted-copy">{safeOutreachV3Error(relationships.error)}</p>
                ) : (
                  <p className="ov3-muted-copy">
                    {sponsorClientId
                      ? 'Relationship metadata loads when the profile opens.'
                      : profileData.relationshipMetadata.lastContactAt
                        ? `Last known contact ${formatDate(profileData.relationshipMetadata.lastContactAt)}.`
                        : 'No client-scoped relationship analysis is available.'}
                  </p>
                )}
              </section>

              <div className="ov3-recovery is-info">
                <ShieldCheck size={17} aria-hidden="true" />
                <div>
                  <strong>Profile is source-backed and bounded</strong>
                  <p>
                    Private note and email bodies remain excluded until governed context review.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="ov3-empty-state is-compact">
              <UserRound size={23} />
              <strong>Inspect a target before adding it</strong>
              <p>Open a profile to review role, contactability, freshness, and relationship health.</p>
            </div>
          )}

          <section className="ov3-coverage-card">
            <span className="ov3-section-label">Audience coverage</span>
            {coveragePending ? (
              <Loader2 className="ov3-spin" size={18} />
            ) : (
              <>
                <strong>{coverageSelectedCount} selected</strong>
                <p>{coverageSendReadyCount} email-ready</p>
                <div className="ov3-meter">
                  <span
                    style={{
                      width: `${Math.min(
                        100,
                        (coverageSendReadyCount / Math.max(coverageSelectedCount, 1)) * 100,
                      )}%`,
                    }}
                  />
                </div>
                {coverage?.snapshotRevalidation.some((entry) => entry.status === 'changed') ? (
                  <p className="ov3-muted-copy">One or more selected profile snapshots changed.</p>
                ) : null}
              </>
            )}
          </section>
        </aside>
      </div>

      <ErrorNotice message={error ?? targetSearchError} />
      <footer className="ov3-panel-footer">
        <span>
          {selected.length} selected · {highConfidence.length} high-confidence available · selection
          stays on this screen until you continue
        </span>
        <div className="ov3-panel-footer__actions">
          <button
            type="button"
            className="ov3-button is-secondary"
            disabled={busy}
            onClick={() => void applyCommands([criteriaCommand()]).catch((caught) => setError(safeOutreachV3Error(caught)))}
          >
            Save criteria
          </button>
        </div>
      </footer>
    </section>
  );
}

function SelectedTargetList({
  selected,
  busy,
  onProfile,
  onRemove,
}: {
  selected: OutreachV3ResolvedTargetRef[];
  busy: boolean;
  onProfile: (locator: OutreachV3TargetLocator) => Promise<void>;
  onRemove: (targetKey: string) => Promise<void>;
}) {
  if (!selected.length) {
    return (
      <div className="ov3-empty-state">
        <ContactRound size={24} />
        <strong>No selected targets</strong>
        <p>Return to Recommended or Directory and add at least one target.</p>
      </div>
    );
  }
  return (
    <div className="ov3-card-list">
      {selected.map((target) => (
        <article key={target.targetKey} className="ov3-target-card is-selected">
          <header>
            <span className="ov3-avatar">{target.displayName.slice(0, 2).toUpperCase()}</span>
            <div><strong>{target.displayName}</strong><p>{target.title || target.organization || 'Target'}</p></div>
            <StatusPill tone={target.roleStatus === 'current' ? 'success' : 'warning'}>
              {sentence(target.roleStatus)}
            </StatusPill>
          </header>
          <div className="ov3-target-card__meta">
            <span>{target.sourceSnapshot?.system ? sentence(target.sourceSnapshot.system) : sentence(target.locator.source)}</span>
            <span>{target.emailStatus === 'available' ? 'Email ready' : 'Email unavailable'}</span>
            <span>Verified {formatDate(target.sourceSnapshot?.lastVerifiedAt)}</span>
          </div>
          <footer>
            <button type="button" className="ov3-button is-quiet" onClick={() => void onProfile(target.locator)}>
              View profile <ChevronRight size={14} />
            </button>
            <span />
            <button type="button" className="ov3-button is-secondary" disabled>
              <Check size={15} /> Added
            </button>
            <button type="button" className="ov3-button is-quiet" disabled={busy} onClick={() => void onRemove(target.targetKey)}>
              <X size={15} /> Remove
            </button>
          </footer>
        </article>
      ))}
    </div>
  );
}
