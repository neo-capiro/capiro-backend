import { useNavigate } from 'react-router-dom';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import {
  useClientCrmOverviewModel,
  type AttentionKind,
  type AttentionRow,
  type ClientCrmOverviewModel,
  type Metric,
  type RegionStatus,
} from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Client CRM / 01 Overview — Figma `906:2503`.
 *
 * "An account command center, not a dump of every client field." Identity that
 * already appears in the compact header (name, status, owner, focus) is not
 * repeated; this screen adds the description, the account facts, derived
 * attention, and the two pulses.
 */
export function ClientCrmOverview({ client }: { client: Client }) {
  const model = useClientCrmOverviewModel(client);
  return <ClientCrmOverviewView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function ClientCrmOverviewView({ model }: { model: ClientCrmOverviewModel }) {
  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">Client overview</h2>
          <p className="capiro-crm__page-sub">
            The account, the work, and the external signals that need attention now.
          </p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        <CapiroButton variant="secondary" size="compact">
          Edit profile
        </CapiroButton>
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--profile">
        <ClientProfileCard model={model} />
        <AccountCard model={model} />
      </div>

      <div className="capiro-crm__grid">
        <NeedsAttentionCard model={model} />
      </div>

      <div className="capiro-crm__grid capiro-crm__grid--even">
        <WorkPulseCard model={model} />
        <IntelligencePulseCard model={model} />
      </div>
    </div>
  );
}

/* ─────────────────────────────── primitives ──────────────────────────────── */

/**
 * Renders a metric. An unavailable metric is an em dash carrying its reason —
 * it is never rendered as `0`, which would assert a fact nobody established.
 */
function MetricValue({ metric, label }: { metric: Metric; label: string }) {
  const navigate = useNavigate();

  if (metric.kind === 'unavailable') {
    return (
      <div className="capiro-crm__metric">
        <p
          className="capiro-crm__metric-value capiro-crm__metric-value--unavailable"
          title={metric.reason}
        >
          —
        </p>
        <p className="capiro-crm__meta">{label}</p>
        <span className="capiro-crm__sr-only">{`${label}: ${metric.reason}`}</span>
      </div>
    );
  }

  if (!metric.href) {
    return (
      <div className="capiro-crm__metric">
        <p className="capiro-crm__metric-value">{metric.value}</p>
        <p className="capiro-crm__meta">{label}</p>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="capiro-crm__metric"
      onClick={() => navigate(metric.href as string)}
    >
      <p className="capiro-crm__metric-value">{metric.value}</p>
      <p className="capiro-crm__meta">{label}</p>
    </button>
  );
}

/** Loading skeleton, inline error with retry, or the content. */
function Region({
  status,
  skeletonHeight,
  children,
}: {
  status: RegionStatus;
  skeletonHeight: number;
  children: React.ReactNode;
}) {
  if (status.state === 'loading') {
    // Geometry matches the final content so the card does not jump (§7).
    return <div className="capiro-crm__skeleton" style={{ height: skeletonHeight }} aria-hidden />;
  }
  if (status.state === 'error') {
    return (
      <div className="capiro-crm__state capiro-crm__state--error" role="status">
        <span>{status.message ?? 'Could not load'}</span>
        <CapiroButton variant="quiet" size="compact" onClick={status.retry}>
          Retry
        </CapiroButton>
      </div>
    );
  }
  return <>{children}</>;
}

/* ──────────────────────── client profile (908:2899) ──────────────────────── */

function ClientProfileCard({ model }: { model: ClientCrmOverviewModel }) {
  const { profile } = model;
  return (
    <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-profile-title">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title" id="crm-profile-title">
          Client profile
        </h3>
        <button type="button" className="capiro-crm__card-action">
          Edit
        </button>
      </div>

      <div className="capiro-crm__profile">
        <div className="capiro-crm__profile-mark" aria-hidden>
          {profile.logoUrl ? <img src={profile.logoUrl} alt="" /> : profile.initials}
        </div>
        <div className="capiro-crm__profile-body">
          <p className="capiro-crm__profile-desc" title={profile.description ?? undefined}>
            {profile.description ?? 'No description recorded yet.'}
          </p>

          <div className="capiro-crm__profile-facts">
            {profile.sectorLabel ? (
              <span className="capiro-crm__pill capiro-crm__pill--filled">{profile.sectorLabel}</span>
            ) : (
              <span className="capiro-crm__pill">Sector not set</span>
            )}
            {profile.website ? (
              <a
                className="capiro-crm__profile-link"
                href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {profile.website.replace(/^https?:\/\//, '')}
              </a>
            ) : null}
            {profile.location ? (
              <span className="capiro-crm__profile-place">{profile.location}</span>
            ) : null}
          </div>

          <p className="capiro-crm__meta">
            {profile.clientSince ? `Client since  ${profile.clientSince}` : 'Client since not recorded'}
          </p>
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────────── account (908:2910) ─────────────────────────── */

function AccountCard({ model }: { model: ClientCrmOverviewModel }) {
  const { account, accountStatus } = model;
  const briefLabel =
    account.briefState === 'ready'
      ? 'Brief ready'
      : account.briefState === 'none'
        ? 'No brief yet'
        : 'No meeting scheduled';

  return (
    <section className="capiro-crm__card capiro-elevation-widget" aria-labelledby="crm-account-title">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title" id="crm-account-title">
          Account
        </h3>
        <button type="button" className="capiro-crm__card-action">
          Manage team
        </button>
      </div>

      <Region status={accountStatus} skeletonHeight={96}>
        <div className="capiro-crm__fields">
          <div>
            <p className="capiro-crm__meta">Account owner</p>
            {/* No owner column exists on Client — stated, not invented. */}
            <p className="capiro-crm__field-value capiro-crm__field-value--empty">Not tracked</p>
          </div>
          <div>
            <p className="capiro-crm__meta">Primary contact</p>
            <p
              className={`capiro-crm__field-value${account.primaryContact ? '' : ' capiro-crm__field-value--empty'}`}
            >
              {account.primaryContact ?? 'Not set'}
            </p>
          </div>
          <div>
            <p className="capiro-crm__meta">Next meeting</p>
            <p
              className={`capiro-crm__field-value${account.nextMeeting ? '' : ' capiro-crm__field-value--empty'}`}
            >
              {account.nextMeeting?.label ?? 'None scheduled'}
            </p>
          </div>
          <div>
            <p className="capiro-crm__meta">Account team</p>
            <div className="capiro-crm__field-inline">
              <p className="capiro-crm__field-value capiro-crm__field-value--empty">
                {account.accountTeamAvailable
                  ? `${account.accountTeam.length} members`
                  : 'Not tracked'}
              </p>
              <span
                className={`capiro-crm__pill${account.briefState === 'ready' ? ' capiro-crm__pill--filled' : ''}`}
              >
                <span className="capiro-crm__pill-dot" aria-hidden />
                {briefLabel}
              </span>
            </div>
          </div>
        </div>
      </Region>
    </section>
  );
}

/* ───────────────────────── needs attention (908:2931) ────────────────────── */

const ATTENTION_TONE: Record<AttentionKind, 'neutral' | 'info' | 'warning' | 'danger'> = {
  budget: 'neutral',
  hearing: 'info',
  work: 'neutral',
  regulatory: 'info',
  profile: 'warning',
};

function NeedsAttentionCard({ model }: { model: ClientCrmOverviewModel }) {
  const navigate = useNavigate();
  const { attention, attentionTotal, attentionStatus } = model;

  return (
    <section
      className="capiro-crm__card capiro-crm__card--attention capiro-elevation-widget"
      aria-labelledby="crm-attention-title"
    >
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title capiro-crm__card-title--ink" id="crm-attention-title">
          Needs attention
        </h3>
        {attentionTotal > 0 ? (
          <button type="button" className="capiro-crm__card-action">
            {`View all  ${attentionTotal}`}
          </button>
        ) : null}
      </div>

      <Region status={attentionStatus} skeletonHeight={180}>
        {attention.length === 0 ? (
          <div className="capiro-crm__state" role="status">
            Nothing needs attention for this client right now.
          </div>
        ) : (
          <div className="capiro-crm__attention">
            {attention.map((row) => (
              <AttentionRowView key={row.id} row={row} onOpen={() => row.href && navigate(row.href)} />
            ))}
          </div>
        )}
      </Region>
    </section>
  );
}

function AttentionRowView({ row, onOpen }: { row: AttentionRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="capiro-crm__attention-row"
      data-urgent={row.urgent}
      onClick={onOpen}
      disabled={!row.href}
      // Urgency is never colour-only: the row states it in text for a screen
      // reader and shows it as a badge tone plus a status word (§6).
      aria-label={`${row.urgent ? 'Urgent: ' : ''}${row.title}. ${row.meta}. ${row.when}. ${row.status}`}
    >
      <span className="capiro-crm__attention-dot" aria-hidden />
      <span style={{ minWidth: 0 }}>
        <span className="capiro-crm__attention-title">{row.title}</span>
        <span className="capiro-crm__meta capiro-crm__attention-meta">{row.meta}</span>
      </span>
      <CapiroBadge tone={ATTENTION_TONE[row.kind]}>{row.kind.toUpperCase()}</CapiroBadge>
      <span className="capiro-crm__attention-when">{row.when}</span>
      <span className="capiro-crm__meta capiro-crm__attention-status">{row.status}</span>
    </button>
  );
}

/* ─────────────────────────── work pulse (908:2969) ───────────────────────── */

function WorkPulseCard({ model }: { model: ClientCrmOverviewModel }) {
  const { work, workStatus } = model;
  return (
    <section className="capiro-crm__card capiro-crm__card--pulse capiro-elevation-widget" aria-labelledby="crm-work-title">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title" id="crm-work-title">
          Work pulse
        </h3>
        <button type="button" className="capiro-crm__card-action">
          Open work
        </button>
      </div>

      <Region status={workStatus} skeletonHeight={140}>
        <div className="capiro-crm__metrics">
          <MetricValue metric={work.currentStrategies} label="Current strategies" />
          <MetricValue metric={work.remainingActions} label="Remaining actions" />
          <MetricValue metric={work.upcomingMilestones} label="Upcoming milestones" />
          <MetricValue metric={work.openRisk} label="Open risk" />
        </div>

        <div className="capiro-crm__readiness">
          <p className="capiro-crm__meta">Client work readiness</p>
          {work.readiness == null ? (
            // A percentage with no completion signal behind it would be fiction.
            <p className="capiro-crm__foot" title={work.readinessReason ?? undefined}>
              Not available — {work.readinessReason}
            </p>
          ) : (
            <div className="capiro-crm__track-row">
              <div
                className="capiro-crm__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(work.readiness * 100)}
                aria-label="Client work readiness"
              >
                <span
                  className="capiro-crm__track-value"
                  style={{ width: `${Math.round(work.readiness * 100)}%` }}
                />
              </div>
              <span className="capiro-crm__track-pct">{Math.round(work.readiness * 100)}%</span>
            </div>
          )}
          {work.nextStep ? <p className="capiro-crm__foot">{work.nextStep}</p> : null}
        </div>
      </Region>
    </section>
  );
}

/* ───────────────────── intelligence pulse (908:2985) ─────────────────────── */

function IntelligencePulseCard({ model }: { model: ClientCrmOverviewModel }) {
  const { intelligence, intelligenceStatus } = model;
  return (
    <section className="capiro-crm__card capiro-crm__card--pulse capiro-elevation-widget" aria-labelledby="crm-intel-title">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title" id="crm-intel-title">
          Intelligence pulse
        </h3>
        <button type="button" className="capiro-crm__card-action">
          Open intelligence
        </button>
      </div>

      <Region status={intelligenceStatus} skeletonHeight={140}>
        <div className="capiro-crm__metrics">
          <MetricValue metric={intelligence.trackedBills} label="Tracked bills" />
          <MetricValue metric={intelligence.opportunities} label="Opportunities" />
          <MetricValue metric={intelligence.districts} label="Districts" />
          <MetricValue metric={intelligence.regulatoryMatters} label="Regulatory matters" />
        </div>

        {intelligence.signals.length > 0 ? (
          <div className="capiro-crm__chips">
            {intelligence.signals.map((signal) => (
              <span key={signal} className="capiro-crm__pill capiro-crm__pill--filled">
                <span className="capiro-crm__pill-dot" aria-hidden />
                {signal}
              </span>
            ))}
          </div>
        ) : null}

        <p className="capiro-crm__foot">
          {intelligence.lastRefresh
            ? `Last intelligence refresh: ${intelligence.lastRefresh}`
            : 'Source refresh time is not reported by these services.'}
        </p>
      </Region>
    </section>
  );
}
