import { Skeleton, Tag, Tooltip } from 'antd';
import { DrillSection } from '../explorer/bill-detail.js';
import { useChokepoint, type ChokepointMember, type ChokepointResult } from './chokepoint-api.js';

/**
 * Committee Chokepoint section (Phase 1 M2.5, PD3) — "who actually controls
 * this bill's fate," slotted into the bill detail drawer via BillDrawer's
 * `extra` prop (both rails). Ranked-list-style, not a map (no map lib in the
 * web app — the plan's own M2.5 scoping). Every row is either a real,
 * deterministic resolution or an explicit "not shown" — never a fuzzy guess.
 */
const BAND_COLOR: Record<string, string> = {
  stalled: 'red',
  'at-risk': 'orange',
  'likely-advances': 'green',
};
const BAND_LABEL: Record<string, string> = {
  stalled: 'Stalled',
  'at-risk': 'At risk',
  'likely-advances': 'Likely advances',
};

function MemberRow({ member, why }: { member: ChokepointMember; why: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12.5 }}>
      <span style={{ fontWeight: 600 }}>{member.name}</span>
      {member.party ? <span style={{ color: 'var(--ink-3)' }}>({member.party})</span> : null}
      <span style={{ color: 'var(--ink-3)' }}>— {why}</span>
    </div>
  );
}

function CutoffLabel(cutoffType: string): string {
  switch (cutoffType) {
    case 'committeeCutoff':
      return 'committee cutoff';
    case 'crossover':
      return 'crossover day';
    case 'secondCommitteeCutoff':
      return 'second-chamber committee cutoff';
    case 'sineDie':
      return 'sine die';
    default:
      return cutoffType;
  }
}

function ChokepointBody({ data }: { data: ChokepointResult }) {
  const rows: Array<{ member: ChokepointMember; why: string }> = [];
  if (data.chair) {
    rows.push({
      member: data.chair,
      why: data.referredCommittee ? `Chairs ${data.referredCommittee.name}` : 'Committee chair',
    });
  }
  if (data.rankingMember)
    rows.push({ member: data.rankingMember, why: 'Ranking member on the referred committee' });
  if (data.viceChair)
    rows.push({ member: data.viceChair, why: 'Vice chair on the referred committee' });
  if (data.chamberLeadership && data.chamberLeadership.id !== data.chair?.id) {
    rows.push({
      member: data.chamberLeadership,
      why: 'Rules/Calendars leadership for this chamber',
    });
  }
  if (data.sponsor && data.sponsor.id && data.sponsor.id !== data.chair?.id) {
    rows.push({ member: data.sponsor, why: 'Sponsor' });
  }

  const risks: string[] = [];
  if (data.rulesGate === 'failed') risks.push('The governing rule FAILED — stalled on the floor.');
  else if (data.rulesGate === 'pending')
    risks.push('A governing rule has been filed but not yet resolved.');
  if (data.deadlineRisk && !data.deadlineRisk.isPastCutoff) {
    risks.push(
      `${data.deadlineRisk.daysUntil} day(s) until its ${CutoffLabel(data.deadlineRisk.cutoffType)} (${data.deadlineRisk.cutoffDate}).`,
    );
  }
  if (data.companionStatus) {
    risks.push(
      `Companion ${data.companionStatus.relatedDisplay ?? data.companionStatus.relatedBillKey}: ${data.companionStatus.status ?? 'unknown status'}.`,
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {data.survivalBand ? (
          <Tooltip
            title={
              data.survivalConfidence === 'low'
                ? 'Partial score — one or more factors could not be resolved.'
                : 'Deterministic weighted score, not ML — see the chokepoint doc for the factor breakdown.'
            }
          >
            <Tag color={BAND_COLOR[data.survivalBand]}>
              {BAND_LABEL[data.survivalBand]}
              {data.survivalConfidence === 'low' ? ' (low confidence)' : ''}
              {typeof data.survivalScore === 'number' ? ` · ${data.survivalScore.toFixed(2)}` : ''}
            </Tag>
          </Tooltip>
        ) : (
          <Tag>Survival band not resolvable</Tag>
        )}
        {!data.referredCommittee && <Tag>Committee referral unmatched — chair not shown</Tag>}
      </div>

      {rows.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <MemberRow key={r.member.id} member={r.member} why={r.why} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
          No chokepoint members resolvable for this bill.
        </div>
      )}

      {risks.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {risks.map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {r}
            </div>
          ))}
        </div>
      ) : null}

      {data.footprintOverlap.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-3)' }}>
            Your footprint
          </span>
          {data.footprintOverlap.map((f, i) => (
            <div key={i} style={{ fontSize: 12 }}>
              <b>{f.memberName}</b> ({f.memberRole}) represents a district containing{' '}
              <b>{f.facilityName}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChokepointSection({ billId, clientId }: { billId: string; clientId?: string }) {
  const query = useChokepoint(billId, clientId);
  if (query.isLoading) {
    return (
      <DrillSection title="Chokepoint">
        <Skeleton active paragraph={{ rows: 3 }} />
      </DrillSection>
    );
  }
  if (!query.data) return null;
  return (
    <DrillSection title="Chokepoint">
      <ChokepointBody data={query.data} />
    </DrillSection>
  );
}

export default ChokepointSection;
