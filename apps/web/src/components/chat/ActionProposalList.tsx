import { useEffect, useRef, useState } from 'react';
import { ActionProposalCard } from './ActionProposalCard.js';
import { outstandingApprovals } from './meri-pending-approvals.js';
import type { PendingApproval } from './useMeriChatController.js';

export function ActionProposalList({
  proposals,
  busyProposalId,
  onApprove,
  onApproveAll,
  onDismiss,
  onEditProposal,
  onRepropose,
}: {
  proposals: PendingApproval[];
  busyProposalId: string | null;
  onApprove: (proposalId: string) => void | Promise<void>;
  onApproveAll: () => void | Promise<void>;
  onDismiss: (proposalId: string) => void | Promise<void>;
  onEditProposal?: (proposal: PendingApproval) => void;
  onRepropose?: (proposal: PendingApproval) => void;
}) {
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const outstanding = outstandingApprovals(proposals);
  const highRiskCount = outstanding.filter(
    (proposal) =>
      proposal.preview.leavesFirm ||
      ['high', 'restricted', 'critical'].includes(
        String(proposal.riskTier ?? proposal.preview.riskTier ?? '').toLowerCase(),
      ),
  ).length;

  useEffect(() => {
    if (confirmAllOpen) confirmButtonRef.current?.focus();
  }, [confirmAllOpen]);

  const close = () => {
    setConfirmAllOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <section className="action-proposal-list" aria-labelledby="action-proposals-heading">
      <header className="action-proposal-list__heading">
        <div>
          <strong id="action-proposals-heading">Proposed actions</strong>
          {outstanding.length > 0 && (
            <span>
              {' '}
              · {outstanding.length} waiting · nothing runs until approved
            </span>
          )}
        </div>
        {outstanding.length > 1 && (
          <button
            ref={triggerRef}
            type="button"
            disabled={Boolean(busyProposalId)}
            onClick={() => setConfirmAllOpen(true)}
          >
            Approve all ({outstanding.length})
          </button>
        )}
      </header>

      <div className="action-proposal-list__cards">
        {proposals.map((proposal) => (
          <ActionProposalCard
            key={proposal.proposalId}
            proposal={proposal}
            busy={busyProposalId === proposal.proposalId}
            onApprove={onApprove}
            onDismiss={onDismiss}
            onEditProposal={onEditProposal}
            onRepropose={onRepropose}
          />
        ))}
      </div>

      {confirmAllOpen && (
        <div className="action-proposal-dialog-backdrop" role="presentation">
          <section
            className="action-proposal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-all-proposals"
          >
            <h3 id="confirm-all-proposals">Approve {outstanding.length} separate actions?</h3>
            <p>
              The server will execute these in sequence. Each action remains a separate immutable
              proposal with its own outcome.
            </p>
            {highRiskCount > 0 && (
              <div role="alert" className="action-proposal-dialog__warning">
                {highRiskCount} selected action{highRiskCount === 1 ? '' : 's'}{' '}
                {highRiskCount === 1 ? 'is' : 'are'} external or high risk. Review every item below.
              </div>
            )}
            <ol className="action-proposal-dialog__list">
              {outstanding.map((proposal) => (
                <li key={proposal.proposalId}>
                  <strong>{proposal.preview.label}</strong>
                  {proposal.preview.client?.name ? ` · ${proposal.preview.client.name}` : ''}
                  {proposal.preview.leavesFirm ? ' · external' : ''}
                  {proposal.preview.fields?.to ? ` · ${proposal.preview.fields.to}` : ''}
                </li>
              ))}
            </ol>
            <label className="action-proposal-dialog__acknowledgment">
              <input type="checkbox" required />
              I reviewed each action and understand that approval runs all of them.
            </label>
            <div className="action-proposal-dialog__actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                onClick={(event) => {
                  const dialog = event.currentTarget.closest('[role="dialog"]');
                  const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
                  if (!checkbox?.checked) {
                    checkbox?.focus();
                    return;
                  }
                  close();
                  void onApproveAll();
                }}
              >
                Confirm and run all
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
