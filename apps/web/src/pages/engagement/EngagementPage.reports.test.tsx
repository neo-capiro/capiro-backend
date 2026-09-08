import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportsView } from './EngagementPage.js';

vi.mock('../../lib/me.js', () => ({ useMe: vi.fn() }));
vi.mock('../../lib/use-api.js', () => ({ useApi: vi.fn() }));
vi.mock('../../state/client-filter.js', () => ({ useClientFilter: vi.fn() }));
vi.mock('./meetings/meetings-api.js', () => ({ meetingsListKey: 'meetings' }));
vi.mock('./meetings/MeetingsV2.js', () => ({ MeetingsV2: () => null }));
vi.mock('./OverviewTab.js', () => ({ OverviewTab: () => null }));
vi.mock('./OutreachView.js', () => ({ OutreachView: () => null }));
vi.mock('./meeting-actions.js', () => ({
  DebriefNotesView: () => null,
  extractMeetingJoinUrl: vi.fn(),
  MeetingQuickActions: () => null,
  NotetakerConsentFields: () => null,
  parseDebriefBody: vi.fn(),
}));

function props(): Parameters<typeof ReportsView>[0] {
  return {
    report: {
      cycle: {
        period: 'previous',
        reportYear: 2025,
        label: 'Previous Cycle (2025)',
        from: null,
        to: null,
      },
      summary: {
        targetOffices: 1,
        meetingsHeld: 0,
        outreachSent: 0,
        submissionsFiled: 0,
        pendingActions: 0,
      },
      rows: [
        {
          targetId: 'target',
          clientId: 'client-b',
          clientName: null,
          scopeKey: 'client-b',
          officeKey: 'manual:target',
          memberPrincipal: 'Planned office',
          committee: null,
          staffer: null,
          building: null,
          leadOwner: null,
          meetingsHeld: 0,
          outreachSent: 0,
          pendingActions: 0,
          prepStatus: 'complete',
          outreachStatus: 'complete',
          submissionStatus: 'not_started',
          source: 'manual',
          manuallyOverridden: true,
          prepOverridden: true,
          outreachOverridden: true,
          submissionOverridden: false,
          meetings: [],
        },
      ],
    },
    loading: false,
    period: 'previous',
    onPeriodChange: vi.fn(),
    statusFilter: 'all',
    onStatusFilterChange: vi.fn(),
    sort: 'member-asc',
    onSortChange: vi.fn(),
    updatingCell: null,
    onViewMeetings: vi.fn(),
    onStatusChange: vi.fn(),
    onRestore: vi.fn(),
    onAddTargetOffice: vi.fn(),
    onLinkDirectory: vi.fn(),
    onAssignClient: vi.fn(),
  };
}

describe('legacy Reports controls', () => {
  it('identifies manual-only targets and the actual client when its name is missing', () => {
    const input = props();
    render(<ReportsView {...input} />);
    expect(screen.getByText('Client client-b')).toBeVisible();
    expect(screen.getByText('Manual-only — no automatic activity')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Link to Directory' }));
    expect(input.onLinkDirectory).toHaveBeenCalledWith(input.report!.rows[0]);
  });

  it('restores only the status menu the user selected', () => {
    const input = props();
    render(<ReportsView {...input} />);
    const status = document.querySelector('.engagement-report-status-select input')!;
    fireEvent.mouseDown(status);
    fireEvent.click(screen.getByText('Restore automatic tracking'));
    expect(input.onRestore).toHaveBeenCalledWith(input.report!.rows[0], 'prepStatus');
    expect(input.onStatusChange).not.toHaveBeenCalled();
  });

  it('keeps All Time read-only, including linking and creating targets', () => {
    const input = props();
    input.period = 'all';
    input.report!.cycle = { ...input.report!.cycle, period: 'all', reportYear: null };
    render(<ReportsView {...input} />);
    expect(screen.getByRole('button', { name: /Add target office/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link to Directory' })).toBeDisabled();
    for (const status of document.querySelectorAll('.engagement-report-status-select input')) {
      expect(status).toBeDisabled();
    }
  });

  it('does not enable status edits on an unassigned legacy target', () => {
    const input = props();
    input.report!.rows[0]!.clientId = null;
    input.report!.rows[0]!.scopeKey = 'all';
    render(<ReportsView {...input} />);
    expect(screen.getByText('Unassigned — select a client')).toBeVisible();
    for (const status of document.querySelectorAll('.engagement-report-status-select input')) {
      expect(status).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Link to Directory' })).toBeEnabled();
  });

  it('offers explicit client assignment for an unassigned canonical Directory target', () => {
    const input = props();
    Object.assign(input.report!.rows[0]!, {
      clientId: null,
      scopeKey: 'all',
      officeKey: 'directory:member-42',
    });
    render(<ReportsView {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Assign client' }));
    expect(input.onAssignClient).toHaveBeenCalledWith(input.report!.rows[0]);
    expect(screen.queryByRole('button', { name: 'Link to Directory' })).not.toBeInTheDocument();
  });

  it('does not expose mutation actions on archived targets', () => {
    const input = props();
    Object.assign(input.report!.rows[0]!, { clientId: null, archivedAt: '2026-09-08T00:00:00Z' });
    render(<ReportsView {...input} />);
    expect(screen.queryByRole('button', { name: 'Link to Directory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign client' })).not.toBeInTheDocument();
  });

  it('renders persisted display override markers after report reload', () => {
    const input = props();
    const { rerender } = render(<ReportsView {...input} />);
    expect(screen.queryByText('Edited')).not.toBeInTheDocument();
    input.report = {
      ...input.report!,
      rows: [{ ...input.report!.rows[0]!, displayOverrides: ['memberPrincipal', 'building'] }],
    };
    rerender(<ReportsView {...input} />);
    expect(screen.getAllByText('Edited')).toHaveLength(2);
  });
});
