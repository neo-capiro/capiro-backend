import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OwnedMemoryCandidate,
  ReviewableMemoryCandidate,
} from '../../components/memory-queue-shared.js';
import { memoryCandidateTargetLabel } from '../../components/memory-queue-shared.js';
import type { MemoryReviewInboxItem } from '../../components/memory-review-inbox-shared.js';
import type { MeriContextPacket } from './meri-vnext-api.js';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

import { MeriMemoryTab } from './MeriMemoryTab.js';

function candidate(id: string, clientId: string, clientName: string): ReviewableMemoryCandidate {
  return {
    id, clientId, clientName, scope: 'client', candidateKind: 'standard',
    proposedByUserId: 'proposer', sourceKind: 'chat', createdAt: '2026-09-09T00:00:00Z',
    proposal: { key: `Proposal ${id}`, value: 'A proposed fact', canonicalItem: null },
    capabilities: { approve: true, reject: true },
  };
}

function owned(id: string, overrides: Partial<OwnedMemoryCandidate> = {}): OwnedMemoryCandidate {
  return {
    ...candidate(id, 'l3', 'L3 Harris'), status: 'pending', decidedAt: null,
    restricted: false, capabilities: { withdraw: true }, ...overrides,
  };
}

function packet(clientId: string): MeriContextPacket {
  return {
    packetId: clientId, clientId, persisted: true, persistenceErrorCode: null,
    surface: 'chat', items: [], exclusions: [], unauthorizedCount: 0, degraded: false,
  };
}

function card(title: string) {
  return within(screen.getByText(title).closest('article')!);
}

describe('Meri governed proposal targets', () => {
  let review: ReviewableMemoryCandidate[];
  let proposals: OwnedMemoryCandidate[];
  let history: MemoryReviewInboxItem[];

  beforeEach(() => {
    vi.clearAllMocks();
    review = [candidate('l3-review', 'l3', 'L3 Harris'), candidate('anduril-review', 'anduril', 'Anduril')];
    proposals = [owned('own-l3')];
    history = [];
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: history, nextCursor: null } };
      }
      return {
        data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review },
      };
    });
    mocks.api.post.mockImplementation(async (url: string) => {
      const [, id, action] = url.match(/\/([^/]+)\/(approve|reject|withdraw)$/)!;
      if (action === 'withdraw') {
        proposals = proposals.map((row) => row.id === id
          ? { ...row, status: 'withdrawn', capabilities: { withdraw: false } }
          : row);
      } else {
        review = review.filter((row) => row.id !== id);
      }
      return { data: { outcome: action === 'approve' ? 'activated' : action === 'reject' ? 'rejected' : 'withdrawn' } };
    });
  });

  function show(clientId = 'anduril') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string) => (
      <QueryClientProvider client={qc}><MeriMemoryTab packet={packet(id)} /></QueryClientProvider>
    );
    const rendered = render(tree(clientId));
    return { ...rendered, selectClient: (id: string) => rendered.rerender(tree(id)) };
  }

  it('keeps both actual client labels across picker/context changes without client-filtering requests', async () => {
    const view = show();
    await screen.findByText('Proposal l3-review');
    expect(card('Proposal l3-review').getByText('Target: L3 Harris')).toBeInTheDocument();
    expect(card('Proposal anduril-review').getByText('Target: Anduril')).toBeInTheDocument();
    expect(screen.getByText(/Across your firm/)).toHaveTextContent('client picker does not filter this queue');
    view.selectClient('l3');
    expect(card('Proposal anduril-review').getByText('Target: Anduril')).toBeInTheDocument();
    view.selectClient('portfolio');
    expect(card('Proposal l3-review').getByText('Target: L3 Harris')).toBeInTheDocument();
    expect(mocks.api.get.mock.calls.map(([url]) => url)).toEqual([
      '/api/memory/review/candidates', '/api/memory/proposals', '/api/memory/review/inbox',
    ]);
  });

  it('approves, rejects with a required reason, and withdraws the recorded proposal IDs after picker switches', async () => {
    const view = show('anduril');
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('Proposal l3-review')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenNthCalledWith(1, '/api/memory/review/candidates/l3-review/approve', {});
    view.selectClient('l3');
    fireEvent.click(card('Proposal anduril-review').getByRole('button', { name: 'Reject' }));
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    expect(card('Proposal anduril-review').getByRole('button', { name: 'Reject proposal' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Rejection reason' }), { target: { value: '  Source is outdated  ' } });
    view.selectClient('portfolio');
    fireEvent.click(card('Proposal anduril-review').getByRole('button', { name: 'Reject proposal' }));
    await waitFor(() => expect(screen.queryByText('Proposal anduril-review')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenNthCalledWith(2, '/api/memory/review/candidates/anduril-review/reject', { reason: 'Source is outdated' });
    fireEvent.click(card('Proposal own-l3').getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(card('Proposal own-l3').getAllByText(/WITHDRAWN/)).toHaveLength(2));
    expect(mocks.api.post).toHaveBeenNthCalledWith(3, '/api/memory/proposals/own-l3/withdraw', {});
    expect(card('Proposal own-l3').getByText('Target: L3 Harris')).toBeInTheDocument();
    expect(card('Proposal own-l3').queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('honors server capabilities and hides stale client names on restricted proposals', async () => {
    review = [{ ...review[0]!, capabilities: { approve: false, reject: false } }];
    proposals = [owned('restricted', { restricted: true, proposal: null, clientName: 'Hidden firm' })];
    show();
    await screen.findByText('Proposal l3-review');
    expect(card('Proposal l3-review').queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Target: Restricted client memory')).toBeInTheDocument();
    expect(screen.queryByText(/Hidden firm/)).not.toBeInTheDocument();
    fireEvent.click(card('Restricted client memory proposal').getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledWith('/api/memory/proposals/restricted/withdraw', {}));
  });

  it('keeps every pending proposal reachable in Meri and does not route review to Settings', async () => {
    proposals = Array.from({ length: 7 }, (_, index) => owned(`pending-${index + 1}`));
    show();
    await screen.findByText('Proposal pending-7');
    expect(screen.getAllByText(/Pending review/i)).toHaveLength(7);
    expect(screen.queryByRole('link', { name: /Governance Center/i })).not.toBeInTheDocument();
  });

  it('restores canonical decision receipts after a fresh mount', async () => {
    history = [{
      candidateId: 'approved-7', reviewRequestId: 'request-7', candidateKind: 'correction',
      scope: 'client', client: { id: 'l3', name: 'L3 Harris', status: 'active' },
      title: 'Approved cadence correction', status: 'approved', revisionNumber: 2,
      rootCandidateId: 'approved-1', predecessorCandidateId: 'approved-1',
      submittedBy: { userId: 'proposer', name: 'Pat Proposer' },
      assignedReviewer: { userId: 'reviewer', name: 'Priya Reviewer' },
      decidedBy: { userId: 'reviewer', name: 'Priya Reviewer' },
      createdAt: '2026-09-09T00:00:00Z', decidedAt: '2026-09-09T01:00:00Z',
      blockedReason: null, nextAction: 'none',
      capabilities: { open: true, approve: false, reject: false, requestChanges: false, revise: false, reassign: false, withdraw: false },
    }];
    show();
    expect(await screen.findByText('Approved cadence correction')).toBeInTheDocument();
    const receipt = card('Approved cadence correction');
    expect(receipt.getByText('Review reference: approved-7')).toBeInTheDocument();
    expect(receipt.getByText('Revision: 2')).toBeInTheDocument();
    expect(receipt.getByText('Decided by: Priya Reviewer')).toBeInTheDocument();
  });

  it('keeps an authorization failure visible without claiming that the proposal changed', async () => {
    mocks.api.post.mockRejectedValue({ response: { data: { message: 'Review authorization changed' } } });
    show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Review authorization changed'));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(card('Proposal l3-review').getByText('Target: L3 Harris')).toBeInTheDocument();
  });

  it('shows canonical source, proposer, review reference, reviewer, and conflict details', async () => {
    review = [{
      ...review[0]!,
      candidateKind: 'learning_signal_conflict',
      conflict: { contradictsMemoryItemId: 'memory-v3', conflictStatus: 'open' },
      workflow: {
        requestId: 'review-request-7', status: 'pending',
        submittedBy: { userId: 'proposer', name: 'Pat Proposer' },
        assignedReviewer: { userId: 'reviewer', name: 'Priya Reviewer' },
        decidedBy: null, feedbackReason: null, createdAt: '2026-09-09T00:00:00Z',
        decidedAt: null, capabilities: { requestChanges: true, reassign: false },
      },
      capabilities: { approve: true, reject: true, requestChanges: true, resolveConflict: true },
    }];
    show();
    await screen.findByText('Proposal l3-review');
    const proposal = card('Proposal l3-review');
    expect(proposal.getByText('Source: chat')).toBeInTheDocument();
    expect(proposal.getByText('Proposed by: Pat Proposer')).toBeInTheDocument();
    expect(proposal.getByText('Review reference: review-request-7')).toBeInTheDocument();
    expect(proposal.getByText('Current reviewer: Priya Reviewer')).toBeInTheDocument();
    expect(proposal.getByText(/Conflict: open against memory memory-v3/)).toBeInTheDocument();
    fireEvent.click(proposal.getByRole('button', { name: 'Request changes' }));
    expect(proposal.getByRole('textbox', { name: 'Requested changes' })).toBeInTheDocument();
  });

  it('recovers an ambiguous network outcome by reading status without repeating the decision', async () => {
    mocks.api.post.mockRejectedValueOnce(new Error('Network unavailable'));
    show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check current status' }));
    await waitFor(() => {
      expect(mocks.api.get.mock.calls.filter(([url]) => String(url).includes('/inbox/candidates/')).length).toBeGreaterThanOrEqual(2);
    });
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'Review permission denied'],
    [409, 'Review changed before this decision'],
    [503, 'Decision status unconfirmed'],
  ])('keeps an HTTP %s decision failure visible without false success', async (status, title) => {
    mocks.api.post.mockRejectedValueOnce({
      response: { status, data: { message: `Injected ${status} review failure` } },
    });
    show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(`Injected ${status} review failure`, { exact: false })).toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('labels firm, personal, and legacy unnamed client cards explicitly under a selected client', async () => {
    review = [
      { ...candidate('firm', 'l3', 'L3 Harris'), scope: 'firm', clientId: null },
      { ...candidate('personal', 'l3', 'L3 Harris'), scope: 'personal', clientId: null },
      { ...candidate('legacy', 'l3', 'L3 Harris'), clientName: undefined },
    ];
    show('anduril');
    await screen.findByText('Proposal firm');
    expect(card('Proposal firm').getByText('Target: Firm memory')).toBeInTheDocument();
    expect(card('Proposal personal').getByText('Target: Personal memory')).toBeInTheDocument();
    expect(card('Proposal legacy').getByText('Target: Client unavailable')).toBeInTheDocument();
    expect(card('Proposal legacy').queryByText(/Anduril|L3 Harris/)).not.toBeInTheDocument();
  });

  it.each([
    [{ scope: 'client', clientId: 'legacy' }, 'Client unavailable'],
    [{ scope: 'client', clientId: 'legacy', clientName: '   ' }, 'Client unavailable'],
    [{ scope: 'client', clientId: null, clientName: 'Unbound name' }, 'Client unavailable'],
    [{ scope: 'firm', clientId: null }, 'Firm memory'],
    [{ scope: 'personal', clientId: null }, 'Personal memory'],
    [{ scope: 'user_private', clientId: null }, 'Personal memory'],
    [{ scope: 'unknown', clientId: null }, 'Target unavailable'],
  ])('reports the actual or unavailable target without inventing a picker-derived name', (input, expected) => {
    expect(memoryCandidateTargetLabel(input)).toBe(expected);
  });
});
