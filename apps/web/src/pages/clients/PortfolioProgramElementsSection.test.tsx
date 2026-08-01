import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PortfolioProgramElementsSection } from './PortfolioProgramElementsSection.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
  }),
}));

vi.mock('../actions/actions-api.js', () => ({
  useActionsList: () => ({
    data: {
      data: [
        {
          id: 'action-1',
          peCode: '0603270A',
          status: 'triaged',
        },
      ],
      total: 1,
      page: 1,
      limit: 100,
    },
    isLoading: false,
  }),
}));

const ROW = {
  peCode: '0603270A',
  title: 'Army Electronic Warfare Technology',
  service: 'ARMY',
  budgetActivity: '03',
  appropriationType: 'RDTE',
  status: 'active',
  lastSyncedAt: '2026-07-30T00:00:00.000Z',
  latestCurrent: 310.5,
  latestCurrentFy: 2027,
  latestCurrentStage: 'conference',
  latestRequest: 260.9,
  latestRequestFy: 2027,
  deltaPct: 19,
  spark: [258, 273, 281, 298, 233, 310.5],
  watched: true,
  billCount: 2,
  signalType: 'mark_vs_request',
  signalScore: 0.8,
};

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
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

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <PortfolioProgramElementsSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PortfolioProgramElementsSection', () => {
  beforeEach(() => {
    setupBrowserMocks();
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiGetMock.mockResolvedValue({
      data: { data: [ROW], total: 1, page: 1, limit: 100 },
    });
    apiPostMock.mockResolvedValue({
      data: { peCode: ROW.peCode, watching: false },
    });
  });

  test('renders monitored program elements as portfolio cards', async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText(ROW.peCode)).toBeInTheDocument());
    expect(screen.getByText(ROW.title)).toBeInTheDocument();
    expect(screen.getByText('$310.5M')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  test('opens the add-program-element search modal', async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText(ROW.peCode)).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Add program element' })[0]!);

    expect(await screen.findByText('Add a program element')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/0603270A or electronic warfare/i)).toBeInTheDocument();
  });

  test('uses the existing watch mutation when removing a card', async () => {
    renderSection();
    const remove = await screen.findByRole('button', {
      name: `Stop monitoring ${ROW.peCode}`,
    });

    fireEvent.click(remove);

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(`/api/program-elements/${ROW.peCode}/watch`, {
        watching: false,
      }),
    );
  });
});
