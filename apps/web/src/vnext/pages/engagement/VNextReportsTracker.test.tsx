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
const patchMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: getMock,
    post: postMock,
    put: vi.fn(),
    patch: patchMock,
    delete: deleteMock,
  }),
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
  archivedAt?: string | null;
  displayOverrides?: string[];
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
    cycle: {
      reportYear: 2026 as number | null,
      period: 'current',
      label: 'Current Cycle (2026)',
      from: null,
      to: null,
    },
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

const directoryFixture = {
  id: 'member-7',
  fullName: 'Rep. Ana Lopez',
  chamber: 'House',
  state: 'WA',
  district: 'WA-7',
  title: 'Representative',
  office: 'Ana Lopez office (WA-7)',
  officeLocation: '123 Rayburn House Office Building',
  committees: ['Appropriations'],
  staff: [{ fullName: 'Jamie Aide' }],
};
function mockGetFor(rows: FixtureRow[]) {
  getMock.mockImplementation((url: string, config?: { params?: { period?: string } }) => {
    if (url === '/api/engagement/reports/overview') {
      const data = fixtureReport(rows);
      if (config?.params?.period === 'previous') data.cycle.reportYear = 2025;
      if (config?.params?.period === 'all') data.cycle.reportYear = null;
      return Promise.resolve({ data });
    }
    if (url === '/api/directory/contacts')
      return Promise.resolve({ data: { contacts: [directoryFixture] } });
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

function renderTracker(initialEntry = '/engagement/reports', clientId: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <EngagementToastProvider>
          <VNextReportsTracker clientId={clientId} />
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
    patchMock.mockReset();
    deleteMock.mockReset();
    patchMock.mockResolvedValue({ data: {} });
    deleteMock.mockResolvedValue({ data: {} });
    postMock.mockResolvedValue({ data: {} });
  });

  test('renders the heading, cycle subline, and tracker heading', async () => {
    mockGetFor([makeRow()]);
    renderTracker();
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(
      await screen.findByText('Current Cycle (2026) Engagement Activity Overview'),
    ).toBeInTheDocument();
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
      makeRow({
        officeKey: 'o-1',
        memberPrincipal: 'Rep. Jane Smith (D-CA-12)',
        pendingActions: 2,
      }),
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
        makeRow({
          manuallyOverridden: true,
          prepOverridden: true,
          outreachOverridden: false,
          submissionOverridden: false,
        }),
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
    const submissionTrigger = container
      .querySelectorAll('.uui-report-status-cell')[2]!
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
      makeRow({
        officeKey: 'o-1',
        memberPrincipal: 'Rep. Jane Smith (D-CA-12)',
        submissionStatus: 'in_progress',
      }),
      makeRow({
        officeKey: 'o-2',
        memberPrincipal: 'Sen. Mark Reyes (R-TX)',
        prepStatus: 'not_started',
        outreachStatus: 'not_started',
        submissionStatus: 'not_started',
      }),
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
    expect(within(memberCells[0]! as HTMLElement).getByRole('button')).toHaveTextContent(
      'Sen. Mark Reyes (R-TX)',
    );
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
    test('creates a canonical client target using the real Directory location and selected report year', async () => {
      mockGetFor([makeRow()]);
      renderTracker('/engagement/reports?period=previous', 'c-overland');
      await screen.findByText('Rep. Jane Smith (D-CA-12)');
      fireEvent.click(screen.getByRole('button', { name: /add target office/i }));
      await waitFor(() =>
        expect(screen.getByLabelText('Client · required')).toHaveValue('c-overland'),
      );
      fireEvent.change(
        screen.getByRole('combobox', { name: 'Find member / principal in Directory' }),
        { target: { value: 'Ana' } },
      );
      fireEvent.click(await screen.findByRole('option', { name: /Rep. Ana Lopez · House/ }));
      expect(screen.getByPlaceholderText('Rayburn')).toHaveValue(
        '123 Rayburn House Office Building',
      );
      fireEvent.change(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)'), {
        target: { value: 'My preferred name' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add office' }));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith(
          '/api/engagement/reports/target-offices',
          expect.objectContaining({
            clientId: 'c-overland',
            directoryContactId: 'member-7',
            reportYear: 2025,
            memberPrincipal: 'My preferred name',
          }),
        ),
      );
      expect(postMock.mock.calls[0]?.[1]).not.toHaveProperty('building');
      expect(postMock.mock.calls[0]?.[1]).not.toHaveProperty('committee');
      expect(await screen.findByText(/Target office added/)).toBeInTheDocument();
    });

    test('requires an explicit client and manual-only action for an unlinked name', async () => {
      mockGetFor([]);
      renderTracker();
      await screen.findByText('No target offices are linked to this reporting period yet.');
      fireEvent.click(screen.getByRole('button', { name: 'Add target office' }));
      fireEvent.change(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)'), {
        target: { value: 'New planned office' },
      });
      expect(screen.getByRole('button', { name: 'Add office' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save as manual-only' })).toBeDisabled();
      await screen.findByRole('option', { name: 'Acme Corp' });
      fireEvent.change(screen.getByLabelText('Client · required'), { target: { value: 'c-acme' } });
      expect(screen.getByRole('button', { name: 'Add office' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Save as manual-only' }));
      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith(
          '/api/engagement/reports/target-offices',
          expect.objectContaining({ clientId: 'c-acme', manualOnly: true, reportYear: 2026 }),
        ),
      );
    });

    test('changing the selected identity refreshes untouched defaults and retains deliberate edits', async () => {
      mockGetFor([]);
      renderTracker('/engagement/reports', 'c-acme');
      await screen.findByText('No target offices are linked to this reporting period yet.');
      fireEvent.click(screen.getByRole('button', { name: 'Add target office' }));
      const search = screen.getByRole('combobox', { name: 'Find member / principal in Directory' });
      fireEvent.change(search, { target: { value: 'Ana' } });
      fireEvent.click(await screen.findByRole('option', { name: /Rep. Ana Lopez · House/ }));
      fireEvent.change(screen.getByPlaceholderText('HASC'), {
        target: { value: 'Custom committee' },
      });
      const previousGet = getMock.getMockImplementation()!;
      getMock.mockImplementation((url: string, config: unknown) =>
        url === '/api/directory/contacts'
          ? Promise.resolve({
              data: {
                contacts: [
                  {
                    ...directoryFixture,
                    id: 'member-8',
                    fullName: 'Sen. Ben Jones',
                    chamber: 'Senate',
                    district: 'TX',
                    officeLocation: '201 Hart Senate Office Building',
                  },
                ],
              },
            })
          : previousGet(url, config),
      );
      fireEvent.change(search, { target: { value: 'Ben' } });
      fireEvent.click(await screen.findByRole('option', { name: /Sen. Ben Jones · Senate/ }));
      expect(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)')).toHaveValue(
        'Sen. Ben Jones',
      );
      expect(screen.getByPlaceholderText('Rayburn')).toHaveValue('201 Hart Senate Office Building');
      expect(screen.getByPlaceholderText('HASC')).toHaveValue('Custom committee');
      expect(screen.getByPlaceholderText('HASC').closest('label')).toHaveTextContent('edited');
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
      expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
        'href',
        'https://teams.example/m-1',
      );
    });

    test('empty state when no meetings are linked', async () => {
      mockGetFor([makeRow({ meetings: [] })]);
      renderTracker();
      await screen.findByText('Rep. Jane Smith (D-CA-12)');
      fireEvent.click(screen.getByRole('button', { name: '3 View' }));
      expect(
        await screen.findByText('No meetings are linked to this target office yet.'),
      ).toBeInTheDocument();
    });
  });

  test('Export CSV triggers a real download and a confirmation toast', async () => {
    mockGetFor([makeRow()]);
    renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(clickSpy).toHaveBeenCalled();
    expect(
      await screen.findByText(/CSV export queued · current cycle · 1 office/),
    ).toBeInTheDocument();
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
  test('restores only the chosen status and year, then renders the refreshed automatic value', async () => {
    const saved = makeRow({
      prepOverridden: true,
      outreachOverridden: true,
      submissionOverridden: true,
      prepStatus: 'complete',
      outreachStatus: 'in_progress',
      submissionStatus: 'complete',
    });
    mockGetFor([saved]);
    deleteMock.mockImplementation(async () => {
      saved.prepOverridden = false;
      saved.prepStatus = 'not_started';
      return { data: {} };
    });
    const { container } = renderTracker('/engagement/reports?period=previous');
    await screen.findByText(saved.memberPrincipal);
    fireEvent.click(container.querySelectorAll('.uui-report-status-trigger')[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore automatic tracking' }));
    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/api/engagement/reports/target-offices/overrides', {
        data: { clientId: 'c-overland', officeKey: 'o-1', reportYear: 2025, field: 'prepStatus' },
      }),
    );
    await waitFor(() =>
      expect(container.querySelectorAll('.uui-report-override-marker')).toHaveLength(2),
    );
    expect(container.querySelectorAll('.uui-report-status-trigger')[0]).toHaveTextContent(
      'Not started',
    );
    expect(container.querySelectorAll('.uui-report-status-trigger')[1]).toHaveTextContent(
      'In progress',
    );
    expect(container.querySelectorAll('.uui-report-status-trigger')[2]).toHaveTextContent(
      'Complete',
    );
  });

  test('failed restore retains the marker and reports the error without a success toast', async () => {
    mockGetFor([makeRow({ prepOverridden: true })]);
    deleteMock.mockRejectedValue(new Error('offline'));
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');
    fireEvent.click(container.querySelectorAll('.uui-report-status-trigger')[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore automatic tracking' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update this status');
    expect(container.querySelectorAll('.uui-report-override-marker')).toHaveLength(1);
    expect(
      screen.queryByText('Automatic tracking restored for this status and reporting year'),
    ).not.toBeInTheDocument();
  });

  test('status button keyboard events and menu clicks do not open target details', async () => {
    mockGetFor([makeRow()]);
    const { container } = renderTracker();
    await screen.findByText('Rep. Jane Smith (D-CA-12)');
    const trigger = container.querySelectorAll('.uui-report-status-trigger')[0]!;
    expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(trigger, { key: ' ' })).toBe(true);
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'In progress' }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('All Time is read-only for status and creation', async () => {
    mockGetFor([makeRow()]);
    const { container } = renderTracker('/engagement/reports?period=all');
    await screen.findByText('Rep. Jane Smith (D-CA-12)');
    expect(screen.getByRole('button', { name: 'Add target office' })).toBeDisabled();
    container
      .querySelectorAll('.uui-report-status-trigger')
      .forEach((trigger) => expect(trigger).toBeDisabled());
  });

  test('fresh detail editing loads client choices and displays refreshed saved values', async () => {
    const saved = makeRow();
    mockGetFor([saved]);
    patchMock.mockImplementation(async (_url: string, values: Partial<FixtureRow>) => {
      Object.assign(saved, values);
      return { data: saved };
    });
    renderTracker();
    fireEvent.click(await screen.findByRole('button', { name: saved.memberPrincipal }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('option', { name: 'Acme Corp' })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)'), {
      target: { value: 'Updated name' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('Target office · Updated name'),
    );
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(patchMock).toHaveBeenCalledWith('/api/engagement/reports/target-offices/t-1', {
      memberPrincipal: 'Updated name',
    });
  });

  test('completion uses the viewed year and refreshes the open detail card', async () => {
    const saved = makeRow({ submissionStatus: 'in_progress' });
    mockGetFor([saved]);
    postMock.mockImplementation(async () => {
      saved.submissionStatus = 'complete';
      return { data: {} };
    });
    renderTracker('/engagement/reports?period=previous');
    fireEvent.click(await screen.findByRole('button', { name: saved.memberPrincipal }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark submission complete' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/reports/target-offices/overrides',
        expect.objectContaining({ reportYear: 2025, submissionStatus: 'complete' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('Submission: Complete'),
    );
  });

  test('linking from All clients uses the target client and explicitly resolves collisions', async () => {
    mockGetFor([makeRow({ officeKey: 'manual:one', source: 'manual' })]);
    postMock
      .mockRejectedValueOnce({
        response: {
          data: {
            code: 'TARGET_LINK_CONFLICT',
            conflicts: [
              { field: '2025.prepStatus', manual: 'not_started', existing: 'complete' },
              { field: 'leadOwner', manual: 'Neo', existing: 'Lee' },
            ],
          },
        },
      })
      .mockRejectedValueOnce(new Error('offline'));
    renderTracker();
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Directory' }));
    expect(screen.getByLabelText('Target client · required')).toHaveValue('c-overland');
    expect(screen.getByLabelText('Target client · required')).toBeDisabled();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Find member / principal in Directory' }),
      { target: { value: 'Ana' } },
    );
    fireEvent.click(await screen.findByRole('option', { name: /Rep. Ana Lopez · House/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Link target' }));
    await screen.findByText('2025.prepStatus');
    expect(screen.getByRole('button', { name: 'Resolve and link' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Existing Directory target: complete' }));
    fireEvent.click(screen.getByRole('radio', { name: 'This target: Neo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve and link' }));
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith('/api/engagement/reports/target-offices/link', {
        targetId: 't-1',
        officeKey: 'manual:one',
        clientId: 'c-overland',
        directoryContactId: 'member-7',
        conflictResolutions: { '2025.prepStatus': 'existing', leadOwner: 'manual' },
      }),
    );
    await screen.findByText('Could not link this target. Your saved target was kept. Try again.');
    expect(screen.getByRole('radio', { name: 'This target: Neo' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve and link' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('assigned clients without names never appear as firm-wide in table or CSV', async () => {
    mockGetFor([makeRow({ clientName: null })]);
    renderTracker();
    expect(await screen.findByText('Client c-overland')).toBeInTheDocument();
    expect(screen.queryByText(/Firm-wide/i)).not.toBeInTheDocument();
  });

  test('saving keeps the visible creation values fixed while the request is pending', async () => {
    mockGetFor([]);
    let finish!: (value: { data: object }) => void;
    postMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderTracker('/engagement/reports', 'c-acme');
    await screen.findByText('No target offices are linked to this reporting period yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Add target office' }));
    fireEvent.change(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)'), {
      target: { value: 'Planned office' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as manual-only' }));
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Rep. Jane Smith (D-CA-12)')).toBeDisabled(),
    );
    expect(screen.getByLabelText('Client · required')).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: 'Find member / principal in Directory' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    finish({ data: {} });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('All Time retains archived targets as history without offering link, edit or status actions', async () => {
    mockGetFor([
      makeRow({
        officeKey: 'manual:archived',
        source: 'manual',
        archivedAt: '2026-09-08T12:00:00Z',
      }),
    ]);
    const { container } = renderTracker('/engagement/reports?period=all');
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to Directory' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBeDisabled();
    container
      .querySelectorAll('.uui-report-status-trigger')
      .forEach((trigger) => expect(trigger).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: '3 View' }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });
});
