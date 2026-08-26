import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriApprovalsTab } from './MeriApprovalsTab.js';

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    proposalId: 'proposal-1',
    status: 'proposed',
    tool: 'send_email',
    preview: {
      label: 'Send follow-up email',
      riskTier: 'standard',
      leavesFirm: true,
      reversible: false,
      fields: {},
      counts: {},
      reason: 'Drafted from the thread.',
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reason: 'This sends an email to an external recipient.',
    riskTier: 'standard',
    policyCode: null,
    policy: {
      source: 'tenant',
      mode: 'enforced',
      packKey: 'default',
      packVersion: '1',
      binding: 'strict',
      decisionHash: 'hash',
      contextHash: 'hash',
      decision: 'hold',
      jurisdiction: 'us',
      channel: 'email',
      recipientType: 'external',
    },
    attemptCount: 0,
    resultSummary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MeriApprovalsTab', () => {
  test('renders an empty state when nothing is pending for this conversation', () => {
    render(<MeriApprovalsTab approvals={[]} approvingProposalId={null} onApprove={vi.fn()} onApproveAll={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('Nothing is awaiting your approval for this conversation.')).toBeTruthy();
  });

  test('a proposed action can be approved after the informed-consent dialog is confirmed', () => {
    const onApprove = vi.fn();
    render(
      <MeriApprovalsTab
        approvals={[approval()]}
        approvingProposalId={null}
        onApprove={onApprove}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('PROPOSED · SEND FOLLOW-UP EMAIL')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    // MeriActionConfirm's own informed-consent gate: the confirm button stays
    // disabled until the acknowledgement checkbox is checked.
    fireEvent.click(screen.getByRole('checkbox', { name: /I have reviewed this action/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & run' }));
    expect(onApprove).toHaveBeenCalledWith('proposal-1');
  });

  test('dismiss calls onDismiss directly, without a confirm dialog', () => {
    const onDismiss = vi.fn();
    render(
      <MeriApprovalsTab approvals={[approval()]} approvingProposalId={null} onApprove={vi.fn()} onApproveAll={vi.fn()} onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('proposal-1');
  });

  test('a failed_retryable action offers Retry instead of Approve, and still allows Dismiss', () => {
    render(
      <MeriApprovalsTab
        approvals={[approval({ status: 'failed_retryable' })]}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  test.each(['succeeded', 'executing', 'failed_terminal', 'dismissed', 'expired', 'blocked', 'outcome_unknown', 'approved'] as const)(
    'a %s action is withdrawn from the UI — no Approve or Dismiss control, not merely disabled',
    (status) => {
      render(
        <MeriApprovalsTab
          approvals={[approval({ status })]}
          approvingProposalId={null}
          onApprove={vi.fn()}
          onApproveAll={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    },
  );

  test('offers "Approve all proposed actions" only when more than one proposal is proposed', () => {
    const { rerender } = render(
      <MeriApprovalsTab approvals={[approval()]} approvingProposalId={null} onApprove={vi.fn()} onApproveAll={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByText('Approve all proposed actions')).toBeNull();

    rerender(
      <MeriApprovalsTab
        approvals={[approval({ proposalId: 'p1' }), approval({ proposalId: 'p2' })]}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Approve all proposed actions')).toBeTruthy();
  });

  test('renders an outcome line from resultSummary when present', () => {
    render(
      <MeriApprovalsTab
        approvals={[approval({ status: 'failed_retryable', resultSummary: { summary: 'The recipient address bounced.' } })]}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('The recipient address bounced.')).toBeTruthy();
  });
});
