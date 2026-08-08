import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FederalSpendingPage } from './FederalSpendingPage.js';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

function browserMocks() {
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
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
}

function renderPage(entry = '/intelligence/federal-spending') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <FederalSpendingPage />
        </AntApp>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const contracts = {
  items: [
    {
      id: 'award-1',
      awardId: 'CONT_AWD_1',
      recipientName: 'Prime Robotics LLC',
      recipientUei: 'AAA111BBB222',
      awardingAgency: 'Department of the Army',
      amount: 1_200_000,
      description: 'Autonomous vehicle integration',
      actionDate: '2026-08-01T00:00:00.000Z',
      state: 'VA',
      district: '10',
      districtKey: 'VA-10',
      source: 'usaspending',
      sourceUpdatedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
  source: 'USAspending / Capiro first-party ingestion',
  asOf: '2026-08-08T00:00:00.000Z',
  generatedAt: '2026-08-08T00:00:00.000Z',
};

const subawards = {
  items: [
    {
      id: 'sub-1',
      providerKey: 'sub-1',
      awardKey: 'CONT_AWD_1',
      primeRecipientName: 'Prime Robotics LLC',
      primeRecipientUei: 'AAA111BBB222',
      subawardeeName: 'Virginia Supplier Inc',
      subawardeeUei: 'CCC333DDD444',
      awardingAgency: 'Department of the Army',
      awardingOffice: 'Army Contracting Command',
      amount: 250_000,
      description: 'Component manufacturing',
      actionDate: '2026-08-02T00:00:00.000Z',
      fiscalYear: 2026,
      naicsCode: '336992',
      state: 'VA',
      district: null,
      districtKey: null,
      sourceUrl: 'https://example.gov/subaward',
      source: 'tango',
      sourceUpdatedAt: '2026-08-08T00:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 25,
  source: 'MakeGov/Tango subaward intelligence',
  asOf: '2026-08-08T00:00:00.000Z',
  generatedAt: '2026-08-08T00:00:00.000Z',
};

describe('FederalSpendingPage', () => {
  beforeEach(() => {
    browserMocks();
    apiGetMock.mockReset();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/clients') {
        return { data: [{ id: 'client-1', name: 'Overland AI', status: 'active' }] };
      }
      if (url.includes('/api/federal-spending/market/contracts')) return { data: contracts };
      if (url.includes('/api/federal-spending/market/subawards')) return { data: subawards };
      return {
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 25,
          source: 'MakeGov/Tango',
          asOf: null,
          generatedAt: '2026-08-08T00:00:00.000Z',
        },
      };
    });
  });

  test('starts as a calm scan view with advanced filters hidden', async () => {
    renderPage();

    expect(await screen.findByText('Prime Robotics LLC')).toBeInTheDocument();
    expect(screen.getByText('Federal Spending')).toBeInTheDocument();
    expect(screen.getByText('1 records')).toBeInTheDocument();
    expect(screen.getByText('$1.2M')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Agency or office')).not.toBeInTheDocument();

    // The label sits in a nested span inside the antd button, so match the button
    // by its class hook rather than by accessible name (the icon's own aria-label
    // makes the computed name unreliable).
    const toggle = await screen.findByText('Filters', {
      selector: '.fsm-filter-toggle span',
    });
    fireEvent.click(toggle.closest('button')!);
    expect(screen.getByPlaceholderText('Agency or office')).toBeInTheDocument();
  });

  test('preserves state and exact district when opened from District Nexus', async () => {
    renderPage('/intelligence/federal-spending?state=VA&district=10&clientId=client-1');

    expect(await screen.findByText('District: 10')).toBeInTheDocument();
    await waitFor(() => {
      const marketCall = apiGetMock.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes('/api/federal-spending/market/contracts'));
      expect(marketCall).toContain('state=VA');
      expect(marketCall).toContain('district=10');
      expect(marketCall).toContain('clientId=client-1');
    });
  });

  test('opens one record in a focused drawer and links back to District Nexus', async () => {
    renderPage('/intelligence/federal-spending?clientId=client-1');

    fireEvent.click(await screen.findByText('Prime Robotics LLC'));

    expect(await screen.findByText('CONTRACT AWARD')).toBeInTheDocument();
    expect(screen.getByText('Autonomous vehicle integration')).toBeInTheDocument();
    expect(screen.getByText('AAA111BBB222')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Meri' })).toBeInTheDocument();
    const districtLink = screen.getByRole('link', { name: 'View District Nexus' });
    expect(districtLink.getAttribute('href')).toContain('state=VA');
    expect(districtLink.getAttribute('href')).toContain('district=VA-10');
    expect(districtLink.getAttribute('href')).toContain('clientId=client-1');
  });

  test('keeps Tango subawards on a visibly separate rail and does not invent district geography', async () => {
    renderPage();

    fireEvent.click(await screen.findByText('Subawards'));

    expect(await screen.findByText('Virginia Supplier Inc')).toBeInTheDocument();
    expect(screen.getByText('VA · state only')).toBeInTheDocument();
    expect(screen.getByText(/MakeGov\/Tango subaward intelligence/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/federal-spending/market/subawards'),
      ),
    );
  });

  test('renders a failed request as failure rather than an empty market', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/clients') return { data: [] };
      throw new Error('network down');
    });

    renderPage();

    // The page retries once (retry: 1) before surfacing the error, so allow the
    // retry round-trip to settle.
    expect(
      await screen.findByText('Federal market data could not be loaded', undefined, {
        timeout: 8000,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This is a request failure, not evidence that no records exist/i),
    ).toBeInTheDocument();
  });
});
