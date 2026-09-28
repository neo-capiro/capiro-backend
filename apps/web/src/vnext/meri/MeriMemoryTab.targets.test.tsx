import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OwnedMemoryCandidate,
  ReviewableMemoryCandidate,
} from '../../components/memory-queue-shared.js';
import { memoryCandidateTargetLabel } from '../../components/memory-queue-shared.js';
import type {
  MemoryReviewDetail,
  MemoryReviewInboxItem,
} from '../../components/memory-review-inbox-shared.js';
import type { MeriContextPacket } from './meri-vnext-api.js';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
  scope: { value: 'org-a:self:actor-a' },
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.scope.value }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

import { MeriMemoryTab } from './MeriMemoryTab.js';

const fixtureIds = new Map<string, string>();
function fixtureUuid(label: string): string {
  const existing = fixtureIds.get(label);
  if (existing) return existing;
  const id = `00000000-0000-4000-8000-${String(fixtureIds.size + 1).padStart(12, '0')}`;
  fixtureIds.set(label, id);
  return id;
}

function candidate(label: string, clientId: string, clientName: string): ReviewableMemoryCandidate {
  const id = fixtureUuid(label);
  return {
    id, clientId, clientName, scope: 'client', candidateKind: 'standard',
    proposedByUserId: 'proposer', sourceKind: 'chat', createdAt: '2026-09-09T00:00:00Z',
    proposal: { key: `Proposal ${label}`, value: 'A proposed fact', canonicalItem: null },
    capabilities: { approve: true, reject: true },
  };
}

function owned(label: string, overrides: Partial<OwnedMemoryCandidate> = {}): OwnedMemoryCandidate {
  return {
    ...candidate(label, 'l3', 'L3 Harris'), status: 'pending', decidedAt: null,
    restricted: false, capabilities: { withdraw: true }, ...overrides,
  };
}

function packet(clientId: string): MeriContextPacket {
  return {
    packetId: clientId, clientId, persisted: true, persistenceErrorCode: null,
    surface: 'chat', items: [], exclusions: [], unauthorizedCount: 0, degraded: false,
  };
}

function storeDecisionRecovery(
  scope: string,
  input: {
    id: string;
    reviewRequestId: string;
    decision: 'approve' | 'reject' | 'request-changes' | 'resolve-conflict';
  },
  legacyProof: Record<string, unknown> = {},
) {
  window.sessionStorage.setItem(
    `capiro:meri-memory-decision:v1:${encodeURIComponent(scope)}:${input.id}:${input.decision}:none`,
    JSON.stringify({ input, ...legacyProof }),
  );
}

function inboxItem(
  label: string,
  status: MemoryReviewInboxItem['status'] = 'changes_requested',
): MemoryReviewInboxItem {
  return {
    candidateId: fixtureUuid(`${label}-candidate`),
    reviewRequestId: fixtureUuid(`${label}-request`),
    candidateKind: 'correction',
    scope: 'client',
    client: { id: fixtureUuid('client-l3'), name: 'L3 Harris', status: 'active' },
    title: label,
    status,
    revisionNumber: 1,
    rootCandidateId: fixtureUuid(`${label}-candidate`),
    predecessorCandidateId: null,
    submittedBy: { userId: fixtureUuid('proposer'), name: 'Pat Proposer' },
    assignedReviewer: { userId: fixtureUuid('reviewer'), name: 'Priya Reviewer' },
    decidedBy:
      status === 'pending'
        ? null
        : { userId: fixtureUuid('reviewer'), name: 'Priya Reviewer' },
    createdAt: '2026-09-09T00:00:00Z',
    decidedAt: status === 'pending' ? null : '2026-09-09T01:00:00Z',
    blockedReason: null,
    nextAction: status === 'changes_requested' ? 'revise' : 'none',
    capabilities: {
      open: true,
      approve: false,
      reject: false,
      requestChanges: false,
      revise: status === 'changes_requested',
      reassign: false,
      withdraw: false,
    },
  };
}

function detailFor(
  item: MemoryReviewInboxItem,
  overrides: Partial<MemoryReviewDetail> = {},
): MemoryReviewDetail {
  return {
    ...item,
    proposal: { key: item.title, value: 'Original proposal', canonicalItem: null },
    feedbackReason:
      item.status === 'changes_requested' ? 'Add the supporting program office.' : null,
    eligibleReviewers: [],
    timeline: [],
    controllingMemory: null,
    activeMemoryUnchanged: item.status !== 'approved',
    ...overrides,
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
    window.sessionStorage.clear();
    mocks.scope.value = 'org-a:self:actor-a';
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
      '/api/memory/review/inbox',
    ]);
  });

  it('approves, rejects with a required reason, and withdraws the recorded proposal IDs after picker switches', async () => {
    const view = show('anduril');
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('Proposal l3-review')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenNthCalledWith(
      1,
      `/api/memory/review/candidates/${fixtureUuid('l3-review')}/approve`,
      {},
    );
    view.selectClient('l3');
    fireEvent.click(card('Proposal anduril-review').getByRole('button', { name: 'Reject' }));
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    expect(card('Proposal anduril-review').getByRole('button', { name: 'Reject proposal' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Rejection reason' }), { target: { value: '  Source is outdated  ' } });
    view.selectClient('portfolio');
    fireEvent.click(card('Proposal anduril-review').getByRole('button', { name: 'Reject proposal' }));
    await waitFor(() => expect(screen.queryByText('Proposal anduril-review')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenNthCalledWith(
      2,
      `/api/memory/review/candidates/${fixtureUuid('anduril-review')}/reject`,
      { reason: 'Source is outdated' },
    );
    fireEvent.click(card('Proposal own-l3').getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(card('Proposal own-l3').getAllByText(/WITHDRAWN/)).toHaveLength(2));
    expect(mocks.api.post).toHaveBeenNthCalledWith(
      3,
      `/api/memory/proposals/${fixtureUuid('own-l3')}/withdraw`,
      {},
    );
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
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith(
        `/api/memory/proposals/${fixtureUuid('restricted')}/withdraw`,
        {},
      ),
    );
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
      candidateId: fixtureUuid('approved-7'), reviewRequestId: fixtureUuid('request-7'), candidateKind: 'correction',
      scope: 'client', client: { id: 'l3', name: 'L3 Harris', status: 'active' },
      title: 'Approved cadence correction', status: 'approved', revisionNumber: 2,
      rootCandidateId: fixtureUuid('approved-1'), predecessorCandidateId: fixtureUuid('approved-1'),
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
    expect(receipt.getByText(`Review reference: ${fixtureUuid('request-7')}`)).toBeInTheDocument();
    expect(receipt.getByText(`Candidate: ${fixtureUuid('approved-7')}`)).toBeInTheDocument();
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
        requestId: fixtureUuid('review-request-7'), status: 'pending',
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
    expect(proposal.getByText(`Review reference: ${fixtureUuid('review-request-7')}`)).toBeInTheDocument();
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

  it('loads proposer candidate 51 through the canonical cursor contract', async () => {
    const first = Array.from({ length: 50 }, (_, index) => owned(`page-one-${index + 1}`));
    const fiftyFirst = owned('candidate-51');
    mocks.api.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.endsWith('/proposals')) {
        return config?.params?.cursor
          ? { data: { enabled: true, candidates: [fiftyFirst], nextCursor: null } }
          : { data: { enabled: true, candidates: first, nextCursor: 'page-2' } };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: config?.params?.view, items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: review } };
    });
    show();
    await screen.findByText('Proposal page-one-50');
    expect(screen.queryByText('Proposal candidate-51')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more proposals' }));
    expect(await screen.findByText('Proposal candidate-51')).toBeInTheDocument();
    expect(mocks.api.get).toHaveBeenCalledWith('/api/memory/proposals', {
      params: { limit: 50, cursor: 'page-2' },
    });
  });

  it('renders changes_requested and revises through the authorized canonical flow', async () => {
    const correction = inboxItem('Correct Aster cadence');
    const detail = detailFor(correction);
    mocks.api.get.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.includes('/inbox/requests/')) return { data: detail };
      if (url.endsWith('/inbox')) {
        return {
          data: {
            enabled: true,
            view: config?.params?.view,
            items: config?.params?.view === 'submitted_by_me' ? [correction] : [],
            nextCursor: null,
          },
        };
      }
      return {
        data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review },
      };
    });
    mocks.api.post.mockResolvedValue({
      data: {
        predecessorCandidateId: correction.candidateId,
        candidateId: fixtureUuid('revision-successor'),
      },
    });
    show();
    await screen.findByText('Correct Aster cadence');
    const correctionCard = card('Correct Aster cadence');
    expect(correctionCard.getByText(/CHANGES REQUESTED/)).toBeInTheDocument();
    fireEvent.click(correctionCard.getByRole('button', { name: 'Revise and resubmit' }));
    const editor = await correctionCard.findByRole('textbox', { name: 'Revised proposal' });
    fireEvent.change(editor, { target: { value: 'Briefs include the program office.' } });
    fireEvent.click(correctionCard.getByRole('button', { name: 'Submit revision' }));
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith(
        `/api/memory/review/candidates/${correction.candidateId}/revise`,
        { value: 'Briefs include the program office.' },
      ),
    );
  });

  it.each([
    [403, true, 'Review permission denied'],
    [409, false, 'Review changed before this decision'],
  ])(
    'does not attribute HTTP %s terminal state from a wrong review or another actor',
    async (status, wrongId, title) => {
      const requestId = fixtureUuid(`denied-${status}-request`);
      review = [{
        ...review[0]!,
        workflow: {
          requestId,
          status: 'pending',
          submittedBy: { userId: fixtureUuid('proposer'), name: 'Pat Proposer' },
          assignedReviewer: { userId: fixtureUuid('reviewer'), name: 'Priya Reviewer' },
          decidedBy: null,
          feedbackReason: null,
          createdAt: '2026-09-09T00:00:00Z',
          decidedAt: null,
          capabilities: { requestChanges: true, reassign: false },
        },
      }];
      const recorded = inboxItem(`denied-${status}`, 'approved');
      mocks.api.get.mockImplementation(async (url: string) => {
        if (url.includes('/inbox/candidates/')) {
          return {
            data: detailFor(recorded, {
              candidateId: wrongId ? fixtureUuid('wrong-candidate') : review[0]!.id,
              reviewRequestId: wrongId ? fixtureUuid('wrong-request') : requestId,
              decidedBy: { userId: fixtureUuid('other-reviewer'), name: 'Other Reviewer' },
            }),
          };
        }
        if (url.endsWith('/inbox')) {
          return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
        }
        return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
      });
      mocks.api.post.mockRejectedValueOnce({
        response: { status, data: { message: `Injected ${status}` } },
      });
      show();
      await screen.findByText('Proposal l3-review');
      fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByText(/not attributed to your attempted write/i)).toBeInTheDocument();
      expect(mocks.toast.success).not.toHaveBeenCalled();
    },
  );

  it('records conflict_requires_review as unresolved with the current controlling item', async () => {
    const requestId = fixtureUuid('conflict-request');
    const conflictCandidate = {
      ...candidate('conflict-candidate', 'l3', 'L3 Harris'),
      candidateKind: 'learning_signal_conflict' as const,
      conflict: { contradictsMemoryItemId: fixtureUuid('controlling-item'), conflictStatus: 'open' },
      workflow: {
        requestId,
        status: 'pending',
        submittedBy: { userId: fixtureUuid('proposer'), name: 'Pat Proposer' },
        assignedReviewer: { userId: fixtureUuid('reviewer'), name: 'Priya Reviewer' },
        decidedBy: null,
        feedbackReason: null,
        createdAt: '2026-09-09T00:00:00Z',
        decidedAt: null,
        capabilities: { requestChanges: true, reassign: false },
      },
      capabilities: { approve: true, reject: true, resolveConflict: true },
    };
    review = [conflictCandidate];
    const approved = inboxItem('conflict-recorded', 'approved');
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        return { data: detailFor(approved, { candidateId: conflictCandidate.id, reviewRequestId: requestId }) };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });
    mocks.api.post.mockResolvedValue({
      data: {
        candidateId: conflictCandidate.id,
        decision: 'conflict_requires_review',
        outcome: 'conflict',
        controllingItemId: fixtureUuid('controlling-item'),
      },
    });
    show();
    const conflictCard = await screen.findByText('Proposal conflict-candidate');
    fireEvent.click(within(conflictCard.closest('article')!).getByRole('button', { name: 'Resolve conflict' }));
    fireEvent.click(within(conflictCard.closest('article')!).getByRole('button', { name: 'Confirm conflict decision' }));
    expect(await screen.findByText('Conflict remains open')).toBeInTheDocument();
    expect(screen.getByText(/Current controlling item:/)).toHaveTextContent(fixtureUuid('controlling-item'));
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('restores an ambiguous lock with GET only and isolates it across auth scope changes', async () => {
    const requestId = fixtureUuid('ambiguous-request');
    review = [{
      ...review[0]!,
      workflow: {
        requestId,
        status: 'pending',
        submittedBy: { userId: fixtureUuid('proposer'), name: 'Pat Proposer' },
        assignedReviewer: { userId: fixtureUuid('reviewer'), name: 'Priya Reviewer' },
        decidedBy: null,
        feedbackReason: null,
        createdAt: '2026-09-09T00:00:00Z',
        decidedAt: null,
        capabilities: { requestChanges: true, reassign: false },
      },
    }];
    const pending = inboxItem('ambiguous-record', 'pending');
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        return { data: detailFor(pending, { candidateId: review[0]!.id, reviewRequestId: requestId }) };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });
    mocks.api.post.mockRejectedValueOnce(new Error('Lost response'));
    const first = show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    first.unmount();

    const second = show();
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.api.get.mock.calls.filter(([url]) => String(url).includes('/inbox/candidates/')).length).toBeGreaterThanOrEqual(2),
    );
    expect(mocks.api.post).toHaveBeenCalledTimes(1);

    mocks.scope.value = 'org-b:self:actor-b';
    second.selectClient('new-auth-scope');
    await waitFor(() =>
      expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
  });

  it('restores every ambiguous candidate lock after reload and checks each with GET only', async () => {
    const candidates = [
      candidate('ambiguous-one', 'l3', 'L3 Harris'),
      candidate('ambiguous-two', 'anduril', 'Anduril'),
    ];
    review = candidates;
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        const candidateId = url.slice(url.lastIndexOf('/') + 1);
        const pending = inboxItem(`pending-${candidateId}`, 'pending');
        return {
          data: detailFor(pending, {
            candidateId,
            reviewRequestId: candidateId,
          }),
        };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });
    mocks.api.post.mockRejectedValue(new Error('Lost response'));

    const first = show();
    await screen.findByText('Proposal ambiguous-one');
    fireEvent.click(card('Proposal ambiguous-one').getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(card('Proposal ambiguous-two').getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
    fireEvent.click(card('Proposal ambiguous-two').getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.getAllByText('Decision status unconfirmed')).toHaveLength(2),
    );
    expect(card('Proposal ambiguous-one').getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(card('Proposal ambiguous-two').getByRole('button', { name: 'Approve' })).toBeDisabled();
    first.unmount();

    show();
    await screen.findByText('Proposal ambiguous-one');
    await waitFor(() =>
      expect(screen.getAllByText('Decision status unconfirmed')).toHaveLength(2),
    );
    expect(card('Proposal ambiguous-one').getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(card('Proposal ambiguous-two').getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(
      mocks.api.get.mock.calls.filter(([url]) => String(url).includes('/inbox/candidates/')),
    ).toHaveLength(4);
    expect(mocks.api.post).toHaveBeenCalledTimes(2);
  });

  it('skips a malformed same-scope recovery entry and restores the later valid lock', async () => {
    const locked = review[0]!;
    window.sessionStorage.setItem(
      `capiro:meri-memory-decision:v1:${encodeURIComponent(mocks.scope.value)}:malformed`,
      '{not-json',
    );
    storeDecisionRecovery(mocks.scope.value, {
      id: locked.id,
      reviewRequestId: locked.id,
      decision: 'approve',
    });
    const pending = inboxItem('malformed-sibling-pending', 'pending');
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        return {
          data: detailFor(pending, {
            candidateId: locked.id,
            reviewRequestId: locked.id,
          }),
        };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });

    show();
    await screen.findByText('Proposal l3-review');
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(mocks.api.get).toHaveBeenCalledWith(
      `/api/memory/review/inbox/candidates/${locked.id}`,
    );
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it('does not treat stored accepted metadata as causal proof and keeps it within auth scope', async () => {
    const locked = review[0]!;
    storeDecisionRecovery(
      mocks.scope.value,
      { id: locked.id, reviewRequestId: locked.id, decision: 'approve' },
      {
        accepted: true,
        acceptedResult: { candidateId: locked.id, outcome: 'activated' },
      },
    );
    const approved = inboxItem('stored-accepted-approved', 'approved');
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        return {
          data: detailFor(approved, {
            candidateId: locked.id,
            reviewRequestId: locked.id,
          }),
        };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });

    const view = show();
    await screen.findByText('Proposal l3-review');
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    expect(screen.getByText(/No fresh acknowledged decision response is available/)).toBeInTheDocument();
    expect(screen.getByText(/Current recorded status: approved/)).toBeInTheDocument();
    expect(screen.getByText(/terminal read alone is not attributed to your write/)).toBeInTheDocument();
    expect(screen.queryByText('Decision confirmed')).not.toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeDisabled();

    mocks.scope.value = 'org-b:self:actor-b';
    view.selectClient('new-auth-scope');
    await waitFor(() =>
      expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
    expect(mocks.api.post).not.toHaveBeenCalled();
  });

  it('does not confirm an approve when its accepted response reports the reject outcome', async () => {
    const approving = review[0]!;
    const approved = inboxItem('wrong-outcome-approved', 'approved');
    mocks.api.get.mockImplementation(async (url: string) => {
      if (url.includes('/inbox/candidates/')) {
        return {
          data: detailFor(approved, {
            candidateId: approving.id,
            reviewRequestId: approving.id,
          }),
        };
      }
      if (url.endsWith('/inbox')) {
        return { data: { enabled: true, view: 'history', items: [], nextCursor: null } };
      }
      return { data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review } };
    });
    mocks.api.post.mockResolvedValueOnce({
      data: { candidateId: approving.id, outcome: 'rejected' },
    });

    show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Decision status unconfirmed')).toBeInTheDocument();
    expect(screen.getByText(/accepted response did not match the requested decision/i)).toBeInTheDocument();
    expect(screen.getByText(/Current recorded status: approved/)).toBeInTheDocument();
    expect(screen.queryByText('Decision confirmed')).not.toBeInTheDocument();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(card('Proposal l3-review').getByRole('button', { name: 'Approve' })).toBeDisabled();
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
