/**
 * Port of src/pages/program-element/MarkupMonitorPage.test.tsx onto the native
 * vNext rebuild. The behavior assertions are unchanged — mark-cell color
 * thresholds (110%/95%), $x.xxm formatting, divergence default-desc sort,
 * service + threshold filtering, and the empty-state copy. Only the control
 * interactions differ: a native <select> (still role "combobox") replaces the
 * antd Select dropdown dance, and the threshold input stays role "spinbutton".
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PeMarkupMonitorPage } from './PeMarkupMonitorPage.js';

const apiGetMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
  }),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PeMarkupMonitorPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeMarkupMonitorPage (vNext native)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  test('renders watched PEs and color thresholds are correct', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        data: [
          {
            peCode: '0603270A',
            title: 'EW Advanced Payloads',
            service: 'Army',
            request: 100,
            hascMark: 111,
            sascMark: 100,
            hacDMark: 90,
            sacDMark: null,
            divergencePct: 21,
          },
        ],
        total: 1,
        page: 1,
        limit: 1,
      },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('0603270A')).toBeInTheDocument());

    expect(screen.getByText('EW Advanced Payloads')).toBeInTheDocument();
    expect(screen.getAllByText('$100.00m').length).toBeGreaterThan(0);
    expect(screen.getByText('21.0%')).toBeInTheDocument();

    expect(screen.getByTestId('mark-cell-green')).toHaveTextContent('$111.00m');
    expect(screen.getByTestId('mark-cell-gold')).toHaveTextContent('$100.00m');
    expect(screen.getByTestId('mark-cell-red')).toHaveTextContent('$90.00m');
    expect(screen.getByTestId('mark-cell-default')).toHaveTextContent('-');

    // The endpoint contract is unchanged: mode=markup-monitor on the shared list URL.
    expect(apiGetMock).toHaveBeenCalledWith('/api/program-elements', {
      params: { mode: 'markup-monitor', service: undefined, divergence_threshold: 0 },
    });
  });

  test(
    'sorts divergence descending by default and filters by service + threshold',
    async () => {
      apiGetMock.mockResolvedValue({
        data: {
          data: [
            {
              peCode: '0601000A',
              title: 'Army Program',
              service: 'Army',
              request: 100,
              hascMark: 110,
              sascMark: 103,
              hacDMark: 100,
              sacDMark: 105,
              divergencePct: 10,
            },
            {
              peCode: '0602000N',
              title: 'Navy Program',
              service: 'Navy',
              request: 100,
              hascMark: 130,
              sascMark: 100,
              hacDMark: 95,
              sacDMark: 110,
              divergencePct: 35,
            },
            {
              peCode: '0603000F',
              title: 'Air Force Program',
              service: 'Air Force',
              request: 100,
              hascMark: 115,
              sascMark: 112,
              hacDMark: 110,
              sacDMark: 111,
              divergencePct: 5,
            },
          ],
          total: 3,
          page: 1,
          limit: 3,
        },
      });

      renderPage();

      await waitFor(() => expect(screen.getByText('0601000A')).toBeInTheDocument());

      // Default sort: divergence descending — Navy (35) first after the header row.
      const rowsBefore = screen.getAllByRole('row');
      expect(rowsBefore[1]).toHaveTextContent('0602000N');

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Army' } });

      await waitFor(() => {
        expect(screen.getByText('0601000A')).toBeInTheDocument();
        expect(screen.queryByText('0602000N')).toBeNull();
        expect(screen.queryByText('0603000F')).toBeNull();
      });

      const thresholdInput = screen.getByRole('spinbutton');
      fireEvent.change(thresholdInput, { target: { value: '12' } });

      await waitFor(() => {
        expect(screen.queryByText('0601000A')).toBeNull();
      });
    },
    15000,
  );

  test('shows empty state when no watched PEs', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        data: [],
        total: 0,
        page: 1,
        limit: 0,
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Watch some PEs to populate this view')).toBeInTheDocument();
    });
  });
});
