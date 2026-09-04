import type { MeriActionProposalStatus, PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriApprovalNotice — the v6 transcript replacement for the full approval
 * card PendingApprovalsInline renders inline in the log today (status label,
 * reason, outcome, Approve/Retry/Dismiss). One sentence plus a "Review it"
 * link that opens the turn inspector's Approvals tab, focused on the turn
 * this notice belongs to.
 *
 * Built and unit-tested in isolation here, but NOT yet swapped in as
 * PendingApprovalsInline's live rendering: doing that now would strip the
 * only reachable Approve/Retry/Dismiss UI from production before the turn
 * inspector panel is mounted anywhere (VNextMeriShell.tsx is intentionally
 * untouched in this piece). That swap belongs in the same follow-up
 * integration step that wires the panel in.
 */

/**
 * Every sentence is deliberately label-initial ("Send follow-up email needs
 * your approval…") rather than splicing the label into the middle of a
 * clause — proposal.preview.label is a capitalised, real-world action name
 * (e.g. "Send follow-up email"), and a mid-sentence splice would force a
 * case decision that is wrong for most of these ten statuses.
 */
const STATUS_SENTENCE: Record<MeriActionProposalStatus, (label: string) => string> = {
  proposed: (label) => `${label} needs your approval before Meri runs it.`,
  approved: (label) => `${label} was approved and is queued to run.`,
  executing: (label) => `${label} is running now.`,
  succeeded: (label) => `${label} completed successfully.`,
  failed_retryable: (label) => `${label} failed and can be retried.`,
  failed_terminal: (label) => `${label} failed and could not be retried.`,
  outcome_unknown: (label) => `${label}'s outcome could not be confirmed.`,
  blocked: (label) => `${label} was blocked by policy.`,
  dismissed: (label) => `${label} was dismissed.`,
  expired: (label) => `${label}'s approval window expired.`,
};

function noticeSentence(approvals: PendingApproval[]): string {
  if (approvals.length > 1) {
    return `Meri has ${approvals.length} governed actions from this turn awaiting your review.`;
  }
  const only = approvals[0];
  if (!only) return '';
  const label = (only.preview.label || only.tool.replace(/_/g, ' ')).trim();
  return STATUS_SENTENCE[only.status](label);
}

export interface MeriApprovalNoticeProps {
  /** The governed actions proposed by this turn. */
  approvals: PendingApproval[];
  /** Opens the turn inspector to the Approvals tab, focused on this turn. */
  onReview: () => void;
}

export function MeriApprovalNotice({ approvals, onReview }: MeriApprovalNoticeProps) {
  if (approvals.length === 0) return null;

  return (
    <div className="vnext-meri__approval-notice" role="status">
      <span className="vnext-meri__approval-notice-text">{noticeSentence(approvals)}</span>
      <button type="button" className="vnext-meri__approval-notice-link" onClick={onReview}>
        Review it
        <MeriIcon name="ArrowNarrowRight" size={14} color="#363F72" />
      </button>
    </div>
  );
}
