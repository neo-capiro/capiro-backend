/**
 * Ported from pages/admin/AnalystConsolePage.test.tsx — same URL-routed GET
 * fixtures, same SLA aria-label assertions (the chip copy is identical), same
 * quarantine / audit-log / alias-manager behavior assertions, adapted to the
 * vNext tab strip (role=tab), native select, and confirm-dialog flow.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { VNextAnalystConsolePage } from './VNextAnalystConsolePage.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const apiDeleteMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: apiPatchMock, delete: apiDeleteMock }),
}));

let meRole = 'capiro_admin';
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: meRole }, isLoading: false }),
}));

const REVIEW_COUNTS = {
  reconciliation: { openCount: 4, oldestOpenAt: '2026-06-04T12:00:00.000Z' },
  programMatch: { openCount: 2, quarantinedCount: 1, oldestOpenAt: '2026-06-07T12:00:00.000Z' },
  personCandidate: { openCount: 3, oldestOpenAt: '2026-06-06T12:00:00.000Z' },
  personnelMerge: { openCount: 0, oldestOpenAt: null },
  provisionPeLink: { candidateCount: 5, oldestOpenAt: '2026-06-05T12:00:00.000Z' },
  programQuarantine: { count: 7 },
  personnelQuarantine: { count: 0 },
};

const QUARANTINE_RESPONSE = {
  data: [
    {
      id: 'q1',
      rawRecord: { peCode: 'BAD', title: 'x' },
      reason: 'Invalid pe_code: BAD',
      source: 'pdoc_fy2027',
      quarantinedAt: '2026-06-07T12:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 25,
};

const AUDIT_RESPONSE = {
  data: [
    {
      id: 'a1',
      actorUserId: 'u1',
      actorRole: 'capiro_admin',
      action: 'program.merge',
      entityType: 'program',
      entityId: 'prog-2',
      before: { mergeProgramId: 'prog-2' },
      after: { keepProgramId: 'prog-1' },
      occurredAt: '2026-06-07T12:00:00.000Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 25,
};

const PROGRAM_SEARCH = {
  data: [{ id: 'prog-1', canonicalName: 'PATRIOT', component: 'ARMY', mdapCode: 'M001', status: 'active' }],
  total: 1,
  q: '',
};

const ALIASES = {
  programId: 'prog-1',
  data: [
    {
      id: 'al1',
      programId: 'prog-1',
      alias: 'Patriot Advanced Capability',
      aliasNormalized: 'PATRIOT ADVANCED CAPABILITY',
      aliasType: 'project_title',
      source: 'analyst',
      sourceUrl: null,
      confidence: 0.9,
    },
  ],
  total: 1,
};

const DUPLICATE_ALIASES = {
  data: [
    {
      aliasNormalized: 'PATRIOT',
      programs: [
        { programId: 'prog-1', canonicalName: 'PATRIOT', status: 'active', aliasId: 'al1' },
        { programId: 'prog-2', canonicalName: 'Patriot (dup)', status: 'active', aliasId: 'al2' },
      ],
    },
  ],
  total: 1,
};

/** Route GET calls to the right fixture by URL so every mounted tab self-fetches. */
function routeGet(url: string) {
  if (url === '/api/capiro-admin/review-counts') return Promise.resolve({ data: REVIEW_COUNTS });
  if (url === '/api/capiro-admin/quarantine') return Promise.resolve({ data: QUARANTINE_RESPONSE });
  if (url === '/api/capiro-admin/audit-logs') return Promise.resolve({ data: AUDIT_RESPONSE });
  if (url === '/api/programs') return Promise.resolve({ data: PROGRAM_SEARCH });
  if (url === '/api/programs/admin/duplicate-aliases') return Promise.resolve({ data: DUPLICATE_ALIASES });
  if (url.endsWith('/aliases')) return Promise.resolve({ data: ALIASES });
  // mounted review-queue pages
  return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 25 } });
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/analyst-console']}>
        <VNextAnalystConsolePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextAnalystConsolePage', () => {
  beforeEach(() => {
    meRole = 'capiro_admin';
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
    apiDeleteMock.mockReset();
    apiGetMock.mockImplementation((url: string) => routeGet(url));
  });

  test('SLA header renders count badges + chips from mocked review-counts', async () => {
    renderConsole();

    // Header SLA chips computed from review-counts. The visible text is split
    // across nodes inside each badge, so assert on the single-node aria-label.
    // The "oldest …" age is time-relative, so match only the stable prefix.
    expect(await screen.findByLabelText(/^Reconciliation 4 open/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Program 2 open, oldest/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Provision links 5 open/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Personnel merge 0 open, oldest clear$/)).toBeInTheDocument();
    expect(screen.getByText('Program quarantine: 7')).toBeInTheDocument();
    expect(screen.getByText('Personnel quarantine: 0')).toBeInTheDocument();
    // Tab labels carry count badges. The Quarantine tab badge sums program (7)
    // + personnel (0) = 7 quarantined records — unique among the badges.
    expect(screen.getByRole('tab', { name: /Quarantine/ })).toHaveTextContent('7');
    expect(screen.getByRole('tab', { name: /Alias manager/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Audit log/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /SAM/ })).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/capiro-admin/review-counts');
  });

  test('Quarantine tab renders rows + a Reprocess button', async () => {
    renderConsole();
    await screen.findByText(/Reconciliation: 4 open/);

    fireEvent.click(screen.getByRole('tab', { name: /Quarantine/ }));

    expect(await screen.findByText('Invalid pe_code: BAD')).toBeInTheDocument();
    expect(screen.getByText('pdoc_fy2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprocess' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/capiro-admin/quarantine',
      expect.objectContaining({
        params: expect.objectContaining({ type: 'program_element', page: 1, limit: 25 }),
      }),
    );
  });

  test('Audit log tab renders rows from mocked audit-logs', async () => {
    renderConsole();
    await screen.findByText(/Reconciliation: 4 open/);

    fireEvent.click(screen.getByRole('tab', { name: /Audit log/ }));

    expect(await screen.findByText('program.merge')).toBeInTheDocument();
    expect(screen.getByText('prog-2')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/capiro-admin/audit-logs', expect.anything());
  });

  test('Alias manager renders aliases + a duplicate pair with a Merge affordance', async () => {
    renderConsole();
    await screen.findByText(/Reconciliation: 4 open/);

    fireEvent.click(screen.getByRole('tab', { name: /Alias manager/ }));

    // Duplicate-alias detector renders the dup group + a merge affordance.
    expect((await screen.findAllByText('PATRIOT')).length).toBeGreaterThan(0);
    expect(screen.getByText('Patriot (dup)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge programs' })).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/programs/admin/duplicate-aliases');

    // Selecting a program lists its aliases (native select in vNext).
    fireEvent.change(screen.getByLabelText('Pick a program'), { target: { value: 'prog-1' } });
    expect(await screen.findByText('Patriot Advanced Capability')).toBeInTheDocument();
  });

  test('Reprocess posts to the reprocess endpoint and reports the rejection reason', async () => {
    apiPostMock.mockResolvedValue({
      data: { reprocessed: true, accepted: false, reason: 'Invalid pe_code: BAD' },
    });
    renderConsole();
    await screen.findByText(/Reconciliation: 4 open/);

    fireEvent.click(screen.getByRole('tab', { name: /Quarantine/ }));
    await screen.findByText('Invalid pe_code: BAD');

    fireEvent.click(screen.getByRole('button', { name: 'Reprocess' }));
    // Confirm in the dialog.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reprocess' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/capiro-admin/quarantine/program_element/q1/reprocess'),
    );
  });

  test('non-admin sees the in-page 403 and no queries fire', () => {
    meRole = 'user_admin';
    renderConsole();

    expect(screen.getByText('403')).toBeInTheDocument();
    expect(
      screen.getByText('The analyst console is restricted to Capiro administrators.'),
    ).toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
