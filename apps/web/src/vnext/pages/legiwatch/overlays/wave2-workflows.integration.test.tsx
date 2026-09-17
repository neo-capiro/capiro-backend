/**
 * LegiWatch V2 Wave 2 — REAL component integration for the new W2-2 (Saved
 * Views), W2-4 (Create Watch wizard), and W2-5 (Coverage) workflows.
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
  method: 'get' | 'put' | 'post' | 'delete';
  url: string;
  body?: unknown;
}

const calls: Call[] = [];
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => 'wave2-test-tenant:analyst',
}));
const handlers = {
  get: vi.fn<(url: string) => unknown>(),
  put: vi.fn<(url: string, body?: unknown) => unknown>(),
  post: vi.fn<(url: string, body?: unknown) => unknown>(),
  delete: vi.fn<(url: string) => unknown>(),
};

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return { data: handlers.get(url) };
    },
    put: async (url: string, body?: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: handlers.put(url, body) };
    },
    post: async (url: string, body?: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: handlers.post(url, body) };
    },
    delete: async (url: string) => {
      calls.push({ method: 'delete', url });
      return { data: handlers.delete(url) };
    },
  }),
}));

import { CreateWatchOverlay } from './CreateWatchOverlay.js';
import { ColdStart } from '../coldstart/ColdStart.js';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENTS = [{ id: CLIENT_A, name: 'Aperture Defense', status: 'active' }];

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
  handlers.put.mockReset();
  handlers.post.mockReset();
  handlers.delete.mockReset();
  handlers.get.mockImplementation((url: string) => {
    throw new Error(`unexpected GET ${url}`);
  });
});

afterEach(() => cleanup());

describe('W2-4 — Create Watch wizard (real 5-step flow)', () => {
  beforeEach(() => {
    handlers.get.mockImplementation((url: string) => {
      if (url === '/api/clients') return CLIENTS;
      throw new Error(`unexpected GET ${url}`);
    });
  });

  it('walks Scope → Signals → Triggers → Preview → Save and creates a real preset', async () => {
    handlers.post.mockImplementation((url: string, body?: unknown) => {
      if (url === '/api/legiwatch/live-hearings/watch-presets/backtest') {
        return {
          id: 'job-1',
          status: 'completed',
          lastError: null,
          queryVersion: 'w2-backtest-v1',
          createdAt: '2026-09-01T00:00:00.000Z',
          completedAt: '2026-09-01T00:00:01.000Z',
          result: {
            evaluatedFrom: '2026-08-02T00:00:00.000Z',
            evaluatedTo: '2026-09-01T00:00:00.000Z',
            corpusCoverage: {
              bill: { evaluated: true },
              hearing: { evaluated: true },
              regulation: { evaluated: false },
              program_element: { evaluated: false },
              state_bill: { evaluated: false },
            },
            totalMatched: 3,
            bySignalFamily: { bill: 3 },
            byPriority: {},
            sampleMatches: [
              {
                packetId: 'p1',
                canonicalObject: {
                  kind: 'bill',
                  id: 'b1',
                  label: 'H.R. 1 — Autonomy Act',
                  detailPath: null,
                },
                occurredAt: '2026-08-15T00:00:00.000Z',
                reasonCodes: [],
                matchedConditions: [],
                evidence: null,
              },
            ],
            unknownOrUnsupportedConditions: [],
            queryVersion: 'w2-backtest-v1',
            asOf: '2026-09-01T00:00:00.000Z',
          },
        };
      }
      if (url === '/api/legiwatch/live-hearings/watch-presets') {
        return {
          id: 'preset-1',
          name: (body as { name: string }).name,
          clientIds: (body as { clientIds: string[] }).clientIds,
          signalFamilies: (body as { signalFamilies: string[] }).signalFamilies,
          conditions: (body as { conditions: unknown[] }).conditions,
          status: 'active',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        };
      }
      throw new Error(`unexpected POST ${url}`);
    });

    const onClose = vi.fn();
    renderWithProviders(<CreateWatchOverlay onClose={onClose} onConfigure={() => {}} />);

    // Step 1 — Scope: name is required to advance.
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Watch name'), {
      target: { value: 'Autonomy funding movement' },
    });
    await screen.findByText('Aperture Defense');
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    // Step 2 — Signals: bill + hearing are pre-selected; keep bill only for a focused test.
    await screen.findByText('Signal families');
    fireEvent.click(screen.getByRole('button', { name: 'Hearings' })); // deselect
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    // Step 3 — Triggers: add a keyword match.
    await screen.findByText('Triggers');
    fireEvent.click(screen.getByText('+ Keyword match'));
    fireEvent.change(screen.getByLabelText('Keyword for trigger 1'), {
      target: { value: 'autonomy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    // Step 4 — Preview: run the real backtest.
    await screen.findByText(
      'Preview runs a REAL query against the last 30 days of historical data — never an estimate.',
    );
    // Both the body's own control and the modal footer's primary action say
    // "Run preview" while no result exists yet — either triggers the backtest.
    fireEvent.click(screen.getAllByRole('button', { name: 'Run preview' })[0]!);
    await screen.findByText('3 matches');
    expect(screen.getByText(/H\.R\. 1 — Autonomy Act/)).toBeTruthy();
    const backtestCall = calls.find(
      (c) => c.url === '/api/legiwatch/live-hearings/watch-presets/backtest',
    );
    expect((backtestCall?.body as { signalFamilies: string[] }).signalFamilies).toEqual(['bill']);
    expect((backtestCall?.body as { windowDays: number }).windowDays).toBe(30);

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    // Step 5 — Save.
    await screen.findByText(/Saved as active/);
    fireEvent.click(screen.getByRole('button', { name: 'Create watch' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const createCall = calls.find(
      (c) => c.method === 'post' && c.url === '/api/legiwatch/live-hearings/watch-presets',
    );
    expect((createCall?.body as { name: string }).name).toBe('Autonomy funding movement');
    expect(
      (createCall?.body as { conditions: Array<{ keyword: string }> }).conditions[0]?.keyword,
    ).toBe('autonomy');
  });

  it('drops a trigger once its family is deselected back in Signals, and re-blocks advancing', async () => {
    handlers.post.mockImplementation((url: string) => {
      throw new Error(`unexpected POST ${url}`);
    });
    renderWithProviders(<CreateWatchOverlay onClose={() => {}} onConfigure={() => {}} />);
    fireEvent.change(screen.getByLabelText('Watch name'), { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await screen.findByText('Signal families');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' })); // keep bill + hearing

    await screen.findByText('Triggers');
    // Keyword match defaults to the first selected family — bills.
    fireEvent.click(screen.getByText('+ Keyword match'));
    fireEvent.change(screen.getByLabelText('Keyword for trigger 1'), { target: { value: 'test' } });
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();

    // Go back to Signals and deselect Bills — the family this trigger uses.
    fireEvent.click(screen.getByRole('button', { name: '2. Signals' }));
    await screen.findByText('Signal families');
    fireEvent.click(screen.getByRole('button', { name: 'Bills' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await screen.findByText(/needs a family no longer selected/);
    // Zero VALID conditions remain — Triggers can no longer advance.
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
  });
});

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
