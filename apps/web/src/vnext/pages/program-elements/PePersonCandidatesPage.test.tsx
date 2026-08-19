/**
 * Contact review queue (native rebuild) behavior contract:
 *  - role gate: capiro_admin sees the scored queue; user_admin sees the
 *    suggest form (both feed the same backend).
 *  - queue: same endpoint + params, score-desc default order, confirm goes
 *    through the modal (canonical Popconfirm copy), reject posts directly.
 *  - suggest form: canonical validation copy, uppercased/trimmed peCode on
 *    submit.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PePersonCandidatesPage } from './PePersonCandidatesPage.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const useMeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
  }),
}));
vi.mock('../../../lib/me.js', () => ({ useMe: useMeMock }));

const QUEUE = {
  data: {
    data: [
      {
        id: 'cand-low',
        personId: 'p1',
        peCode: '0604201A',
        score: 0.55,
        matchBasis: 'Named in an SBIR award abstract',
        status: 'open',
        person: { id: 'p1', fullName: 'Casey Lowman', organization: 'PEO Aviation', title: 'Deputy PM', role: null },
        programElement: { peCode: '0604201A', title: 'Aircraft Avionics', service: 'Army' },
      },
      {
        id: 'cand-high',
        personId: 'p2',
        peCode: '0603270A',
        score: 0.92,
        matchBasis: 'Program office org chart, March 2026',
        status: 'open',
        person: { id: 'p2', fullName: 'Rae Highsmith', organization: 'DEVCOM', title: 'Program Manager', role: null },
        programElement: { peCode: '0603270A', title: 'EW Advanced Payloads', service: 'Army' },
      },
    ],
    total: 2,
    page: 1,
    limit: 200,
  },
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PePersonCandidatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PePersonCandidatesPage (vNext native)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    useMeMock.mockReset();
  });

  it('capiro_admin sees the review queue, sorted by score descending', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'capiro_admin' } });
    apiGetMock.mockResolvedValue(QUEUE);

    renderPage();

    await waitFor(() => expect(screen.getByText('Rae Highsmith')).toBeInTheDocument());
    expect(apiGetMock).toHaveBeenCalledWith('/api/admin/program-elements/person-candidates', {
      params: { status: 'open', limit: 200 },
    });

    // Score-descending default: the 92% candidate rows above the 55% one.
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Rae Highsmith');
    expect(rows[1]).toHaveTextContent('92%');
    expect(rows[2]).toHaveTextContent('Casey Lowman');
    expect(rows[2]).toHaveTextContent('55%');
  });

  it('confirm goes through the modal with the canonical Popconfirm copy, then posts confirm', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'capiro_admin' } });
    apiGetMock.mockResolvedValue(QUEUE);
    apiPostMock.mockResolvedValue({ data: { resolved: true, linked: true } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Rae Highsmith')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0]!);
    expect(screen.getByText('Confirm this person → PE link?')).toBeInTheDocument();
    expect(
      screen.getByText("This sets the person's primary PE and attaches a citation."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm link' }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/admin/program-elements/person-candidates/cand-high/resolve',
        { decision: 'confirm', notes: undefined },
      ),
    );
  });

  it('reject posts directly without a modal', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'capiro_admin' } });
    apiGetMock.mockResolvedValue(QUEUE);
    apiPostMock.mockResolvedValue({ data: { resolved: true, linked: false } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Rae Highsmith')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/admin/program-elements/person-candidates/cand-high/resolve',
        { decision: 'reject', notes: undefined },
      ),
    );
  });

  it('shows the empty-queue copy when the queue is clear', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'capiro_admin' } });
    apiGetMock.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 200 } });

    renderPage();
    await waitFor(() =>
      expect(screen.getByText('No open candidates — queue is clear.')).toBeInTheDocument(),
    );
  });

  it('non-admin roles see the suggest form and validation uses the canonical copy', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'user_admin' } });

    renderPage();
    expect(await screen.findByText('Suggest a program contact')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Submit suggestion' }));
    expect(await screen.findByText('Enter the PE code, e.g. 0604201A')).toBeInTheDocument();
    expect(screen.getByText('Enter a name')).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('suggest submit trims + uppercases the PE code and posts the canonical body', async () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { role: 'user_admin' } });
    apiPostMock.mockResolvedValue({ data: { suggested: true, candidateId: 'c1' } });

    renderPage();
    await screen.findByText('Suggest a program contact');

    fireEvent.change(screen.getByLabelText('Program Element (PE) code'), {
      target: { value: ' 0604201a ' },
    });
    fireEvent.change(screen.getByLabelText("Person's full name"), {
      target: { value: 'Jane A. Smith' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit suggestion' }));

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/program-elements/0604201A/suggest-person', {
        fullName: 'Jane A. Smith',
        roleTitle: undefined,
        organization: undefined,
        notes: undefined,
      }),
    );
  });
});
