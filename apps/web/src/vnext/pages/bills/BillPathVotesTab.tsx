import { fmtDate } from '../../../components/dossier/dossier-format.js';
import type {
  BillVote,
  GoverningRule,
  LegislativeMilestone,
  VotePartyBreakdown,
  VoteTarget,
} from '../../../pages/bills/bill-360.types.js';
import { EventTimeline, GavelIcon, InfoIcon, Pill } from './dossier-primitives.js';

/**
 * Path & votes tab — vNext re-skin of pages/bills/BillPathVotesTab.tsx: the
 * legislative-path timeline, the governing-rule callout (with the
 * controls-status badge), the recorded-vote cards with party bars, and the
 * explicit "no roll call" statement.
 */

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
    <div className="b360-party">
      {rows.map((r) => {
        const t = r.yea + r.nay || 1;
        return (
          <div className="b360-party-row" key={r.label}>
            <span className="b360-party-label">{r.label}</span>
            <div className="b360-bar-track">
              <span className="b360-bar-yea" style={{ width: `${((r.yea / t) * 100).toFixed(0)}%` }} />
              <span className="b360-bar-nay" style={{ width: `${((r.nay / t) * 100).toFixed(0)}%` }} />
            </div>
            <span className="b360-party-tally">
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
    <div className="b360-path">
      {milestones.length ? (
        <div className="b360-card b360-card--roomy">
          <div className="b360-section-label b360-section-label--timeline">Legislative path</div>
          <EventTimeline milestones={milestones} />
        </div>
      ) : null}

      {governingRules.length ? (
        <div className="b360-rule-callout">
          {governingRules.map((r) => (
            <div key={r.id}>
              <div className="b360-rule-head">
                <span className="b360-rule-gavel">
                  <GavelIcon />
                </span>
                <span className="b360-rule-label">{r.label}</span>
                <Pill sev={r.resultSev}>Rule {r.result ?? '—'}</Pill>
                <span className="b360-rule-tally">{r.tally}</span>
                {r.controls ? <span className="b360-controls-badge">Controls status</span> : null}
              </div>
              {r.desc || r.date ? (
                <div className="b360-rule-desc">
                  {[r.desc, fmtDate(r.date)].filter(Boolean).join(' · ')}
                </div>
              ) : null}
              {r.note ? <div className="b360-rule-note">{r.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {votes.length ? (
        <div className="b360-card b360-card--roomy">
          <div className="b360-section-label b360-section-label--votes">Recorded votes</div>
          {votes.map((vt) => (
            <div className="b360-vote-card" key={vt.id}>
              <div className="b360-vote-head">
                <span className="b360-vote-target">{voteTargetLabel(vt.target)}</span>
                <span className="b360-vote-label">{vt.label}</span>
                <Pill sev={vt.resultSev}>{vt.result ?? '—'}</Pill>
                <span className="b360-vote-tally">{vt.tally}</span>
              </div>
              {vt.party ? <PartyBars party={vt.party} /> : null}
              {vt.note ? <div className="b360-vote-note">{vt.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {noVote ? (
        <div className="b360-novote">
          <span className="b360-novote-icon">
            <InfoIcon />
          </span>
          <span className="b360-novote-text">{noVote}</span>
        </div>
      ) : null}
    </div>
  );
}
