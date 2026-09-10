import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriApprovalNotice } from './MeriApprovalNotice.js';

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

describe('MeriApprovalNotice', () => {
  test('renders nothing when there are no approvals for this turn', () => {
    const { container } = render(<MeriApprovalNotice approvals={[]} onReview={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  test('one sentence for a single proposed action, plus a Review it link', () => {
    render(<MeriApprovalNotice approvals={[approval()]} onReview={vi.fn()} />);
    expect(
      screen.getByText('Send follow-up email needs your approval before Meri runs it.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Review it/ })).toBeTruthy();
  });

  test('summarises all conversation actions without claiming completed actions await review', () => {
    render(
      <MeriApprovalNotice
        approvals={[
          approval({ proposalId: 'p1' }),
          approval({ proposalId: 'p2', status: 'succeeded' }),
        ]}
        onReview={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Meri has 2 governed actions from this conversation. Review their status and results.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/awaiting your review|from this turn/)).toBeNull();
    expect(screen.getByRole('button', { name: /Review/ })).toBeTruthy();
  });

  test.each([
    ['succeeded', 'Send follow-up email completed successfully.'],
    ['failed_retryable', 'Send follow-up email failed and can be retried.'],
    ['blocked', 'Send follow-up email was blocked by policy.'],
    ['dismissed', 'Send follow-up email was dismissed.'],
  ] as const)('renders a status-appropriate sentence for %s', (status, expected) => {
    render(<MeriApprovalNotice approvals={[approval({ status })]} onReview={vi.fn()} />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  test('"Review it" calls onReview', () => {
    const onReview = vi.fn();
    render(<MeriApprovalNotice approvals={[approval()]} onReview={onReview} />);
    fireEvent.click(screen.getByRole('button', { name: /Review it/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });
});
