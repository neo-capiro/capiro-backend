import { ResearchPortfolioAuthorityBoundary } from './research-portfolio-authority.js';
import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../../../state/impersonation.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type {
  ResearchPortfolioGrantRole,
  ResearchPortfolioDetailDto,
  ResearchPortfolioMemberDto,
  ResearchPortfolioMemberKind,
  ResearchPortfolioMode,
  ResearchPortfolioFitDto,
  ResearchPortfolioFitResultDto,
  ResearchPortfolioMutationOutcomeDto,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  addResearchPortfolioMember,
  changeResearchPortfolioLifecycle,
  decideResearchPortfolioMember,
  getResearchPortfolioFit,
  getResearchPortfolio,
  getResearchPortfolioTourState,
  updateResearchPortfolioTourState,
  linkResearchPortfolioClient,
  putResearchPortfolioGrant,
  removeResearchPortfolioGrant,
  researchPortfolioKeys,
  resolveResearchPortfolioMember,
  unlinkResearchPortfolioClient,
  updateResearchPortfolio,
} from './research-portfolios-api.js';
import { ResearchPortfolioRulesPanel } from './ResearchPortfolioRulesPanel.js';
import {
  ResearchReviewsPanel,
  AnnualContinuityPanel,
  ResearchImportsPanel,
} from './ResearchPortfolioOperationsPanel.js';
import {
  ChangesAndSubscriptions,
  AnalyticsAndSnapshots,
  DurableOutputs,
} from './ResearchPortfolioAnalyticsPanel.js';
import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';

interface ClientOption {
  id: string;
  name: string;
}
interface TenantMember {
  id: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
}
export const RESEARCH_PORTFOLIO_TABS = [
  'overview',
  'members',
  'changes',
  'analytics',
  'reviews',
  'settings',
] as const;
type ResearchPortfolioTab = (typeof RESEARCH_PORTFOLIO_TABS)[number];
export function resolveResearchPortfolioTab(raw: string | null): ResearchPortfolioTab {
  if (raw === 'review') return 'reviews';
  return (RESEARCH_PORTFOLIO_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as ResearchPortfolioTab)
    : 'overview';
}
const RESEARCH_PORTFOLIO_TOUR_VERSION = 'research-portfolios-v1';
const TOUR_STEPS = [
  {
    label: 'Confirm purpose, access, and client links',
    target: 'research-portfolio-tour-settings',
    tab: 'settings',
  },
  {
    label: 'Review governed members, rules, and exclusions',
    target: 'research-portfolio-tour-members',
    tab: 'members',
  },
  {
    label: 'Inspect personal change state and explicit watches',
    target: 'research-portfolio-tour-changes',
    tab: 'changes',
  },
  {
    label: 'Inspect compatible-basis analytics and capture a snapshot',
    target: 'research-portfolio-tour-analytics',
    tab: 'analytics',
  },
  {
    label: 'Build, download, and optionally file the exact output',
    target: 'research-portfolio-tour-outputs',
    tab: 'analytics',
  },
] as const;

function userLabel(user: TenantMember): string {
  return (
    user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.id
  );
}

export function ResearchPortfolioDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  return (
    <ResearchPortfolioAuthorityBoundary>
      <ResearchPortfolioDetailPageContent key={id} />
    </ResearchPortfolioAuthorityBoundary>
  );
}

function ResearchPortfolioDetailPageContent() {
  const { id = '' } = useParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveResearchPortfolioTab(searchParams.get('tab'));
  const tabButtons = useRef<Partial<Record<ResearchPortfolioTab, HTMLButtonElement | null>>>({});
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  function selectTab(value: ResearchPortfolioTab, replace = false) {
    const next = new URLSearchParams(searchParams);
    value === 'overview' ? next.delete('tab') : next.set('tab', value);
    setSearchParams(next, { replace });
  }
  useEffect(() => {
    const raw = searchParams.get('tab');
    if (raw && raw !== tab) selectTab(tab, true);
  }, [searchParams, tab]);
  useEffect(() => {
    if (!pendingTask) return;
    const target = document.getElementById(pendingTask);
    const focusTarget = target?.querySelector<HTMLElement>('h2, h3, input, button') ?? target;
    if (focusTarget) {
      focusTarget.tabIndex = -1;
      focusTarget.focus();
      focusTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setPendingTask(null);
  }, [tab, pendingTask]);
  const [notice, setNotice] = useState<string | null>(null);
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const authorityScope = JSON.stringify([userId, orgId, actAsTenantSlug ?? null]);
  const currentAuthority = useRef(authorityScope);
  currentAuthority.current = authorityScope;
  const tourKey = [
    'research-portfolios',
    'tour-state',
    RESEARCH_PORTFOLIO_TOUR_VERSION,
    authorityScope,
  ];
  const [lastTourIntent, setLastTourIntent] = useState<'dismissed' | 'completed' | null>(null);
  const [replayingTour, setReplayingTour] = useState(false);
  const tourWrite = useMutation({
    mutationFn: async (input: { status: 'dismissed' | 'completed'; scope: string }) => {
      const result = await updateResearchPortfolioTourState(
        api,
        RESEARCH_PORTFOLIO_TOUR_VERSION,
        input.status,
      );
      if (result.status !== input.status) throw new Error('Tour save was not confirmed');
      return result;
    },
    onSuccess: (result, input) => {
      if (input.scope !== currentAuthority.current) return;
      queryClient.setQueryData(tourKey, result);
      setShowTour(false);
      setReplayingTour(false);
      setNotice('Tour state saved.');
    },
  });
  const tourState = useQuery({
    queryKey: tourKey,
    queryFn: () => getResearchPortfolioTourState(api, RESEARCH_PORTFOLIO_TOUR_VERSION),
  });
  const [showTour, setShowTour] = useState(false);
  useEffect(() => {
    if (tourState.data && !replayingTour) {
      setShowTour(tourState.data.status === 'active');
    }
  }, [tourState.data, replayingTour]);
  const detail = useQuery({
    queryKey: researchPortfolioKeys.detail(id),
    queryFn: () => getResearchPortfolio(api, id),
    enabled: Boolean(id),
  });
  const portfolio = detail.data;
  const canEdit = portfolio?.myRole === 'owner' || portfolio?.myRole === 'editor';
  const isOwner = portfolio?.myRole === 'owner';
  const isArchived = portfolio?.lifecycle === 'archived';

  const clients = useQuery({
    queryKey: ['research-portfolios', 'client-options'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    enabled: Boolean(canEdit && !isArchived),
  });
  const tenantMembers = useQuery({
    queryKey: ['research-portfolios', 'tenant-members'],
    queryFn: async () => (await api.get<TenantMember[]>('/api/users/tenant-members')).data,
    enabled: Boolean(isOwner && !isArchived),
  });

  async function refresh(message: string) {
    setNotice(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.detail(id) }),
      queryClient.invalidateQueries({ queryKey: researchPortfolioKeys.all }),
    ]);
  }

  if (detail.isLoading)
    return (
      <main className="rp-page">
        <p className="rp-state">Loading portfolio…</p>
      </main>
    );
  if (detail.error || !portfolio)
    return (
      <main className="rp-page">
        <p className="rp-error" role="alert">
          This portfolio is unavailable or you do not have access.
        </p>
        <Link to="/research-portfolios">Back to portfolios</Link>
      </main>
    );

  return (
    <main className="rp-page" data-testid="research-portfolio-detail">
      <Link className="rp-back" to="/research-portfolios">
        ← Research portfolios
      </Link>
      <header className="rp-page__header">
        <div>
          <p className="rp-eyebrow">
            {portfolio.myRole} access · revision {portfolio.revision}
          </p>
          <h1>{portfolio.name}</h1>
          <p>{portfolio.purpose || 'No purpose recorded.'}</p>
        </div>
        <div className="rp-row">
          <button
            className="rp-button"
            type="button"
            onClick={() =>
              openVNextMeriWorkspaceWindow(window, window.location.origin, {
                researchPortfolioId: portfolio.id,
                prompt: `Analyze the current Research Portfolio ${portfolio.name}. Start with its qualified analytics, change feed, and explicit limitations.`,
              })
            }
          >
            Ask Meri
          </button>
          <button
            className="rp-button"
            type="button"
            onClick={() => {
              setShowTour(true);
              setReplayingTour(tourState.data?.status !== 'active');
            }}
          >
            Product tour
          </button>
          <span className={`rp-badge rp-badge--${portfolio.lifecycle}`}>{portfolio.lifecycle}</span>
        </div>
      </header>
      {notice ? (
        <p className="rp-notice" role="status">
          {notice}
        </p>
      ) : null}
      <>
        {tourState.error ? (
          <div>
            <p role="alert">Saved tour state could not be loaded.</p>
            <button onClick={() => tourState.refetch()}>Retry loading tour state</button>
          </div>
        ) : null}
      </>
      {showTour ? (
        <section className="rp-card rp-tour" aria-label="Research Portfolio product tour">
          <div>
            <p className="rp-eyebrow">Product tour · {RESEARCH_PORTFOLIO_TOUR_VERSION}</p>
            <h2>From governed membership to an inspectable output</h2>
            {replayingTour ? (
              <p role="status">
                Replaying this version locally. Your saved tour status is unchanged until a new
                completion or dismissal is confirmed.
              </p>
            ) : null}
            <ol>
              {TOUR_STEPS.map((step) => (
                <li key={step.target}>
                  <span>{step.label}</span>{' '}
                  <button
                    className="rp-button"
                    type="button"
                    onClick={() => {
                      selectTab(step.tab);
                      setPendingTask(step.target);
                    }}
                  >
                    Show me
                  </button>
                </li>
              ))}
            </ol>
          </div>
          {tourWrite.error ? (
            <div>
              <p className="rp-error" role="alert">
                Tour state was not saved. The tour remains open.
              </p>
              <button
                disabled={tourWrite.isPending || !lastTourIntent}
                onClick={() => {
                  if (lastTourIntent)
                    tourWrite.mutate({ status: lastTourIntent, scope: authorityScope });
                }}
              >
                Retry saving tour state
              </button>
            </div>
          ) : null}
          <div className="rp-action-group">
            <button
              className="rp-button"
              type="button"
              disabled={tourWrite.isPending}
              onClick={() => {
                setLastTourIntent('dismissed');
                tourWrite.mutate({ status: 'dismissed', scope: authorityScope });
              }}
            >
              Dismiss
            </button>
            <button
              className="rp-button rp-button--primary"
              type="button"
              disabled={tourWrite.isPending}
              onClick={() => {
                setLastTourIntent('completed');
                tourWrite.mutate({ status: 'completed', scope: authorityScope });
              }}
            >
              Mark tour complete
            </button>
          </div>
        </section>
      ) : null}
      {isArchived ? (
        <p className="rp-notice">Archived portfolios are read-only until an owner restores them.</p>
      ) : null}

      <div className="rp-tabs" role="tablist" aria-label="Research Portfolio sections">
        {RESEARCH_PORTFOLIO_TABS.map((value) => (
          <button
            key={value}
            ref={(node) => {
              tabButtons.current[value] = node;
            }}
            id={`rp-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`rp-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className="rp-button"
            onClick={() => selectTab(value)}
            onKeyDown={(event) => {
              const index = RESEARCH_PORTFOLIO_TABS.indexOf(value);
              const destination =
                event.key === 'ArrowRight'
                  ? RESEARCH_PORTFOLIO_TABS[(index + 1) % 6]
                  : event.key === 'ArrowLeft'
                    ? RESEARCH_PORTFOLIO_TABS[(index + 5) % 6]
                    : event.key === 'Home'
                      ? 'overview'
                      : event.key === 'End'
                        ? 'settings'
                        : null;
              if (destination) {
                event.preventDefault();
                selectTab(destination);
                tabButtons.current[destination]?.focus();
              }
            }}
          >
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id="rp-panel-overview"
        aria-labelledby="rp-tab-overview"
        hidden={tab !== 'overview'}
        tabIndex={0}
      >
        <h2>Portfolio overview</h2>
        <ClientFitPresentation portfolioId={portfolio.id} />
        <dl className="rp-metrics">
          <div>
            <dt>Members</dt>
            <dd>{portfolio.memberCount}</dd>
          </div>
          <div>
            <dt>Linked clients</dt>
            <dd>{portfolio.clientLinkCount}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{portfolio.mode}</dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>{portfolio.myRole}</dd>
          </div>
        </dl>
        <section className="rp-card">
          <h2>Recent history</h2>
          <ol className="rp-history">
            {portfolio.recentEvents.map((event) => (
              <li key={event.id}>
                <strong>{event.eventKind.replaceAll('_', ' ')}</strong>
                <span>
                  Revision {event.aggregateRevision} · {new Date(event.occurredAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </section>
      <section
        role="tabpanel"
        id="rp-panel-members"
        aria-labelledby="rp-tab-members"
        hidden={tab !== 'members'}
        tabIndex={0}
      >
        <div id="research-portfolio-tour-members">
          <MembersPanel
            portfolio={portfolio}
            canEdit={Boolean(canEdit && !isArchived)}
            onDone={refresh}
          />
          <ResearchPortfolioRulesPanel
            portfolio={portfolio}
            canEdit={Boolean(canEdit && !isArchived)}
            onDone={refresh}
          />
        </div>
      </section>
      <section
        role="tabpanel"
        id="rp-panel-changes"
        aria-labelledby="rp-tab-changes"
        hidden={tab !== 'changes'}
        tabIndex={0}
      >
        <ChangesAndSubscriptions portfolio={portfolio} />
      </section>
      <section
        role="tabpanel"
        id="rp-panel-analytics"
        aria-labelledby="rp-tab-analytics"
        hidden={tab !== 'analytics'}
        tabIndex={0}
      >
        <AnalyticsAndSnapshots
          portfolio={portfolio}
          canCreateSnapshot={Boolean(canEdit && !isArchived)}
        />
        <DurableOutputs portfolio={portfolio} />
      </section>
      <section
        role="tabpanel"
        id="rp-panel-reviews"
        aria-labelledby="rp-tab-reviews"
        hidden={tab !== 'reviews'}
        tabIndex={0}
      >
        <ResearchReviewsPanel portfolio={portfolio} canEdit={Boolean(canEdit && !isArchived)} />
        <AnnualContinuityPanel portfolio={portfolio} canEdit={Boolean(canEdit && !isArchived)} />
      </section>
      <section
        role="tabpanel"
        id="rp-panel-settings"
        aria-labelledby="rp-tab-settings"
        hidden={tab !== 'settings'}
        tabIndex={0}
      >
        <div id="research-portfolio-tour-settings">
          <PortfolioSettings
            portfolio={portfolio}
            canEdit={Boolean(canEdit)}
            isOwner={Boolean(isOwner)}
            onDone={refresh}
          />
          <div className="rp-columns">
            <ClientLinksPanel
              portfolio={portfolio}
              options={clients.data ?? []}
              canEdit={Boolean(canEdit && !isArchived)}
              onDone={refresh}
            />
            <SharingPanel
              portfolio={portfolio}
              users={tenantMembers.data ?? []}
              canEdit={Boolean(isOwner && !isArchived)}
              onDone={refresh}
            />
          </div>
        </div>
        <ResearchImportsPanel portfolio={portfolio} canEdit={Boolean(canEdit && !isArchived)} />
      </section>
    </main>
  );
}

function PortfolioSettings({
  portfolio,
  canEdit,
  isOwner,
  onDone,
}: {
  portfolio: ResearchPortfolioDetailDto;
  canEdit: boolean;
  isOwner: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [name, setName] = useState(portfolio.name);
  const [purpose, setPurpose] = useState(portfolio.purpose ?? '');
  const [mode, setMode] = useState<ResearchPortfolioMode>(portfolio.mode);
  useEffect(() => {
    setName(portfolio.name);
    setPurpose(portfolio.purpose ?? '');
    setMode(portfolio.mode);
  }, [portfolio]);
  const update = useMutation({
    mutationFn: () =>
      updateResearchPortfolio(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        name: name.trim(),
        purpose: purpose.trim() || null,
        mode,
      }),
    onSuccess: () => onDone('Portfolio settings saved.'),
  });
  const lifecycle = useMutation({
    mutationFn: () =>
      changeResearchPortfolioLifecycle(
        api,
        portfolio.id,
        portfolio.lifecycle === 'archived' ? 'restore' : 'archive',
        { expectedRevision: portfolio.revision },
      ),
    onSuccess: () =>
      onDone(portfolio.lifecycle === 'archived' ? 'Portfolio restored.' : 'Portfolio archived.'),
  });
  return (
    <section className="rp-card">
      <div className="rp-row rp-row--spread">
        <h2>Portfolio settings</h2>
        {isOwner ? (
          <button
            className="rp-button"
            onClick={() => lifecycle.mutate()}
            disabled={lifecycle.isPending}
          >
            {portfolio.lifecycle === 'archived' ? 'Restore' : 'Archive'}
          </button>
        ) : null}
      </div>
      {canEdit && portfolio.lifecycle === 'active' ? (
        <form
          className="rp-form rp-form--inline"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate();
          }}
        >
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Purpose
            <input value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as ResearchPortfolioMode)}
            >
              <option value="manual">Manual</option>
              <option value="rules">Rules</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </label>
          <button
            className="rp-button rp-button--primary"
            disabled={update.isPending || !name.trim()}
          >
            Save
          </button>
        </form>
      ) : (
        <p>Settings are visible in read-only mode.</p>
      )}
      {update.error || lifecycle.error ? (
        <p className="rp-error" role="alert">
          The change could not be saved. Refresh and try again.
        </p>
      ) : null}
    </section>
  );
}

type PortfolioShape = ResearchPortfolioDetailDto;

function MembersPanel({
  portfolio,
  canEdit,
  onDone,
}: {
  portfolio: PortfolioShape;
  canEdit: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [kind, setKind] = useState<ResearchPortfolioMemberKind>('program_element');
  const [targetId, setTargetId] = useState('');
  const [label, setLabel] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState('');
  const [bulkOutcomes, setBulkOutcomes] = useState<readonly ResearchPortfolioMutationOutcomeDto[]>(
    [],
  );
  const [preserveUnresolved, setPreserveUnresolved] = useState(false);
  const bulk = useMutation({
    mutationFn: (disposition: 'included' | 'excluded') =>
      decideResearchPortfolioMember(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        decisions: portfolio.members
          .filter((member) => selected.has(member.id) && member.disposition !== 'unresolved')
          .map((member) => ({ memberId: member.id, disposition, reason: bulkReason.trim() })),
      }),
    onSuccess: (receipt) => {
      setBulkOutcomes(receipt.outcomes);
      setSelected(new Set());
      return onDone('Bulk member decisions recorded.');
    },
  });
  const add = useMutation({
    mutationFn: () =>
      addResearchPortfolioMember(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        targetKind: kind,
        targetId: targetId.trim(),
        label: label.trim() || null,
        ...(preserveUnresolved
          ? {
              unresolvedInput: {
                enteredKind: kind,
                enteredId: targetId.trim(),
                enteredLabel: label.trim() || null,
              },
            }
          : {}),
      }),
    onSuccess: () => {
      setTargetId('');
      setLabel('');
      return onDone('Member added.');
    },
  });
  const decide = useMutation({
    mutationFn: ({
      member,
      disposition,
    }: {
      member: ResearchPortfolioMemberDto;
      disposition: 'included' | 'excluded';
    }) =>
      decideResearchPortfolioMember(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        decisions: [
          {
            memberId: member.id,
            disposition,
            reason:
              reasons[member.id]?.trim() ||
              (disposition === 'included'
                ? 'Reinstated by portfolio editor'
                : 'Excluded by portfolio editor'),
          },
        ],
      }),
    onSuccess: () => onDone('Member decision recorded.'),
  });
  return (
    <section className="rp-card">
      <h2>
        Members <span className="rp-count">{portfolio.members.length}</span>
      </h2>
      {canEdit ? (
        <form
          className="rp-form rp-form--member"
          onSubmit={(event) => {
            event.preventDefault();
            if (targetId.trim()) add.mutate();
          }}
        >
          <label>
            Type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as ResearchPortfolioMemberKind)}
            >
              {['program', 'program_element', 'project', 'budget_line', 'award'].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            Canonical ID
            <input
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              required
            />
          </label>
          <label>
            Label
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <input
              type="checkbox"
              checked={preserveUnresolved}
              onChange={(event) => setPreserveUnresolved(event.target.checked)}
            />{' '}
            Preserve unresolved identifier
          </label>
          <button className="rp-button rp-button--primary" disabled={add.isPending}>
            Add
          </button>
        </form>
      ) : null}
      <div className="rp-row">
        {canEdit ? (
          <>
            <label>
              Bulk decision reason
              <input value={bulkReason} onChange={(event) => setBulkReason(event.target.value)} />
            </label>
            <button
              disabled={
                !selected.size || selected.size > 100 || !bulkReason.trim() || bulk.isPending
              }
              onClick={() => bulk.mutate('included')}
            >
              Include selected members
            </button>
            <button
              disabled={
                !selected.size || selected.size > 100 || !bulkReason.trim() || bulk.isPending
              }
              onClick={() => bulk.mutate('excluded')}
            >
              Exclude selected members
            </button>
            <span>{selected.size} selected · maximum 100</span>
          </>
        ) : null}
      </div>
      {bulkOutcomes.length ? (
        <section aria-label="Bulk member outcomes">
          <ul>
            {bulkOutcomes.map((outcome, index) => (
              <li key={outcome.id ?? index}>
                {outcome.targetId} · {outcome.status} · {outcome.message ?? 'Recorded'} ·{' '}
                {outcome.id}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {bulk.error ? (
        <p className="rp-error" role="alert">
          The bulk decision was rejected; selection and reason are retained. Reload the current
          revision before retrying.
        </p>
      ) : null}
      <ul className="rp-list">
        {portfolio.members.map((member) => (
          <li key={member.id} className="rp-list__item">
            {canEdit ? (
              <input
                type="checkbox"
                aria-label={`Select member ${member.label || member.targetId}`}
                checked={selected.has(member.id)}
                disabled={member.disposition === 'unresolved' || bulk.isPending}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    event.target.checked ? next.add(member.id) : next.delete(member.id);
                    return next;
                  })
                }
              />
            ) : null}
            <div>
              <strong>{member.label || member.targetId}</strong>
              <p>
                {member.targetKind.replaceAll('_', ' ')} ·{' '}
                <span className={`rp-badge rp-badge--${member.disposition}`}>
                  {member.disposition}
                </span>
              </p>
              {member.reason ? <small>{member.reason}</small> : null}
            </div>
            {canEdit ? (
              <div className="rp-member-actions">
                <input
                  aria-label={`Reason for ${member.label || member.targetId}`}
                  placeholder="Decision reason"
                  value={reasons[member.id] ?? ''}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [member.id]: event.target.value }))
                  }
                />
                {member.disposition === 'unresolved' ? (
                  <ResolveMemberForm portfolio={portfolio} member={member} onDone={onDone} />
                ) : (
                  <button
                    className="rp-button"
                    onClick={() =>
                      decide.mutate({
                        member,
                        disposition: member.disposition === 'excluded' ? 'included' : 'excluded',
                      })
                    }
                  >
                    {member.disposition === 'excluded' ? 'Reinstate' : 'Exclude'}
                  </button>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {add.error || decide.error ? (
        <p className="rp-error" role="alert">
          The member change could not be saved.
        </p>
      ) : null}
    </section>
  );
}

function ResolveMemberForm({
  portfolio,
  member,
  onDone,
}: {
  portfolio: PortfolioShape;
  member: ResearchPortfolioMemberDto;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [targetId, setTargetId] = useState(member.targetId);
  const [targetKind, setTargetKind] = useState<ResearchPortfolioMemberKind>(member.targetKind);
  const resolve = useMutation({
    mutationFn: () =>
      resolveResearchPortfolioMember(api, portfolio.id, member.id, {
        expectedRevision: portfolio.revision,
        targetKind,
        targetId: targetId.trim(),
        label: member.label,
      }),
    onSuccess: () => onDone('Unresolved member linked to its canonical record.'),
  });
  return (
    <form
      className="rp-resolve"
      onSubmit={(event) => {
        event.preventDefault();
        resolve.mutate();
      }}
    >
      <label>
        Resolve type
        <select
          value={targetKind}
          onChange={(event) => setTargetKind(event.target.value as ResearchPortfolioMemberKind)}
        >
          {['program', 'program_element', 'project', 'budget_line', 'award'].map((kind) => (
            <option key={kind} value={kind}>
              {kind.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      <input
        aria-label={`Resolve ${member.label || member.id}`}
        value={targetId}
        onChange={(event) => setTargetId(event.target.value)}
        required
      />
      {resolve.error ? (
        <p role="alert">
          The typed target could not be resolved; the unresolved member is retained.
        </p>
      ) : null}
      <button className="rp-button" disabled={resolve.isPending || !targetId.trim()}>
        Resolve
      </button>
    </form>
  );
}

function ClientLinksPanel({
  portfolio,
  options,
  canEdit,
  onDone,
}: {
  portfolio: PortfolioShape;
  options: ClientOption[];
  canEdit: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [clientId, setClientId] = useState('');
  const link = useMutation({
    mutationFn: () =>
      linkResearchPortfolioClient(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        clientId,
      }),
    onSuccess: () => {
      setClientId('');
      return onDone('Client linked.');
    },
  });
  const unlink = useMutation({
    mutationFn: (id: string) =>
      unlinkResearchPortfolioClient(api, portfolio.id, id, portfolio.revision),
    onSuccess: () => onDone('Client unlinked.'),
  });
  const linked = new Set(portfolio.clientLinks.map((item) => item.clientId));
  return (
    <section className="rp-card">
      <h2>Linked clients</h2>
      {canEdit ? (
        <form
          className="rp-form rp-form--inline"
          onSubmit={(event) => {
            event.preventDefault();
            if (clientId) link.mutate();
          }}
        >
          <label>
            Authorized client
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">Select client</option>
              {options
                .filter((client) => !linked.has(client.id))
                .map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="rp-button" disabled={!clientId || link.isPending}>
            Link
          </button>
        </form>
      ) : null}
      <ul className="rp-list">
        {portfolio.clientLinks.map((item) => (
          <li className="rp-list__item" key={item.id}>
            <span>{item.clientName}</span>
            {canEdit ? (
              <button
                className="rp-button rp-button--danger"
                onClick={() => unlink.mutate(item.clientId)}
              >
                Unlink
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SharingPanel({
  portfolio,
  users,
  canEdit,
  onDone,
}: {
  portfolio: PortfolioShape;
  users: TenantMember[];
  canEdit: boolean;
  onDone: (message: string) => Promise<void>;
}) {
  const api = useApi();
  const [principalId, setPrincipalId] = useState('');
  const [role, setRole] = useState<ResearchPortfolioGrantRole>('viewer');
  const put = useMutation({
    mutationFn: () =>
      putResearchPortfolioGrant(api, portfolio.id, principalId, {
        expectedRevision: portfolio.revision,
        principalType: 'user',
        role,
      }),
    onSuccess: () => {
      setPrincipalId('');
      return onDone('Sharing access updated.');
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      removeResearchPortfolioGrant(api, portfolio.id, id, portfolio.revision),
    onSuccess: () => onDone('Sharing access removed.'),
  });
  const granted = new Set(portfolio.grants.map((grant) => grant.principalUserId));
  return (
    <section className="rp-card">
      <h2>Sharing</h2>
      {canEdit ? (
        <form
          className="rp-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (principalId) put.mutate();
          }}
        >
          <label>
            Tenant member
            <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
              <option value="">Select member</option>
              {users
                .filter((user) => !granted.has(user.id))
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {userLabel(user)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as ResearchPortfolioGrantRole)}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <button className="rp-button" disabled={!principalId || put.isPending}>
            Share
          </button>
        </form>
      ) : null}
      <ul className="rp-list">
        {portfolio.grants.map((grant) => (
          <li className="rp-list__item" key={grant.id}>
            <span>
              {userLabel(
                users.find((user) => user.id === grant.principalUserId) ?? {
                  id: grant.principalUserId,
                },
              )}{' '}
              · {grant.role}
            </span>
            {canEdit ? (
              <button
                className="rp-button rp-button--danger"
                onClick={() => remove.mutate(grant.principalUserId)}
              >
                Revoke
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface QualifiedFitResult extends ResearchPortfolioFitResultDto {
  availability?: 'available' | 'partial' | 'unavailable';
  versionId?: string;
  basis?: {
    calculationVersion: string;
    scoreBasis: 'direct_qualified_pe_association_share';
    portfolioRevision: number;
    ruleVersionIds: readonly string[];
    capabilityFingerprint: string;
    sourceBasisFingerprint: string;
    basisFingerprint: string;
    totalIncludedMemberCount: number;
    supportedMemberCount: number;
    matchedMemberCount: number;
    limitations: readonly string[];
  };
  memberMatches?: readonly {
    memberId: string;
    targetKind: ResearchPortfolioMemberKind;
    targetId: string;
    matched: boolean | null;
    capabilityIds: readonly string[];
    reasons: readonly string[];
    sourceDocumentIds: readonly string[];
  }[];
}
interface QualifiedFitProjection extends ResearchPortfolioFitDto {
  clientFits: readonly QualifiedFitResult[];
  availability?: 'available' | 'partial' | 'unavailable';
  limitations?: readonly string[];
}
function ClientFitPresentation({ portfolioId }: { portfolioId: string }) {
  const api = useApi();
  const { userId, orgId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  const fit = useQuery({
    queryKey: ['research-portfolios', portfolioId, 'fit', userId, orgId, actAsTenantSlug ?? null],
    queryFn: () => getResearchPortfolioFit(api, portfolioId),
    enabled: Boolean(userId),
  });
  const projection =
    fit.data && Array.isArray((fit.data as QualifiedFitProjection).clientFits)
      ? (fit.data as QualifiedFitProjection)
      : undefined;
  return (
    <section className="rp-card" aria-label="Linked-client fit">
      <h2>Linked-client fit</h2>
      {fit.isLoading ? <p>Loading authorized client fit…</p> : null}
      {fit.error ? (
        <div>
          <p role="alert">Client fit could not be loaded.</p>
          <button onClick={() => fit.refetch()}>Retry client fit</button>
        </div>
      ) : null}
      {projection?.limitations?.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {projection?.clientFits.length === 0 ? (
        <p>No authorized linked-client fit is available.</p>
      ) : null}
      {projection?.clientFits.map((client) => (
        <article key={client.clientId}>
          <h3>{client.clientName}</h3>
          <p>
            {client.availability ?? 'unavailable'} · calculated {projection.calculatedAt}
          </p>
          {client.basis?.scoreBasis === 'direct_qualified_pe_association_share' ? (
            <>
              <p>
                Direct qualified PE association share:{' '}
                {client.fitScore === null ? 'unavailable' : `${client.fitScore}%`} of{' '}
                {client.basis.supportedMemberCount} supported members. This basis covers{' '}
                {client.basis.supportedMemberCount} of {client.basis.totalIncludedMemberCount}{' '}
                included members; {client.basis.matchedMemberCount} match.
              </p>
              <p>
                Stored version {client.versionId ?? 'not returned'} · calculation{' '}
                {client.basis.calculationVersion} · portfolio revision{' '}
                {client.basis.portfolioRevision}
              </p>
              <details>
                <summary>Inspect qualified basis and limitations</summary>
                <p>Basis fingerprint {client.basis.basisFingerprint}</p>
                <p>Capability fingerprint {client.basis.capabilityFingerprint}</p>
                <p>Source fingerprint {client.basis.sourceBasisFingerprint}</p>
                <p>Rules {client.basis.ruleVersionIds.join(', ') || 'No rule version'}</p>
                <ul>
                  {client.basis.limitations.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <ul>
                  {client.memberMatches?.map((member) => (
                    <li key={member.memberId}>
                      {member.targetKind} · {member.targetId} ·{' '}
                      {member.matched === null
                        ? 'unsupported / unknown'
                        : member.matched
                          ? 'direct association'
                          : 'no direct association'}{' '}
                      · {member.reasons.join('; ')}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <p>
              No qualified score basis/version was returned. A relevance score has not been inferred
              from this legacy response.
            </p>
          )}
        </article>
      ))}
    </section>
  );
}
