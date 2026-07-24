import { InfoCircleOutlined } from '@ant-design/icons';
import { Pill } from '../../components/dossier/EvidenceBadge.js';
import { EventTimeline } from '../../components/dossier/EventTimeline.js';
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { BillVote, GoverningRule, LegislativeMilestone, VotePartyBreakdown, VoteTarget } from './bill-360.types.js';

function GavelIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 13l-7.5 7.5a2.1 2.1 0 0 1-3-3L11 10" />
      <path d="M9.5 7.5l7 7" />
      <path d="M13 4l7 7" />
      <path d="M16 3l5 5" />
      <path d="M11 6l5 5" />
    </svg>
  );
}

function voteTargetLabel(t: VoteTarget): string {
  if (t === 'rule') return 'Governing rule';
  if (t === 'committee') return 'Committee vote';
  return 'Passage vote';
}

function PartyBars({ party }: { party: VotePartyBreakdown }) {
  const rows = [
    { label: 'Majority (R)', yea: party.gopYea, nay: party.gopNay },
    { label: 'Minority (D)', yea: party.demYea, nay: party.demNay },
  ];
  return (
    <div className="dsr-party">
      {rows.map((r) => {
        const t = r.yea + r.nay || 1;
        return (
          <div className="dsr-party-row" key={r.label}>
            <span className="dsr-party-label">{r.label}</span>
            <div className="dsr-bar-track">
              <span className="dsr-bar-yea" style={{ width: `${((r.yea / t) * 100).toFixed(0)}%` }} />
              <span className="dsr-bar-nay" style={{ width: `${((r.nay / t) * 100).toFixed(0)}%` }} />
            </div>
            <span className="dsr-party-tally">
              {r.yea}–{r.nay}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function BillPathVotesTab({
  milestones,
  governingRules,
  votes,
  noVote,
}: {
  milestones: LegislativeMilestone[];
  governingRules: GoverningRule[];
  votes: BillVote[];
  noVote: string | null;
}) {
  return (
    <div className="dsr-path">
      {milestones.length ? (
        <div className="dsr-card" style={{ padding: '17px 18px' }}>
          <div className="dsr-section-label" style={{ marginBottom: 15 }}>
            Legislative path
          </div>
          <EventTimeline milestones={milestones} />
        </div>
      ) : null}

      {governingRules.length ? (
        <div className="dsr-rule-callout">
          {governingRules.map((r) => (
            <div key={r.id}>
              <div className="dsr-rule-head">
                <span className="dsr-rule-gavel">
                  <GavelIcon />
                </span>
                <span className="dsr-rule-label">{r.label}</span>
                <Pill sev={r.resultSev}>Rule {r.result ?? '—'}</Pill>
                <span className="dsr-rule-tally">{r.tally}</span>
                {r.controls ? <span className="dsr-controls-badge">Controls status</span> : null}
              </div>
              {r.desc || r.date ? (
                <div className="dsr-rule-desc">
                  {[r.desc, fmtDate(r.date)].filter(Boolean).join(' · ')}
                </div>
              ) : null}
              {r.note ? <div className="dsr-rule-note">{r.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {votes.length ? (
        <div className="dsr-card" style={{ padding: '17px 18px' }}>
          <div className="dsr-section-label" style={{ marginBottom: 13 }}>
            Recorded votes
          </div>
          {votes.map((vt) => (
            <div className="dsr-vote-card" key={vt.id}>
              <div className="dsr-vote-head">
                <span className="dsr-vote-target">{voteTargetLabel(vt.target)}</span>
                <span className="dsr-vote-label">{vt.label}</span>
                <Pill sev={vt.resultSev}>{vt.result ?? '—'}</Pill>
                <span className="dsr-vote-tally">{vt.tally}</span>
              </div>
              {vt.party ? <PartyBars party={vt.party} /> : null}
              {vt.note ? <div className="dsr-vote-note">{vt.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {noVote ? (
        <div className="dsr-novote">
          <span style={{ color: 'var(--ink-3)', flexShrink: 0 }}>
            <InfoCircleOutlined />
          </span>
          <span className="dsr-novote-text">{noVote}</span>
        </div>
      ) : null}
    </div>
  );
}
