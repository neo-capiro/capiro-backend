import { MeriRetrievalCoverage } from './MeriRetrievalCoverage.js';
import { meriCoverageReason } from '../../components/chat/meri-retrieval-metadata.js';
import type { ChatMessageRetrieval, GroundingCaveat } from '../../components/chat/chat-store.js';
import { MeriIcon } from './meri-icons.js';
import { MeriPanelState } from './MeriPanelState.js';
import { coverageWarningTone } from './MeriCoverageWarning.js';
import type {
  MeriEvidenceClaim,
  MeriEvidenceSource,
  MeriEvidenceStat,
} from './MeriEvidenceTray.js';

/**
 * MeriEvidenceTab — v6 turn inspector, Evidence tab. Merges what
 * MeriEvidenceTray renders as two separate tabs (SOURCES, VERIFICATION) into
 * one, and folds in the two warning banners that mount separately beneath an
 * answer today (MeriGroundingWarning, MeriCoverageWarning) as a single
 * notice at the top of this tab. Both of those components stay exactly as
 * they are — this is new, independent markup carrying the same copy and
 * tone logic, not a refactor of them.
 *
 * CONTEXT USED is deliberately not included: that content already lives in
 * the rail's own Context tab, so repeating it here would be a second,
 * divergeable copy of the same packet.
 *
 * `groundingCaveat`/`retrieval` are the raw message fields (chat-store.ts
 * shapes), not pre-mapped view models — the mapping VNextMeriMessage.tsx
 * does today (findings -> items) happens locally below, mirroring that
 * exact logic so the two surfaces read findings the same way.
 */

function domainLabel(domain: string): string {
  return domain.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * `coverage.stopReason` is a fixed server enum (`complete` | `partial` |
 * `no-retrieval-required`), not a sentence — render its meaning, not the
 * raw code. Mirrors MeriCoverageWarning's stopReasonCopy.
 */
function coverageStopReasonCopy(stopReason: string): string | null {
  return stopReason === 'complete' ? null : meriCoverageReason(stopReason);
}

export interface MeriEvidenceTabProps {
  sources: MeriEvidenceSource[];
  verifyStats: MeriEvidenceStat[];
  claims: MeriEvidenceClaim[];
  groundingCaveat: GroundingCaveat | null;
  retrieval: ChatMessageRetrieval | null;
  onOpenSource?: (source: MeriEvidenceSource, index: number) => void;
}

export function MeriEvidenceTab({
  sources,
  verifyStats,
  claims,
  groundingCaveat,
  retrieval,
  onOpenSource,
}: MeriEvidenceTabProps) {
  const groundingItems = groundingCaveat?.findings ?? [];
  const coverageTone = retrieval ? coverageWarningTone(retrieval) : null;
  const hasAnything =
    sources.length > 0 ||
    verifyStats.length > 0 ||
    claims.length > 0 ||
    groundingItems.length > 0 ||
    Boolean(retrieval);

  if (!hasAnything) {
    return (
      <div className="vnext-meri__evidence-tab-body">
        <MeriPanelState tone="empty">No evidence was recorded for this turn.</MeriPanelState>
      </div>
    );
  }

  const missing = retrieval?.coverage.missingDomains ?? [];
  const partial = retrieval?.coverage.partialDomains ?? [];
  const searched = retrieval?.coverage.searchedDomains ?? [];
  const stopReasonNote = retrieval ? coverageStopReasonCopy(retrieval.coverage.stopReason) : null;

  return (
    <div className="vnext-meri__evidence-tab-body">
      {groundingItems.length > 0 ? (
        <div className="vnext-meri__evidence-warning" role="alert" data-tone="warning">
          <div className="vnext-meri__evidence-warning-head">
            <MeriIcon name="AlertTriangle" size={15} />
            <span className="vnext-meri__evidence-warning-title">
              Meri flagged a possible grounding issue — verify before relying on it.
            </span>
          </div>
          <div className="vnext-meri__evidence-warning-items">
            {groundingItems.map((finding, index) => (
              <div key={`${finding.check}-${index}`} className="vnext-meri__evidence-warning-item">
                <div className="vnext-meri__evidence-warning-item-kind">
                  {finding.check.replace(/_/g, ' ').toUpperCase()}
                </div>
                <div className="vnext-meri__evidence-warning-item-text">{finding.detail}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {coverageTone && retrieval ? (
        <div className="vnext-meri__evidence-warning" role="status" data-tone={coverageTone}>
          <div className="vnext-meri__evidence-warning-head">
            <MeriIcon
              name={coverageTone === 'missing' ? 'AlertCircle' : 'AlertTriangle'}
              size={14}
            />
            <span className="vnext-meri__evidence-warning-label">
              {coverageTone === 'missing' ? 'REQUIRED SOURCE MISSING' : 'PARTIAL COVERAGE'}
            </span>
          </div>
          {missing.length ? (
            <div className="vnext-meri__evidence-warning-body">
              Not searched: {missing.map(domainLabel).join(', ')}.
            </div>
          ) : null}
          {partial.length ? (
            <div className="vnext-meri__evidence-warning-body">
              Incomplete results: {partial.map(domainLabel).join(', ')}.
            </div>
          ) : null}
          {searched.length ? (
            <div className="vnext-meri__evidence-warning-meta">
              SEARCHED · {searched.map(domainLabel).join(' · ').toUpperCase()}
            </div>
          ) : null}
          {stopReasonNote ? (
            <div className="vnext-meri__evidence-warning-note">{stopReasonNote}</div>
          ) : null}
        </div>
      ) : null}

      {retrieval ? <MeriRetrievalCoverage retrieval={retrieval} /> : null}

      {sources.length > 0 ? (
        <div className="vnext-meri__evidence-section">
          <div className="vnext-meri__evidence-section-label">SOURCES · {sources.length}</div>
          <div className="vnext-meri__evidence-source-list">
            {sources.map((source, index) => (
              <button
                type="button"
                key={`${source.locator}-${index}`}
                className="vnext-meri__evidence-source-row"
                onClick={() => onOpenSource?.(source, index)}
              >
                <span className="vnext-meri__evidence-source-tile">
                  <MeriIcon name={source.icon} size={13} />
                </span>
                <span className="vnext-meri__evidence-source-body">
                  <span className="vnext-meri__evidence-source-meta">
                    <span className="vnext-meri__evidence-source-provider">{source.provider}</span>
                    <span className="vnext-meri__evidence-source-date">{source.date}</span>
                  </span>
                  <span className="vnext-meri__evidence-source-title">
                    [{index + 1}] {source.title}
                  </span>
                  <span className="vnext-meri__evidence-source-snippet">{source.snippet}</span>
                </span>
                <span className="vnext-meri__evidence-source-locator">{source.locator}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {verifyStats.length > 0 || claims.length > 0 ? (
        <div className="vnext-meri__evidence-section">
          <div className="vnext-meri__evidence-section-label">VERIFICATION</div>
          {verifyStats.length > 0 ? (
            <div className="vnext-meri__evidence-stat-row">
              {verifyStats.map((stat) => (
                <span
                  key={stat.label}
                  className="vnext-meri__evidence-stat-pill"
                  data-tone={stat.tone}
                >
                  {stat.label}
                </span>
              ))}
            </div>
          ) : null}
          {claims.length > 0 ? (
            <div className="vnext-meri__evidence-claim-list">
              {claims.map((claim, index) => (
                <ClaimRow key={`${claim.claim}-${index}`} claim={claim} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const CLAIM_META: Record<
  MeriEvidenceClaim['state'],
  {
    state: string;
    icon: 'Check' | 'Diamond01' | 'AlertTriangle' | 'SwitchVertical01' | 'HelpCircle';
  }
> = {
  verified: { state: 'VERIFIED · TIED TO A CITED LOCATOR', icon: 'Check' },
  inference: { state: 'INFERENCE · DERIVED, NOT QUOTED', icon: 'Diamond01' },
  unsupported: { state: 'UNSUPPORTED · NO EVIDENCE FOUND', icon: 'AlertTriangle' },
  conflict: { state: 'SOURCES DISAGREE', icon: 'SwitchVertical01' },
  low: { state: 'LOW CONFIDENCE · SINGLE WEAK SOURCE', icon: 'HelpCircle' },
};

function ClaimRow({ claim }: { claim: MeriEvidenceClaim }) {
  const meta = CLAIM_META[claim.state];
  return (
    <div className="vnext-meri__evidence-claim-row" data-state={claim.state}>
      <span className="vnext-meri__evidence-claim-dot">
        <MeriIcon name={meta.icon} size={11} />
      </span>
      <span className="vnext-meri__evidence-claim-body">
        <span className="vnext-meri__evidence-claim-text">{claim.claim}</span>
        <span className="vnext-meri__evidence-claim-state">{meta.state}</span>
      </span>
    </div>
  );
}
