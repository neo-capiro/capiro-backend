import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type {
  ResearchPortfolioGrantRole,
  ResearchPortfolioDetailDto,
  ResearchPortfolioMemberDto,
  ResearchPortfolioMemberKind,
  ResearchPortfolioMode,
} from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import {
  addResearchPortfolioMember,
  changeResearchPortfolioLifecycle,
  decideResearchPortfolioMember,
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
import { ResearchPortfolioOperationsPanel } from './ResearchPortfolioOperationsPanel.js';
import { ResearchPortfolioAnalyticsPanel } from './ResearchPortfolioAnalyticsPanel.js';
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
const RESEARCH_PORTFOLIO_TOUR_VERSION = 'research-portfolios-v1';
const TOUR_STEPS = [
  {
    label: 'Confirm purpose, access, and client links',
    target: 'research-portfolio-tour-settings',
  },
  {
    label: 'Review governed members, rules, and exclusions',
    target: 'research-portfolio-tour-members',
  },
  {
    label: 'Inspect personal change state and explicit watches',
    target: 'research-portfolio-tour-changes',
  },
  {
    label: 'Inspect compatible-basis analytics and capture a snapshot',
    target: 'research-portfolio-tour-analytics',
  },
  {
    label: 'Build, download, and optionally file the exact output',
    target: 'research-portfolio-tour-outputs',
  },
] as const;

function userLabel(user: TenantMember): string {
  return (
    user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || user.id
  );
}

export function ResearchPortfolioDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const api = useApi();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const tourState = useQuery({
    queryKey: ['research-portfolios', 'tour-state', RESEARCH_PORTFOLIO_TOUR_VERSION],
    queryFn: () => getResearchPortfolioTourState(api, RESEARCH_PORTFOLIO_TOUR_VERSION),
  });
  const [showTour, setShowTour] = useState(true);
  useEffect(() => {
    if (tourState.data) {
      setShowTour(tourState.data.status === 'active');
    }
  }, [tourState.data]);
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
          <button className="rp-button" type="button" onClick={() => setShowTour(true)}>
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
      {showTour ? (
        <section className="rp-card rp-tour" aria-label="Research Portfolio product tour">
          <div>
            <p className="rp-eyebrow">Product tour · {RESEARCH_PORTFOLIO_TOUR_VERSION}</p>
            <h2>From governed membership to an inspectable output</h2>
            <ol>
              {TOUR_STEPS.map((step) => (
                <li key={step.target}>
                  <span>{step.label}</span>{' '}
                  <button
                    className="rp-button"
                    type="button"
                    onClick={() =>
                      document
                        .getElementById(step.target)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    Show me
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <div className="rp-action-group">
            <button
              className="rp-button"
              type="button"
              onClick={() => {
                updateResearchPortfolioTourState(api, RESEARCH_PORTFOLIO_TOUR_VERSION, 'dismissed').catch(() => {});
                setShowTour(false);
              }}
            >
              Dismiss
            </button>
            <button
              className="rp-button rp-button--primary"
              type="button"
              onClick={() => {
                updateResearchPortfolioTourState(api, RESEARCH_PORTFOLIO_TOUR_VERSION, 'completed').catch(() => {});
                setShowTour(false);
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

      <div id="research-portfolio-tour-settings">
        <PortfolioSettings
          portfolio={portfolio}
          canEdit={Boolean(canEdit)}
          isOwner={Boolean(isOwner)}
          onDone={refresh}
        />
      </div>

      <ResearchPortfolioRulesPanel
        portfolio={portfolio}
        canEdit={Boolean(canEdit && !isArchived)}
        onDone={refresh}
      />

      <ResearchPortfolioOperationsPanel
        portfolio={portfolio}
        canEdit={Boolean(canEdit && !isArchived)}
      />

      <ResearchPortfolioAnalyticsPanel
        portfolio={portfolio}
        canCreateSnapshot={Boolean(canEdit && !isArchived)}
      />

      <section className="rp-columns" id="research-portfolio-tour-members">
        <MembersPanel
          portfolio={portfolio}
          canEdit={Boolean(canEdit && !isArchived)}
          onDone={refresh}
        />
        <aside className="rp-stack">
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
        </aside>
      </section>

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
  const add = useMutation({
    mutationFn: () =>
      addResearchPortfolioMember(api, portfolio.id, {
        expectedRevision: portfolio.revision,
        targetKind: kind,
        targetId: targetId.trim(),
        label: label.trim() || null,
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
          <button className="rp-button rp-button--primary" disabled={add.isPending}>
            Add
          </button>
        </form>
      ) : null}
      <ul className="rp-list">
        {portfolio.members.map((member) => (
          <li key={member.id} className="rp-list__item">
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
  const resolve = useMutation({
    mutationFn: () =>
      resolveResearchPortfolioMember(api, portfolio.id, member.id, {
        expectedRevision: portfolio.revision,
        targetKind: member.targetKind,
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
      <input
        aria-label={`Resolve ${member.label || member.id}`}
        value={targetId}
        onChange={(event) => setTargetId(event.target.value)}
        required
      />
      <button className="rp-button" disabled={resolve.isPending}>
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
