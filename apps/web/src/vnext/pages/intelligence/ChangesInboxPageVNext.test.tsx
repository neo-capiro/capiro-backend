/**
 * Changes Inbox vNext — ported from the canonical suite
 * (pages/intelligence/ChangesInboxPage.test.tsx). Same behavioral
 * assertions: the program_element source renders, the PE pill deep-links
 * into Program Elements, mark-read PATCHes the row, and the empty state
 * distinguishes "a source failed" from "genuinely no changes".
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChangesInboxPageVNext } from './ChangesInboxPageVNext.js';

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    patch: apiPatchMock,
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/intelligence/changes']}>
        <Routes>
          <Route path="/intelligence/changes" element={<ChangesInboxPageVNext />} />
          <Route path="/program-elements/:peCode" element={<div data-testid="pe-watch-destination">PE Watch</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChangesInboxPageVNext', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPatchMock.mockReset();

    apiGetMock.mockImplementation(async (url: string) => {
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
      if (url === '/api/intelligence/portfolio-alerts') {
        return { data: { alerts: [], total: 0, clientCount: 0, generatedAt: '2026-08-18T00:00:00.000Z' } };
      }
      return { data: [] };
    });

    apiPatchMock.mockResolvedValue({ data: {} });
  });

  test(
    'row opens the drawer, marks the change read, and the PE pill navigates to PE Watch',
    async () => {
      renderPage();

      await waitFor(() => expect(screen.getByText(/HASC marked PE 0603270A/i)).toBeInTheDocument());

      const titleCell = screen.getByText(/HASC marked PE 0603270A/i);
      const row = titleCell.closest('tr');
      expect(row).not.toBeNull();
      fireEvent.click(row as HTMLElement);

      // Real persisted rows PATCH consumed=true on open — same as canonical.
      await waitFor(() =>
        expect(apiPatchMock).toHaveBeenCalledWith('/api/intelligence/changes/chg-1', {
          consumed: true,
        }),
      );

      const peTag = await screen.findByRole('button', { name: /PE 0603270A/i });
      expect(screen.getAllByText('program_element').length).toBeGreaterThan(0);
      fireEvent.click(peTag);

      await waitFor(() => expect(screen.getByTestId('pe-watch-destination')).toBeInTheDocument());
    },
    15000,
  );

  /**
   * REGRESSION (carried over from canonical): a failed portfolio-alerts fetch
   * must be visible to the empty-state copy — a real outage may never render
   * identically to "there are genuinely no changes".
   */
  test('a failed portfolio-alerts fetch with no other changes shows a distinct notice, not "No changes found"', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
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

  test('a portfolio alert row with an href navigates instead of PATCHing (synthetic rows have no DB row)', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/intelligence/changes') return { data: [] };
      if (url === '/api/intelligence/portfolio-alerts') {
        return {
          data: {
            alerts: [
              {
                id: 'alert-77',
                type: 'comment_deadline',
                severity: 'critical',
                title: 'Comment window closes for FAR case 2026-013',
                subtitle: 'Overland AI',
                when: '2026-08-15T00:00:00.000Z',
                countdownDays: 3,
                countdownLabel: '3 days left',
                href: '/program-elements/0603270A',
                clientId: 'client-1',
                clientName: 'Overland AI',
              },
            ],
            total: 1,
            clientCount: 1,
            generatedAt: '2026-08-18T00:00:00.000Z',
          },
        };
      }
      return { data: [] };
    });
    renderPage();

    const title = await screen.findByText(/Comment window closes for FAR case 2026-013/i);
    fireEvent.click(title.closest('tr') as HTMLElement);

    await waitFor(() => expect(screen.getByTestId('pe-watch-destination')).toBeInTheDocument());
    expect(apiPatchMock).not.toHaveBeenCalled();
  });
});
