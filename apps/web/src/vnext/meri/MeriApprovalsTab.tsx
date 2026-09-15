import { useEffect, useState } from 'react';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { clientSaveReceipt } from '../../components/chat/meri-client-save-receipt.js';
import { MeriIcon } from './meri-icons.js';
import type { MeriIconName } from './meri-icons.js';
import { MeriPanelState } from './MeriPanelState.js';
import { MeriActionConfirm, MeriBulkActionConfirm } from './MeriActionConfirm.js';
import './meri-approvals.css';

/**
 * MeriApprovalsTab — v6 turn inspector, Approvals tab. Compact presentation
 * (status header + risk, readable action title, external/irreversible flag
 * rows, field table, counts, reason, Approve/Dismiss + expiry, collapsed
 * policy grid) rendered directly on the gray panel — only the empty state is
 * a white placeholder card. All content comes from the server's own
 * PendingApproval/preview payload; nothing is inferred client-side and no
 * demo content is hardcoded.
 *
 * MeriActionConfirm/MeriBulkActionConfirm — the informed-consent dialogs
 * gating a real approval — are triggered exactly the same way as before:
 * local confirm-target state, opened on Approve/Retry, closed on cancel or
 * confirm.
 *
 * The backend returns these proposals at conversation scope. The inspector
 * therefore labels them as conversation approvals rather than inventing a
 * turn association. Once an action leaves
 * `proposed`/`failed_retryable`, it is WITHDRAWN from the UI, not disabled —
 * canApprove/canDismiss below carries that forward unchanged from the
 * original inline card.
 */

type ApprovalTone = 'warning' | 'success' | 'error' | 'navy' | 'gray';

interface StatusPresentation {
  label: string;
  tone: ApprovalTone;
  icon: MeriIconName;
}

/** Per-status label, tone and icon for the approval header. */
const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  proposed: { label: 'AWAITING YOUR APPROVAL', tone: 'warning', icon: 'Hourglass03' },
  approved: { label: 'APPROVED', tone: 'navy', icon: 'CheckCircle' },
  executing: { label: 'EXECUTING', tone: 'navy', icon: 'Loading01' },
  succeeded: { label: 'SUCCEEDED', tone: 'success', icon: 'CheckCircle' },
  failed_retryable: { label: 'FAILED — RETRYABLE', tone: 'warning', icon: 'RefreshCw01' },
  failed_terminal: { label: 'FAILED', tone: 'error', icon: 'XCircle' },
  outcome_unknown: { label: 'OUTCOME UNKNOWN', tone: 'gray', icon: 'HelpCircle' },
  blocked: { label: 'BLOCKED BY POLICY', tone: 'error', icon: 'Lock01' },
  dismissed: { label: 'DISMISSED', tone: 'gray', icon: 'SlashCircle01' },
  expired: { label: 'EXPIRED', tone: 'gray', icon: 'Clock' },
};

const TONE_ICON_COLOR: Record<ApprovalTone, string> = {
  warning: '#B54708',
  success: '#067647',
  error: '#B42318',
  navy: '#363F72',
  gray: '#667085',
};

function statusPresentation(proposal: PendingApproval, receiptLabel: string | null) {
  if (receiptLabel) {
    // Save-confirmation outcomes keep the action title in the status line so
    // the confirmed result reads as "NOTE SAVED · SAVE NOTE".
    return {
      label: `${receiptLabel.toUpperCase()} · ${(proposal.preview?.label ?? '').toUpperCase()}`,
      tone: STATUS_PRESENTATION[proposal.status]?.tone ?? 'gray',
      icon: STATUS_PRESENTATION[proposal.status]?.icon ?? ('InfoCircle' as MeriIconName),
    };
  }
  // Generic lifecycle statuses show the status label alone; the readable
  // action title sits directly beneath, so it is not duplicated here.
  return (
    STATUS_PRESENTATION[proposal.status] ?? {
      label: proposal.status.replace(/_/g, ' ').toUpperCase(),
      tone: 'gray' as const,
      icon: 'InfoCircle' as MeriIconName,
    }
  );
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

function briefingDraftLocation(proposal: PendingApproval): string | null {
  if (
    proposal.tool !== 'prepare_legiwatch_briefing' ||
    proposal.status !== 'succeeded' ||
    !proposal.resultSummary ||
    typeof proposal.resultSummary !== 'object'
  )
    return null;
  const result = proposal.resultSummary as Record<string, unknown>;
  if (typeof result.documentId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(result.documentId))
    return null;
  const location = '/workspace/draft/' + encodeURIComponent(result.documentId);
  return result.location === location ? location : null;
}

/** Compact "Expires in 23h" style label from the server's expiresAt. */
function expiryLabel(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'Expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Expires in <1m';
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

/** "externalDomains" -> "EXTERNAL DOMAIN" (camelCase -> words, uppercased). */
function fieldLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toUpperCase();
}

/** "externalDomains" -> "external domain"; count of 1 singularizes. */
function countLabel(key: string, value: number): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (value === 1 && words.endsWith('s')) return words.slice(0, -1);
  return words;
}

function truncateHash(value: string): string {
  return value.length > 8 ? `${value.slice(0, 6)}…` : value;
}

/** Policy grid rows — display-only, straight from the proposal's policy block. */
function policyRows(proposal: PendingApproval): Array<{ key: string; value: string }> {
  const policy = proposal.policy;
  if (!policy) return [];
  const rows: Array<{ key: string; value: string }> = [];
  if (policy.source) rows.push({ key: 'Source', value: policy.source });
  if (policy.mode) rows.push({ key: 'Mode', value: policy.mode });
  if (policy.packKey) rows.push({ key: 'Pack', value: policy.packKey });
  if (policy.packVersion) rows.push({ key: 'Version', value: policy.packVersion });
  if (policy.binding) rows.push({ key: 'Binding', value: policy.binding });
  if (policy.decision) rows.push({ key: 'Decision', value: policy.decision });
  if (policy.jurisdiction) rows.push({ key: 'Jurisdiction', value: policy.jurisdiction });
  if (policy.channel) rows.push({ key: 'Channel', value: policy.channel });
  if (policy.recipientType) rows.push({ key: 'Recipient type', value: policy.recipientType });
  if (proposal.policyCode) rows.push({ key: 'Policy code', value: proposal.policyCode });
  if (proposal.ruleId) rows.push({ key: 'Rule', value: proposal.ruleId });
  if (policy.decisionHash) rows.push({ key: 'Decision hash', value: truncateHash(policy.decisionHash) });
  if (policy.contextHash) rows.push({ key: 'Context hash', value: truncateHash(policy.contextHash) });
  rows.push({ key: 'Attempts', value: String(proposal.attemptCount ?? 0) });
  return rows;
}

export interface MeriApprovalsTabProps {
  approvals: PendingApproval[];
  approvingProposalId: string | null;
  onApprove: (proposalId: string) => void;
  onApproveAll: () => void;
  onDismiss: (proposalId: string) => void;
}

export function MeriApprovalsTab({
  approvals,
  approvingProposalId,
  onApprove,
  onApproveAll,
  onDismiss,
}: MeriApprovalsTabProps) {
  const actionBusy = Boolean(approvingProposalId);
  const [confirmFor, setConfirmFor] = useState<PendingApproval | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [policyOpenFor, setPolicyOpenFor] = useState<string | null>(null);
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
        <MeriPanelState tone="empty">
          Nothing is awaiting your approval for this conversation.
        </MeriPanelState>
      </div>
    );
  }

  return (
    <div className="vnext-meri__evidence-tab-body">
      <div className="vnext-meri__pending-approvals">
        {approvals.map((proposal) => {
          const canApprove =
            proposal.status === 'proposed' || proposal.status === 'failed_retryable';
          const canDismiss =
            proposal.status === 'proposed' || proposal.status === 'failed_retryable';
          const receipt = clientSaveReceipt(proposal);
          const briefingLocation = briefingDraftLocation(proposal);
          const outcome =
            receipt?.summary ||
            proposalOutcome(proposal.resultSummary) ||
            proposal.error?.message ||
            null;
          const active = approvingProposalId === proposal.proposalId;

          const preview = proposal.preview;
          const status = statusPresentation(proposal, receipt?.label ?? null);
          const riskTier = preview?.riskTier ?? proposal.riskTier ?? null;
          const flags: Array<{ key: string; label: string; sub: string; icon: MeriIconName }> = [];
          if (preview?.leavesFirm) {
            flags.push({
              key: 'external',
              label: 'LEAVES THE FIRM',
              sub: 'External recipients',
              icon: 'LogOut01',
            });
          }
          if (preview && preview.reversible === false) {
            flags.push({
              key: 'irreversible',
              label: 'IRREVERSIBLE',
              sub: 'Cannot be recalled',
              icon: 'AlertTriangle',
            });
          }
          const fields: Array<{ key: string; label: string; value: string }> = [];
          if (preview?.client?.name) {
            fields.push({ key: 'client', label: 'CLIENT', value: preview.client.name });
          }
          for (const [key, value] of Object.entries(preview?.fields ?? {})) {
            fields.push({ key: `field:${key}`, label: fieldLabel(key), value: String(value) });
          }
          const counts = Object.entries(preview?.counts ?? {}).map(([key, value]) => ({
            key,
            label: countLabel(key, value),
            value,
          }));
          const reason = preview?.reason || proposal.reason || null;
          const expiry = canApprove || canDismiss ? expiryLabel(proposal.expiresAt) : null;
          const policy = policyRows(proposal);
          const policyOpen = policyOpenFor === proposal.proposalId;

          return (
            <div
              key={proposal.proposalId}
              className="vnext-meri__pending-approval-card"
              data-tone={status.tone}
            >
              <div className="vnext-meri__pending-approval-head">
                <span className="vnext-meri__pending-approval-head-icon">
                  <MeriIcon name={status.icon} size={15} color={TONE_ICON_COLOR[status.tone]} />
                </span>
                <span className="vnext-meri__pending-approval-status">{status.label}</span>
                {riskTier ? (
                  <span className="vnext-meri__pending-approval-risk">
                    {`RISK · ${String(riskTier).toUpperCase()}`}
                  </span>
                ) : null}
              </div>

              <div className="vnext-meri__pending-approval-title">{preview?.label}</div>

              {flags.length ? (
                <div className="vnext-meri__pending-approval-flags">
                  {flags.map((flag) => (
                    <div key={flag.key} className="vnext-meri__pending-approval-flag">
                      <span className="vnext-meri__pending-approval-flag-icon">
                        <MeriIcon name={flag.icon} size={15} color="#B42318" />
                      </span>
                      <span className="vnext-meri__pending-approval-flag-label">{flag.label}</span>
                      <span className="vnext-meri__pending-approval-flag-sub">{flag.sub}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {fields.length || counts.length ? (
                <div className="vnext-meri__pending-approval-fields">
                  {fields.map((field) => (
                    <div key={field.key} className="vnext-meri__pending-approval-field">
                      <span className="vnext-meri__pending-approval-field-label">{field.label}</span>
                      <span className="vnext-meri__pending-approval-field-value">{field.value}</span>
                    </div>
                  ))}
                  {counts.length ? (
                    <div className="vnext-meri__pending-approval-counts">
                      {counts.map((count) => (
                        <span key={count.key} className="vnext-meri__pending-approval-count">
                          <span className="vnext-meri__pending-approval-count-value">
                            {count.value}
                          </span>
                          <span className="vnext-meri__pending-approval-count-label">
                            {count.label}
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {reason ? <div className="vnext-meri__pending-approval-reason">{reason}</div> : null}

              {outcome ? <div className="vnext-meri__attachment-notice">{outcome}</div> : null}

              {briefingLocation || receipt?.location ? (
                <div className="vnext-meri__pending-approval-links">
                  {briefingLocation ? (
                    <a className="vnext-meri__rail-action-btn" href={briefingLocation}>
                      Open editable Workspace draft
                    </a>
                  ) : null}
                  {receipt?.location ? (
                    <a className="vnext-meri__rail-action-btn" href={receipt.location}>
                      Open saved note in Files
                    </a>
                  ) : null}
                </div>
              ) : null}

              {receipt?.files.length ? (
                <ul className="vnext-meri__save-receipt-files">
                  {receipt.files.map((file, index) => (
                    <li key={`${index}-${file.name}`}>
                      <span>
                        {file.name} —{' '}
                        {file.status === 'pending'
                          ? 'Processing'
                          : file.status === 'saved'
                            ? 'Saved'
                            : 'Failed'}
                      </span>
                      {file.reason ? <span>{file.reason}</span> : null}
                      {file.location ? (
                        <a href={file.location}>Open in Files: {file.name}</a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {receipt && proposal.error?.message ? (
                <div className="vnext-meri__attachment-notice">{proposal.error.message}</div>
              ) : null}

              {canApprove || canDismiss ? (
                <div className="vnext-meri__pending-approval-actions">
                  {canApprove ? (
                    <button
                      type="button"
                      className="vnext-meri__pending-approval-btn vnext-meri__pending-approval-btn--approve"
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
                      className="vnext-meri__pending-approval-btn vnext-meri__pending-approval-btn--dismiss"
                      disabled={actionBusy}
                      onClick={() => onDismiss(proposal.proposalId)}
                    >
                      Dismiss
                    </button>
                  ) : null}
                  {expiry ? (
                    <span className="vnext-meri__pending-approval-expiry">{expiry}</span>
                  ) : null}
                </div>
              ) : null}

              {policy.length ? (
                <div className="vnext-meri__pending-approval-policy">
                  <button
                    type="button"
                    className="vnext-meri__pending-approval-policy-toggle"
                    aria-expanded={policyOpen}
                    onClick={() =>
                      setPolicyOpenFor(policyOpen ? null : proposal.proposalId)
                    }
                  >
                    <MeriIcon name="ShieldTick" size={14} color="#667085" />
                    {`${policyOpen ? 'HIDE' : 'SHOW'} POLICY DECISION · ${policy.length} FIELDS`}
                  </button>
                  {policyOpen ? (
                    <div className="vnext-meri__pending-approval-policy-grid">
                      {policy.map((row) => (
                        <div key={row.key} className="vnext-meri__pending-approval-policy-row">
                          <span className="vnext-meri__pending-approval-policy-key">{row.key}</span>
                          <span className="vnext-meri__pending-approval-policy-value">
                            {row.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {proposedCount > 1 ? (
          <button
            type="button"
            className="vnext-meri__pending-approvals-bulk"
            disabled={actionBusy}
            onClick={() => setBulkOpen(true)}
          >
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
