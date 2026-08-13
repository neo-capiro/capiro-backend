import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  ChevronRight,
  CircleHelp,
  FileSearch,
  Globe2,
  Loader2,
  LockKeyhole,
  Mail,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import type { Client } from '../../../clients/clientTypes.js';
import {
  acceptContextCommand,
  addTargetCommand,
  deliveryCommands,
  excludeContextCommand,
  goalCommands,
  rejectTargetRecommendationCommand,
  removeTargetCommand,
  sponsorCommand,
  strategyCommands,
  targetCriteriaCommand,
  type GoalDraft,
} from './commands.js';
import type {
  CapabilityResult,
  OutreachV3Command,
  OutreachV3ContextCandidate,
  OutreachV3ContextClass,
  OutreachV3ContextReviewResponse,
  OutreachV3DeliveryPattern,
  OutreachV3Length,
  OutreachV3Personalization,
  OutreachV3Proposal,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
  OutreachV3SponsorKind,
  OutreachV3Stage,
  OutreachV3StrategyData,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
  OutreachV3TargetLocator,
} from './contracts.js';
import type { OutreachV3TargetProfileResponse } from './target-intelligence-contracts.js';
import type { OutreachV3ContextSearchInput } from './useOutreachV3Session.js';

export interface DecisionSurfacesProps {
  session: OutreachV3SessionEnvelope;
  stage: OutreachV3Stage;
  clients: Client[];
  selectedClientId: string | null;
  busy: boolean;
  applyCommands: (commands: OutreachV3Command[]) => Promise<unknown>;
  pendingProposals: OutreachV3Proposal[];
  proposalBusy: boolean;
  applyProposal: (proposal: OutreachV3Proposal) => Promise<unknown>;
  rejectProposal: (proposal: OutreachV3Proposal) => Promise<unknown>;
  searchTargets: (input: {
    query?: string;
    clientId?: string | null;
    sources?: string[];
    limit?: number;
  }) => Promise<unknown>;
  targetCandidates: OutreachV3TargetCandidate[];
  targetSearchPending: boolean;
  targetSearchError?: string | null;
  getTargetProfile: (locator: OutreachV3TargetLocator) => Promise<unknown>;
  targetProfile?: OutreachV3TargetProfileResponse;
  targetProfilePending: boolean;
  coverage?: OutreachV3TargetCoverageResponse;
  coveragePending: boolean;
  searchContext: (input: OutreachV3ContextSearchInput) => Promise<unknown>;
  contextCandidates: OutreachV3ContextCandidate[];
  contextSearchPending: boolean;
  contextSearchError?: string | null;
  contextReview?: OutreachV3ContextReviewResponse;
  contextReviewPending: boolean;
  contextReviewError?: string | null;
  strategy?: CapabilityResult<OutreachV3StrategyData>;
  strategyPending: boolean;
  strategyError?: string | null;
  onFinish: () => void;
}

const STAGE_META: Record<
  OutreachV3Stage,
  { eyebrow: string; title: string; description: string }
> = {
  goal: {
    eyebrow: 'Goal · 1 of 6',
    title: 'What should this campaign accomplish?',
    description: 'Start with the desired outcome. Client or sponsor scope is optional and comes next.',
  },
  sponsor: {
    eyebrow: 'Sponsor scope · client optional',
    title: 'Who is this campaign for?',
    description: 'Sponsor scope governs confidential context. It never chooses the recipients.',
  },
  targets: {
    eyebrow: 'Targets · 2 of 6',
    title: 'Choose the people and offices to contact',
    description: 'Search authorized sources, inspect every recommendation, and add targets explicitly.',
  },
  delivery: {
    eyebrow: 'Delivery · 3 of 6',
    title: 'How should recipients receive the message?',
    description: 'Choose the message relationship and the allowed personalization depth.',
  },
  context: {
    eyebrow: 'Context · 4 of 6',
    title: 'Review what Meri may use',
    description: 'Sources remain classified by purpose, evidence quality, sensitivity, and exact scope.',
  },
  strategy: {
    eyebrow: 'Strategy · 5 of 6',
    title: 'Set the campaign angle, tone, and length',
    description: 'Meri can recommend a strategy. The canonical values change only after your confirmation.',
  },
  ready_for_generation: {
    eyebrow: 'Planning complete · governed boundary',
    title: 'The campaign is ready for the generation phase',
    description: 'Phase 6 stops here. No draft, approval, preflight, send intent, or provider call has been created.',
  },
};

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function sentence(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function PanelHeader({
  stage,
  badge,
}: {
  stage: OutreachV3Stage;
  badge?: ReactNode;
}) {
  const meta = STAGE_META[stage];
  return (
    <header className="ov3-panel-header">
      <div>
        <span className="ov3-eyebrow">{meta.eyebrow}</span>
        <h2>{meta.title}</h2>
        <p>{meta.description}</p>
      </div>
      {badge}
    </header>
  );
}

function ErrorNotice({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="ov3-recovery is-danger" role="alert">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>This action could not complete</strong>
        <p>{message}</p>
      </div>
    </div>
  );
}

function FooterActions({
  hint,
  children,
}: {
  hint: string;
  children: ReactNode;
}) {
  return (
    <footer className="ov3-panel-footer">
      <span>{hint}</span>
      <div className="ov3-panel-footer__actions">{children}</div>
    </footer>
  );
}

function ChoiceCard({
  selected,
  title,
  description,
  icon,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx('ov3-choice-card', selected && 'is-selected')}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="ov3-choice-card__radio" aria-hidden="true">
        {selected ? <span /> : null}
      </span>
      {icon ? <span className="ov3-choice-card__icon">{icon}</span> : null}
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  multiline,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  multiline?: boolean;
  type?: 'text' | 'email' | 'search';
}) {
  return (
    <label className="ov3-field">
      <span>
        {label}
        {required ? <em>Required</em> : null}
      </span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

export function DecisionSurfaces(props: DecisionSurfacesProps) {
  const pending = props.pendingProposals[0];
  if (pending) {
    return <ProposalReviewSurface {...props} proposal={pending} />;
  }

  switch (props.stage) {
    case 'goal':
      return <GoalSurface key={props.session.specHash} {...props} />;
    case 'sponsor':
      return <SponsorSurface key={props.session.specHash} {...props} />;
    case 'targets':
      return <TargetsSurface key={props.session.specHash} {...props} />;
    case 'delivery':
      return <DeliverySurface key={props.session.specHash} {...props} />;
    case 'context':
      return <ContextSurface key={props.session.specHash} {...props} />;
    case 'strategy':
      return <StrategySurface key={props.session.specHash} {...props} />;
    case 'ready_for_generation':
      return <ReadyBoundary {...props} />;
  }
}

function GoalSurface({ session, busy, applyCommands }: DecisionSurfacesProps) {
  const goal = session.spec.goal;
  const [draft, setDraft] = useState<GoalDraft>({
    goal: goal.goal ?? '',
    objective: goal.objective ?? '',
    topic: goal.topic ?? '',
    desiredOutcome: goal.desiredOutcome ?? '',
    askMode: goal.ask.mode === 'none' ? 'none' : 'explicit',
    askText: goal.ask.text ?? '',
    whyNow: goal.whyNow ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const outcomes = [
    ['Request a meeting', 'Ask the office for a focused staff briefing.'],
    ['Protect funding', 'Build support before the next authorization or mark.'],
    ['Share an update', 'Keep stakeholders informed with a concise policy update.'],
    ['Custom outcome', 'Describe a different result in your own words.'],
  ] as const;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.goal.trim() || !draft.topic.trim() || !draft.desiredOutcome.trim()) {
      setError('Goal, topic, and desired outcome are required.');
      return;
    }
    if (draft.askMode === 'explicit' && !draft.askText.trim()) {
      setError('Enter the explicit ask or choose “No formal ask.”');
      return;
    }
    setError(null);
    try {
      await applyCommands(goalCommands(draft));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The goal could not be saved.');
    }
  };

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <PanelHeader stage="goal" badge={<span className="ov3-badge">Draft</span>} />
      <div className="ov3-split is-brief">
        <div className="ov3-form-stack">
          <span className="ov3-section-label">Choose an outcome</span>
          <div className="ov3-choice-grid">
            {outcomes.map(([title, description]) => (
              <ChoiceCard
                key={title}
                selected={draft.desiredOutcome === title}
                title={title}
                description={description}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    desiredOutcome: title,
                    goal: current.goal || title,
                    askText:
                      title === 'Request a meeting' && !current.askText
                        ? 'Request a 30-minute staff briefing'
                        : current.askText,
                  }))
                }
              />
            ))}
          </div>
          <Field
            label="Campaign goal"
            required
            value={draft.goal}
            placeholder="Protect FY27 Ground Robotics funding"
            onChange={(value) => setDraft((current) => ({ ...current, goal: value }))}
          />
          <div className="ov3-field-grid">
            <Field
              label="Topic"
              required
              value={draft.topic}
              placeholder="FY27 Ground Robotics funding"
              onChange={(value) => setDraft((current) => ({ ...current, topic: value }))}
            />
            <Field
              label="Objective"
              value={draft.objective}
              placeholder="Educate staff before the next mark"
              onChange={(value) => setDraft((current) => ({ ...current, objective: value }))}
            />
          </div>
          <div className="ov3-inline-choice" role="group" aria-label="Ask mode">
            <button
              type="button"
              className={draft.askMode === 'explicit' ? 'is-selected' : ''}
              onClick={() => setDraft((current) => ({ ...current, askMode: 'explicit' }))}
            >
              Explicit ask
            </button>
            <button
              type="button"
              className={draft.askMode === 'none' ? 'is-selected' : ''}
              onClick={() => setDraft((current) => ({ ...current, askMode: 'none' }))}
            >
              No formal ask
            </button>
          </div>
          {draft.askMode === 'explicit' ? (
            <Field
              label="Explicit ask"
              required
              value={draft.askText}
              placeholder="Request a 30-minute staff briefing"
              onChange={(value) => setDraft((current) => ({ ...current, askText: value }))}
            />
          ) : null}
          <Field
            label="Why now"
            value={draft.whyNow}
            placeholder="The current mark is below the request"
            onChange={(value) => setDraft((current) => ({ ...current, whyNow: value }))}
            multiline
          />
        </div>
        <aside className="ov3-guidance-card">
          <Sparkles size={18} aria-hidden="true" />
          <span className="ov3-eyebrow">Meri can help</span>
          <h3>Start with the result, not the form</h3>
          <p>
            Describe the outcome in natural language. These fields are the canonical read-back
            and remain editable even if reasoning is unavailable.
          </p>
          <ul>
            <li>Client selection is optional.</li>
            <li>Targets are chosen later.</li>
            <li>No draft or email is created here.</li>
          </ul>
        </aside>
      </div>
      <ErrorNotice message={error} />
      <FooterActions hint="Every save creates a new immutable Campaign Spec version.">
        <button type="submit" className="ov3-button is-primary" disabled={busy}>
          {busy ? <Loader2 className="ov3-spin" size={16} /> : null}
          Confirm goal
        </button>
      </FooterActions>
    </form>
  );
}

const SPONSOR_OPTIONS: Array<{
  kind: OutreachV3SponsorKind;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  { kind: 'client', title: 'One client', description: 'Use one authorized client scope.', icon: <Building2 /> },
  { kind: 'multi_client', title: 'Several clients', description: 'Each client must be authorized.', icon: <UsersRound /> },
  { kind: 'firm', title: 'Firm-wide', description: 'Tenant-neutral context only.', icon: <ShieldCheck /> },
  { kind: 'coalition', title: 'Coalition or association', description: 'Named shared sponsor scope.', icon: <Globe2 /> },
  { kind: 'internal_team', title: 'Internal team', description: 'No external sponsor attribution.', icon: <UserRound /> },
  { kind: 'none', title: 'No formal sponsor', description: 'General relationship outreach.', icon: <CircleHelp /> },
];

function SponsorSurface({
  session,
  clients,
  selectedClientId,
  busy,
  applyCommands,
}: DecisionSurfacesProps) {
  const sponsor = session.spec.sponsor;
  const [kind, setKind] = useState<OutreachV3SponsorKind>(
    sponsor.kind === 'undecided' ? (selectedClientId ? 'client' : 'firm') : sponsor.kind,
  );
  const [label, setLabel] = useState(sponsor.label ?? '');
  const [search, setSearch] = useState('');
  const [clientIds, setClientIds] = useState<string[]>(
    sponsor.clientRefs.length
      ? sponsor.clientRefs.map((ref) => ref.clientId)
      : selectedClientId
        ? [selectedClientId]
        : [],
  );
  const [error, setError] = useState<string | null>(null);
  const filteredClients = clients.filter((client) =>
    client.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggleClient = (clientId: string) => {
    setClientIds((current) => {
      if (kind === 'client') return [clientId];
      return current.includes(clientId)
        ? current.filter((id) => id !== clientId)
        : [...current, clientId];
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (kind === 'client' && clientIds.length !== 1) {
      setError('Select exactly one client.');
      return;
    }
    if (kind === 'multi_client' && clientIds.length < 2) {
      setError('Select at least two clients.');
      return;
    }
    if (kind === 'coalition' && !label.trim()) {
      setError('Enter the coalition or association name.');
      return;
    }
    const scopedIds = kind === 'client' || kind === 'multi_client' ? clientIds : [];
    setError(null);
    try {
      await applyCommands([sponsorCommand({ kind, label, clientIds: scopedIds })]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The sponsor scope could not be saved.');
    }
  };

  return (
    <form className="ov3-decision-panel" onSubmit={submit}>
      <PanelHeader
        stage="sponsor"
        badge={<span className="ov3-badge is-info">Client optional</span>}
      />
      <div className="ov3-choice-grid is-three">
        {SPONSOR_OPTIONS.map((option) => (
          <ChoiceCard
            key={option.kind}
            selected={kind === option.kind}
            title={option.title}
            description={option.description}
            icon={option.icon}
            onClick={() => {
              setKind(option.kind);
              setError(null);
            }}
          />
        ))}
      </div>

      {kind === 'client' || kind === 'multi_client' ? (
        <section className="ov3-selection-box">
          <header>
            <div>
              <span className="ov3-section-label">Authorized clients</span>
              <p>{kind === 'client' ? 'Choose one client.' : 'Choose two or more clients.'}</p>
            </div>
            <label className="ov3-search-control">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search clients"
                aria-label="Search clients"
              />
            </label>
          </header>
          <div className="ov3-client-list">
            {filteredClients.slice(0, 20).map((client) => {
              const selected = clientIds.includes(client.id);
              return (
                <button
                  key={client.id}
                  type="button"
                  className={selected ? 'is-selected' : ''}
                  aria-pressed={selected}
                  onClick={() => toggleClient(client.id)}
                >
                  <span className="ov3-avatar">{client.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{client.name}</strong>
                    <small>{client.website || client.sectorTag || 'Client account'}</small>
                  </span>
                  {selected ? <Check size={17} aria-hidden="true" /> : <Plus size={17} />}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {kind === 'coalition' ? (
        <Field
          label="Coalition or association name"
          required
          value={label}
          placeholder="Autonomous Systems Coalition"
          onChange={setLabel}
        />
      ) : null}

      <div className="ov3-recovery is-info">
        <LockKeyhole size={18} aria-hidden="true" />
        <div>
          <strong>Sponsor and target audience are separate</strong>
          <p>
            Sponsor scope determines which confidential context may be reviewed. It never adds
            anyone to the campaign audience.
          </p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <FooterActions hint="No client is required. Client scope only governs context and attribution.">
        <button type="submit" className="ov3-button is-primary" disabled={busy}>
          Confirm sponsor
        </button>
      </FooterActions>
    </form>
  );
}

const TARGET_SOURCE_OPTIONS = [
  { key: 'recommended', label: 'Recommended', sources: [] as string[] },
  {
    key: 'directory',
    label: 'Directory',
    sources: ['directory_member', 'directory_staff', 'state_legislator'],
  },
  {
    key: 'client',
    label: 'Client contacts',
    sources: ['client_person', 'engagement_contact', 'client_recommendation'],
  },
] as const;

function TargetsSurface(props: DecisionSurfacesProps) {
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
  const selected = session.spec.targeting.selectedTargetRefs;
  const sponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;
  const [source, setSource] = useState<(typeof TARGET_SOURCE_OPTIONS)[number]['key']>('recommended');
  const [query, setQuery] = useState(session.spec.goal.topic ?? '');
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ name: '', email: '', title: '', organization: '', note: '' });
  const searched = useRef(false);

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const option = TARGET_SOURCE_OPTIONS.find((entry) => entry.key === source)!;
    if (source === 'client' && !sponsorClientId) {
      setError('Client contacts require one explicit client sponsor.');
      return;
    }
    setError(null);
    try {
      await searchTargets({
        query: query.trim() || undefined,
        clientId: source === 'client' ? sponsorClientId : undefined,
        sources: [...option.sources],
        limit: 20,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Targets could not be searched.');
    }
  };

  useEffect(() => {
    if (searched.current) return;
    searched.current = true;
    void runSearch();
    // Intentionally run once from the canonical topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addCandidate = async (candidate: OutreachV3TargetCandidate) => {
    setError(null);
    try {
      await applyCommands([addTargetCommand(candidate)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The target could not be added.');
    }
  };

  const addManual = async () => {
    if (!manual.name.trim()) {
      setError('Enter the target name.');
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
      setManualOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The manual target could not be added.');
    }
  };

  const profileTarget = targetProfile?.data?.target;
  const profileStatus = targetProfile?.selectionSnapshot?.status;

  return (
    <section className="ov3-decision-panel">
      <PanelHeader
        stage="targets"
        badge={<span className="ov3-badge is-success">{selected.length} selected</span>}
      />

      <div className="ov3-tab-row" role="tablist" aria-label="Target sources">
        {TARGET_SOURCE_OPTIONS.map((option) => (
          <button
            key={option.key}
            role="tab"
            type="button"
            aria-selected={source === option.key}
            className={source === option.key ? 'is-selected' : ''}
            onClick={() => setSource(option.key)}
          >
            {option.label}
          </button>
        ))}
        <button type="button" onClick={() => setManualOpen((value) => !value)}>
          Manual
        </button>
      </div>

      <form className="ov3-search-bar" onSubmit={runSearch}>
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search names, committees, offices, states, or issue areas"
          aria-label="Search targets"
        />
        <button className="ov3-button is-secondary" type="submit" disabled={targetSearchPending}>
          {targetSearchPending ? <Loader2 className="ov3-spin" size={16} /> : null}
          Search
        </button>
      </form>

      {manualOpen ? (
        <section className="ov3-manual-entry">
          <header>
            <div>
              <span className="ov3-section-label">Manual target</span>
              <p>Manual identities are resolved and snapshotted by the server before selection.</p>
            </div>
            <button type="button" className="ov3-icon-button" onClick={() => setManualOpen(false)}>
              <X size={17} />
              <span className="sr-only">Close manual target form</span>
            </button>
          </header>
          <div className="ov3-field-grid">
            <Field label="Name" required value={manual.name} onChange={(name) => setManual({ ...manual, name })} />
            <Field label="Email" type="email" value={manual.email} onChange={(email) => setManual({ ...manual, email })} />
            <Field label="Title" value={manual.title} onChange={(title) => setManual({ ...manual, title })} />
            <Field
              label="Organization"
              value={manual.organization}
              onChange={(organization) => setManual({ ...manual, organization })}
            />
          </div>
          <Field label="Note" value={manual.note} onChange={(note) => setManual({ ...manual, note })} multiline />
          <button type="button" className="ov3-button is-primary" onClick={() => void addManual()} disabled={busy}>
            Add manual target
          </button>
        </section>
      ) : null}

      <div className="ov3-work-grid is-targets">
        <div className="ov3-target-column">
          {selected.length > 0 ? (
            <section className="ov3-selected-strip">
              <span className="ov3-section-label">Selected audience</span>
              <div>
                {selected.map((target) => (
                  <button
                    key={target.targetKey}
                    type="button"
                    className="ov3-target-chip"
                    onClick={() => void getTargetProfile(target.locator)}
                  >
                    <span>{target.displayName}</span>
                    <small>{target.title || target.organization || 'Target'}</small>
                    <ChevronRight size={14} />
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <span className="ov3-section-label">Search results</span>
          {targetSearchPending ? (
            <div className="ov3-loading-list" aria-label="Searching targets">
              {[1, 2, 3].map((value) => <span key={value} />)}
            </div>
          ) : targetCandidates.length === 0 ? (
            <div className="ov3-empty-state">
              <UsersRound size={24} aria-hidden="true" />
              <strong>No matching targets yet</strong>
              <p>Broaden the search, choose another source, or add a target manually.</p>
            </div>
          ) : (
            <div className="ov3-card-list">
              {targetCandidates.map((candidate) => {
                const isSelected = selected.some((target) => target.targetKey === candidate.targetKey);
                return (
                  <article key={candidate.recommendationRef} className={cx('ov3-target-card', isSelected && 'is-selected')}>
                    <header>
                      <span className="ov3-avatar">{candidate.displayName.slice(0, 2).toUpperCase()}</span>
                      <div>
                        <strong>{candidate.displayName}</strong>
                        <p>{candidate.title || candidate.organization || 'Government-affairs target'}</p>
                      </div>
                      <span className={cx('ov3-badge', candidate.roleStatus !== 'current' && 'is-warning')}>
                        {candidate.roleStatus === 'current' ? 'Current' : sentence(candidate.roleStatus)}
                      </span>
                    </header>
                    <p className="ov3-target-card__why">
                      {candidate.signals[0]?.label ?? 'Matches the current target criteria.'}
                    </p>
                    <div className="ov3-target-card__meta">
                      <span>{candidate.organization || candidate.jurisdiction.chamber || 'Directory'}</span>
                      <span>{candidate.emailStatus === 'available' ? 'Email ready' : 'Email missing'}</span>
                      <span>{Math.round(candidate.score * 100)}% match</span>
                    </div>
                    <footer>
                      <button type="button" className="ov3-button is-quiet" onClick={() => void getTargetProfile(candidate.locator)}>
                        View profile
                      </button>
                      {!isSelected ? (
                        <button
                          type="button"
                          className="ov3-button is-quiet"
                          onClick={() =>
                            void applyCommands([
                              rejectTargetRecommendationCommand({
                                recommendationRef: candidate.recommendationRef,
                                targetKey: candidate.targetKey,
                              }),
                            ])
                          }
                        >
                          Not relevant
                        </button>
                      ) : null}
                      <span />
                      {isSelected ? (
                        <button
                          type="button"
                          className="ov3-button is-secondary"
                          onClick={() => void applyCommands([removeTargetCommand(candidate.targetKey)])}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="ov3-button is-primary"
                          onClick={() => void addCandidate(candidate)}
                          disabled={busy}
                        >
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

        <aside className="ov3-inspector">
          <header>
            <span className="ov3-eyebrow">Target profile</span>
            {profileStatus ? <span className="ov3-badge">{sentence(profileStatus)}</span> : null}
          </header>
          {targetProfilePending ? (
            <div className="ov3-centered"><Loader2 className="ov3-spin" /></div>
          ) : profileTarget ? (
            <>
              <div className="ov3-inspector__identity">
                <span className="ov3-avatar is-large">{profileTarget.displayName.slice(0, 2).toUpperCase()}</span>
                <div>
                  <h3>{profileTarget.displayName}</h3>
                  <p>{profileTarget.title || profileTarget.organization || 'Target'}</p>
                </div>
              </div>
              <dl className="ov3-detail-list">
                <div><dt>Office</dt><dd>{profileTarget.organization || 'Not listed'}</dd></div>
                <div><dt>Email</dt><dd>{profileTarget.email || 'Not available'}</dd></div>
                <div><dt>Role</dt><dd>{sentence(profileTarget.roleStatus)}</dd></div>
                <div><dt>Committees</dt><dd>{profileTarget.jurisdiction.committees.join(', ') || 'Not listed'}</dd></div>
                <div><dt>Issue areas</dt><dd>{profileTarget.jurisdiction.issueAreas.join(', ') || 'Not listed'}</dd></div>
              </dl>
              <div className="ov3-recovery is-info">
                <ShieldCheck size={17} />
                <div>
                  <strong>Profile is source-backed</strong>
                  <p>Snapshot changes will make downstream drafts stale in the owning phase.</p>
                </div>
              </div>
            </>
          ) : (
            <div className="ov3-empty-state is-compact">
              <UserRound size={23} />
              <strong>Select “View profile”</strong>
              <p>Inspect role, office, contactability, and source health before adding a target.</p>
            </div>
          )}

          <section className="ov3-coverage-card">
            <span className="ov3-section-label">Audience coverage</span>
            {coveragePending ? (
              <Loader2 className="ov3-spin" size={18} />
            ) : (
              <>
                <strong>{coverage?.coverage.selectedCount ?? selected.length} selected</strong>
                <p>{coverage?.coverage.sendReadyCount ?? selected.filter((target) => target.email).length} email-ready</p>
                <div className="ov3-meter">
                  <span
                    style={{
                      width: `${Math.min(
                        100,
                        ((coverage?.coverage.sendReadyCount ?? 0) /
                          Math.max(coverage?.coverage.selectedCount ?? selected.length, 1)) *
                          100,
                      )}%`,
                    }}
                  />
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
      <ErrorNotice message={error ?? targetSearchError} />
      <FooterActions hint={`${selected.length} selected · recommendations never become targets automatically`}>
        <button
          type="button"
          className="ov3-button is-secondary"
          onClick={() =>
            void applyCommands([
              targetCriteriaCommand({
                notes: query,
                governmentLevels: ['federal'],
                relationshipPreference: 'any',
              }),
            ])
          }
          disabled={busy}
        >
          Save search criteria
        </button>
      </FooterActions>
    </section>
  );
}

function DeliverySurface({ session, busy, applyCommands }: DecisionSurfacesProps) {
  const delivery = session.spec.delivery;
  const [pattern, setPattern] = useState<OutreachV3DeliveryPattern>(delivery.pattern);
  const [personalization, setPersonalization] = useState<OutreachV3Personalization>(
    delivery.personalization,
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (pattern === 'undecided' || personalization === 'undecided') {
      setError('Choose a delivery pattern and personalization level.');
      return;
    }
    setError(null);
    try {
      await applyCommands(deliveryCommands(pattern, personalization));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Delivery could not be saved.');
    }
  };

  return (
    <section className="ov3-decision-panel">
      <PanelHeader stage="delivery" badge={<span className="ov3-badge is-info">Choose explicitly</span>} />
      <div className="ov3-split is-brief">
        <div className="ov3-form-stack">
          <span className="ov3-section-label">Delivery pattern</span>
          <ChoiceCard
            selected={pattern === 'personalized_separate'}
            title="Personalized separate"
            description="Each recipient gets an independently reviewable message. Recipients are hidden from one another."
            icon={<Mail />}
            onClick={() => setPattern('personalized_separate')}
          />
          <ChoiceCard
            selected={pattern === 'uniform_separate'}
            title="Uniform separate"
            description="One approved message is delivered separately to each recipient."
            icon={<Mail />}
            onClick={() => setPattern('uniform_separate')}
          />
          <ChoiceCard
            selected={pattern === 'shared_thread'}
            title="Shared thread"
            description="One email thread with the recipient list visible to everyone."
            icon={<UsersRound />}
            onClick={() => setPattern('shared_thread')}
          />

          <span className="ov3-section-label">Personalization level</span>
          <div className="ov3-segmented" role="group" aria-label="Personalization level">
            {(['high', 'light', 'none'] as OutreachV3Personalization[]).map((value) => (
              <button
                key={value}
                type="button"
                className={personalization === value ? 'is-selected' : ''}
                aria-pressed={personalization === value}
                onClick={() => setPersonalization(value)}
              >
                {sentence(value)}
              </button>
            ))}
          </div>
          <div className="ov3-recovery is-info">
            <ShieldCheck size={18} />
            <div>
              <strong>Personalization remains governed</strong>
              <p>
                Target-specific context can appear only after it is accepted for that exact target.
              </p>
            </div>
          </div>
        </div>
        <aside className="ov3-guidance-card">
          <Sparkles size={18} />
          <span className="ov3-eyebrow">Recommended default</span>
          <h3>Personalized separate · light</h3>
          <p>
            This keeps target scope independently reviewable without overusing personal details.
          </p>
          <dl className="ov3-detail-list">
            <div><dt>Selected targets</dt><dd>{session.spec.targeting.selectedTargetRefs.length}</dd></div>
            <div><dt>Recipient visibility</dt><dd>{pattern === 'shared_thread' ? 'Visible' : 'Hidden'}</dd></div>
            <div><dt>Draft authority</dt><dd>Not enabled in Phase 6</dd></div>
          </dl>
        </aside>
      </div>
      <ErrorNotice message={error} />
      <FooterActions hint="This stage chooses delivery semantics; it does not generate or send email.">
        <button type="button" className="ov3-button is-primary" onClick={() => void submit()} disabled={busy}>
          Confirm delivery
        </button>
      </FooterActions>
    </section>
  );
}

function allAcceptedContext(session: OutreachV3SessionEnvelope): OutreachV3ResolvedContextRef[] {
  const context = session.spec.context;
  return [
    ...context.requiredPolicyRefs,
    ...context.writingGuidanceRefs,
    ...context.campaignFactRefs,
    ...context.targetSpecificRefs,
    ...context.groupSafeRefs,
  ];
}

function ContextSurface(props: DecisionSurfacesProps) {
  const {
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
  } = props;
  const [source, setSource] = useState<'memory' | 'government'>('government');
  const [query, setQuery] = useState(session.spec.goal.topic ?? '');
  const [contextClass, setContextClass] = useState<OutreachV3ContextClass>('campaign_fact');
  const [targetKey, setTargetKey] = useState(session.spec.targeting.selectedTargetRefs[0]?.targetKey ?? '');
  const [error, setError] = useState<string | null>(null);
  const accepted = allAcceptedContext(session);
  const sponsorClientId =
    session.spec.sponsor.kind === 'client' && session.spec.sponsor.clientRefs.length === 1
      ? session.spec.sponsor.clientRefs[0]?.clientId ?? null
      : null;

  const scope = useMemo(() => {
    if (contextClass === 'target_specific') return { kind: 'target' as const, targetKey };
    return { kind: 'campaign' as const };
  }, [contextClass, targetKey]);

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (query.trim().length < 2) {
      setError('Enter at least two characters.');
      return;
    }
    if (contextClass === 'target_specific' && !targetKey) {
      setError('Choose the target that this context belongs to.');
      return;
    }
    if (source === 'government' && contextClass === 'writing_guidance') {
      setError('Writing guidance must come from governed memory, not a government fact source.');
      return;
    }
    setError(null);
    try {
      await searchContext({
        source,
        query,
        clientId: source === 'memory' ? sponsorClientId : null,
        intendedClass: contextClass,
        scope,
        limit: 20,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Context could not be searched.');
    }
  };

  const accept = async (candidate: OutreachV3ContextCandidate) => {
    setError(null);
    try {
      await applyCommands([acceptContextCommand([candidate.selection])]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Context could not be accepted.');
    }
  };

  return (
    <section className="ov3-decision-panel">
      <PanelHeader
        stage="context"
        badge={<span className="ov3-badge is-success">{accepted.length} accepted</span>}
      />
      <div className="ov3-tab-row" role="tablist" aria-label="Context sources">
        <button
          role="tab"
          type="button"
          aria-selected={source === 'government'}
          className={source === 'government' ? 'is-selected' : ''}
          onClick={() => setSource('government')}
        >
          Government records
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={source === 'memory'}
          className={source === 'memory' ? 'is-selected' : ''}
          onClick={() => setSource('memory')}
        >
          Institutional memory
        </button>
      </div>

      <form className="ov3-context-search" onSubmit={runSearch}>
        <label>
          <span>Use as</span>
          <select
            value={contextClass}
            onChange={(event) => setContextClass(event.target.value as OutreachV3ContextClass)}
          >
            <option value="campaign_fact">Campaign fact</option>
            <option value="required_policy">Required policy</option>
            <option value="writing_guidance">Writing guidance</option>
            <option value="target_specific">Target-specific fact</option>
          </select>
        </label>
        {contextClass === 'target_specific' ? (
          <label>
            <span>Target scope</span>
            <select value={targetKey} onChange={(event) => setTargetKey(event.target.value)}>
              <option value="">Choose target</option>
              {session.spec.targeting.selectedTargetRefs.map((target) => (
                <option key={target.targetKey} value={target.targetKey}>{target.displayName}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="ov3-search-control is-large">
          <Search size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={source === 'memory' ? 'Search approved memory' : 'Search government records'}
            aria-label="Search context"
          />
        </label>
        <button type="submit" className="ov3-button is-primary" disabled={contextSearchPending}>
          {contextSearchPending ? <Loader2 className="ov3-spin" size={16} /> : <FileSearch size={16} />}
          Search
        </button>
      </form>

      <div className="ov3-work-grid is-context">
        <div className="ov3-context-results">
          <span className="ov3-section-label">Candidates</span>
          {contextSearchPending ? (
            <div className="ov3-loading-list"><span /><span /><span /></div>
          ) : contextCandidates.length === 0 ? (
            <div className="ov3-empty-state">
              <FileSearch size={24} />
              <strong>No context candidates loaded</strong>
              <p>Search a source or ask Meri to research the current campaign.</p>
            </div>
          ) : (
            <div className="ov3-card-list">
              {contextCandidates.map((candidate, index) => {
                const title = candidate.title;
                const summary =
                  candidate.sourceKind === 'memory'
                    ? candidate.summary
                    : candidate.subtitle || `${candidate.category} record`;
                return (
                  <article key={`${candidate.sourceKind}-${candidate.selection.locator.id}-${index}`} className="ov3-context-card">
                    <header>
                      <div>
                        <span className="ov3-eyebrow">
                          {candidate.sourceKind === 'memory'
                            ? candidate.memoryType
                            : candidate.category}
                        </span>
                        <h3>{title}</h3>
                      </div>
                      <span className="ov3-badge is-info">{sentence(candidate.selection.contextClass)}</span>
                    </header>
                    <p>{summary}</p>
                    <div className="ov3-context-card__scope">
                      <span>{candidate.sourceKind === 'memory' ? candidate.verificationClass : 'Authoritative'}</span>
                      <span>{candidate.selection.scope.kind === 'target' ? 'Target scoped' : 'Campaign scoped'}</span>
                    </div>
                    <footer>
                      <span />
                      <button type="button" className="ov3-button is-primary" onClick={() => void accept(candidate)} disabled={busy}>
                        Accept context
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="ov3-inspector">
          <header>
            <span className="ov3-eyebrow">Accepted context</span>
            {contextReviewPending ? <Loader2 className="ov3-spin" size={16} /> : null}
          </header>
          {accepted.length === 0 ? (
            <div className="ov3-empty-state is-compact">
              <LockKeyhole size={22} />
              <strong>Nothing accepted yet</strong>
              <p>A search result or Meri proposal must be reviewed before use.</p>
            </div>
          ) : (
            <div className="ov3-accepted-list">
              {accepted.map((item) => (
                <article key={item.contextKey}>
                  <div>
                    <span className="ov3-eyebrow">{sentence(item.contextClass)}</span>
                    <strong>{item.title}</strong>
                    <p>{item.summary}</p>
                  </div>
                  <span className={cx('ov3-badge', item.usableAsEvidence ? 'is-success' : 'is-info')}>
                    {item.usableAsEvidence ? 'Evidence' : 'Guidance'}
                  </span>
                  <button
                    type="button"
                    className="ov3-icon-button"
                    aria-label={`Exclude ${item.title}`}
                    onClick={() => void applyCommands([excludeContextCommand([{ contextKey: item.contextKey }])])}
                    disabled={busy}
                  >
                    <X size={15} />
                  </button>
                </article>
              ))}
            </div>
          )}
          {contextReview ? (
            <dl className="ov3-detail-list">
              <div><dt>Facts</dt><dd>{contextReview.summary.campaignFactCount}</dd></div>
              <div><dt>Guidance</dt><dd>{contextReview.summary.writingGuidanceCount}</dd></div>
              <div><dt>Target-specific</dt><dd>{contextReview.summary.targetSpecificCount}</dd></div>
              <div><dt>Unverified evidence</dt><dd>{contextReview.summary.unverifiedEvidenceCount}</dd></div>
            </dl>
          ) : null}
        </aside>
      </div>
      <ErrorNotice message={error ?? contextSearchError ?? contextReviewError} />
      <FooterActions hint="Writing guidance cannot support a factual claim. Target facts remain target-scoped.">
        <span className="ov3-badge is-success">{accepted.length} accepted</span>
      </FooterActions>
    </section>
  );
}

function StrategySurface({
  session,
  busy,
  applyCommands,
  strategy,
  strategyPending,
  strategyError,
}: DecisionSurfacesProps) {
  const recommended = strategy?.data.recommendation ?? strategy?.data ?? {};
  const [campaignAngle, setCampaignAngle] = useState(
    session.spec.strategy.campaignAngle ?? recommended.campaignAngle ?? '',
  );
  const [tone, setTone] = useState(session.spec.strategy.tone ?? recommended.tone ?? 'Direct · professional');
  const [length, setLength] = useState<OutreachV3Length>(
    session.spec.strategy.length === 'undecided'
      ? recommended.length ?? 'short'
      : session.spec.strategy.length,
  );
  const [customInstruction, setCustomInstruction] = useState(
    session.spec.strategy.customLengthInstruction ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const rationale = recommended.rationale ?? strategy?.data.rationale ?? [];
  const warnings = recommended.warnings ?? strategy?.data.warnings ?? [];

  const submit = async () => {
    if (!campaignAngle.trim() || !tone.trim() || length === 'undecided') {
      setError('Campaign angle, tone, and length are required.');
      return;
    }
    if (length === 'custom' && !customInstruction.trim()) {
      setError('Enter a custom length instruction.');
      return;
    }
    setError(null);
    try {
      await applyCommands(
        strategyCommands({ campaignAngle, tone, length, customInstruction }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Strategy could not be saved.');
    }
  };

  return (
    <section className="ov3-decision-panel">
      <PanelHeader
        stage="strategy"
        badge={
          <span className="ov3-badge is-info">
            {strategyPending ? 'Loading recommendation' : 'Meri recommends'}
          </span>
        }
      />
      <div className="ov3-split is-brief">
        <div className="ov3-form-stack">
          <Field
            label="Campaign angle"
            required
            value={campaignAngle}
            placeholder="Protect funding through staff education"
            onChange={setCampaignAngle}
            multiline
          />
          <Field
            label="Tone"
            required
            value={tone}
            placeholder="Direct · professional · evidence-led"
            onChange={setTone}
          />
          <span className="ov3-section-label">Length</span>
          <div className="ov3-segmented" role="group" aria-label="Campaign length">
            {(['short', 'medium', 'long', 'custom'] as OutreachV3Length[]).map((value) => (
              <button
                key={value}
                type="button"
                className={length === value ? 'is-selected' : ''}
                aria-pressed={length === value}
                onClick={() => setLength(value)}
              >
                {sentence(value)}
              </button>
            ))}
          </div>
          {length === 'custom' ? (
            <Field
              label="Custom length instruction"
              required
              value={customInstruction}
              onChange={setCustomInstruction}
              placeholder="No more than 180 words with three short paragraphs"
            />
          ) : null}
          <div className="ov3-recovery is-info">
            <BadgeCheck size={18} />
            <div>
              <strong>Recommendation, not authority</strong>
              <p>Saving this form creates deterministic Campaign Spec commands.</p>
            </div>
          </div>
        </div>
        <aside className="ov3-guidance-card is-strategy">
          <Sparkles size={18} />
          <span className="ov3-eyebrow">Why this fits</span>
          <h3>{campaignAngle || 'Strategy recommendation'}</h3>
          {strategyPending ? (
            <div className="ov3-centered"><Loader2 className="ov3-spin" /></div>
          ) : (
            <ul>
              {(rationale.length
                ? rationale
                : [
                    'The selected audience is independently reviewable.',
                    'The accepted facts support an evidence-led opening.',
                    'The explicit ask favors a concise structure.',
                  ]
              ).map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          )}
          {warnings.length > 0 ? (
            <div className="ov3-recovery is-warning">
              <AlertTriangle size={17} />
              <div>
                <strong>Open consideration</strong>
                <p>{warnings[0]}</p>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
      <ErrorNotice message={error ?? strategyError} />
      <FooterActions hint="Meri may also return these values as a pending proposal for explicit Apply.">
        <button type="button" className="ov3-button is-primary" onClick={() => void submit()} disabled={busy}>
          Confirm strategy
        </button>
      </FooterActions>
    </section>
  );
}

function commandLabel(command: OutreachV3Command): string {
  const labels: Record<string, string> = {
    SET_GOAL: 'Campaign goal',
    SET_OBJECTIVE: 'Objective',
    SET_TOPIC: 'Topic',
    SET_DESIRED_OUTCOME: 'Desired outcome',
    SET_ASK: 'Explicit ask',
    SET_WHY_NOW: 'Why now',
    SET_SPONSOR_SCOPE: 'Sponsor scope',
    SET_TARGET_CRITERIA: 'Target criteria',
    ADD_TARGET_REFS: 'Add target',
    REMOVE_TARGET_REFS: 'Remove target',
    ACCEPT_CONTEXT_REFS: 'Accept context',
    EXCLUDE_CONTEXT_REFS: 'Exclude context',
    SET_DELIVERY_PATTERN: 'Delivery pattern',
    SET_PERSONALIZATION: 'Personalization',
    SET_CAMPAIGN_ANGLE: 'Campaign angle',
    SET_TONE: 'Tone',
    SET_LENGTH: 'Length',
  };
  return labels[command.type] ?? sentence(command.type);
}

function commandValue(command: OutreachV3Command): string {
  const payload = command.payload as Record<string, unknown>;
  if (typeof payload.value === 'string') return sentence(payload.value);
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.kind === 'string') return sentence(payload.kind);
  if (Array.isArray(payload.refs)) return `${payload.refs.length} reference${payload.refs.length === 1 ? '' : 's'}`;
  if (Array.isArray(payload.selections)) {
    return `${payload.selections.length} context selection${payload.selections.length === 1 ? '' : 's'}`;
  }
  return 'Update campaign state';
}

function ProposalReviewSurface(
  props: DecisionSurfacesProps & { proposal: OutreachV3Proposal },
) {
  const { proposal, session, proposalBusy, applyProposal, rejectProposal } = props;
  const stale = proposal.expectedStateVersion !== session.currentStateVersion;
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setError(null);
    try {
      await applyProposal(proposal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The proposal could not be applied.');
    }
  };

  const discard = async () => {
    setError(null);
    try {
      await rejectProposal(proposal);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The proposal could not be discarded.');
    }
  };

  return (
    <section className="ov3-decision-panel is-proposal">
      <PanelHeader
        stage="strategy"
        badge={<span className={cx('ov3-badge', stale ? 'is-warning' : 'is-info')}>{stale ? 'Stale' : 'Pending'}</span>}
      />
      <div className="ov3-proposal-banner">
        <Sparkles size={18} />
        <div>
          <span className="ov3-eyebrow">Meri proposal · V{proposal.expectedStateVersion}</span>
          <h3>Review the exact campaign changes</h3>
          <p>
            Nothing has changed. Apply commits the entire deterministic batch atomically;
            Discard changes only the proposal status.
          </p>
        </div>
      </div>

      {stale ? (
        <div className="ov3-recovery is-warning">
          <RefreshCw size={18} />
          <div>
            <strong>This proposal no longer matches the current campaign</strong>
            <p>
              It was based on state V{proposal.expectedStateVersion}; the campaign is now V
              {session.currentStateVersion}. Discard it or ask Meri for a fresh proposal.
            </p>
          </div>
        </div>
      ) : null}

      <div className="ov3-proposal-list">
        {proposal.commands.map((command, index) => (
          <article key={`${command.type}-${index}`}>
            <header>
              <span className="ov3-eyebrow">{commandLabel(command)}</span>
              <code>{command.type}</code>
            </header>
            <div>
              <span>Current Campaign Spec</span>
              <ArrowRight size={17} />
              <strong>{commandValue(command)}</strong>
            </div>
          </article>
        ))}
      </div>

      <div className="ov3-recovery is-info">
        <ShieldCheck size={18} />
        <div>
          <strong>State safety</strong>
          <p>No draft, approval, send intent, provider call, or memory commit is part of this proposal.</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <FooterActions hint={`Proposal ${proposal.id.slice(0, 8)} · expected state V${proposal.expectedStateVersion}`}>
        <button type="button" className="ov3-button is-quiet" onClick={() => void discard()} disabled={proposalBusy}>
          Discard
        </button>
        <button
          type="button"
          className="ov3-button is-primary"
          onClick={() => void apply()}
          disabled={proposalBusy || stale}
        >
          {proposalBusy ? <Loader2 className="ov3-spin" size={16} /> : null}
          Apply {proposal.commands.length} change{proposal.commands.length === 1 ? '' : 's'}
        </button>
      </FooterActions>
    </section>
  );
}

function ReadyBoundary({ session, onFinish }: DecisionSurfacesProps) {
  return (
    <section className="ov3-decision-panel is-ready-boundary">
      <PanelHeader
        stage="ready_for_generation"
        badge={<span className="ov3-badge is-success">Planning validated</span>}
      />
      <div className="ov3-ready-hero">
        <div className="ov3-ready-hero__mark"><Check size={28} /></div>
        <div>
          <span className="ov3-eyebrow">Campaign Spec V{session.currentStateVersion}</span>
          <h3>Goal, sponsor, audience, delivery, context, and strategy are canonical</h3>
          <p>
            The accepted Figma journey continues into representative samples, exception-first
            draft review, deterministic preflight, and delivery results. Those controls remain
            unavailable until their governed backend phases are implemented.
          </p>
        </div>
      </div>
      <div className="ov3-future-grid">
        {[
          ['Representative samples', 'Generate immutable sample versions before the full audience.'],
          ['Draft review', 'Review ready, held, stale, and incomplete versions.'],
          ['Preflight', 'Revalidate sender, recipients, exact approvals, and attachments.'],
          ['Delivery results', 'Keep accepted, failed, and unknown outcomes distinct.'],
        ].map(([title, description]) => (
          <article key={title}>
            <LockKeyhole size={18} />
            <strong>{title}</strong>
            <p>{description}</p>
            <span>Later governed phase</span>
          </article>
        ))}
      </div>
      <div className="ov3-recovery is-info">
        <ShieldCheck size={18} />
        <div>
          <strong>No external action has occurred</strong>
          <p>No draft, approval, test send, send intent, or provider delivery exists.</p>
        </div>
      </div>
      <FooterActions hint="Finish later preserves the canonical session. Classic Outreach remains available separately.">
        <button type="button" className="ov3-button is-primary" onClick={onFinish}>
          Finish for now
        </button>
      </FooterActions>
    </section>
  );
}
