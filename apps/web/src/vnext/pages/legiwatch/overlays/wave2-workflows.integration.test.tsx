/**
 * LegiWatch V2 Wave 2 — REAL component integration for the W2-5 (Coverage)
 * workflow. The W2-4 (Create Watch wizard) feature was removed; W2-2 (Saved
 * Views) was removed earlier.
 *
 * Same convention as wave1-workflows.integration.test.tsx: render the actual
 * component tree with `useApi` stubbed and every call recorded, so assertions
 * exercise real state transitions and real request bodies — never source text.
 */
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call {
  method: 'get';
  url: string;
}

const calls: Call[] = [];
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => 'wave2-test-tenant:analyst',
}));
const handlers = {
  get: vi.fn<(url: string) => unknown>(),
};

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return { data: handlers.get(url) };
    },
  }),
}));

import { ColdStart } from '../coldstart/ColdStart.js';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';

function renderWithProviders(ui: ReactElement, initialPath = '/legiwatch?tab=hearings') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  handlers.get.mockReset();
  handlers.get.mockImplementation((url: string) => {
    throw new Error(`unexpected GET ${url}`);
  });
});

afterEach(() => cleanup());

describe('W2-5 — Coverage score in Cold Start', () => {
  it('renders the real coverage percentage and status, never a fabricated NOT READY', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/tracker/watchlists/')) return { issueAreas: ['defense'] };
      if (url.includes('/coverage')) {
        return {
          clientId: CLIENT_A,
          asOf: '2026-09-01T00:00:00.000Z',
          overall: { coveredConcepts: 3, totalConcepts: 4, percentage: 75, status: 'PARTIAL' },
          concepts: [],
          signalFamilies: [],
          sourceHealth: { healthy: 1, degraded: 0, failing: 0, stale: 0, acceptedExceptions: 0 },
          recommendations: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderWithProviders(<ColdStart clientId={CLIENT_A} onConfigure={() => {}} />);
    await screen.findByText('75%');
    expect(screen.getByText('PARTIAL')).toBeTruthy();
    expect(screen.getByText(/3 of 4 concepts covered/)).toBeTruthy();
  });

  it('renders NOT CONFIGURED (not 0%) when the client has no watchlist concepts', async () => {
    handlers.get.mockImplementation((url: string) => {
      if (url.includes('/tracker/watchlists/')) return {};
      if (url.includes('/coverage')) {
        return {
          clientId: CLIENT_A,
          asOf: '2026-09-01T00:00:00.000Z',
          overall: {
            coveredConcepts: 0,
            totalConcepts: 0,
            percentage: null,
            status: 'NOT_CONFIGURED',
          },
          concepts: [],
          signalFamilies: [],
          sourceHealth: { healthy: 0, degraded: 0, failing: 0, stale: 0, acceptedExceptions: 0 },
          recommendations: [],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });

    renderWithProviders(<ColdStart clientId={CLIENT_A} onConfigure={() => {}} />);
    await screen.findByText('NOT CONFIGURED');
    expect(screen.queryByText('0%')).toBeNull();
  });
});
