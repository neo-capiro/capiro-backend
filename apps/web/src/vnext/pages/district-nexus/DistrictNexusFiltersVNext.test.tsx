import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictNexusFiltersVNext, type DistrictNexusFilterState } from './DistrictNexusFiltersVNext.js';

/** vNext port of DistrictNexusFilters.test.tsx (no antd matchMedia shims —
 * CapiroSelect is a native select). */

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

const BASE: DistrictNexusFilterState = {
  clientId: null,
  state: null,
  metric: 'nexus',
  minAmount: 0,
  gapFilter: false,
};

function renderFilters(value: DistrictNexusFilterState, onChange = vi.fn()) {
  apiGetMock.mockResolvedValue({ data: [{ id: 'c1', name: 'Acme Corp', status: 'active' }] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onChange,
    ...render(
      <QueryClientProvider client={qc}>
        <DistrictNexusFiltersVNext value={value} onChange={onChange} resultCount={7} />
      </QueryClientProvider>,
    ),
  };
}

describe('DistrictNexusFiltersVNext', () => {
  beforeEach(() => apiGetMock.mockReset());

  test('shows the result count', () => {
    renderFilters(BASE);
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('districts')).toBeTruthy();
  });

  test('"Clear filters" is hidden with no active filters, and appears once one is set', () => {
    const { rerender, onChange } = renderFilters(BASE);
    expect(screen.queryByText('Clear filters')).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DistrictNexusFiltersVNext value={{ ...BASE, state: 'TX' }} onChange={onChange} resultCount={3} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Clear filters')).toBeTruthy();
  });

  test('clicking "Clear filters" resets client/state/minAmount/gap but preserves the chosen metric', () => {
    const onChange = vi.fn();
    renderFilters(
      { clientId: 'c1', state: 'TX', metric: 'contracts', minAmount: 5_000_000, gapFilter: true },
      onChange,
    );
    screen.getByText('Clear filters').click();
    expect(onChange).toHaveBeenCalledWith({
      clientId: null,
      state: null,
      metric: 'contracts',
      minAmount: 0,
      gapFilter: false,
    });
  });

  test('changing State emits the server-backed filter value, and clearing it emits null', () => {
    const onChange = vi.fn();
    renderFilters(BASE, onChange);
    const stateSelect = screen.getByLabelText('Filter by state');
    fireEvent.change(stateSelect, { target: { value: 'TX' } });
    expect(onChange).toHaveBeenCalledWith({ ...BASE, state: 'TX' });
    fireEvent.change(stateSelect, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...BASE, state: null });
  });

  test('archived clients never appear as filter options', async () => {
    apiGetMock.mockResolvedValue({
      data: [
        { id: 'c1', name: 'Acme Corp', status: 'active' },
        { id: 'c2', name: 'Closed LLC', status: 'archived' },
      ],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DistrictNexusFiltersVNext value={BASE} onChange={vi.fn()} resultCount={7} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Acme Corp')).toBeTruthy();
    expect(screen.queryByText('Closed LLC')).toBeNull();
  });
});
