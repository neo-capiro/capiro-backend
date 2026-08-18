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

/**
 * Overview tab (spec §6). Order: profile+account → federal footprint →
 * advocacy history → work+intelligence pulse. §16: NO "Needs attention" card.
 *
 * Data: profile/account/work/intel pulse bind to the real overview model.
 * Federal footprint reads from the real client-profile endpoint (LDA spend,
 * filings, awards, trajectory) via the overview model's `federalFootprint`.
 * NO design fixture renders on this tab any more: every region shows
 * skeletons while loading, an inline error + Retry on failure, and only real
 * rows once settled.
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
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Client overview"
        sub="The account, its federal footprint, and the advocacy record behind it."
        actions={
          <PfButton onClick={onEditProfile} disabled={!onEditProfile}>
            Edit profile
          </PfButton>
        }
      />

      {/* profile + account (§6.1) */}
      <div className="cap-pf-grid-profile">
        <ProfileCard model={model} onEditProfile={onEditProfile} />
        <AccountCard model={model} client={client} />
      </div>

      {/* federal footprint (§6.2) */}
      <FederalFootprintCard model={model} onOpen={onOpenFederalFootprint} />

      {/* advocacy history (§6.3) */}
      <AdvocacyHistoryCard client={client} />

      {/* work + intelligence pulse (§6.4) */}
      <div className="cap-pf-grid-2">
        <WorkPulseCard model={model} onOpenWork={onOpenWork} />
        <IntelligencePulseCard model={model} onOpenIntelligence={onOpenIntelligence} />
      </div>
    </div>
  );
}

/* ── shared region-state pieces ───────────────────────────────────────────── */

/** Inline failure line + Retry — the model's RegionStatus carries both. */
function RegionErrorLine({ status, label }: { status: RegionStatus; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, color: '#B42318', textWrap: 'pretty' }}>
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
    <span style={{ flex: 1, minWidth: 104, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <PfSkeleton width={56} height={28} />
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>{label}</span>
    </span>
  );
}

/* ── §6.1 Client profile ──────────────────────────────────────────────────── */

function ProfileCard({ model, onEditProfile }: { model: ClientCrmOverviewModel; onEditProfile?: () => void }) {
  const { profile } = model;
  return (
    <Card>
      <CardHead title="Client profile" action={<PfButton variant="link" onClick={onEditProfile}>Edit</PfButton>} />
      <div style={{ display: 'flex', gap: 20, padding: 24 }}>
        <Tile initials={profile.initials} size={64} src={profile.logoUrl} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 16, lineHeight: '24px', color: '#344054', textWrap: 'pretty' }}>
            {profile.description ?? 'No description recorded yet.'}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
            {profile.sectorLabel ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 24,
                  padding: '0 10px',
                  borderRadius: 9999,
                  background: '#F2F4F7',
                  boxShadow: 'inset 0 0 0 1px #D0D5DD',
                  color: '#101828',
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}
              >
                {profile.sectorLabel}
              </span>
            ) : null}
            {profile.website ? (
              <a
                href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
                target="_blank"
                rel="noreferrer noopener"
                style={{ fontSize: 14, fontWeight: 600 }}
              >
                {profile.website.replace(/^https?:\/\//, '')}
              </a>
            ) : null}
            {profile.location ? <span style={{ fontSize: 14, color: '#475467' }}>{profile.location}</span> : null}
          </div>
          <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
            {profile.clientSince ? `Client since ${profile.clientSince}` : 'Client since not recorded'}
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ── §6.1 Account ─────────────────────────────────────────────────────────── */

function AccountCard({ model, client }: { model: ClientCrmOverviewModel; client: Client }) {
  const navigate = useNavigate();
  const { account, accountStatus } = model;
  const briefLabel = account.briefState === 'ready' ? 'Brief ready' : account.briefState === 'none' ? 'No brief yet' : 'No meeting scheduled';
  const contactEmail = client.primaryContactEmail;
  // Account owner already lives in the shell header — repeating it here was
  // pure duplication. Its slot shows the relationship start when recorded.
  const clientSince = formatDateShort(client.intakeData?.engagementStartDate ?? null);
  const meetingsLoading = accountStatus.state === 'loading';
  return (
    <Card>
      {/* Row 7, wire-audit "4 New capability": there is no per-client
          account-team roster API — `accountTeam` is hardcoded empty in the
          overview model. The real, existing destination is the firm's team
          settings, so the link says that rather than implying a client roster
          this product does not store. */}
      <CardHead
        title="Account"
        action={<PfButton variant="link" onClick={() => navigate('/settings/team')}>Firm team settings</PfButton>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 24px', padding: 24 }}>
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
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Next meeting</div>
            <div style={{ marginTop: 8 }}>
              <PfSkeleton width={120} height={16} />
            </div>
          </div>
        ) : (
          <Field label="Next meeting" value={account.nextMeeting?.label ?? 'None scheduled'} empty={!account.nextMeeting} />
        )}
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Account team</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            {/* Wire-audit "3 Compose extend" item 3: no per-client team roster
                exists, so the hardcoded fixture avatars (SM, JC, AR) are
                replaced with an honest empty state that links to the real
                team settings. */}
            <span style={{ fontSize: 14, color: '#98A2B3' }}>No roster</span>
            {meetingsLoading ? <PfSkeleton width={72} height={22} style={{ borderRadius: 9999 }} /> : <Pill tone="success">{briefLabel}</Pill>}
          </div>
        </div>
      </div>
      {accountStatus.state === 'error' ? (
        <div style={{ padding: '0 24px 20px' }}>
          <RegionErrorLine status={accountStatus} label="Couldn't read meetings" />
        </div>
      ) : null}
    </Card>
  );
}

function Field({ label, value, empty = false, href }: { label: string; value: string; empty?: boolean; href?: string }) {
  const [hover, setHover] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{label}</div>
      {href ? (
        <a
          href={href}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ display: 'block', marginTop: 4, fontSize: 16, fontWeight: 500, color: hover ? '#0E141C' : '#101828' }}
        >
          {value}
        </a>
      ) : (
        <div style={{ marginTop: 4, fontSize: 16, fontWeight: 500, color: empty ? '#98A2B3' : '#101828' }}>{value}</div>
      )}
    </div>
  );
}

/* ── §6.2 Federal footprint ───────────────────────────────────────────────── */

const FOOT_LABEL_STYLE = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: '#667085',
  textWrap: 'pretty',
} as const;

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
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: metric.kind === 'value' ? '#101828' : '#98A2B3', lineHeight: 1.2 }}
          title={metric.kind === 'unavailable' ? metric.reason : undefined}
        >
          {display}
        </span>
      </span>
      <span style={FOOT_LABEL_STYLE} title={title}>
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
        <span
          style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: '#98A2B3', lineHeight: 1.2 }}
          title={metric.reason}
        >
          —
        </span>
        <span style={FOOT_LABEL_STYLE}>Lobbying trajectory</span>
      </>
    );
  }
  const rate = metric.growthRate;
  const direction = rate == null ? null : rate < 0 ? 'down' : rate > 0 ? 'up' : 'flat';
  const pct = rate == null ? null : Math.abs(rate * 100).toFixed(1).replace(/\.0$/, '');
  const labelText = metric.trajectoryLabel.charAt(0).toUpperCase() + metric.trajectoryLabel.slice(1);
  return (
    <>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 31 }}>
        <Pill tone="gray">{labelText}</Pill>
        {direction != null && pct != null ? (
          <span
            aria-label={`${direction} ${pct} percent year over year`}
            style={{ fontSize: 13, fontWeight: 600, color: '#475467', whiteSpace: 'nowrap' }}
          >
            {direction === 'flat' ? 'Flat YoY' : `${direction === 'down' ? '↓' : '↑'} ${pct}% YoY`}
          </span>
        ) : null}
      </span>
      <span style={FOOT_LABEL_STYLE}>Lobbying trajectory</span>
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
          title="Count of matched federal contract awards"
        />
      ),
    },
    { label: 'Lobbying trajectory', cell: <TrajectoryCell metric={fp.lobbyingTrajectory} /> },
  ];
  const cellStyle = (i: number) =>
    ({
      flex: 1,
      minWidth: 172,
      padding: '18px 24px 20px',
      boxShadow: i === 0 ? 'none' : 'inset 1px 0 0 #EAECF0',
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
    }) as const;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 18px', borderBottom: '1px solid #EAECF0', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Federal footprint</span>
          <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
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
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {stats.map((s, i) => (
            <span key={s.label} style={cellStyle(i)}>
              <PfSkeleton width={96} height={26} style={{ margin: '2px 0' }} />
              <span style={FOOT_LABEL_STYLE}>{s.label}</span>
            </span>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {stats.map((s, i) => (
            <span key={s.label} style={cellStyle(i)}>
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
      <div style={{ padding: '2px 24px 8px' }}>
        {failed ? (
          <div style={{ padding: '14px 0 18px' }}>
            <RegionErrorLine
              status={{ state: 'error', retry: retryReads }}
              label="Couldn't load this client's submission history"
            />
          </div>
        ) : loading ? (
          [0, 1, 2].map((i) => <AdvocacySkeletonRow key={i} last={i === 2} />)
        ) : genuinelyEmpty ? (
          <p style={{ margin: 0, padding: '10px 0 16px', fontSize: 14, color: '#667085' }}>
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
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '16px 0', borderBottom: last ? 'none' : '1px solid #F2F4F7' }}>
      <span style={{ flex: '0 0 auto', width: 64 }}>
        <PfSkeleton width={40} height={13} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '14px 0', borderTop: '1px solid #F2F4F7' }}>
      <span style={{ flex: '0 0 auto', width: 64, fontSize: 13, fontWeight: 600, color: '#101828' }}>
        {row.fiscalYear}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>
          {row.title}
        </span>
        <span style={{ display: 'block', marginTop: 3, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>
          {[row.capabilityName, row.meta].filter(Boolean).join(' · ') || 'No detail recorded'}
        </span>
        {row.notes ? (
          <span style={{ display: 'block', marginTop: 6, fontSize: 13, lineHeight: '19px', color: '#475467', textWrap: 'pretty' }}>
            {row.notes}
          </span>
        ) : null}
      </span>
      <span style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <Pill tone={tone}>{OUTCOME_TYPE_LABEL[row.outcomeType] ?? row.outcomeType}</Pill>
        {row.outcome ? (
          <span style={{ fontSize: 12, color: '#667085', whiteSpace: 'nowrap' }}>{row.outcome}</span>
        ) : null}
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

const LOG_FIELD = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  height: 40,
  padding: '0 12px',
  borderRadius: 8,
  border: 0,
  outline: 'none',
  background: '#ffffff',
  boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
  fontSize: 14,
  color: '#101828',
} as const;

const LOG_LABEL = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: '#667085',
} as const;

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label>
          <span style={LOG_LABEL}>Capability</span>
          <select
            value={capabilityId}
            aria-label="Capability"
            onChange={(e) => setCapabilityId(e.target.value)}
            style={LOG_FIELD}
          >
            {capabilities.map((capability) => (
              <option key={capability.id} value={capability.id}>
                {capability.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ flex: '0 0 120px' }}>
            <span style={LOG_LABEL}>Fiscal year</span>
            <input
              value={fiscalYear}
              aria-label="Fiscal year"
              onChange={(e) => setFiscalYear(e.target.value)}
              placeholder="FY27"
              style={LOG_FIELD}
            />
          </label>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={LOG_LABEL}>Title</span>
            <input
              value={title}
              aria-label="Title"
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What was asked for"
              style={LOG_FIELD}
            />
          </label>
        </div>
        <label>
          <span style={LOG_LABEL}>Detail</span>
          <input
            value={meta}
            aria-label="Detail"
            onChange={(e) => setMeta(e.target.value)}
            placeholder="Vehicle, committee, who it went to"
            style={LOG_FIELD}
          />
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <label style={{ flex: 1, minWidth: 0 }}>
            <span style={LOG_LABEL}>Outcome</span>
            <input
              value={outcome}
              aria-label="Outcome"
              onChange={(e) => setOutcome(e.target.value)}
              placeholder="e.g. Included +$8M"
              style={LOG_FIELD}
            />
          </label>
          <label style={{ flex: '0 0 160px' }}>
            <span style={LOG_LABEL}>Status</span>
            <select
              value={outcomeType}
              aria-label="Status"
              onChange={(e) => setOutcomeType(e.target.value as SubmissionOutcomeType)}
              style={LOG_FIELD}
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
          <span style={LOG_LABEL}>Notes</span>
          <textarea
            value={notes}
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Provenance — what is on file for this"
            style={{ ...LOG_FIELD, height: 'auto', padding: '10px 12px', resize: 'vertical' }}
          />
        </label>
        {error ? (
          <p style={{ margin: 0, fontSize: 14, color: '#B42318' }}>
            {error instanceof Error ? error.message : 'Could not log that submission'}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: 8 }}>
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
      <span style={{ flex: 1, minWidth: 104, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: '#98A2B3', lineHeight: 1.2 }} title={metric.reason}>—</span>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>{label}</span>
      </span>
    );
  }
  return (
    <span style={{ flex: 1, minWidth: 104, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828', lineHeight: 1.2 }}>{metric.value}</span>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>{label}</span>
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
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} style={{ flex: 1, minWidth: 104, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
  return <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>{children}</div>;
}

function WorkPulseCard({ model, onOpenWork }: { model: ClientCrmOverviewModel; onOpenWork?: () => void }) {
  const { work, workStatus } = model;
  return (
    <Card>
      <CardHead
        title="Work pulse"
        action={
          <PfButton variant="link" onClick={onOpenWork} disabled={!onOpenWork}>
            Open work
          </PfButton>
        }
      />
      <div style={{ padding: 24 }}>
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
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #EAECF0', fontSize: 13, lineHeight: '19px', color: '#667085', textWrap: 'pretty' }}>
            {work.nextStep ?? work.readinessReason}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function IntelligencePulseCard({
  model,
  onOpenIntelligence,
}: {
  model: ClientCrmOverviewModel;
  onOpenIntelligence?: () => void;
}) {
  const { intelligence, intelligenceStatus } = model;
  return (
    <Card>
      <CardHead
        title="Intelligence pulse"
        action={
          <PfButton variant="link" onClick={onOpenIntelligence} disabled={!onOpenIntelligence}>
            Open intelligence
          </PfButton>
        }
      />
      <div style={{ padding: 24 }}>
        <PulseBody status={intelligenceStatus} errorLabel="Couldn't load this client's intelligence pulse">
          <MetricCell metric={intelligence.trackedBills} label="Tracked bills" />
          <MetricCell metric={intelligence.opportunities} label="Opportunities" />
          <MetricCell metric={intelligence.districts} label="Districts" />
          <MetricCell metric={intelligence.regulatoryMatters} label="Regulatory matters" />
        </PulseBody>
        {intelligenceStatus.state === 'ready' && intelligence.signals.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 24, paddingTop: 20, borderTop: '1px solid #EAECF0', flexWrap: 'wrap' }}>
            {intelligence.signals.map((signal, i) => (
              <Pill key={signal} tone={i === 0 ? 'error' : i === 1 ? 'brand' : 'gray'} dotless={i === 2} size="lg">
                {signal}
              </Pill>
            ))}
          </div>
        ) : null}
        {intelligenceStatus.state === 'ready' && intelligence.lastRefresh ? (
          <div style={{ marginTop: 16, fontSize: 13, color: '#667085' }}>
            {`Last intelligence refresh: ${intelligence.lastRefresh}`}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
