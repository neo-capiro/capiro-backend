import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OwnedMemoryCandidate,
  ReviewableMemoryCandidate,
} from '../../components/memory-queue-shared.js';
import { memoryCandidateTargetLabel } from '../../components/memory-queue-shared.js';
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

  beforeEach(() => {
    vi.clearAllMocks();
    review = [candidate('l3-review', 'l3', 'L3 Harris'), candidate('anduril-review', 'anduril', 'Anduril')];
    proposals = [owned('own-l3')];
    mocks.api.get.mockImplementation(async (url: string) => ({
      data: { enabled: true, candidates: url.endsWith('/proposals') ? proposals : review },
    }));
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
      '/api/memory/review/candidates', '/api/memory/proposals',
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
    await waitFor(() => expect(card('Proposal own-l3').getByText(/WITHDRAWN/)).toBeInTheDocument());
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

  it('keeps an authorization failure visible without claiming that the proposal changed', async () => {
    mocks.api.post.mockRejectedValue({ response: { data: { message: 'Review authorization changed' } } });
    show();
    await screen.findByText('Proposal l3-review');
    fireEvent.click(card('Proposal l3-review').getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Review authorization changed'));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(card('Proposal l3-review').getByText('Target: L3 Harris')).toBeInTheDocument();
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
