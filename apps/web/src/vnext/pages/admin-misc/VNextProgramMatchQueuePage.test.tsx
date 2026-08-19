/**
 * Ported from pages/program-element/ProgramMatchQueuePage.test.tsx — same
 * fixtures and endpoint/payload assertions (getProgramMatchQueue /
 * resolveProgramMatch via programs-api.js), adapted to the vNext
 * confirm-dialog flow.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VNextProgramMatchQueuePage } from './VNextProgramMatchQueuePage.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'capiro_admin' }, isLoading: false }),
}));

function candidateRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pm1',
    peCode: '0601102A',
    projectCode: null,
    programId: 'prog-1',
    score: 0.82,
    confidenceBand: 'medium',
    evidenceTier: 'exact_project_title',
    status: 'candidate',
    matchBasis: 'title trigram',
    whyShown: 'project title exact match + R-2A p.144',
    evidence: [{ kind: 'r2a', sourceUrl: 'http://x.pdf', pageNumber: 144, quote: 'Patriot' }],
    programElement: { peCode: '0601102A', title: 'Patriot Dev', service: 'Army' },
    program: { id: 'prog-1', canonicalName: 'PATRIOT', component: 'ARMY', mdapCode: 'M001' },
    createdAt: '2026-06-07T12:00:00.000Z',
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VNextProgramMatchQueuePage />
    </QueryClientProvider>,
  );
}

describe('VNextProgramMatchQueuePage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
  });

  test('renders resolve controls + why-shown + status filter for candidates', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [candidateRow()], total: 1, page: 1, limit: 200 } });

    renderPage();

    expect(await screen.findByText('PATRIOT')).toBeInTheDocument();
    // Why-shown evidence line rendered.
    expect(screen.getByText('project title exact match + R-2A p.144')).toBeInTheDocument();
    // Evidence link with the page anchor.
    const evidenceLink = screen.getByRole('link', { name: /r2a p\.144/ });
    expect(evidenceLink).toHaveAttribute('href', 'http://x.pdf#page=144');
    // Resolve controls present.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quarantine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    // Status filter present + queue queried with the default 'candidate' status.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/programs/admin/match-queue',
      expect.objectContaining({ params: { status: 'candidate', limit: 200 } }),
    );
  });

  test('Accept resolves via POST to the resolve endpoint with decision=accept and per-row notes', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [candidateRow()], total: 1, page: 1, limit: 200 } });
    apiPostMock.mockResolvedValue({
      data: { resolved: true, id: 'pm1', status: 'accepted', decision: 'accept' },
    });

    renderPage();
    await screen.findByText('PATRIOT');

    fireEvent.change(screen.getByLabelText('notes pm1'), { target: { value: 'looks right' } });

    // Click the Accept trigger, then confirm in the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/programs/admin/match-queue/pm1/resolve'),
      expect.objectContaining({ decision: 'accept', notes: 'looks right' }),
    );
  });

  test('shows an honest empty state when the queue is clear', async () => {
    apiGetMock.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 200 } });

    renderPage();

    expect(await screen.findByText('No candidate matches.')).toBeInTheDocument();
  });
});
