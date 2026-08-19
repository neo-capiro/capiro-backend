/**
 * Native workspace behavior contract:
 *  - the destination bar renders all five destinations and dest is URL query
 *    state (?dest=…, explore default, replace-style updates);
 *  - the Explore grid renders real rows from the same list endpoint with the
 *    same params (page/limit contract), and the paired-FY delta math surfaces
 *    (+25.0% for a 125-vs-100 same-FY pair — a real distinguishing value, not
 *    a fixture string);
 *  - the summary strip prints MONITORED · n and open-markup counts from the
 *    summary endpoint.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PeWorkspacePage } from './PeWorkspacePage.js';

const apiGetMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
  }),
}));

const LIST_ITEM = {
  peCode: '0604999Z',
  title: 'Hypersonic Test Article',
  service: 'ARMY',
  lineType: 'RDTE_PE',
  appropriationType: null,
  budgetActivity: '6.4',
  latestRequest: 100,
  latestRequestFy: 2027,
  latestCurrent: 125,
  latestCurrentFy: 2027,
  latestCurrentStage: 'hasc',
  deltaPct: null,
  spark: [80, 90, 100, 125],
  watched: true,
  signalType: null,
  signalDeltaPct: null,
  actionSignalType: null,
  billCount: 2,
};

function mockApiByUrl() {
  apiGetMock.mockImplementation((url: string) => {
    if (url === '/api/program-elements/summary') {
      return Promise.resolve({
        data: { watched: 3, openMarkups: 2, latestRequestFy: 2027, trend: [], byService: [] },
      });
    }
    if (url === '/api/program-elements') {
      return Promise.resolve({ data: { data: [LIST_ITEM], total: 1, page: 1, limit: 50 } });
    }
    if (url === '/api/budget-lines/movement') {
      return Promise.resolve({ data: { feed: [], openFy: 2027 } });
    }
    if (url === '/api/intelligence/actions') {
      return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 100 } });
    }
    if (url.endsWith('/client-relevance')) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: {} });
  });
}

function renderAt(path = '/program-elements') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <PeWorkspacePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeWorkspacePage (vNext native)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    mockApiByUrl();
  });

  it('renders the five destinations with Explore as the default and the summary meta', async () => {
    renderAt();

    for (const label of ['Explore', 'Movement', 'Congressional', 'Actions', 'Portfolio']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(document.querySelector('[data-screen-label="Explore"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Explore' })).toHaveAttribute('aria-current', 'page');

    await waitFor(() => expect(screen.getByText(/MONITORED · 3/)).toBeInTheDocument());
    expect(screen.getByText(/2 OPEN MARKUPS/)).toBeInTheDocument();
  });

  it('renders Explore rows from the shared list endpoint with the canonical page/limit params', async () => {
    renderAt();

    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());
    expect(screen.getByText('Hypersonic Test Article')).toBeInTheDocument();
    // Paired-FY delta math: 125 vs 100 in FY2027 → +25.0%.
    expect(screen.getByText('+25.0%')).toBeInTheDocument();
    // Stage prints the mockup short label.
    expect(screen.getByText('HASC')).toBeInTheDocument();

    expect(apiGetMock).toHaveBeenCalledWith('/api/program-elements', {
      params: {
        q: undefined,
        service: undefined,
        line_type: undefined,
        watched: undefined,
        page: 1,
        limit: 50,
      },
    });
  });

  it('honors ?dest= deep links (URL state, not component state)', async () => {
    renderAt('/program-elements?dest=movement');

    expect(document.querySelector('[data-screen-label="Movement"]')).not.toBeNull();
    expect(document.querySelector('[data-screen-label="Explore"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Movement' })).toHaveAttribute('aria-current', 'page');
    await waitFor(() =>
      expect(screen.getByText('No movement matches every filter')).toBeInTheDocument(),
    );
  });

  it('switches destination through the bar', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Movement' }));
    expect(document.querySelector('[data-screen-label="Movement"]')).not.toBeNull();
    expect(document.querySelector('[data-screen-label="Explore"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    await waitFor(() =>
      expect(document.querySelector('[data-screen-label="Explore"]')).not.toBeNull(),
    );
  });
});
