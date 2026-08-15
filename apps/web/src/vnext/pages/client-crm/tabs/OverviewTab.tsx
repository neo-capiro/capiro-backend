import { useMemo, useState } from 'react';
import {
  Avatar,
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
import { ADVOCACY, FOOT_STATS, LIFE } from '../portfolio-fixtures.js';
import {
  useClientCrmOverviewModel,
  type ClientCrmOverviewModel,
  type Metric,
} from '../../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Overview tab (spec §6). Order: profile+account → federal footprint →
 * advocacy history → work+intelligence pulse. §16: NO "Needs attention" card.
 *
 * Data: profile/account/work/intel pulse bind to the real overview model.
 * Federal footprint and the advocacy lifecycle have no per-client backend
 * lifecycle records — they render the design's fixtures (flagged UI-only).
 */

export function ClientCrmOverviewProto({ client, onEditProfile }: { client: Client; onEditProfile?: () => void }) {
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
        <AccountCard model={model} />
      </div>

      {/* federal footprint (§6.2) */}
      <FederalFootprintCard />

      {/* advocacy history (§6.3) */}
      <AdvocacyHistoryCard />

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

function AccountCard({ model }: { model: ClientCrmOverviewModel }) {
  const { account } = model;
  const briefLabel = account.briefState === 'ready' ? 'Brief ready' : account.briefState === 'none' ? 'No brief yet' : 'No meeting scheduled';
  return (
    <Card>
      <CardHead title="Account" action={<LinkBtn>Manage team</LinkBtn>} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 24px', padding: 24 }}>
        <Field label="Account owner" value={account.accountOwner ?? 'Not tracked'} empty={!account.accountOwner} />
        <Field label="Primary contact" value={account.primaryContact ?? 'Not set'} empty={!account.primaryContact} link={Boolean(account.primaryContact)} />
        <Field label="Next meeting" value={account.nextMeeting?.label ?? 'None scheduled'} empty={!account.nextMeeting} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Account team</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <span style={{ display: 'flex' }}>
              {['SM', 'JC', 'AR'].map((init, i) => (
                <Avatar key={init} initials={init} size={28} overlap={i > 0} dark />
              ))}
            </span>
            <Pill tone="success">{briefLabel}</Pill>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Field({ label, value, empty = false, link = false }: { label: string; value: string; empty?: boolean; link?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{label}</div>
      {link ? (
        <button
          type="button"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ marginTop: 4, fontSize: 16, fontWeight: 500, color: hover ? '#0E141C' : '#101828' }}
        >
          {value}
        </button>
      ) : (
        <div style={{ marginTop: 4, fontSize: 16, fontWeight: 500, color: empty ? '#98A2B3' : '#101828' }}>{value}</div>
      )}
    </div>
  );
}

/* ── §6.2 Federal footprint ───────────────────────────────────────────────── */

function FederalFootprintCard() {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '20px 24px 18px', borderBottom: '1px solid #EAECF0', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 240 }}>
          <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Federal footprint</span>
          <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
            The public record: lobbying disclosures, federal awards, political giving, and the districts this client sits in.
          </span>
        </span>
        <LinkBtn>Open federal footprint →</LinkBtn>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {FOOT_STATS.map((f, i) => (
          <span
            key={f.label}
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
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828', lineHeight: 1.2 }}>{f.value}</span>
              {f.delta ? (
                <span style={{ fontSize: 12, fontWeight: 600, color: f.up ? '#027A48' : '#667085', whiteSpace: 'nowrap' }}>{f.delta}</span>
              ) : null}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>
              {f.label}
            </span>
          </span>
        ))}
      </div>
      <CardFoot
        left="3 active registrants · latest filing 2026 Q2 · LD-2"
        right="8 districts mapped · WA-07 and WA-08 strongest"
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

function AdvocacyHistoryCard() {
  // Default open record: FY27 · Autonomous logistics pilot (v2). §6.3 accordion.
  const [openId, setOpenId] = useState<string | null>('v2');

  return (
    <Card>
      <CardHead
        withDesc
        title="Advocacy history"
        description="What this client asked for, the vehicle it moved through, and what happened. Open a record to see its evidence trail."
        action={<SecondaryBtn>Log a submission</SecondaryBtn>}
      />
      <div style={{ padding: '2px 24px 8px' }}>
        {ADVOCACY.map((rec, i) => {
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
        })}
      </div>
      <CardFoot left="6 records · 3 public · 2 client-verified · 1 inferred" right={<LinkBtn>Evidence classes and full history →</LinkBtn>} />
    </Card>
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
