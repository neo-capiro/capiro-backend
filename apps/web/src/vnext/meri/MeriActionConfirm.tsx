import { useEffect, useMemo, useRef, useState } from 'react';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriActionConfirm / MeriBulkActionConfirm — the informed-consent gate the v4
 * spec puts between "Approve" and the write actually leaving the tenant.
 *
 * Everything rendered here comes from the server's own PublicMeriActionProposal:
 * `preview.fields`, `preview.leavesFirm`, `preview.reversible`, the `policy`
 * block, `expiresAt` and `attemptCount`. Nothing is inferred client-side, and
 * the acknowledgement checkbox is a local gate only — approval itself is still
 * re-verified server-side on submit.
 */

function riskLine(proposal: PendingApproval): string {
  const parts = [
    proposal.preview.riskTier ?? proposal.riskTier,
    proposal.preview.leavesFirm ? 'EXTERNAL' : 'INTERNAL',
    proposal.preview.reversible ? 'REVERSIBLE' : 'NOT RELIABLY REVERSIBLE',
  ];
  return parts.filter(Boolean).join(' · ').toUpperCase();
}

function fieldRows(proposal: PendingApproval): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (proposal.preview.client?.name) {
    rows.push({ label: 'CLIENT', value: proposal.preview.client.name });
  }
  for (const [key, value] of Object.entries(proposal.preview.fields ?? {})) {
    rows.push({ label: key.replace(/[_.]/g, ' ').toUpperCase(), value: String(value) });
  }
  for (const [key, value] of Object.entries(proposal.preview.counts ?? {})) {
    rows.push({ label: key.replace(/[_.]/g, ' ').toUpperCase(), value: String(value) });
  }
  return rows;
}

function policyRows(proposal: PendingApproval): Array<{ label: string; value: string }> {
  const policy = proposal.policy;
  const rows: Array<{ label: string; value: string }> = [];
  if (proposal.reason) rows.push({ label: 'POLICY REASON', value: proposal.reason });
  if (proposal.policyCode) rows.push({ label: 'POLICY CODE', value: proposal.policyCode });
  if (proposal.ruleId) rows.push({ label: 'POLICY RULE', value: proposal.ruleId });
  if (policy?.packKey) {
    rows.push({
      label: 'POLICY PACK',
      value: policy.packVersion ? `${policy.packKey} ${policy.packVersion}` : policy.packKey,
    });
  }
  if (policy?.binding) rows.push({ label: 'PACK BINDING', value: policy.binding });
  if (policy?.decision) rows.push({ label: 'DECISION', value: policy.decision });
  if (policy?.decisionHash) rows.push({ label: 'DECISION HASH', value: policy.decisionHash });
  if (policy?.jurisdiction) rows.push({ label: 'JURISDICTION', value: policy.jurisdiction });
  if (policy?.channel) rows.push({ label: 'CHANNEL', value: policy.channel });
  if (policy?.recipientType) rows.push({ label: 'RECIPIENT TYPE', value: policy.recipientType });
  if (proposal.expiresAt) rows.push({ label: 'PROPOSAL EXPIRES', value: proposal.expiresAt });
  rows.push({ label: 'ATTEMPTS', value: String(proposal.attemptCount) });
  return rows;
}

/** Focus trap + Escape handling shared by both dialogs. */
function useDialogBehaviour(open: boolean, onCancel: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  return { dialogRef, cancelRef };
}

interface MeriActionConfirmProps {
  proposal: PendingApproval | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MeriActionConfirm({ proposal, busy, onCancel, onConfirm }: MeriActionConfirmProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { dialogRef, cancelRef } = useDialogBehaviour(Boolean(proposal), onCancel);

  useEffect(() => {
    setAcknowledged(false);
    setDetailsOpen(false);
  }, [proposal?.proposalId]);

  const fields = useMemo(() => (proposal ? fieldRows(proposal) : []), [proposal]);
  const policy = useMemo(() => (proposal ? policyRows(proposal) : []), [proposal]);

  if (!proposal) return null;

  const external = proposal.preview.leavesFirm;
  const retry = proposal.status === 'failed_retryable';

  return (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <div
        ref={dialogRef}
        className="vnext-meri__confirm-dialog vnext-meri__approve-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-approve-title"
      >
        <div className="vnext-meri__approve-head">
          <span
            className={`vnext-meri__approve-badge${external ? ' is-external' : ''}`}
            aria-hidden="true"
          >
            <MeriIcon name="Shield01" size={17} color={external ? '#B54708' : '#344054'} />
          </span>
          <span className="vnext-meri__approve-head-copy">
            <span id="meri-approve-title" className="vnext-meri__approve-title">
              {retry ? 'Retry' : 'Approve'} {proposal.preview.label}?
            </span>
            <span className={`vnext-meri__approve-risk${external ? ' is-external' : ''}`}>
              {riskLine(proposal)}
            </span>
          </span>
          <button
            type="button"
            className="vnext-meri__approve-close"
            aria-label="Cancel"
            onClick={onCancel}
          >
            <MeriIcon name="XClose" size={16} color="#667085" />
          </button>
        </div>

        {fields.length ? (
          <div className="vnext-meri__approve-fields">
            {fields.map((field) => (
              <div key={field.label} className="vnext-meri__approve-field">
                <div className="vnext-meri__approve-field-label">{field.label}</div>
                <div className="vnext-meri__approve-field-value">{field.value}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="vnext-meri__approve-note">
          {proposal.preview.reason || proposal.reason}
        </div>

        <div className="vnext-meri__approve-note">
          Approving records your decision against this exact payload. Execution is a separate write,
          and the outcome is recorded whether it succeeds or fails.
        </div>

        {proposal.error?.message ? (
          <div className="vnext-meri__approve-error">
            <div className="vnext-meri__approve-error-label">
              {proposal.error.code ?? 'PREVIOUS ATTEMPT FAILED'}
            </div>
            <div>{proposal.error.message}</div>
          </div>
        ) : null}

        <button
          type="button"
          className={`vnext-meri__approve-ack${acknowledged ? ' is-checked' : ''}`}
          role="checkbox"
          aria-checked={acknowledged}
          onClick={() => setAcknowledged((value) => !value)}
        >
          <span className="vnext-meri__approve-ack-box" aria-hidden="true">
            {acknowledged ? <MeriIcon name="Check" size={13} color="#ffffff" /> : null}
          </span>
          <span>
            I have reviewed this action
            {proposal.preview.client?.name ? ` on behalf of ${proposal.preview.client.name}` : ''}
            {external ? ', including that it leaves the tenant and cannot be recalled' : ''}.
          </span>
        </button>

        {policy.length ? (
          <>
            <button
              type="button"
              className="vnext-meri__approve-details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <MeriIcon name={detailsOpen ? 'ChevronUp' : 'ChevronDown'} size={13} color="#667085" />
              {detailsOpen ? 'HIDE POLICY AND AUDIT DETAIL' : 'POLICY AND AUDIT DETAIL'}
            </button>
            {detailsOpen ? (
              <div className="vnext-meri__approve-details">
                {policy.map((row) => (
                  <div key={row.label} className="vnext-meri__approve-detail-row">
                    <span className="vnext-meri__approve-detail-label">{row.label}</span>
                    <span className="vnext-meri__approve-detail-value">{row.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        <div className="vnext-meri__confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="vnext-meri__confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vnext-meri__approve-submit"
            disabled={!acknowledged || busy}
            onClick={onConfirm}
          >
            {busy ? 'Submitting…' : retry ? 'Confirm & retry' : 'Confirm & run'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MeriBulkActionConfirmProps {
  proposals: PendingApproval[];
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function MeriBulkActionConfirm({
  proposals,
  open,
  busy,
  onCancel,
  onConfirm,
}: MeriBulkActionConfirmProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { dialogRef, cancelRef } = useDialogBehaviour(open, onCancel);

  useEffect(() => {
    setAcknowledged(false);
  }, [open]);

  if (!open) return null;

  const externalCount = proposals.filter((proposal) => proposal.preview.leavesFirm).length;
  const irreversibleCount = proposals.filter((proposal) => !proposal.preview.reversible).length;

  return (
    <div className="vnext-meri__confirm-scrim" role="presentation">
      <div
        ref={dialogRef}
        className="vnext-meri__confirm-dialog vnext-meri__approve-dialog vnext-meri__approve-dialog--bulk"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meri-bulk-approve-title"
      >
        <div className="vnext-meri__approve-head">
          <span className="vnext-meri__approve-head-copy">
            <span id="meri-bulk-approve-title" className="vnext-meri__approve-title">
              {proposals.length} action{proposals.length === 1 ? '' : 's'} waiting for approval
            </span>
            <span className="vnext-meri__approve-risk">
              THEY RUN IN THIS ORDER
              {externalCount ? ` · ${externalCount} LEAVE${externalCount === 1 ? 'S' : ''} YOUR TENANT` : ''}
            </span>
          </span>
          <button
            type="button"
            className="vnext-meri__approve-close"
            aria-label="Cancel"
            onClick={onCancel}
          >
            <MeriIcon name="XClose" size={16} color="#667085" />
          </button>
        </div>

        <div className="vnext-meri__approve-list">
          {proposals.map((proposal, index) => (
            <div key={proposal.proposalId} className="vnext-meri__approve-list-row">
              <span className="vnext-meri__approve-list-num">{index + 1}</span>
              <span className="vnext-meri__approve-list-copy">
                <span className="vnext-meri__approve-list-title">{proposal.preview.label}</span>
                <span className="vnext-meri__approve-list-detail">
                  {proposal.preview.reason || proposal.reason}
                </span>
              </span>
              <span
                className={`vnext-meri__approve-list-risk${
                  proposal.preview.leavesFirm ? ' is-external' : ''
                }`}
              >
                {riskLine(proposal)}
              </span>
            </div>
          ))}
        </div>

        {irreversibleCount ? (
          <div className="vnext-meri__approve-warn">
            {irreversibleCount} of these cannot be reliably reversed. Approving all approves
            {irreversibleCount === 1 ? ' that action' : ' those actions'} too.
          </div>
        ) : null}

        <button
          type="button"
          className={`vnext-meri__approve-ack${acknowledged ? ' is-checked' : ''}`}
          role="checkbox"
          aria-checked={acknowledged}
          onClick={() => setAcknowledged((value) => !value)}
        >
          <span className="vnext-meri__approve-ack-box" aria-hidden="true">
            {acknowledged ? <MeriIcon name="Check" size={13} color="#ffffff" /> : null}
          </span>
          <span>
            I have reviewed all {proposals.length} action{proposals.length === 1 ? '' : 's'}
            {externalCount ? ', including the external send' : ''}.
          </span>
        </button>

        <div className="vnext-meri__confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="vnext-meri__confirm-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="vnext-meri__approve-submit"
            disabled={!acknowledged || busy}
            onClick={onConfirm}
          >
            {busy ? 'Submitting…' : 'Confirm & run all'}
          </button>
        </div>
      </div>
    </div>
  );
}
