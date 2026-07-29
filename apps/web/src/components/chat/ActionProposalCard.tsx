import { useEffect, useMemo, useRef, useState } from 'react';
import { describeApprovalOutcome } from './meri-pending-approvals.js';
import type { PendingApproval } from './useMeriChatController.js';

const STATUS_LABELS: Record<string, string> = {
  proposed: 'Needs approval',
  approved: 'Approved, not yet executed',
  executing: 'Executing',
  succeeded: 'Succeeded',
  failed_retryable: 'Failed · retry available',
  failed_terminal: 'Failed',
  outcome_unknown: 'Outcome unknown',
  blocked: 'Blocked',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

const FIELD_LABELS: Record<string, string> = {
  to: 'Recipient',
  cc: 'CC',
  bcc: 'BCC',
  subject: 'Subject',
  title: 'Title',
  name: 'Name',
  dueDate: 'Due date',
  startsAt: 'Starts',
  endsAt: 'Ends',
  cadence: 'Cadence',
  destination: 'Destination',
  intervalMinutes: 'Interval (minutes)',
  scope: 'Scope',
  changedFields: 'Profile fields',
  bodyPreview: 'Body preview',
  bodyCharacters: 'Body length',
};

const COUNT_LABELS: Record<string, string> = {
  people: 'People rows',
  facilities: 'Facility rows',
  capabilities: 'Capability rows',
  recipients: 'Recipients',
  attachments: 'Attachments',
  profileFields: 'Profile fields',
};

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function riskLabel(value: string | null | undefined): string {
  if (!value) return 'Unclassified risk';
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)} risk`;
}

function statusTone(status: PendingApproval['status']): 'neutral' | 'warning' | 'danger' | 'success' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed_terminal' || status === 'blocked' || status === 'outcome_unknown') return 'danger';
  if (status === 'proposed' || status === 'failed_retryable' || status === 'expired') return 'warning';
  return 'neutral';
}

export interface ActionProposalCardProps {
  proposal: PendingApproval;
  busy?: boolean;
  onApprove: (proposalId: string) => void | Promise<void>;
  onDismiss: (proposalId: string) => void | Promise<void>;
  onEditProposal?: (proposal: PendingApproval) => void;
  onRepropose?: (proposal: PendingApproval) => void;
}

/**
 * Renders only the server-built, bounded preview. The immutable input payload is
 * intentionally absent from this component, so raw JSON/secrets cannot leak into
 * the browser UI and the preview can never become execution authority.
 */
export function ActionProposalCard({
  proposal,
  busy = false,
  onApprove,
  onDismiss,
  onEditProposal,
  onRepropose,
}: ActionProposalCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const approveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmOpen) confirmRef.current?.focus();
  }, [confirmOpen]);

  const fields = useMemo(() => Object.entries(proposal.preview.fields ?? {}), [proposal.preview.fields]);
  const counts = useMemo(() => Object.entries(proposal.preview.counts ?? {}), [proposal.preview.counts]);
  const bodyPreview = proposal.preview.fields?.bodyPreview;
  const visibleFields = fields.filter(([key]) => key !== 'bodyPreview');
  const isProposed = proposal.status === 'proposed';
  const isRetryable = proposal.status === 'failed_retryable';
  const isExecuting = proposal.status === 'executing';
  const mayRepropose = proposal.status === 'expired' || proposal.status === 'blocked';
  const expiresAt = formatDate(proposal.expiresAt);
  const approvedAt = formatDate(proposal.approvedAt);
  const tone = statusTone(proposal.status);

  const closeConfirm = () => {
    setConfirmOpen(false);
    requestAnimationFrame(() => approveTriggerRef.current?.focus());
  };

  const approve = async () => {
    closeConfirm();
    await onApprove(proposal.proposalId);
  };

  return (
    <article
      className={`action-proposal action-proposal--${tone}`}
      aria-labelledby={`proposal-${proposal.proposalId}`}
    >
      <header className="action-proposal__header">
        <div>
          <h4 id={`proposal-${proposal.proposalId}`}>{proposal.preview.label}</h4>
          <div className="action-proposal__badges">
            <span className={`action-proposal__status action-proposal__status--${tone}`}>
              {STATUS_LABELS[proposal.status] ?? proposal.status}
            </span>
            <span>{riskLabel(proposal.riskTier ?? proposal.preview.riskTier)}</span>
            <span>{proposal.preview.leavesFirm ? 'External action' : 'Internal action'}</span>
            <span>{proposal.preview.reversible ? 'Reversible' : 'Not reliably reversible'}</span>
          </div>
        </div>
      </header>

      {proposal.preview.client && (
        <div className="action-proposal__target">
          <strong>Client:</strong>{' '}
          {proposal.preview.client.name || `Client ${proposal.preview.client.id.slice(0, 8)}`}
        </div>
      )}

      {visibleFields.length > 0 && (
        <dl className="action-proposal__summary">
          {visibleFields.slice(0, 8).map(([key, value]) => (
            <div key={key}>
              <dt>{FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1')}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {typeof bodyPreview === 'string' && bodyPreview && (
        <div className="action-proposal__body-preview">
          <button type="button" onClick={() => setBodyExpanded((value) => !value)}>
            {bodyExpanded ? 'Hide message preview' : 'Show message preview'}
          </button>
          {bodyExpanded && <p>{bodyPreview}</p>}
        </div>
      )}

      {counts.length > 0 && (
        <div className="action-proposal__counts" aria-label="Action row counts">
          {counts.map(([key, value]) => (
            <span key={key}>
              {COUNT_LABELS[key] ?? key}: {value}
            </span>
          ))}
        </div>
      )}

      {!isProposed && !isExecuting && (
        <div className={`action-proposal__outcome action-proposal__outcome--${tone}`} role="status">
          {describeApprovalOutcome(proposal)}
        </div>
      )}
      {isExecuting && (
        <div className="action-proposal__outcome" role="status" aria-live="polite">
          Executing this exact approved proposal…
        </div>
      )}

      <button
        type="button"
        className="action-proposal__details-toggle"
        onClick={() => setDetailsOpen((value) => !value)}
        aria-expanded={detailsOpen}
      >
        {detailsOpen ? 'Hide details' : 'View details'}
      </button>

      {detailsOpen && (
        <div className="action-proposal__details">
          <dl>
            <div>
              <dt>Policy reason</dt>
              <dd>{proposal.preview.reason || proposal.reason}</dd>
            </div>
            <div>
              <dt>Policy rule</dt>
              <dd>{proposal.ruleId || proposal.policyCode || 'Policy rule not supplied'}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{expiresAt || 'Expiration unavailable'}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{proposal.attemptCount}</dd>
            </div>
            {approvedAt && (
              <div>
                <dt>Approval</dt>
                <dd>
                  Approved by {proposal.approvedBy ? 'the recorded approver' : 'you'} · {approvedAt}
                </dd>
              </div>
            )}
          </dl>
          {proposal.error?.message && (
            <div className="action-proposal__error" role="alert">
              {proposal.error.message}
            </div>
          )}
        </div>
      )}

      <footer className="action-proposal__actions">
        {isExecuting ? (
          <button type="button" disabled>
            Executing…
          </button>
        ) : (
          (isProposed || isRetryable) && (
            <button
              ref={approveTriggerRef}
              type="button"
              className="action-proposal__approve"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              {busy ? 'Working…' : isRetryable ? 'Retry' : 'Approve & run'}
            </button>
          )
        )}
        {isProposed && onEditProposal && (
          <button type="button" disabled={busy} onClick={() => onEditProposal(proposal)}>
            Edit proposal
          </button>
        )}
        {mayRepropose && onRepropose && (
          <button type="button" disabled={busy} onClick={() => onRepropose(proposal)}>
            Re-propose
          </button>
        )}
        {!isExecuting && (
          <button type="button" disabled={busy} onClick={() => void onDismiss(proposal.proposalId)}>
            {isProposed ? 'Dismiss' : 'Clear'}
          </button>
        )}
      </footer>

      {confirmOpen && (
        <div className="action-proposal-dialog-backdrop" role="presentation">
          <section
            className="action-proposal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`confirm-${proposal.proposalId}`}
          >
            <h3 id={`confirm-${proposal.proposalId}`}>Approve this exact action?</h3>
            <p>
              <strong>{proposal.preview.label}</strong> ·{' '}
              {proposal.preview.leavesFirm ? 'leaves the firm' : 'internal'} ·{' '}
              {riskLabel(proposal.riskTier ?? proposal.preview.riskTier)}
            </p>
            {proposal.preview.client && (
              <p>Target: {proposal.preview.client.name || proposal.preview.client.id}</p>
            )}
            <p>{proposal.preview.reason || proposal.reason}</p>
            <div className="action-proposal-dialog__actions">
              <button type="button" onClick={closeConfirm}>
                Cancel
              </button>
              <button ref={confirmRef} type="button" onClick={() => void approve()}>
                Confirm and run
              </button>
            </div>
          </section>
        </div>
      )}
    </article>
  );
}
