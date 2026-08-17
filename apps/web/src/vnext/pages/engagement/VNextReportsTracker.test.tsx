import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VNextReportsTracker } from './VNextReportsTracker.js';
import { EngagementToastProvider } from './engagement-toast.js';

/**
 * VNextReportsTracker — the vNext-only Reports surface (design README §10 /
 * `Capiro Engagement - Untitled UI.dc.html`'s `isReports` block). Mocks
 * useApi (Clerk-backed, throws without a provider — same convention
 * VNextMeetingsWorkspace.test.tsx uses) with controllable per-URL responses,
 * since this component owns its query/mutations directly rather than going
 * through an exported hook module the way Library does.
 */

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));

interface FixtureRow {
  targetId: string;
  clientId: string | null;
  clientName: string | null;
  scopeKey: string;
  officeKey: string;
  memberPrincipal: string;
  committee: string | null;
  staffer: string | null;
  building: string | null;
  leadOwner: string | null;
  meetingsHeld: number;
  outreachSent: number;
  pendingActions: number;
  prepStatus: 'not_started' | 'in_progress' | 'complete';
  outreachStatus: 'not_started' | 'in_progress' | 'complete';
  submissionStatus: 'not_started' | 'in_progress' | 'complete';
  source: string;
  manuallyOverridden: boolean;
  prepOverridden?: boolean;
  outreachOverridden?: boolean;
  submissionOverridden?: boolean;
  meetings: Array<{
    id: string;
    subject: string;
    startsAt: string;
    endsAt: string;
    location: string | null;
    externalUrl: string | null;
  }>;
}

function makeRow(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    targetId: 't-1',
    clientId: 'c-overland',
    clientName: 'Overland AI',
    scopeKey: 'c-overland',
    officeKey: 'o-1',
    memberPrincipal: 'Rep. Jane Smith (D-CA-12)',
    committee: 'HASC',
    staffer: 'Priya Anand',
    building: 'Rayburn',
    leadOwner: 'Neo',
    meetingsHeld: 3,
    outreachSent: 2,
    pendingActions: 2,
    prepStatus: 'complete',
    outreachStatus: 'complete',
    submissionStatus: 'in_progress',
    source: 'auto',
    manuallyOverridden: false,
    meetings: [],
    ...overrides,
  };
}

function fixtureReport(rows: FixtureRow[]) {
  return {
    cycle: { period: 'current', label: 'Current Cycle (2026)', from: null, to: null },
    summary: {
      targetOffices: rows.length,
      meetingsHeld: rows.reduce((n, r) => n + r.meetingsHeld, 0),
      outreachSent: rows.reduce((n, r) => n + r.outreachSent, 0),
      submissionsFiled: rows.filter((r) => r.submissionStatus === 'complete').length,
      pendingActions: rows.reduce((n, r) => n + r.pendingActions, 0),
    },
    rows,
  };
}

function mockGetFor(rows: FixtureRow[]) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/engagement/reports/overview') {
      return Promise.resolve({ data: fixtureReport(rows) });
    }
    if (url === '/api/clients') {
      return Promise.resolve({
        data: [
          { id: 'c-acme', name: 'Acme Corp', status: 'active' },
          { id: 'c-overland', name: 'Overland AI', status: 'active' },
        ],
      });
    }
    return Promise.resolve({ data: [] });
  });
}

function LocationSpy() {
  const location = useLocation();
  return (
    <div data-testid="location-spy">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderTracker(initialEntry = '/engagement/reports') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <EngagementToastProvider>
          <VNextReportsTracker clientId={null} />
        </EngagementToastProvider>
        <LocationSpy />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function locationSearch(): string {
  return screen.getByTestId('location-spy').textContent ?? '';
}

describe('VNextReportsTracker', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    postMock.mockResolvedValue({ data: {} });
  });

  test('renders the heading, cycle subline, and tracker heading', async () => {
    mockGetFor([makeRow()]);
    renderTracker();
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(await screen.findByText('Current Cycle (2026) Engagement Activity Overview')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Office Engagement Tracker' })).toBeInTheDocument();
  });

  test('renders a row with all real cells', async () => {
    mockGetFor([makeRow()]);
    const { container } = renderTracker();
    expect(await screen.findByText('Rep. Jane Smith (D-CA-12)')).toBeInTheDocument();
    const row = container.querySelector('.uui-report-table__row') as HTMLElement;
    expect(within(row).getByText('HASC')).toBeInTheDocument();
    expect(within(row).getByText('Priya Anand')).toBeInTheDocument();
    expect(within(row).getByText('Rayburn')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '3 View' })).toBeInTheDocument();
    expect(within(row).getAllByText('Complete')).toHaveLength(2); // prep + outreach
    expect(within(row).getByText('In progress')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument(); // pending
  });

  test('Pending is honestly color-coded — dark when nonzero, muted when zero (a real conditional, not a fixed color)', async () => {
    mockGetFor([
      makeRow({ officeKey: 'o-1', memberPrincipal: 'Rep. Jane Smith (D-CA-12)', pendingActions: 2 }),
      makeRow({ officeKey: 'o-2', memberPrincipal: 'Sen. Mark Reyes (R-TX)', pendingActions: 0 }),
    ]);
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    // Locate each row by its own member name rather than assuming array
    // order, since the default sort (Member A–Z) is a real, independent
    // behavior this test shouldn't have to also encode.
    const rowFor = (name: string) =>
      screen.getByText(name).closest('.uui-report-table__row') as HTMLElement;
    const nonzeroPending = within(rowFor('Rep. Jane Smith (D-CA-12)')).getByText('2', {
      selector: '.uui-report-pending',
    });
    const zeroPending = within(rowFor('Sen. Mark Reyes (R-TX)')).getByText('0', {
      selector: '.uui-report-pending',
    });
    expect(nonzeroPending).toHaveAttribute('data-nonzero', 'true');
    expect(zeroPending).not.toHaveAttribute('data-nonzero');
  });

  test('empty state offers Add target office when no rows are linked yet', async () => {
    mockGetFor([]);
    renderTracker();
    expect(
      await screen.findByText('No target offices are linked to this reporting period yet.'),
    ).toBeInTheDocument();
  });

  describe('override marker — per-field, not the collapsed flag', () => {
    test('shows the marker only on the specific overridden cell, not on all three', async () => {
      mockGetFor([
        makeRow({ manuallyOverridden: true, prepOverridden: true, outreachOverridden: false, submissionOverridden: false }),
      ]);
      const { container } = renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');

      const cells = container.querySelectorAll('.uui-report-status-cell');
      expect(cells).toHaveLength(3);
      // Prep (first cell) is overridden; Outreach and Submission are not.
      expect(cells[0]!.querySelector('.uui-report-override-marker')).not.toBeNull();
      expect(cells[1]!.querySelector('.uui-report-override-marker')).toBeNull();
      expect(cells[2]!.querySelector('.uui-report-override-marker')).toBeNull();
    });

    test('no marker on any cell when nothing was overridden', async () => {
      mockGetFor([makeRow()]);
      const { container } = renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');
      expect(container.querySelectorAll('.uui-report-override-marker')).toHaveLength(0);
    });
  });

  test('changing a status cell posts the real override with the right field/value', async () => {
    mockGetFor([makeRow()]);
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    // Third status cell in row order (prep, outreach, submission) — the
    // fixture's only 'in_progress' cell, so this unambiguously opens the
    // Submission cell's menu.
    const submissionTrigger = container.querySelectorAll('.uui-report-status-cell')[2]!
      .querySelector('.uui-report-status-trigger') as HTMLElement;
    fireEvent.click(submissionTrigger);
    fireEvent.click(within(screen.getByRole('menu')).getByText('Complete'));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/reports/target-offices/overrides',
        expect.objectContaining({ officeKey: 'o-1', submissionStatus: 'complete' }),
      ),
    );
  });

  test('status filter narrows the visible rows client-side', async () => {
    mockGetFor([
      makeRow({ officeKey: 'o-1', memberPrincipal: 'Rep. Jane Smith (D-CA-12)', submissionStatus: 'in_progress' }),
      makeRow({ officeKey: 'o-2', memberPrincipal: 'Sen. Mark Reyes (R-TX)', prepStatus: 'not_started', outreachStatus: 'not_started', submissionStatus: 'not_started' }),
    ]);
    renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');
    expect(screen.getByText('Sen. Mark Reyes (R-TX)')).toBeInTheDocument();

    // A real dropdown-button + menu, not a native <select> (per the phase
    // brief) — open the trigger, then click the option.
    fireEvent.click(screen.getByLabelText('Filter by status'));
    fireEvent.click(screen.getByText('Filter: Not started'));

    expect(screen.queryByText('Rep. Jane Smith (D-CA-12)')).not.toBeInTheDocument();
    expect(screen.getByText('Sen. Mark Reyes (R-TX)')).toBeInTheDocument();
    // The trigger itself now reflects the selected filter, not the default.
    expect(screen.getByLabelText('Filter by status')).toHaveTextContent('Filter: Not started');
  });

  test('sort control reorders rows by the chosen key', async () => {
    mockGetFor([
      makeRow({ officeKey: 'o-1', memberPrincipal: 'Rep. Jane Smith (D-CA-12)', meetingsHeld: 1 }),
      makeRow({ officeKey: 'o-2', memberPrincipal: 'Sen. Mark Reyes (R-TX)', meetingsHeld: 9 }),
    ]);
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    fireEvent.click(screen.getByLabelText('Sort'));
    fireEvent.click(screen.getByText('Sort: Meetings held'));

    const memberCells = container.querySelectorAll('.uui-report-table__row > :first-child');
    expect(memberCells[0]!.textContent).toBe('Sen. Mark Reyes (R-TX)');
  });

  test('Filter and Sort are real dropdown-button-with-menu controls, not native selects', async () => {
    mockGetFor([makeRow()]);
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');
    expect(container.querySelector('.uui-report-toolbar-row select')).toBeNull();
    expect(screen.getByLabelText('Filter by status').tagName).toBe('BUTTON');
    expect(screen.getByLabelText('Sort').tagName).toBe('BUTTON');
  });

  test('period control persists to the URL, matching the canonical contract', async () => {
    mockGetFor([makeRow()]);
    renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    fireEvent.click(screen.getByRole('button', { name: 'Previous Cycle' }));
    await waitFor(() => expect(locationSearch()).toContain('period=previous'));
  });

  describe('Add target office', () => {
    test('submits the real 6-field payload and shows a confirmation toast', async () => {
      mockGetFor([makeRow()]);
      renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');

      fireEvent.click(screen.getByRole('button', { name: /add target office/i }));
      fireEvent.change(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)'), {
        target: { value: 'Rep. Ana Lopez (D-WA-07)' },
      });
      fireEvent.change(screen.getByPlaceholderText('HASC'), { target: { value: 'HAC-D' } });

      fireEvent.click(screen.getByRole('button', { name: 'Add office' }));

      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith(
          '/api/engagement/reports/target-offices',
          expect.objectContaining({ memberPrincipal: 'Rep. Ana Lopez (D-WA-07)', committee: 'HAC-D' }),
        ),
      );
      expect(await screen.findByText(/Target office added/)).toBeInTheDocument();
    });

    test('Add office stays disabled until a member/principal is entered', async () => {
      mockGetFor([makeRow()]);
      renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');
      fireEvent.click(screen.getByRole('button', { name: /add target office/i }));
      expect(screen.getByRole('button', { name: 'Add office' })).toBeDisabled();
    });
  });

  describe('office drilldown', () => {
    test('shows the row’s embedded meetings — no separate endpoint needed', async () => {
      mockGetFor([
        makeRow({
          meetings: [
            {
              id: 'm-1',
              subject: 'Autonomy provision check-in',
              startsAt: new Date(2026, 7, 18, 10, 0).toISOString(),
              endsAt: new Date(2026, 7, 18, 10, 30).toISOString(),
              location: 'Rayburn 2154',
              externalUrl: 'https://teams.example/m-1',
            },
          ],
        }),
      ]);
      renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');

      fireEvent.click(screen.getByRole('button', { name: '3 View' }));

      expect(await screen.findByText('Autonomy provision check-in')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://teams.example/m-1');
    });

    test('empty state when no meetings are linked', async () => {
      mockGetFor([makeRow({ meetings: [] })]);
      renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');
      fireEvent.click(screen.getByRole('button', { name: '3 View' }));
      expect(await screen.findByText('No meetings are linked to this target office yet.')).toBeInTheDocument();
    });
  });

  test('Export CSV triggers a real download and a confirmation toast', async () => {
    mockGetFor([makeRow()]);
    renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(clickSpy).toHaveBeenCalled();
    expect(await screen.findByText(/CSV export queued · current cycle · 1 office/)).toBeInTheDocument();
    clickSpy.mockRestore();
  });

  test('Export CSV produces the correct escaped CSV content for a fixture', async () => {
    mockGetFor([
      makeRow({
        memberPrincipal: 'Rep. Ana Lopez (D-WA-07)',
        clientName: 'Overland, "Prime" AI', // comma + embedded quotes
        committee: 'HAC-D',
        pendingActions: 3,
      }),
    ]);
    renderTracker();
    await screen.findByText('Rep. Ana Lopez (D-WA-07)');

    const blobs: Blob[] = [];
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        blobs.push(blob as Blob);
        return 'blob:csv';
      });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    const text = await blobs[0]!.text();
    const [header, ...rows] = text.split('\n');
    // Canonical's own longer column labels (EngagementPage.tsx's
    // exportEngagementReportCsv), NOT the shorter on-screen table headers —
    // the CSV is a stable export contract, independent of the visual reskin.
    expect(header).toBe(
      'Member / Principal,Client,Committee,Staffer,Building,Lead,Meetings Held,Prep Done,Outreach Sent,Submission Filed,Pending Actions',
    );
    expect(rows[0]).toContain('Rep. Ana Lopez (D-WA-07)');
    // A field holding a comma and quotes is quoted and its quotes doubled, or
    // the row silently gains columns / breaks in a spreadsheet.
    expect(rows[0]).toContain('"Overland, ""Prime"" AI"');
    expect(rows[0]).toContain('Complete'); // prepStatus label, not the raw enum value
    expect(rows[0]).toMatch(/,3$/); // pendingActions is the last column

    createUrl.mockRestore();
    revokeUrl.mockRestore();
    clickSpy.mockRestore();
  });

  test('Export CSV is disabled when there are no rows to export', async () => {
    mockGetFor([]);
    renderTracker();
    await screen.findByText('No target offices are linked to this reporting period yet.');
    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
  });
});
