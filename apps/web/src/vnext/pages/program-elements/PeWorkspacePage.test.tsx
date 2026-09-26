/**
 * Native workspace behavior contract:
 *  - the destination bar renders all five destinations and dest is URL query
 *    state (?dest=…, explore default, replace-style updates);
 *  - the Explore catalog renders real rows from the same list endpoint with the
 *    same params (page/limit contract), and the paired-FY delta math surfaces
 *    (+25.0% for a 125-vs-100 same-FY pair — a real distinguishing value, not
 *    a fixture string);
 *  - the summary strip prints MONITORED · n and open-markup counts from the
 *    summary endpoint.
 *
 * Phase 4 note: the destination bar is a `CapiroTabs` tablist and the catalog
 * is a real `<table>`, so the assertions below are written against ARIA roles
 * (tab / tablist / table / columnheader / checkbox) rather than the old
 * `.pe-v2-*` classnames — the same coverage, pinned to semantics the re-skin
 * cannot silently drop.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    const tablist = screen.getByRole('tablist', { name: 'Defense Budget destinations' });
    for (const label of ['Explore', 'Movement', 'Congressional', 'Actions', 'Portfolio']) {
      expect(within(tablist).getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(document.querySelector('[data-screen-label="Explore"]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Movement' })).toHaveAttribute('aria-selected', 'false');

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
        capability: undefined,
        fy: 2027,
        watched: undefined,
        page: 1,
        limit: 50,
      },
    });
  });

  it('renders the catalog as a real table with the full column contract', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());

    const table = screen.getByRole('table');
    // Column groups (row 1) and columns (row 2) are both header cells.
    for (const group of [
      'Identity',
      'Classification',
      'FY27 position',
      'Movement vs request',
      'Evidence',
      'Client impact & action',
    ]) {
      expect(within(table).getByRole('columnheader', { name: group })).toBeInTheDocument();
    }
    for (const column of [
      'Program / budget line',
      'Component',
      'Type',
      'Request',
      'Current',
      'Stage',
      'Δ request',
      'FY trend',
      'State',
      'Clients',
      'Recommended',
    ]) {
      expect(within(table).getByRole('columnheader', { name: column })).toBeInTheDocument();
    }
    // One data row plus the two header rows.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('selects rows through real checkboxes and surfaces the selection command bar', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());

    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 0604999Z' }));

    const selectionBar = screen.getByRole('region', { name: 'Selection' });
    expect(within(selectionBar).getByText('1 budget line')).toBeInTheDocument();
    expect(within(selectionBar).getByRole('button', { name: 'Create action' })).toBeInTheDocument();
    // Compare needs two lines — the disabled contract is unchanged.
    expect(within(selectionBar).getByRole('button', { name: 'Compare' })).toBeDisabled();

    fireEvent.click(within(selectionBar).getByRole('button', { name: 'Clear ⎋' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();
  });

  it('expands a row into the evidence region and collapses it again', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());

    const expander = screen.getByRole('button', { name: 'Expand 0604999Z' });
    expect(expander).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expander);

    expect(screen.getByText('What changed')).toBeInTheDocument();
    expect(screen.getByText('Client exposure')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse 0604999Z' }));
    expect(screen.queryByText('What changed')).not.toBeInTheDocument();
  });

  it('honors ?dest= deep links (URL state, not component state)', async () => {
    renderAt('/program-elements?dest=movement');

    expect(document.querySelector('[data-screen-label="Movement"]')).not.toBeNull();
    expect(document.querySelector('[data-screen-label="Explore"]')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Movement' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() =>
      expect(screen.getByText('No movement matches every filter')).toBeInTheDocument(),
    );
  });

  it('switches destination through the bar', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('0604999Z')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Movement' }));
    expect(document.querySelector('[data-screen-label="Movement"]')).not.toBeNull();
    expect(document.querySelector('[data-screen-label="Explore"]')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Explore' }));
    await waitFor(() =>
      expect(document.querySelector('[data-screen-label="Explore"]')).not.toBeNull(),
    );
  });
});
