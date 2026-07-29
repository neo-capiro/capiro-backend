import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionProposalCard } from './ActionProposalCard.js';
import { ActionProposalList } from './ActionProposalList.js';
import type { PendingApproval } from './useMeriChatController.js';

const proposal = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  proposalId: 'proposal-1',
  status: 'proposed',
  tool: 'send_email',
  preview: {
    label: 'Send email',
    riskTier: 'restricted',
    leavesFirm: true,
    reversible: false,
    client: { id: 'client-1', name: 'Acme' },
    fields: {
      to: 'staff@example.gov',
      subject: 'Follow-up',
      bodyPreview: 'A bounded preview of the proposed email body.',
      bodyCharacters: 418,
    },
    counts: { recipients: 1 },
    reason: 'External communication requires explicit approval.',
  },
  expiresAt: '2026-07-29T14:00:00.000Z',
  reason: 'External communication requires explicit approval.',
  ruleId: 'send.requires_approval',
  riskTier: 'restricted',
  policyCode: 'external_send',
  attemptCount: 0,
  resultSummary: null,
  createdAt: '2026-07-28T14:00:00.000Z',
  updatedAt: '2026-07-28T14:00:00.000Z',
  ...over,
});

describe('ActionProposalCard', () => {
  it('shows the exact safe preview and never raw JSON', () => {
    render(
      <ActionProposalCard
        proposal={proposal()}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Send email')).toBeTruthy();
    expect(screen.getByText('staff@example.gov')).toBeTruthy();
    expect(screen.getByText('Follow-up')).toBeTruthy();
    expect(screen.getByText('External action')).toBeTruthy();
    expect(screen.getByText('Not reliably reversible')).toBeTruthy();
    expect(screen.queryByText(/"to"/)).toBeNull();
    expect(screen.queryByText('A bounded preview of the proposed email body.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show message preview' }));
    expect(screen.getByText('A bounded preview of the proposed email body.')).toBeTruthy();
  });

  it('requires confirmation before running one proposal', () => {
    const approve = vi.fn();
    render(
      <ActionProposalCard
        proposal={proposal()}
        onApprove={approve}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve & run' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Approve this exact action?');
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run' }));
    expect(approve).toHaveBeenCalledWith('proposal-1');
  });

  it('offers Retry only for a server-declared retryable failure', () => {
    const { rerender } = render(
      <ActionProposalCard
        proposal={proposal({ status: 'failed_retryable' })}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    rerender(
      <ActionProposalCard
        proposal={proposal({ status: 'failed_terminal' })}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers Re-propose for an expired proposal instead of attempting execution', () => {
    const repropose = vi.fn();
    render(
      <ActionProposalCard
        proposal={proposal({ status: 'expired' })}
        onApprove={vi.fn()}
        onDismiss={vi.fn()}
        onRepropose={repropose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Re-propose' }));
    expect(repropose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Approve & run' })).toBeNull();
  });
});

describe('ActionProposalList', () => {
  it('requires a second summary acknowledgment before multiple actions run', () => {
    const approveAll = vi.fn();
    render(
      <ActionProposalList
        proposals={[
          proposal({ proposalId: 'a' }),
          proposal({
            proposalId: 'b',
            tool: 'update_client_profile',
            preview: {
              ...proposal().preview,
              label: 'Update client profile',
              leavesFirm: false,
              reversible: true,
              fields: { changedFields: 'website, description' },
            },
          }),
        ]}
        busyProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={approveAll}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve all (2)' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Send email');
    expect(dialog).toHaveTextContent('Update client profile');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run all' }));
    expect(approveAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and run all' }));
    expect(approveAll).toHaveBeenCalledOnce();
  });
});
