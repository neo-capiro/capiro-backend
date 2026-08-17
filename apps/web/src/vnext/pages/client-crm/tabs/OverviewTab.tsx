import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  CardFoot,
  CardHead,
  EvidenceChip,
  FitChip,
  MilestoneTrack,
  Pill,
  TabPageHead,
  Tile,
  TimelineRail,
  type MilestoneStep,
  type MilestoneState,
  type PillTone,
} from '../portfolio-primitives.js';
import { ADVOCACY, LIFE } from '../portfolio-fixtures.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import type { Capability } from '../../../../pages/clients/CapabilityDrawer.js';
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
 * The advocacy lifecycle has no per-client backend lifecycle records — it
 * renders real submission history when available, and the design's fixtures
 * only while loading or on error (flagged UI-only).
 */

export function ClientCrmOverviewProto({
  client,
  onEditProfile,
  onOpenFederalFootprint,
}: {
  client: Client;
  onEditProfile?: () => void;
  onOpenFederalFootprint?: () => void;
}) {
  const model = useClientCrmOverviewModel(client);
  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead
        title="Client overview"
        sub="The account, its federal footprint, and the advocacy record behind it."
        actions={
          <SecondaryBtn onClick={onEditProfile} disabled={!onEditProfile}>
            Edit profile
          </SecondaryBtn>
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
        <WorkPulseCard model={model} />
        <IntelligencePulseCard model={model} />
      </div>
    </div>
  );
}

/* ── shared small buttons ─────────────────────────────────────────────────── */

function SecondaryBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 40,
        padding: '0 16px',
        borderRadius: 8,
        background: hover ? '#F9FAFB' : '#ffffff',
        color: hover ? '#101828' : '#344054',
        fontSize: 14,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        boxShadow: 'inset 0 0 0 1px #D0D5DD,0px 1px 2px rgba(16,24,40,.05)',
      }}
    >
      {children}
    </button>
  );
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ fontSize: 14, fontWeight: 600, color: hover ? '#0E141C' : '#101828', whiteSpace: 'nowrap' }}
    >
      {children}
    </button>
  );
}

/* ── §6.1 Client profile ──────────────────────────────────────────────────── */

function ProfileCard({ model, onEditProfile }: { model: ClientCrmOverviewModel; onEditProfile?: () => void }) {
  const { profile } = model;
  return (
    <Card>
      <CardHead title="Client profile" action={<LinkBtn onClick={onEditProfile}>Edit</LinkBtn>} />
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
  const { account } = model;
  const briefLabel = account.briefState === 'ready' ? 'Brief ready' : account.briefState === 'none' ? 'No brief yet' : 'No meeting scheduled';
  const contactEmail = client.primaryContactEmail;
  return (
    <Card>
      {/* Row 7, wire-audit "4 New capability": there is no per-client
          account-team roster API — `accountTeam` is hardcoded empty in the
          overview model. The real, existing destination is the firm's team
          settings, so the link says that rather than implying a client roster
          this product does not store. */}
      <CardHead
        title="Account"
        action={<LinkBtn onClick={() => navigate('/settings/team')}>Firm team settings</LinkBtn>}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 24px', padding: 24 }}>
        <Field label="Account owner" value={account.accountOwner ?? 'Not tracked'} empty={!account.accountOwner} />
        <Field
          label="Primary contact"
          value={account.primaryContact ?? 'Not set'}
          empty={!account.primaryContact}
          href={contactEmail ? `mailto:${contactEmail}` : undefined}
        />
        <Field label="Next meeting" value={account.nextMeeting?.label ?? 'None scheduled'} empty={!account.nextMeeting} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Account team</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            {/* Wire-audit "3 Compose extend" item 3: no per-client team roster
                exists, so the hardcoded fixture avatars (SM, JC, AR) are
                replaced with an honest empty state that links to the real
                team settings. */}
            <span style={{ fontSize: 14, color: '#98A2B3' }}>No roster</span>
            <Pill tone="success">{briefLabel}</Pill>
          </div>
        </div>
      </div>
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

/**
 * Wire-audit "3 Compose extend" item 3: federal footprint now reads from the
 * real client-profile endpoint (LDA spend, filings, federal awards, lobbying
 * trajectory) via the overview model's `federalFootprint`. Each slot is a
 * `Metric` — real value or `unavailable` — so missing data renders as `—`
 * rather than a fixture number.
 */
function FootCell({ metric, label }: { metric: Metric; label: string }) {
  const display =
    metric.kind === 'value'
      ? label === 'Lobbying · TTM'
        ? `$${metric.value.toLocaleString()}`
        : metric.value.toLocaleString()
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
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>
        {label}
      </span>
    </>
  );
}

function FederalFootprintCard({ model, onOpen }: { model: ClientCrmOverviewModel; onOpen?: () => void }) {
  const fp: FederalFootprint = model.federalFootprint;
  const stats = [
    { metric: fp.ldaSpend, label: 'Lobbying · TTM' },
    { metric: fp.ldaFilings, label: 'LD-2 filings' },
    { metric: fp.federalAwards, label: 'Federal awards' },
    { metric: fp.lobbyingTrajectory, label: 'Lobbying trajectory' },
  ];
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 18px', borderBottom: '1px solid #EAECF0', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Federal footprint</span>
          <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
            The public record: lobbying disclosures, federal awards, political giving, and the districts this client sits in.
          </span>
        </span>
        <LinkBtn onClick={onOpen}>Open federal footprint →</LinkBtn>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {stats.map((s, i) => (
          <span
            key={s.label}
            style={{
              flex: 1,
              minWidth: 172,
              padding: '18px 24px 20px',
              boxShadow: i === 0 ? 'none' : 'inset 1px 0 0 #EAECF0',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            <FootCell metric={s.metric} label={s.label} />
          </span>
        ))}
      </div>
      <CardFoot
        left={fp.registrantsLabel ?? 'No LDA registrants matched'}
        right="District mapping via facilities"
      />
    </Card>
  );
}

/* ── §6.3 Advocacy history ────────────────────────────────────────────────── */

const ADV_TONE: Record<string, PillTone> = {
  gray: 'gray',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  error: 'error',
};
const ADV_TIER: Record<string, 'Public record' | 'Client-verified' | 'Inferred'> = {
  lda: 'Public record',
  amend: 'Public record',
  cpf: 'Public record',
  client: 'Client-verified',
  inferred: 'Inferred',
};

/**
 * §6.3 Advocacy history.
 *
 * What is real (wire-audit "4 New capability" row 6): the client's
 * `ClientSubmissionHistory` rows — fiscal year, title, meta, outcome and its
 * coarse type — and "Log a submission", which POSTs a new one against a
 * capability. When those rows exist they replace the ADVOCACY fixture.
 *
 * What is NOT real, and is therefore never rendered against live records (rows
 * 1 and 5): the lifecycle/milestone track and the evidence taxonomy
 * (public-record / client-verified / inferred). Neither has any field, table or
 * endpoint in this codebase — `ClientSubmissionHistory` carries no vehicle, no
 * activity type, no evidence class and no per-step timeline. The design's
 * accordion, its LIFE tracks and its "6 records · 3 public · 2 client-verified
 * · 1 inferred" footer render only in the fixture state.
 */
function AdvocacyHistoryCard({ client }: { client: Client }) {
  const api = useApi();
  const qc = useQueryClient();
  const { rows, capabilities, settled, failed } = useClientSubmissions(client.id);
  const [logging, setLogging] = useState(false);
  // Default open record: FY27 · Autonomous logistics pilot (v2). §6.3 accordion.
  const [openId, setOpenId] = useState<string | null>('v2');

  const showFixture = !settled || failed;
  const genuinelyEmpty = settled && !failed && rows.length === 0;

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
          <SecondaryBtn
            onClick={() => setLogging(true)}
            disabled={capabilities.length === 0}
          >
            Log a submission
          </SecondaryBtn>
        }
      />
      <div style={{ padding: '2px 24px 8px' }}>
        {genuinelyEmpty ? (
          <p style={{ margin: 0, padding: '10px 0 16px', fontSize: 14, color: '#667085' }}>
            {capabilities.length === 0
              ? 'No submissions recorded yet. Add a capability first — a submission is recorded against one.'
              : 'No submissions recorded for this client yet.'}
          </p>
        ) : showFixture ? (
          ADVOCACY.map((rec, i) => {
            const open = openId === rec.id;
            const steps = (LIFE as Record<string, Array<{ label: string; date: string; st: string }>>)[rec.id] ?? [];
            const live = rec.outcome === 'Pending' || steps.some((s) => s.st === 'current');
            return (
              <AdvocacyRow
                key={rec.id}
                rec={rec}
                steps={steps}
                open={open}
                live={live}
                first={i === 0}
                last={i === ADVOCACY.length - 1}
                onToggle={() => setOpenId(open ? null : rec.id)}
              />
            );
          })
        ) : (
          rows.map((row) => <SubmissionHistoryRowView key={row.id} row={row} />)
        )}
      </div>
      {/* The evidence-class breakdown is a fixture statistic — a submission has
          no evidence class — so it is shown only alongside the fixture, never
          as a claim about the client's real rows. */}
      {showFixture ? (
        <CardFoot left="6 records · 3 public · 2 client-verified · 1 inferred" right={<span />} />
      ) : rows.length > 0 ? (
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

function AdvocacyRow({
  rec,
  steps,
  open,
  live,
  first,
  last,
  onToggle,
}: {
  rec: (typeof ADVOCACY)[number];
  steps: Array<{ label: string; date: string; st: string }>;
  open: boolean;
  live: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const milestoneSteps: MilestoneStep[] = steps.map((s) => ({
    label: s.label,
    date: s.date,
    state: s.st as MilestoneState,
  }));

  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
      <TimelineRail live={live} first={first} last={last} />
      <div style={{ flex: 1, minWidth: 0, boxShadow: last ? 'none' : 'inset 0 -1px 0 #EAECF0' }}>
        <button
          type="button"
          onClick={onToggle}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            display: 'flex',
            width: '100%',
            alignItems: 'center',
            gap: 14,
            padding: '14px 8px 14px 0',
            textAlign: 'left',
            borderRadius: 8,
            background: hover ? '#FCFCFD' : 'transparent',
          }}
        >
          <span style={{ flex: '0 0 auto', width: 44, fontSize: 13, fontWeight: 600, letterSpacing: '.03em', color: '#101828' }}>{rec.fy}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {rec.ask}
            </span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {`${rec.vehicle} · ${rec.activity} · ${rec.meta}`}
            </span>
          </span>
          <Pill tone={ADV_TONE[rec.oui] ?? 'gray'}>{rec.outcome}</Pill>
          <EvidenceChip tier={ADV_TIER[rec.ev] ?? 'Public record'} label={rec.evLabel} />
          <span style={{ flex: '0 0 auto', width: 16, fontSize: 12, color: '#98A2B3', textAlign: 'center' }}>{open ? '▾' : '▸'}</span>
        </button>
        {open ? (
          <div style={{ padding: '2px 0 20px' }}>
            <MilestoneTrack steps={milestoneSteps} nodeSize={18} />
            <p style={{ margin: '14px 0 0', maxWidth: 840, fontSize: 13, lineHeight: '19px', color: '#475467', textWrap: 'pretty' }}>{rec.note}</p>
          </div>
        ) : null}
      </div>
    </div>
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

function WorkPulseCard({ model }: { model: ClientCrmOverviewModel }) {
  const { work } = model;
  return (
    <Card>
      <CardHead title="Work pulse" action={<LinkBtn>Open work</LinkBtn>} />
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <MetricCell metric={work.currentStrategies} label="Strategies" />
          <MetricCell metric={work.remainingActions} label="Plan steps" />
          <MetricCell metric={work.upcomingMilestones} label="Next 30 days" />
          <MetricCell metric={work.openRisk} label="Open risks" />
        </div>
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #EAECF0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Client work readiness</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>
              {work.readiness == null ? '—' : `${Math.round(work.readiness * 100)}%`}
            </span>
          </div>
          <span style={{ display: 'block', marginTop: 10, height: 8, borderRadius: 4, background: '#F2F4F7', overflow: 'hidden' }}>
            <span
              style={{
                display: 'block',
                height: 8,
                width: work.readiness == null ? '0%' : `${Math.round(work.readiness * 100)}%`,
                borderRadius: 4,
                background: 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)',
              }}
            />
          </span>
          {work.nextStep ? <div style={{ marginTop: 16, fontSize: 14, color: '#475467' }}>{work.nextStep}</div> : null}
        </div>
      </div>
    </Card>
  );
}

function IntelligencePulseCard({ model }: { model: ClientCrmOverviewModel }) {
  const { intelligence } = model;
  return (
    <Card>
      <CardHead title="Intelligence pulse" action={<LinkBtn>Open intelligence</LinkBtn>} />
      <div style={{ padding: 24 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <MetricCell metric={intelligence.trackedBills} label="Tracked bills" />
          <MetricCell metric={intelligence.opportunities} label="Opportunities" />
          <MetricCell metric={intelligence.districts} label="Districts" />
          <MetricCell metric={intelligence.regulatoryMatters} label="Regulatory matters" />
        </div>
        {intelligence.signals.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 24, paddingTop: 20, borderTop: '1px solid #EAECF0', flexWrap: 'wrap' }}>
            {intelligence.signals.map((signal, i) => (
              <Pill key={signal} tone={i === 0 ? 'error' : i === 1 ? 'brand' : 'gray'} dotless={i === 2} size="lg">
                {signal}
              </Pill>
            ))}
          </div>
        ) : null}
        <div style={{ marginTop: 16, fontSize: 14, color: '#475467' }}>
          {intelligence.lastRefresh ? `Last intelligence refresh: ${intelligence.lastRefresh}` : 'Source refresh time is not reported by these services.'}
        </div>
      </div>
    </Card>
  );
}
