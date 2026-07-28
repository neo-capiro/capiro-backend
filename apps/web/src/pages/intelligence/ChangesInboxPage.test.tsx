import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChangesInboxPage } from './ChangesInboxPage.js';

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    patch: apiPatchMock,
  }),
}));

function setupBrowserMocks() {
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

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/intelligence/changes']}>
        <Routes>
          <Route path="/intelligence/changes" element={<ChangesInboxPage />} />
          <Route path="/program-elements/:peCode" element={<div data-testid="pe-watch-destination">PE Watch</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChangesInboxPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();
    setupBrowserMocks();

    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/comment-alerts') {
        return { data: { alerts: [] } };
      }
      if (url === '/api/intelligence/changes') {
        return {
          data: [
            {
              id: 'chg-1',
              source: 'program_element',
              changeType: 'pe_mark_added',
              severity: 'notable',
              title: 'HASC marked PE 0603270A at $537M (+$50M over request)',
              description: 'Program element mark changed',
              relatedClientIds: ['client-1'],
              relatedIssues: [],
              relatedPeCodes: ['0603270A'],
              data: { fy: 2026, field: 'hascMark', oldValue: 487000000, newValue: 537000000, deltaPct: 10.27 },
              detectedAt: '2026-05-28T10:00:00.000Z',
              consumed: false,
            },
          ],
        };
      }
      return { data: [] };
    });

    apiPatchMock.mockResolvedValue({ data: {} });
  });

  test(
    'filter includes program_element source and PE pill navigates to PE Watch',
    async () => {
      renderPage();

      await waitFor(() => expect(screen.getByText(/HASC marked PE 0603270A/i)).toBeInTheDocument());

      const titleCell = screen.getByText(/HASC marked PE 0603270A/i);
      const row = titleCell.closest('tr');
      expect(row).not.toBeNull();
      fireEvent.click(row as HTMLElement);

      const peTag = await screen.findByRole('button', { name: /PE 0603270A/i });
      expect(screen.getAllByText('program_element').length).toBeGreaterThan(0);
      fireEvent.click(peTag);

      await waitFor(() => expect(screen.getByTestId('pe-watch-destination')).toBeInTheDocument());
    },
    15000,
  );

  /**
   * REGRESSION: portfolioAlertsQuery used to catch its own failure and return
   * an empty shape, so a real outage on that source rendered identically to
   * "there are genuinely no changes". These pin that a failure is now visible
   * to the empty-state copy, and that a real empty result still reads as empty.
   */
  test('a failed portfolio-alerts fetch with no other changes shows a distinct notice, not "No changes found"', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/comment-alerts') return { data: { alerts: [] } };
      if (url === '/api/intelligence/changes') return { data: [] };
      if (url === '/api/intelligence/portfolio-alerts') throw new Error('boom');
      return { data: [] };
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load some sources/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText('No changes found')).toBeNull();
  });

  test('genuinely no changes and a successful (empty) portfolio-alerts fetch shows "No changes found"', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/comment-alerts') return { data: { alerts: [] } };
      if (url === '/api/intelligence/changes') return { data: [] };
      if (url === '/api/intelligence/portfolio-alerts') {
        return { data: { alerts: [], total: 0, clientCount: 0, generatedAt: '2026-07-26T00:00:00.000Z' } };
      }
      return { data: [] };
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('No changes found')).toBeInTheDocument());
    expect(screen.queryByText(/Couldn't load some sources/i)).toBeNull();
  });
});
