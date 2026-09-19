import { useEffect, useState } from 'react';
import type {
  MeriHermesApprovalBlock,
  MeriHermesApprovalCard as MeriHermesApprovalCardData,
} from './meri-hermes-interactions.js';
import { isHermesInteractionExpired } from './meri-hermes-interactions.js';

export interface HermesApprovalCardProps {
  card: MeriHermesApprovalCardData;
  busy?: boolean;
  /** Overridable for tests; defaults to the real clock. */
  now?: () => number;
  onDecide: (decision: 'approve_once' | 'deny') => void | Promise<void>;
}

/**
 * Native Hermes terminal-command approval (contracts.md §3, §4.1). Distinct
 * from ActionProposalCard (Meri business-action writes) because the
 * semantics genuinely differ:
 *  - only two decisions exist here — Run once / Deny — never "always" or
 *    "for this session" (Meri deliberately does not expose those);
 *  - Hermes never reports approve/deny outcome as its own event
 *    (`approval.resolved` is internal-only), so there is no server lifecycle
 *    to poll — the resolved state shown here is the user's own choice, and
 *    the run's SSE stream (live or reconnected) is what shows what actually
 *    happened next (the command's tool_call/sources frames, or the run
 *    simply continuing without it);
 *  - approvals expire (default 300s, contracts.md §6) and must show a stale
 *    state instead of silently offering a decision that Hermes will 403;
 *  - a native approval is a `live_process` continuation: the worker is blocked
 *    waiting on it, so once the run is terminal (stopped, failed, expired,
 *    finished) there is no longer anything to approve and the backend refuses
 *    the decision. That is shown as its own no-longer-actionable state — the
 *    one thing this card must never do is keep offering a button that the
 *    server will reject.
 */
export function HermesApprovalCard({ card, busy = false, now = Date.now, onDecide }: HermesApprovalCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(() => isHermesInteractionExpired(card, now()));

  useEffect(() => {
    setExpired(isHermesInteractionExpired(card, now()));
    if (card.resolution || !card.expiresAt) return;
    const remaining = Date.parse(card.expiresAt) - now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setExpired(true), Math.min(remaining + 250, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [card, now]);

  const decide = async (decision: 'approve_once' | 'deny') => {
    setError(null);
    try {
      await onDecide(decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send this decision. Try again.');
    }
  };

  const resolved = card.resolution;
  // Resolution wins over everything: a decision the user actually made is the
  // honest outcome even if the run has since ended or the clock has passed.
  const blocked: MeriHermesApprovalBlock = resolved
    ? 'resolved'
    : card.runTerminal
      ? 'run_ended'
      : expired
        ? 'expired'
        : null;
  const tone = resolved
    ? resolved.decision === 'deny'
      ? 'neutral'
      : 'success'
    : blocked
      ? 'danger'
      : 'warning';

  return (
    <article
      className={`hermes-approval hermes-approval--${tone}`}
      aria-labelledby={`hermes-approval-${card.requestId}`}
      role="group"
    >
      <header className="hermes-approval__header">
        <h4 id={`hermes-approval-${card.requestId}`}>{card.label}</h4>
        <span className="hermes-approval__badge">Native command approval</span>
      </header>

      {card.command ? (
        <pre className="hermes-approval__command">
          <code>{card.command}</code>
        </pre>
      ) : null}

      {resolved ? (
        <div className="hermes-approval__outcome" role="status">
          {resolved.decision === 'approve_once'
            ? 'Approved — Hermes will run this once.'
            : 'Denied — the run continues without it.'}
        </div>
      ) : blocked === 'run_ended' ? (
        <div className="hermes-approval__outcome hermes-approval__outcome--expired" role="status">
          This run has ended, so Hermes can no longer act on this approval. It was never run.
        </div>
      ) : blocked === 'expired' ? (
        <div className="hermes-approval__outcome hermes-approval__outcome--expired" role="status">
          Expired before you responded. Hermes treated this as denied.
        </div>
      ) : (
        <footer className="hermes-approval__actions">
          <button
            type="button"
            className="hermes-approval__approve"
            disabled={busy}
            onClick={() => void decide('approve_once')}
          >
            {busy ? 'Working…' : 'Run once'}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide('deny')}>
            Deny
          </button>
        </footer>
      )}

      {error ? (
        <div className="hermes-approval__error" role="alert">
          {error}
        </div>
      ) : null}
    </article>
  );
}
