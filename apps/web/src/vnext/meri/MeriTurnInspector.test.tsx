import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { MeriTurnInspector, meriTurnInspectorInitialTab, type MeriTurnInspectorData } from './MeriTurnInspector.js';

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

function data(overrides: Partial<MeriTurnInspectorData> = {}): MeriTurnInspectorData {
  return {
    turnId: 'message-1',
    thinking: { plan: 'Verify the appropriations figure.', steps: [], intent: null, tier: null },
    evidence: { sources: [], verifyStats: [], claims: [], groundingCaveat: null, retrieval: null },
    approvals: [],
    ...overrides,
  };
}

describe('meriTurnInspectorInitialTab', () => {
  test('opens to Approvals when this turn has one awaiting a decision', () => {
    expect(meriTurnInspectorInitialTab([approval({ status: 'proposed' })])).toBe('approvals');
    expect(meriTurnInspectorInitialTab([approval({ status: 'failed_retryable' })])).toBe('approvals');
  });

  test('opens to Thinking when nothing is awaiting a decision', () => {
    expect(meriTurnInspectorInitialTab([])).toBe('thinking');
    expect(meriTurnInspectorInitialTab([approval({ status: 'succeeded' })])).toBe('thinking');
    expect(meriTurnInspectorInitialTab([approval({ status: 'dismissed' })])).toBe('thinking');
  });
});

describe('MeriTurnInspector', () => {
  test('renders the Thinking tab body when active', () => {
    render(
      <MeriTurnInspector
        data={data()}
        activeTab="thinking"
        onClose={vi.fn()}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Verify the appropriations figure.')).toBeTruthy();
  });

  test('renders the Evidence tab body when active', () => {
    render(
      <MeriTurnInspector
        data={data({ evidence: { sources: [], verifyStats: [{ label: 'CLAIMS CHECKED · 1', tone: 'n' }], claims: [], groundingCaveat: null, retrieval: null } })}
        activeTab="evidence"
        onClose={vi.fn()}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('CLAIMS CHECKED · 1')).toBeTruthy();
  });

  test('renders the Approvals tab body when active, wired to the approve/dismiss callbacks', () => {
    const onApprove = vi.fn();
    render(
      <MeriTurnInspector
        data={data({ approvals: [approval()] })}
        activeTab="approvals"
        onClose={vi.fn()}
        approvingProposalId={null}
        onApprove={onApprove}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('PROPOSED · SEND FOLLOW-UP EMAIL')).toBeTruthy();
  });

  test('the back control calls onClose', () => {
    const onClose = vi.fn();
    render(
      <MeriTurnInspector
        data={data()}
        activeTab="thinking"
        onClose={onClose}
        approvingProposalId={null}
        onApprove={vi.fn()}
        onApproveAll={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /BACK/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
