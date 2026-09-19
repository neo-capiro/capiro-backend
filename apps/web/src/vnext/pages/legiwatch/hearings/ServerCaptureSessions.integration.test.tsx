import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));
vi.mock('../../../../state/impersonation.js', () => ({ useImpersonation: () => ({ actAsTenantSlug: null }) }));

import { ServerCaptureSessions } from './ServerCaptureSessions.js';

const ROW = {
  id: 'sen-119-1',
  title: 'Oversight of the Federal Bureau of Investigation',
  committeeName: 'Judiciary',
  chamber: 'Senate',
  eventStatus: 'scheduled',
  visibility: 'public',
  date: '2026-09-20',
  startsAt: '2026-09-20T14:00:00Z',
  time: null,
  timeZone: 'America/New_York',
  location: null,
  officialPageUrl: null,
  capture: null,
  capturePending: true,
  scheduleSource: { byUser: true, byRule: false, ruleId: null },
};

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/legiwatch?sub=sessions']}>
        <Routes>
          <Route path="/legiwatch" element={<ServerCaptureSessions />} />
          <Route path="/legiwatch/hearings/:id" element={<div>Hearing detail reached</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
});
afterEach(cleanup);

describe('ServerCaptureSessions (My Sessions durable server list)', () => {
  it('renders a scheduled (capture-pending) row immediately and opens the canonical hearing detail', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url.startsWith('/api/legiwatch/live-hearings/server-sessions'))
        return { data: { rows: [ROW], total: 1, page: 1, pageSize: 50 } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPanel();
    const region = await screen.findByLabelText('Server captures list');
    const row = await within(region).findByRole('button', { name: /Oversight of the Federal Bureau/ });
    expect(within(region).getByText('SCHEDULED')).toBeInTheDocument();
    fireEvent.click(row);
    expect(await screen.findByText('Hearing detail reached')).toBeInTheDocument();
  });

  it('opens a row via keyboard (Enter)', async () => {
    apiGet.mockResolvedValue({ data: { rows: [ROW], total: 1, page: 1, pageSize: 50 } });
    renderPanel();
    const row = await screen.findByRole('button', { name: /Oversight of the Federal Bureau/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(await screen.findByText('Hearing detail reached')).toBeInTheDocument();
  });

  it('shows completed and failed lifecycle states and honest canceled status', async () => {
    const completed = { ...ROW, id: 'h-done', title: 'Completed hearing', capture: { id: 'c1', status: 'COMPLETE', actualStart: null, actualEnd: null }, capturePending: false, eventStatus: 'completed' };
    const failed = { ...ROW, id: 'h-fail', title: 'Failed hearing', capture: { id: 'c2', status: 'FAILED', actualStart: null, actualEnd: null }, capturePending: false };
    const canceled = { ...ROW, id: 'h-cx', title: 'Canceled hearing', eventStatus: 'canceled' };
    apiGet.mockResolvedValue({ data: { rows: [completed, failed, canceled], total: 3, page: 1, pageSize: 50 } });
    renderPanel();
    const region = await screen.findByLabelText('Server captures list');
    expect(await within(region).findByText('COMPLETE')).toBeInTheDocument();
    expect(within(region).getByText('FAILED')).toBeInTheDocument();
    expect(within(region).getByText(/Proceeding canceled/)).toBeInTheDocument();
  });

  it('paginates through older server captures', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url.includes('page=1')) return { data: { rows: [ROW], total: 60, page: 1, pageSize: 50 } };
      if (url.includes('page=2')) return { data: { rows: [{ ...ROW, id: 'h-old', title: 'Older hearing' }], total: 60, page: 2, pageSize: 50 } };
      throw new Error(`unexpected GET ${url}`);
    });
    renderPanel();
    const older = await screen.findByRole('button', { name: 'Older' });
    fireEvent.click(older);
    await waitFor(() => expect(apiGet.mock.calls.some(([u]) => u.includes('page=2'))).toBe(true));
    expect(await screen.findByText('Older hearing')).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing is scheduled', async () => {
    apiGet.mockResolvedValue({ data: { rows: [], total: 0, page: 1, pageSize: 50 } });
    renderPanel();
    expect(await screen.findByText(/No server captures yet/)).toBeInTheDocument();
  });

  it('surfaces an unavailable state instead of implying nothing is scheduled', async () => {
    apiGet.mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/No server captures yet/)).not.toBeInTheDocument();
  });
});
