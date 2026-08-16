import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { MeetingDetailPanel } from './MeetingDetailPanel.js';
import type { DetailTab, Meeting } from './meetings-types.js';

/**
 * Phase 2 §2a3 — MeetingDetailPanel is now fully controlled: `activeTab` /
 * `onTabChange` replace the old internal `tab` state entirely. PrepTab /
 * NotesTab / DebriefTab are mocked wholesale (repo precedent: mocking
 * DistrictNexusMap.js in DistrictNexusPage.test.tsx) so these tests isolate
 * the panel's own tab-routing and debrief-lock logic.
 */

const apiGetMock = vi.fn().mockResolvedValue({ data: [] });
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock('./PrepTab.js', () => ({ PrepTab: () => <div data-testid="tab-prep">PREP</div> }));
vi.mock('./NotesTab.js', () => ({
  NotesTab: ({ onGoToDebrief }: { onGoToDebrief: () => void }) => (
    <div data-testid="tab-notes">
      NOTES
      <button onClick={onGoToDebrief}>go-to-debrief</button>
    </div>
  ),
}));
vi.mock('./DebriefTab.js', () => ({ DebriefTab: () => <div data-testid="tab-debrief">DEBRIEF</div> }));

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Budget sync',
    source: 'outlook',
    description: null,
    location: null,
    startsAt: '2020-01-01T14:00:00.000Z',
    endsAt: '2020-01-01T14:30:00.000Z',
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: false,
    joinLink: null,
    provider: null,
    visibility: 'private',
    sharedAt: null,
    sharedByUserId: null,
    client: null,
    attendees: [],
    attachments: [],
    preps: [],
    notes: [],
    debriefs: [],
    notesApproved: false,
    meri: null,
    contributors: [],
    sharedBy: null,
    ...overrides,
  };
}

interface PanelProps {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
  aiConfigured: boolean;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onSendMeri: (m: Meeting) => void;
  onRequestShare: (m: Meeting) => void;
}

function defaultProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    meeting: makeMeeting(),
    open: true,
    onClose: vi.fn(),
    aiConfigured: true,
    activeTab: 'prep',
    onTabChange: vi.fn(),
    onSendMeri: vi.fn(),
    onRequestShare: vi.fn(),
    ...overrides,
  };
}

function buildTree(qc: QueryClient, props: PanelProps): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter>
          <MeetingDetailPanel {...props} />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>
  );
}

describe('MeetingDetailPanel', () => {
  beforeEach(() => {
    apiGetMock.mockClear();
  });

  test('activeTab/onTabChange drive the panel — no internal tab state to diverge', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onTabChange = vi.fn();
    const props = defaultProps({ activeTab: 'notes', onTabChange });
    const { rerender } = render(buildTree(qc, props));

    expect(screen.getByTestId('tab-notes')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-prep')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Prep'));
    expect(onTabChange).toHaveBeenCalledWith('prep');
    // Controlled: clicking alone must not change what's rendered — only a prop
    // update (the parent reacting to onTabChange) can flip the visible tab.
    expect(screen.getByTestId('tab-notes')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-prep')).not.toBeInTheDocument();

    rerender(buildTree(qc, { ...props, activeTab: 'prep' }));
    expect(screen.getByTestId('tab-prep')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-notes')).not.toBeInTheDocument();
  });

  test('the Debrief tab is inert while the meeting has not ended', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onTabChange = vi.fn();
    const meeting = makeMeeting({
      startsAt: '2099-01-01T10:00:00.000Z',
      endsAt: '2099-01-01T10:30:00.000Z',
    });
    render(buildTree(qc, defaultProps({ meeting, activeTab: 'prep', onTabChange })));

    fireEvent.click(screen.getByText('Debrief'));
    expect(onTabChange).not.toHaveBeenCalled();
  });

  test('debrief-locked auto-switches an already-debrief activeTab to prep via onTabChange', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onTabChange = vi.fn();
    const meeting = makeMeeting({
      startsAt: '2099-01-01T10:00:00.000Z',
      endsAt: '2099-01-01T10:30:00.000Z',
    });
    // Mirrors a `?detail=debrief` deep link on an unfinished meeting — it
    // bypasses the disabled tab button entirely, so the lock effect must
    // canonicalize the tab back to prep through the parent callback (so the
    // URL gets corrected too), not just swallow it locally.
    render(buildTree(qc, defaultProps({ meeting, activeTab: 'debrief', onTabChange })));

    await waitFor(() => expect(onTabChange).toHaveBeenCalledWith('prep'));
  });

  test('debrief unlocks once the meeting has ended', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onTabChange = vi.fn();
    const meeting = makeMeeting({
      startsAt: '2020-01-01T10:00:00.000Z',
      endsAt: '2020-01-01T10:30:00.000Z',
    });
    render(buildTree(qc, defaultProps({ meeting, activeTab: 'prep', onTabChange })));

    fireEvent.click(screen.getByText('Debrief'));
    expect(onTabChange).toHaveBeenCalledWith('debrief');
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  test('NotesTab "go to debrief" also routes through onTabChange, not local state', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onTabChange = vi.fn();
    const meeting = makeMeeting({
      startsAt: '2020-01-01T10:00:00.000Z',
      endsAt: '2020-01-01T10:30:00.000Z',
    });
    render(buildTree(qc, defaultProps({ meeting, activeTab: 'notes', onTabChange })));

    fireEvent.click(screen.getByText('go-to-debrief'));
    expect(onTabChange).toHaveBeenCalledWith('debrief');
  });

  /**
   * The closeout promoted client assignment and attendees from cramped inline
   * disclosures to real production windows. Both must be genuine dialogs, and
   * the attendee window must render the full roster rather than a truncated
   * inline strip.
   */
  test('client assignment opens a real dialog with the meeting client preselected', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const meeting = makeMeeting({ client: { id: 'c1', name: 'Acme Health' } as Meeting['client'] });
    render(buildTree(qc, defaultProps({ meeting })));

    // The trigger shows the current assignment.
    const trigger = screen.getByTitle('Change client assignment');
    expect(trigger).toHaveTextContent('Acme Health');

    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Client assignment');
    // Sharing depends on a client, so the window says so rather than failing later.
    expect(screen.getByText(/sharing requires a client/i)).toBeInTheDocument();
  });

  test('an unassigned meeting offers assignment instead of hiding the control', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ client: null }) })));

    const trigger = screen.getByTitle('Assign a client');
    expect(trigger).toHaveTextContent('Assign client');
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Client assignment');
  });

  test('the attendee window lists every attendee in a readable dialog', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const meeting = makeMeeting({
      attendees: [
        { id: 'a1', name: 'Dana Reed', email: 'dana@example.test', role: 'Chief of Staff' },
        { id: 'a2', name: '', email: 'sam@example.test', role: null },
        { id: 'a3', name: 'Priya Raman', email: 'priya@example.test', role: 'LD' },
      ] as Meeting['attendees'],
    });
    render(buildTree(qc, defaultProps({ meeting })));

    // The trigger carries the real count.
    const trigger = screen.getByRole('button', { name: /attendees · 3/i });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Attendees');
    // Every attendee is present — this is the "full view", not a truncated strip.
    expect(screen.getByText('Dana Reed')).toBeInTheDocument();
    expect(screen.getByText('Priya Raman')).toBeInTheDocument();
    // A nameless attendee still resolves to something identifying: the email
    // stands in for the name and also appears in the detail line.
    expect(screen.getAllByText('sam@example.test').length).toBeGreaterThan(0);
  });

  test('a meeting with no attendees states so rather than rendering an empty window', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(buildTree(qc, defaultProps({ meeting: makeMeeting({ attendees: [] }) })));

    fireEvent.click(screen.getByRole('button', { name: /attendees · 0/i }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/no attendees recorded/i)).toBeInTheDocument();
  });
});
