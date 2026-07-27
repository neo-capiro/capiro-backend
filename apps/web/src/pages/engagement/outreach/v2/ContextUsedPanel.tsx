/**
 * Context Used panel (Phase 1 §3.j2).
 *
 * Shows, for ONE generated draft: what it was grounded in, what was deliberately
 * not used, what failed to load, what still needs confirmation, and which
 * policy/model produced it.
 *
 * The reason this exists is that the pre-Phase-1 pipeline degraded invisibly. A
 * dozen enrichment channels each swallowed their own failure, so a draft written
 * with the recipient profile, tracked bills, votes and correspondence ALL missing
 * looked exactly like one written with everything present — same confident prose,
 * no signal to the reviewer. A lobbyist cannot catch a gap they cannot see.
 *
 * Two display rules are load-bearing:
 *   - A CRITICAL failure blocks Send and states the remediation. It is not a
 *     warning to scroll past.
 *   - Non-critical degradation stays visible rather than being hidden once the
 *     draft "worked". "Worked" and "was fully informed" are different claims.
 */
import {
  AlertOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import type { GenerationSourceManifest, SourceFailure, SourceManifestEntry } from './types.js';

export interface ContextUsedPanelProps {
  manifest: GenerationSourceManifest | undefined;
  /** Rendered above the sections when the draft is held for review. */
  heldNote?: string;
}

/** Friendly labels for the machine source types. */
const SOURCE_LABELS: Record<string, string> = {
  bill: 'Federal bill',
  stateBill: 'State bill',
  programElement: 'Program element',
  email: 'Email thread',
  document: 'Document',
  clientNote: 'Client profile note',
  meetingNote: 'Meeting note',
  debrief: 'Meeting debrief',
  prep: 'Meeting prep',
  note: 'Your note',
  directory: 'Directory profile',
  press: 'Press',
  trackedBills: 'Tracked legislation',
  clientWatchlist: 'Client priorities',
  actionRecommendations: 'Recommended asks',
  relevantVotes: 'Recipient votes',
  upcomingHearings: 'Upcoming hearings',
  priorOutreach: 'Prior outreach',
  insights: 'Selected insights',
  additionalContext: 'Additional context',
  recipient: 'Recipient identity',
  standingMemory: 'Steering memory',
  generation: 'Generation',
};

function sourceLabel(type: string): string {
  return SOURCE_LABELS[type] ?? type;
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

/**
 * True when this manifest must block Send.
 *
 * Exported so StepGenerate and the send preflight gate on the SAME predicate —
 * two copies of "is this blocked" is how a UI ends up letting through what its
 * own panel says is broken.
 */
export function manifestBlocksSend(manifest: GenerationSourceManifest | undefined): boolean {
  if (!manifest) return false;
  return manifest.criticalFailures.length > 0;
}

export function ContextUsedPanel({ manifest, heldNote }: ContextUsedPanelProps) {
  if (!manifest) {
    return (
      <div className="ov2-ctxused ov2-ctxused--empty">
        <InfoCircleOutlined /> Generate this draft to see what it was grounded in.
      </div>
    );
  }

  const critical = manifest.criticalFailures;
  const important = manifest.failures.filter((f) => f.severity === 'important');
  const informational = manifest.failures.filter((f) => f.severity === 'informational');

  return (
    <div className="ov2-ctxused" data-testid="context-used-panel">
      {heldNote ? (
        <div className="ov2-ctxused-held" role="status" data-testid="ctxused-held">
          <AlertOutlined /> {heldNote}
        </div>
      ) : null}

      {/* ── Source failures: critical first, and blocking ── */}
      {critical.length > 0 ? (
        <section className="ov2-ctxused-sec ov2-ctxused-sec--critical" data-testid="ctxused-critical">
          <h4>
            <CloseCircleOutlined /> Source failures — this draft cannot be sent
          </h4>
          <ul>
            {critical.map((f, i) => (
              <li key={`${f.code}-${f.sourceId ?? i}`}>
                <strong>{sourceLabel(f.sourceType)}:</strong> {f.userMessage}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Grounded in ── */}
      <section className="ov2-ctxused-sec" data-testid="ctxused-grounded">
        <h4>
          <CheckCircleOutlined /> Grounded in ({manifest.included.length})
        </h4>
        {manifest.included.length === 0 ? (
          <p className="ov2-ctxused-none">
            No sources were used. This draft asserts no specific facts.
          </p>
        ) : (
          <ul>
            {manifest.included.map((entry) => (
              <IncludedRow key={`${entry.sourceType}:${entry.sourceId}:${entry.scope}`} entry={entry} />
            ))}
          </ul>
        )}
        <p className="ov2-ctxused-meta">
          Email context: <strong>{manifest.emailScopeLabel}</strong>
          {manifest.standingMemoryCount > 0 ? (
            <>
              {' · '}
              {manifest.standingMemoryCount} steering memory item
              {manifest.standingMemoryCount === 1 ? '' : 's'} (style only)
            </>
          ) : null}
          {manifest.oldestSourceAt ? (
            <>
              {' · '}Sources dated {shortDate(manifest.oldestSourceAt)} to{' '}
              {shortDate(manifest.newestSourceAt)}
            </>
          ) : null}
        </p>
      </section>

      {/* ── Not used ── */}
      {manifest.exclusions.length > 0 ? (
        <section className="ov2-ctxused-sec" data-testid="ctxused-notused">
          <h4>Not used ({manifest.exclusions.length})</h4>
          <ul>
            {manifest.exclusions.map((x, i) => (
              <li key={`${x.sourceType}-${x.sourceId ?? i}`}>
                {sourceLabel(x.sourceType)} — {x.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Degraded, but not blocking ── */}
      {important.length > 0 ? (
        <section className="ov2-ctxused-sec ov2-ctxused-sec--warn" data-testid="ctxused-degraded">
          <h4>
            <ExclamationCircleOutlined /> Needs confirmation ({important.length})
          </h4>
          <ul>
            {important.map((f, i) => (
              <FailureRow key={`${f.code}-${f.sourceId ?? i}`} failure={f} />
            ))}
          </ul>
        </section>
      ) : null}

      {informational.length > 0 || manifest.disclosures.length > 0 ? (
        <section className="ov2-ctxused-sec ov2-ctxused-sec--info" data-testid="ctxused-notes">
          <h4>
            <InfoCircleOutlined /> Notes
          </h4>
          <ul>
            {informational.map((f, i) => (
              <FailureRow key={`${f.code}-${f.sourceId ?? i}`} failure={f} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Model / policy details ── */}
      <section className="ov2-ctxused-sec ov2-ctxused-sec--details" data-testid="ctxused-details">
        <h4>Model &amp; policy</h4>
        <dl>
          <div>
            <dt>Audience policy</dt>
            <dd>
              {manifest.policy.label} ({manifest.policy.jurisdiction}) · {manifest.policy.version}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {manifest.provider ?? '—'} / {manifest.model ?? '—'}
              {manifest.planModel && manifest.planModel !== manifest.model
                ? ` (planning: ${manifest.planModel})`
                : ''}
            </dd>
          </div>
          <div>
            <dt>Prompt spec</dt>
            <dd>{manifest.promptSpecVersion}</dd>
          </div>
          <div>
            <dt>Context packet</dt>
            <dd>
              <code>{manifest.contextPacketId || '—'}</code>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function IncludedRow({ entry }: { entry: SourceManifestEntry }) {
  const asOf = shortDate(entry.asOf);
  return (
    <li>
      <span className="ov2-ctxused-type">{sourceLabel(entry.sourceType)}</span>{' '}
      <span className="ov2-ctxused-title">{entry.title}</span>
      {asOf ? <span className="ov2-ctxused-asof"> · as of {asOf}</span> : null}
      {entry.scope !== 'all' ? (
        <span className="ov2-ctxused-scope"> · this recipient only</span>
      ) : null}
      {entry.truncated ? (
        <span className="ov2-ctxused-trunc"> · truncated (only the first portion was used)</span>
      ) : null}
      {entry.relevance ? (
        <span className={`ov2-ctxused-rel ov2-ctxused-rel--${entry.relevance}`}>
          {' '}
          · {entry.relevance} relevance
        </span>
      ) : null}
      {entry.relevanceReasons?.length ? (
        <ul className="ov2-ctxused-why">
          {entry.relevanceReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FailureRow({ failure }: { failure: SourceFailure }) {
  return (
    <li>
      <strong>{sourceLabel(failure.sourceType)}:</strong> {failure.userMessage}
    </li>
  );
}
