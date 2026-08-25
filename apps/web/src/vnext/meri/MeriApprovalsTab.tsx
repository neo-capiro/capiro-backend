import { useEffect, useState } from 'react';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';
import { MeriPanelState } from './MeriPanelState.js';
import { MeriActionConfirm, MeriBulkActionConfirm } from './MeriActionConfirm.js';

/**
 * MeriApprovalsTab — v6 turn inspector, Approvals tab. Card body (status
 * label, reason, outcome line, Approve/Retry/Dismiss actions) moved from
 * PendingApprovalsInline (VNextMeriConversation.tsx), decoupled from the
 * controller: this takes the approvals it should show plus plain callbacks,
 * not `controller` itself.
 *
 * MeriActionConfirm/MeriBulkActionConfirm — the informed-consent dialogs
 * gating a real approval — are triggered exactly the same way as before:
 * local confirm-target state, opened on Approve/Retry, closed on cancel or
 * confirm.
 *
 * Divergence ruling (turn-inspector specific): once an action leaves
 * `proposed`/`failed_retryable`, it is WITHDRAWN from the UI, not disabled —
 * canApprove/canDismiss below carries that forward unchanged from the
 * original inline card.
 */

function proposalStatusLabel(status: string): string {
  return status.replace(/_/g, ' ').toUpperCase();
}

function proposalOutcome(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  for (const key of ['summary', 'message', 'detail']) {
    if (typeof raw[key] === 'string' && raw[key].trim()) return raw[key] as string;
  }
  return null;
}

export interface MeriApprovalsTabProps {
  approvals: PendingApproval[];
  approvingProposalId: string | null;
  onApprove: (proposalId: string) => void;
  onApproveAll: () => void;
  onDismiss: (proposalId: string) => void;
}

export function MeriApprovalsTab({ approvals, approvingProposalId, onApprove, onApproveAll, onDismiss }: MeriApprovalsTabProps) {
  const actionBusy = Boolean(approvingProposalId);
  const [confirmFor, setConfirmFor] = useState<PendingApproval | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const proposedApprovals = approvals.filter((proposal) => proposal.status === 'proposed');
  const proposedCount = proposedApprovals.length;

  // Drop a held dialog if the server retires the proposal underneath it.
  useEffect(() => {
    if (!confirmFor) return;
    const live = approvals.find((proposal) => proposal.proposalId === confirmFor.proposalId);
    if (!live) setConfirmFor(null);
    else if (live !== confirmFor) setConfirmFor(live);
  }, [confirmFor, approvals]);

  useEffect(() => {
    if (bulkOpen && proposedApprovals.length === 0) setBulkOpen(false);
  }, [bulkOpen, proposedApprovals.length]);

  if (approvals.length === 0) {
    return (
      <div className="vnext-meri__evidence-tab-body">
        <MeriPanelState tone="empty">Nothing is awaiting your approval for this turn.</MeriPanelState>
      </div>
    );
  }

  return (
    <div className="vnext-meri__evidence-tab-body">
      <div className="vnext-meri__pending-approvals">
        <div className="vnext-meri__pending-approvals-banner">
          <span className="vnext-meri__pending-approvals-banner-icon">
            <MeriIcon name="Lock01" size={13} />
          </span>
          <span className="vnext-meri__pending-approvals-banner-body">
            <span className="vnext-meri__pending-approvals-banner-title">
              Your approval is required before Meri executes a governed action.
            </span>
            <span className="vnext-meri__pending-approvals-banner-caption">
              REVIEW THE ACTION, SCOPE, AND RISK. MERI WILL NOT EXECUTE A HELD WRITE WITHOUT YOUR
              EXPLICIT APPROVAL.
            </span>
          </span>
        </div>
        {approvals.map((proposal) => {
          const canApprove = proposal.status === 'proposed' || proposal.status === 'failed_retryable';
          const canDismiss = proposal.status === 'proposed' || proposal.status === 'failed_retryable';
          const outcome = proposalOutcome(proposal.resultSummary) || proposal.error?.message || null;
          const active = approvingProposalId === proposal.proposalId;
          return (
            <div key={proposal.proposalId} className="vnext-meri__pending-approval-card">
              <div className="vnext-meri__pending-approval-status">
                {proposalStatusLabel(proposal.status)} · {proposal.preview.label.toUpperCase()}
              </div>
              <div className="vnext-meri__pending-approval-reason">{proposal.reason}</div>
              {outcome ? <div className="vnext-meri__attachment-notice">{outcome}</div> : null}
              {canApprove || canDismiss ? (
                <div className="vnext-meri__pending-approval-actions">
                  {canApprove ? (
                    <button
                      type="button"
                      className="vnext-meri__rail-action-btn"
                      disabled={actionBusy}
                      onClick={() => setConfirmFor(proposal)}
                    >
                      {active
                        ? proposal.status === 'failed_retryable'
                          ? 'Retrying…'
                          : 'Approving…'
                        : proposal.status === 'failed_retryable'
                          ? 'Retry'
                          : 'Approve'}
                    </button>
                  ) : null}
                  {canDismiss ? (
                    <button
                      type="button"
                      className="vnext-meri__protip-trigger"
                      disabled={actionBusy}
                      onClick={() => onDismiss(proposal.proposalId)}
                    >
                      Dismiss
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {proposedCount > 1 ? (
          <button type="button" className="vnext-meri__rail-action-btn" disabled={actionBusy} onClick={() => setBulkOpen(true)}>
            Approve all proposed actions
          </button>
        ) : null}

        <MeriActionConfirm
          proposal={confirmFor}
          busy={actionBusy}
          onCancel={() => setConfirmFor(null)}
          onConfirm={() => {
            const target = confirmFor;
            setConfirmFor(null);
            if (target) onApprove(target.proposalId);
          }}
        />
        <MeriBulkActionConfirm
          proposals={proposedApprovals}
          open={bulkOpen}
          busy={actionBusy}
          onCancel={() => setBulkOpen(false)}
          onConfirm={() => {
            setBulkOpen(false);
            onApproveAll();
          }}
        />
      </div>
    </div>
  );
}
