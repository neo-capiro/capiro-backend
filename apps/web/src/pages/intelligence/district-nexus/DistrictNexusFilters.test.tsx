import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictNexusFilters, type DistrictNexusFilterState } from './DistrictNexusFilters.js';

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

// antd's Select subscribes to matchMedia (responsive breakpoints) on mount —
// jsdom doesn't implement it. Repo precedent: ProgramElementWatchPage.test.tsx.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const BASE: DistrictNexusFilterState = { clientId: null, state: null, metric: 'nexus', minAmount: 0 };

function renderFilters(value: DistrictNexusFilterState, onChange = vi.fn()) {
  apiGetMock.mockResolvedValue({ data: [{ id: 'c1', name: 'Acme Corp', status: 'active' }] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onChange,
    ...render(
      <QueryClientProvider client={qc}>
        <DistrictNexusFilters value={value} onChange={onChange} resultCount={7} />
      </QueryClientProvider>,
    ),
  };
}

describe('DistrictNexusFilters', () => {
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
        <DistrictNexusFilters value={{ ...BASE, state: 'TX' }} onChange={onChange} resultCount={3} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Clear filters')).toBeTruthy();
  });

  test('clicking "Clear filters" resets client/state/minAmount but preserves the chosen metric', () => {
    const onChange = vi.fn();
    renderFilters({ clientId: 'c1', state: 'TX', metric: 'contracts', minAmount: 5_000_000 }, onChange);
    screen.getByText('Clear filters').click();
    expect(onChange).toHaveBeenCalledWith({ clientId: null, state: null, metric: 'contracts', minAmount: 0 });
  });
});
