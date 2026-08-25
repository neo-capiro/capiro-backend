import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  CardFoot,
  CardHead,
  PfButton,
  PfEmptyState,
  PfSkeleton,
  Pill,
  TabPageHead,
  Tile,
  type PillTone,
} from '../portfolio-primitives.js';
import { formatDateShort, formatMoney, formatNumber } from '../../../lib/labels.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import type { Capability } from '../../../../pages/clients/capability-types.js';
import {
  createCapabilityHistory,
  submissionHistoryKeys,
  OUTCOME_TONE,
  OUTCOME_TYPE_LABEL,
  type CreateSubmissionHistoryInput,
  type SubmissionOutcomeType,
} from '../../../../pages/clients/submission-history-api.js';
import { useClientSubmissions, type SubmissionWithCapability } from '../client-submissions.js';
import {
  useClientCrmOverviewModel,
  type ClientCrmOverviewModel,
  type Metric,
  type RegionStatus,
  type TrajectoryMetric,
  type FederalFootprint,
} from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { ManageAccountTeamModal } from '../ManageAccountTeamModal.js';
import './overview-tab.css';

/**
 * Overview tab (spec §6, consolidated). Order: client profile (identity +
 * account facts + work pulse + intelligence pulse, one card) → federal
 * footprint → advocacy history. §16: NO "Needs attention" card.
 *
 * The former four-card top section (Client profile / Account / Work pulse /
 * Intelligence pulse) read as one account snapshot split across separate
 * boxes for no functional reason, and each carried its own "Edit"/action
 * link even though only one editor exists for the whole client record. They
 * are now one "Client profile" card with internal sections, and there is
 * exactly one Edit action — in the card header — which is also the only Edit
 * entry point on this page (the page-level "Edit profile" button in the old
 * header is gone; it opened the identical editor as the card's own Edit).
 *
 * Data: profile/account/work/intel sections all bind to the real overview
 * model. Federal footprint reads from the real client-profile endpoint (LDA
 * spend, filings, awards, trajectory) via the overview model's
 * `federalFootprint`. NO design fixture renders on this tab any more: every
 * region shows skeletons while loading, an inline error + Retry on failure,
 * and only real rows once settled.
 */

export function ClientCrmOverviewProto({
  client,
  onEditProfile,
  onOpenFederalFootprint,
  onOpenWork,
  onOpenIntelligence,
}: {
  client: Client;
  onEditProfile?: () => void;
  onOpenFederalFootprint?: () => void;
  onOpenWork?: () => void;
  onOpenIntelligence?: () => void;
}) {
  const model = useClientCrmOverviewModel(client);
  return (
    <div className="cap-pf-anim-rise ov-root">
      <TabPageHead
        title="Client overview"
        sub="The account, its federal footprint, and the advocacy record behind it."
      />

      {/* client profile: identity + account facts + work pulse + intel pulse,
          one card (§6.1/§6.4 consolidated) */}
      <ClientProfileCard
        model={model}
        client={client}
        onEditProfile={onEditProfile}
        onOpenWork={onOpenWork}
        onOpenIntelligence={onOpenIntelligence}
      />

      {/* federal footprint (§6.2) */}
      <FederalFootprintCard model={model} onOpen={onOpenFederalFootprint} />

      {/* advocacy history (§6.3) */}
      <AdvocacyHistoryCard client={client} />
    </div>
  );
}

/* ── shared region-state pieces ───────────────────────────────────────────── */

/** Inline failure line + Retry — the model's RegionStatus carries both. */
function RegionErrorLine({ status, label }: { status: RegionStatus; label: string }) {
  return (
    <div className="ov-error-line">
      <span className="ov-error-msg">
        {label}
        {status.message ? ` — ${status.message}` : ''}
      </span>
      <PfButton variant="link" onClick={status.retry} style={{ fontSize: 13 }}>
        Retry
      </PfButton>
    </div>
  );
}

/** One loading pulse-metric slot: skeleton number over the real label. */
function SkeletonMetricCell({ label }: { label: string }) {
  return (
    <span className="ov-metric-skel">
      <PfSkeleton width={56} height={28} />
      <span className="ov-eyebrow">{label}</span>
    </span>
  );
}

/* ── §6.1/§6.4 Client profile (consolidated) ─────────────────────────────── */

/** A dividing sub-header INSIDE the consolidated card — not a new Card, so
 *  every section stays visually and semantically one card. */
function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="ov-section-head">
      <h4 className="ov-section-title">{title}</h4>
      <span className="ov-spacer" />
      {action}
    </div>
  );
}

/**
 * One card: identity, account facts, work pulse, and intelligence pulse.
 * These used to be four separate cards, each with its own action link
 * (including its own "Edit"), which duplicated the page-level "Edit
 * profile" button for no reason — there is only ever one editor for a
 * client record. Now there is exactly one Edit action, in this card's
 * header; "Manage team"/"Open work"/"Open intelligence" are distinct
 * navigations (not edits) and keep their own inline actions.
 */
function ClientProfileCard({
  model,
  client,
  onEditProfile,
  onOpenWork,
  onOpenIntelligence,
}: {
  model: ClientCrmOverviewModel;
  client: Client;
  onEditProfile?: () => void;
  onOpenWork?: () => void;
  onOpenIntelligence?: () => void;
}) {
  const { profile, account, accountStatus, accountTeamStatus, work, workStatus, intelligence, intelligenceStatus } = model;
  const [teamOpen, setTeamOpen] = useState(false);
  const briefLabel = account.briefState === 'ready' ? 'Brief ready' : account.briefState === 'none' ? 'No brief yet' : 'No meeting scheduled';
  const contactEmail = client.primaryContactEmail;
  // Account owner already lives in the shell header — repeating it here was
  // pure duplication. Its slot shows the relationship start when recorded.
  const clientSince = formatDateShort(client.intakeData?.engagementStartDate ?? null);
  const meetingsLoading = accountStatus.state === 'loading';

  return (
    <Card>
      <CardHead
        title="Client profile"
        action={
          <PfButton variant="link" onClick={onEditProfile} disabled={!onEditProfile}>
            Edit
          </PfButton>
        }
      />

      {/* identity */}
      <div className="ov-identity">
        <Tile initials={profile.initials} size={64} src={profile.logoUrl} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="ov-identity-desc">{profile.description ?? 'No description recorded yet.'}</p>
          <div className="ov-identity-meta">
            {profile.sectorLabel ? <span className="ov-sector-pill">{profile.sectorLabel}</span> : null}
            {profile.website ? (
              <a
                href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                target="_blank"
                rel="noreferrer noopener"
                className="ov-website-link"
              >
                {profile.website.replace(/^https?:\/\//, '')}
              </a>
            ) : null}
            {profile.location ? <span className="ov-identity-location">{profile.location}</span> : null}
          </div>
          <div className="ov-identity-since">
            {profile.clientSince ? `Client since ${profile.clientSince}` : 'Client since not recorded'}
          </div>
        </div>
      </div>

      {/* account facts */}
      {/* There IS a per-client account-team roster now (`client_team_members`,
          served by `/api/clients/:id/team`), so "Manage team" no longer
          redirects to firm-wide team settings — which was a different thing
          and the reason there was no way to put anyone on an account team. */}
      <SectionHead
        title="Account"
        action={<PfButton variant="link" onClick={() => setTeamOpen(true)}>Manage team</PfButton>}
      />
      <div className="ov-account-grid">
        <Field
          label="Primary contact"
          value={account.primaryContact ?? 'Not set'}
          empty={!account.primaryContact}
          href={contactEmail ? `mailto:${contactEmail}` : undefined}
        />
        {clientSince ? <Field label="Client since" value={clientSince} /> : null}
        {/* Only the meeting fields depend on the meetings read — the contact
            fields come from the client record and stay visible throughout. */}
        {meetingsLoading ? (
          <div>
            <div className="ov-eyebrow">Next meeting</div>
            <div className="ov-account-skel-wrap">
              <PfSkeleton width={120} height={16} />
            </div>
          </div>
        ) : (
          <Field label="Next meeting" value={account.nextMeeting?.label ?? 'None scheduled'} empty={!account.nextMeeting} />
        )}
        <div>
          <div className="ov-eyebrow">Account team</div>
          <div className="ov-team-row">
            <AccountTeamSlot
              team={account.accountTeam}
              available={account.accountTeamAvailable}
              status={accountTeamStatus}
              onManage={() => setTeamOpen(true)}
            />
            {meetingsLoading ? <PfSkeleton width={72} height={22} style={{ borderRadius: 9999 }} /> : <Pill tone="success">{briefLabel}</Pill>}
          </div>
        </div>
      </div>
      {accountStatus.state === 'error' ? (
        <div className="ov-region-error-wrap">
          <RegionErrorLine status={accountStatus} label="Couldn't read meetings" />
        </div>
      ) : null}
      {accountTeamStatus.state === 'error' ? (
        <div className="ov-region-error-wrap">
          <RegionErrorLine status={accountTeamStatus} label="Couldn't read the account team" />
        </div>
      ) : null}

      {/* work pulse */}
      <SectionHead
        title="Work pulse"
        action={
          <PfButton variant="link" onClick={onOpenWork} disabled={!onOpenWork}>
            Open work
          </PfButton>
        }
      />
      <div className="ov-pulse-body">
        <PulseBody status={workStatus} errorLabel="Couldn't load this client's work pulse">
          <MetricCell metric={work.currentStrategies} label="Strategies" />
          <MetricCell metric={work.remainingActions} label="Plan steps" />
          <MetricCell metric={work.upcomingMilestones} label="Next 30 days" />
          <MetricCell metric={work.openRisk} label="Open risks" />
        </PulseBody>
        {/* The readiness meter is gone on purpose: `readiness` is always null —
            nothing in the Strategy API measures completion — so the bar was a
            permanently-empty decoration. The reason renders instead. */}
        {workStatus.state === 'ready' && (work.readinessReason || work.nextStep) ? (
          <div className="ov-pulse-note">{work.nextStep ?? work.readinessReason}</div>
        ) : null}
      </div>

      {/* intelligence pulse */}
      <SectionHead
        title="Intelligence pulse"
        action={
          <PfButton variant="link" onClick={onOpenIntelligence} disabled={!onOpenIntelligence}>
            Open intelligence
          </PfButton>
        }
      />
      <div className="ov-pulse-body--last">
        <PulseBody status={intelligenceStatus} errorLabel="Couldn't load this client's intelligence pulse">
          <MetricCell metric={intelligence.trackedBills} label="Tracked bills" />
          <MetricCell metric={intelligence.opportunities} label="Opportunities" />
          <MetricCell metric={intelligence.districts} label="Districts" />
          <MetricCell metric={intelligence.regulatoryMatters} label="Regulatory matters" />
        </PulseBody>
        {intelligenceStatus.state === 'ready' && intelligence.signals.length > 0 ? (
          <div className="ov-signals-row">
            {intelligence.signals.map((signal, i) => (
              <Pill key={signal} tone={i === 0 ? 'error' : i === 1 ? 'brand' : 'gray'} dotless={i === 2} size="lg">
                {signal}
              </Pill>
            ))}
          </div>
        ) : null}
        {intelligenceStatus.state === 'ready' && intelligence.lastRefresh ? (
          <div className="ov-last-refresh">{`Last intelligence refresh: ${intelligence.lastRefresh}`}</div>
        ) : null}
      </div>

      <ManageAccountTeamModal
        open={teamOpen}
        clientId={client.id}
        clientName={client.name}
        onClose={() => setTeamOpen(false)}
      />
    </Card>
  );
}

/**
 * The Account card's team slot: stacked initials for the real roster.
 *
 * Three genuinely different states, never collapsed into one another:
 *  - loading  → a skeleton (NOT "no roster", which is a claim)
 *  - errored  → nothing here; the card's RegionErrorLine says the read failed
 *  - settled  → the roster, or a real "nobody assigned yet" with a way to fix it
 */
function AccountTeamSlot({
  team,
  available,
  status,
  onManage,
}: {
  team: ClientCrmOverviewModel['account']['accountTeam'];
  available: boolean;
  status: RegionStatus;
  onManage: () => void;
}) {
  if (status.state === 'loading') {
    return <PfSkeleton width={96} height={24} style={{ borderRadius: 9999 }} />;
  }
  if (status.state === 'error' || !available) {
    // The failure is reported once, by the card's own error line.
    return <span className="ov-team-dash">—</span>;
  }
  if (team.length === 0) {
    return (
      <PfButton variant="link" onClick={onManage} style={{ fontSize: 14 }}>
        Add a teammate
      </PfButton>
    );
  }

  const shown = team.slice(0, 4);
  const overflow = team.length - shown.length;
  return (
    <button
      type="button"
      onClick={onManage}
      // The full roster (with roles) as a tooltip, so four stacked initials are
      // still identifiable without opening the editor.
      title={team
        .map((member) => (member.role ? `${member.name} — ${member.role}` : member.name))
        .join(', ')}
      className="ov-team-btn"
    >
      <span className="ov-team-avatars">
        {shown.map((member, index) => (
          <span
            key={member.id}
            className="ov-team-avatar"
            // Overlap so a roster of four stays compact in a two-up card —
            // the only per-instance value here, everything else is static.
            style={{ marginLeft: index === 0 ? 0 : -7 }}
          >
            {member.initials}
          </span>
        ))}
      </span>
      <span className="ov-team-count">
        {team.length} member{team.length === 1 ? '' : 's'}
        {overflow > 0 ? ` (+${overflow} more)` : ''}
      </span>
    </button>
  );
}

function Field({ label, value, empty = false, href }: { label: string; value: string; empty?: boolean; href?: string }) {
  return (
    <div>
      <div className="ov-eyebrow">{label}</div>
      {href ? (
        <a href={href} className="ov-field-value">
          {value}
        </a>
      ) : (
        <div className={empty ? 'ov-field-value ov-field-value--empty' : 'ov-field-value'}>{value}</div>
      )}
    </div>
  );
}

/* ── §6.2 Federal footprint ───────────────────────────────────────────────── */

/**
 * Wire-audit "3 Compose extend" item 3: federal footprint now reads from the
 * real client-profile endpoint (LDA spend, filings, federal awards, lobbying
 * trajectory) via the overview model's `federalFootprint`. Each slot is a
 * `Metric` — real value or `unavailable` — so missing data renders as `—`
 * rather than a fixture number. Rendering follows the metric's own `format`
 * (currency vs count), never a string-match on the display label.
 */
function FootCell({ metric, label, title }: { metric: Metric; label: string; title?: string }) {
  const display =
    metric.kind === 'value'
      ? metric.format === 'currency'
        ? formatMoney(Number(metric.value))
        : formatNumber(metric.value)
      : '—';
  return (
    <>
      <span className="ov-foot-value-wrap">
        <span
          className={metric.kind === 'value' ? 'ov-foot-value' : 'ov-foot-value ov-foot-value--unavailable'}
          title={metric.kind === 'unavailable' ? metric.reason : undefined}
        >
          {display}
        </span>
      </span>
      <span className="ov-eyebrow" title={title}>
        {label}
      </span>
    </>
  );
}

/**
 * The trajectory is a labeled direction, not a number: the source's human
 * label ("Contracting") leads, and the growth rate renders as a humanized
 * YoY delta ("↓ 37.6% YoY") — never the raw -0.376.
 */
function TrajectoryCell({ metric }: { metric: TrajectoryMetric }) {
  if (metric.kind === 'unavailable') {
    return (
      <>
        <span className="ov-foot-value ov-foot-value--unavailable" title={metric.reason}>
          —
        </span>
        <span className="ov-eyebrow">Lobbying trajectory</span>
      </>
    );
  }
  const rate = metric.growthRate;
  const direction = rate == null ? null : rate < 0 ? 'down' : rate > 0 ? 'up' : 'flat';
  const pct = rate == null ? null : Math.abs(rate * 100).toFixed(1).replace(/\.0$/, '');
  const labelText = metric.trajectoryLabel.charAt(0).toUpperCase() + metric.trajectoryLabel.slice(1);
  return (
    <>
      <span className="ov-trajectory-wrap">
        <Pill tone="gray">{labelText}</Pill>
        {direction != null && pct != null ? (
          <span aria-label={`${direction} ${pct} percent year over year`} className="ov-trajectory-rate">
            {direction === 'flat' ? 'Flat YoY' : `${direction === 'down' ? '↓' : '↑'} ${pct}% YoY`}
          </span>
        ) : null}
      </span>
      <span className="ov-eyebrow">Lobbying trajectory</span>
    </>
  );
}

function FederalFootprintCard({ model, onOpen }: { model: ClientCrmOverviewModel; onOpen?: () => void }) {
  const fp: FederalFootprint = model.federalFootprint;
  const stats: Array<{ label: string; title?: string; cell: React.ReactNode }> = [
    { label: 'Lobbying · TTM', cell: <FootCell metric={fp.ldaSpend} label="Lobbying · TTM" /> },
    { label: 'LD-2 filings', cell: <FootCell metric={fp.ldaFilings} label="LD-2 filings" /> },
    {
      label: 'Federal awards',
      cell: (
        <FootCell
          metric={fp.federalAwards}
          label="Federal awards"
          // The figure is obligated DOLLARS on the matched federal contractor
          // record, not a count of awards — the old "Count of…" tooltip was
          // describing the same mislabel that printed the raw 68973208559.3.
          title="Obligated dollars on the matched federal contractor record"
        />
      ),
    },
    { label: 'Lobbying trajectory', cell: <TrajectoryCell metric={fp.lobbyingTrajectory} /> },
  ];
  return (
    <Card>
      <div className="ov-foot-header">
        <span className="ov-foot-header-label">
          <span className="ov-foot-title">Federal footprint</span>
          <span className="ov-foot-desc">
            The public record: lobbying disclosures, federal awards, political giving, and the districts this client sits in.
          </span>
        </span>
        <PfButton variant="link" onClick={onOpen}>Open federal footprint →</PfButton>
      </div>
      {fp.error ? (
        <div style={{ padding: '18px 24px 20px' }}>
          <RegionErrorLine
            status={{ state: 'error', message: fp.error, retry: fp.retry ?? (() => {}) }}
            label="Couldn't load the federal footprint"
          />
        </div>
      ) : !fp.ready ? (
        // Loading: skeleton bars over the real labels, never four fake '—'.
        <div className="ov-foot-row">
          {stats.map((s, i) => (
            <span key={s.label} className={i === 0 ? 'ov-foot-cell' : 'ov-foot-cell ov-foot-cell--divider'}>
              <PfSkeleton width={96} height={26} style={{ margin: '2px 0' }} />
              <span className="ov-eyebrow">{s.label}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="ov-foot-row">
          {stats.map((s, i) => (
            <span key={s.label} className={i === 0 ? 'ov-foot-cell' : 'ov-foot-cell ov-foot-cell--divider'}>
              {s.cell}
            </span>
          ))}
        </div>
      )}
      <CardFoot
        left={fp.registrantsLabel ?? 'No LDA registrants matched'}
        right="District mapping via facilities"
      />
    </Card>
  );
}

/* ── §6.3 Advocacy history ────────────────────────────────────────────────── */

/**
 * §6.3 Advocacy history.
 *
 * What is real (wire-audit "4 New capability" row 6): the client's
 * `ClientSubmissionHistory` rows — fiscal year, title, meta, outcome and its
 * coarse type — and "Log a submission", which POSTs a new one against a
 * capability.
 *
 * What is NOT real, and is therefore never rendered at all: the design's
 * lifecycle/milestone track and evidence taxonomy (public-record /
 * client-verified / inferred). Neither has any field, table or endpoint in
 * this codebase. The ADVOCACY fixture used to stand in while loading or on
 * error — that showed six invented records under a real client's name, so
 * loading now renders skeleton rows and a failure renders an inline error
 * with Retry instead.
 */
function AdvocacyHistoryCard({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const { rows, capabilities, settled, failed } = useClientSubmissions(client.id);
  const [logging, setLogging] = useState(false);

  const loading = !settled && !failed;
  const genuinelyEmpty = settled && !failed && rows.length === 0;

  // `useClientSubmissions` fans out over the shared capability + history
  // keys; invalidating those prefixes re-runs every read behind this card.
  const retryReads = () => {
    void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] });
    void qc.invalidateQueries({ queryKey: ['client-submission-history', client.id] });
  };

  const create = useMutation({
    mutationFn: ({ capabilityId, ...input }: { capabilityId: string } & CreateSubmissionHistoryInput) =>
      createCapabilityHistory(api, client.id, capabilityId, input),
    onSuccess: (_created, variables) => {
      setLogging(false);
      void qc.invalidateQueries({
        queryKey: submissionHistoryKeys.forCapability(client.id, variables.capabilityId),
      });
    },
  });

  return (
    <Card>
      <CardHead
        withDesc
        title="Advocacy history"
        description="What this client asked for, and what happened. Submissions are recorded against the capability they support."
        action={
          <PfButton
            onClick={() => setLogging(true)}
            disabled={capabilities.length === 0}
            title={capabilities.length === 0 ? 'Add a capability first — a submission is recorded against one' : undefined}
          >
            Log a submission
          </PfButton>
        }
      />
      <div className="ov-advocacy-body">
        {failed ? (
          <div className="ov-advocacy-error-wrap">
            <RegionErrorLine
              status={{ state: 'error', retry: retryReads }}
              label="Couldn't load this client's submission history"
            />
          </div>
        ) : loading ? (
          [0, 1, 2].map((i) => <AdvocacySkeletonRow key={i} last={i === 2} />)
        ) : genuinelyEmpty ? (
          <p className="ov-advocacy-empty">
            {capabilities.length === 0
              ? 'No submissions recorded yet. Add a capability first — a submission is recorded against one.'
              : 'No submissions recorded for this client yet.'}
          </p>
        ) : (
          rows.map((row) => <SubmissionHistoryRowView key={row.id} row={row} />)
        )}
      </div>
      {/* Footer is a real computed count — never the design's invented
          "6 records · 3 public …" evidence-class breakdown. */}
      {settled && !failed && rows.length > 0 ? (
        <CardFoot left={`${rows.length} submission${rows.length === 1 ? '' : 's'} on file`} right={<span />} />
      ) : null}

      {logging ? (
        <LogSubmissionModal
          capabilities={capabilities}
          pending={create.isPending}
          error={create.error}
          onClose={() => setLogging(false)}
          onSubmit={(values) => create.mutate(values)}
        />
      ) : null}
    </Card>
  );
}

/** Loading placeholder mirroring one submission row's layout. */
function AdvocacySkeletonRow({ last }: { last: boolean }) {
  return (
    <div className={last ? 'ov-advrow ov-advrow--last' : 'ov-advrow'}>
      <span className="ov-advrow-date-wrap">
        <PfSkeleton width={40} height={13} />
      </span>
      <span className="ov-advrow-content">
        <PfSkeleton width="55%" height={15} />
        <PfSkeleton width="35%" height={12} />
      </span>
      <PfSkeleton width={88} height={22} style={{ borderRadius: 9999 }} />
    </div>
  );
}

/** One real submission. No lifecycle track and no evidence chip — see above. */
function SubmissionHistoryRowView({ row }: { row: SubmissionWithCapability }) {
  const tone = (OUTCOME_TONE[row.outcomeType] ?? 'gray') as PillTone;
  return (
    <div className="ov-subrow">
      <span className="ov-subrow-year">{row.fiscalYear}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="ov-subrow-title">{row.title}</span>
        <span className="ov-subrow-meta">
          {[row.capabilityName, row.meta].filter(Boolean).join(' · ') || 'No detail recorded'}
        </span>
        {row.notes ? <span className="ov-subrow-notes">{row.notes}</span> : null}
      </span>
      <span className="ov-subrow-outcome">
        <Pill tone={tone}>{OUTCOME_TYPE_LABEL[row.outcomeType] ?? row.outcomeType}</Pill>
        {row.outcome ? <span className="ov-subrow-outcome-text">{row.outcome}</span> : null}
      </span>
    </div>
  );
}

const OUTCOME_TYPE_OPTIONS: Array<{ value: SubmissionOutcomeType; label: string }> = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'success', label: 'Succeeded' },
  { value: 'partial', label: 'Partial' },
  { value: 'failed', label: 'Not included' },
];

/**
 * Log a submission. Every field here exists on `ClientSubmissionHistory`; the
 * capability picker is required because the API attaches the row to one
 * (`POST /clients/:id/capabilities/:capId/history` 404s without a real one).
 */
function LogSubmissionModal({
  capabilities,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  capabilities: Capability[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (values: { capabilityId: string } & CreateSubmissionHistoryInput) => void;
}) {
  const [capabilityId, setCapabilityId] = useState(capabilities[0]?.id ?? '');
  const [fiscalYear, setFiscalYear] = useState('');
  const [title, setTitle] = useState('');
  const [meta, setMeta] = useState('');
  const [outcome, setOutcome] = useState('');
  const [outcomeType, setOutcomeType] = useState<SubmissionOutcomeType>('in_progress');
  const [notes, setNotes] = useState('');

  const ready = Boolean(capabilityId && fiscalYear.trim() && title.trim());

  return (
    <CapiroModal open title="Log a submission" onClose={onClose}>
      <div className="ov-log-form">
        <label>
          <span className="ov-eyebrow">Capability</span>
          <select
            value={capabilityId}
            aria-label="Capability"
            onChange={(e) => setCapabilityId(e.target.value)}
            className="ov-log-field"
          >
            {capabilities.map((capability) => (
              <option key={capability.id} value={capability.id}>
                {capability.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ov-log-row">
          <label className="ov-log-field-narrow">
            <span className="ov-eyebrow">Fiscal year</span>
            <input
              value={fiscalYear}
              aria-label="Fiscal year"
              onChange={(e) => setFiscalYear(e.target.value)}
              placeholder="FY27"
              className="ov-log-field"
            />
          </label>
          <label className="ov-log-field-grow">
            <span className="ov-eyebrow">Title</span>
            <input
              value={title}
              aria-label="Title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What was asked for"
              className="ov-log-field"
            />
          </label>
        </div>
        <label>
          <span className="ov-eyebrow">Detail</span>
          <input
            value={meta}
            aria-label="Detail"
            onChange={(e) => setMeta(e.target.value)}
            placeholder="Vehicle, committee, who it went to"
            className="ov-log-field"
          />
        </label>
        <div className="ov-log-row">
          <label className="ov-log-field-grow">
            <span className="ov-eyebrow">Outcome</span>
            <input
              value={outcome}
              aria-label="Outcome"
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="e.g. Included +$8M"
              className="ov-log-field"
            />
          </label>
          <label className="ov-log-field-fixed160">
            <span className="ov-eyebrow">Status</span>
            <select
              value={outcomeType}
              aria-label="Status"
              onChange={(e) => setOutcomeType(e.target.value as SubmissionOutcomeType)}
              className="ov-log-field"
            >
              {OUTCOME_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span className="ov-eyebrow">Notes</span>
          <textarea
            value={notes}
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Provenance — what is on file for this"
            className="ov-log-field ov-log-field--textarea"
          />
        </label>
        {error ? (
          <p className="ov-log-error">{error instanceof Error ? error.message : 'Could not log that submission'}</p>
        ) : null}
        <div className="ov-log-actions">
          <CapiroButton
            variant="primary"
            size="compact"
            loading={pending}
            disabled={!ready}
            onClick={() =>
              onSubmit({
                capabilityId,
                fiscalYear: fiscalYear.trim(),
                title: title.trim(),
                ...(meta.trim() ? { meta: meta.trim() } : {}),
                ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
                outcomeType,
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              })
            }
          >
            Log submission
          </CapiroButton>
          <CapiroButton variant="secondary" size="compact" onClick={onClose}>
            Cancel
          </CapiroButton>
        </div>
      </div>
    </CapiroModal>
  );
}

/* ── §6.4 Work pulse + Intelligence pulse ─────────────────────────────────── */

function MetricCell({ metric, label }: { metric: Metric; label: string }) {
  if (metric.kind === 'unavailable') {
    return (
      <span className="ov-metric">
        <span className="ov-metric-value ov-metric-value--unavailable" title={metric.reason}>—</span>
        <span className="ov-eyebrow">{label}</span>
      </span>
    );
  }
  return (
    <span className="ov-metric">
      <span className="ov-metric-value">{metric.value}</span>
      <span className="ov-eyebrow">{label}</span>
    </span>
  );
}

/** Four metric cells + status handling shared by both pulse cards. */
function PulseBody({
  status,
  children,
  errorLabel,
}: {
  status: RegionStatus;
  children: ReactNode;
  errorLabel: string;
}) {
  if (status.state === 'loading') {
    return (
      <div className="ov-pulse-loading">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="ov-pulse-loading-cell">
            <PfSkeleton width={48} height={28} />
            <PfSkeleton width={80} height={12} />
          </span>
        ))}
      </div>
    );
  }
  if (status.state === 'error') {
    return <RegionErrorLine status={status} label={errorLabel} />;
  }
  return <div className="ov-pulse-grid">{children}</div>;
}

/* WorkPulseCard and IntelligencePulseCard were folded into ClientProfileCard
   above — their bodies (MetricCell + PulseBody usage) now render as sections
   of the one consolidated card instead of standalone Cards. */
