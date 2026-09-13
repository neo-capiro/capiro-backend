import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  enabled: true,
  actor: 'tenant-a:user-a',
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post, patch: mocks.patch }),
}));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.actor }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  STATE_CALENDAR_FEATURE: 'legiwatch_state_calendar_v1',
  useIntelFeatureEnabled: () => mocks.enabled,
}));
import { PreparationPanel } from './PreparationPanel.js';
import { BillAgenda } from './BillAgenda.js';
import { PreparationRevisionNotice } from './PreparationRevisionNotice.js';
import { normalizeCanonicalHearingEvent } from '../lib/canonical-hearings.js';

const event = normalizeCanonicalHearingEvent({
  id: 'state-fl-test',
  title: 'Published committee agenda',
  geographicJurisdiction: 'FL',
  legislativeSession: '2026',
  calendarRevision: 3,
  calendarCheckedAt: new Date().toISOString(),
  calendarCheckState: 'complete',
  timePrecision: 'relative',
  date: '2026-09-11',
  time: 'Upon adjournment',
  chamber: 'House',
  committeeName: 'State committee',
  visibility: 'public',
  eventStatus: 'scheduled',
  stateCommitteeId: 'ocd-organization/test',
  agenda: [
    {
      key: 'b',
      position: 1,
      kind: 'bill',
      title: 'HB 2',
      bill: { id: 'ocd-bill/two', scope: 'state' },
      sourceUrl: 'https://example.gov/bill2',
    },
    {
      key: 'a',
      position: 0,
      kind: 'unresolved_bill',
      title: 'PCB 1',
      sourceUrl: 'https://example.gov/bill1',
    },
  ],
  documents: [
    {
      id: 'notice',
      title: 'Published notice',
      sourceUrl: 'https://example.gov/notice',
      deadlines: ['Amendment deadline: September 10 at 9 AM'],
    },
  ],
})!;
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mocks.enabled = true;
  mocks.actor = 'tenant-a:user-a';
  mocks.get.mockReset();
  mocks.post.mockReset().mockResolvedValue({ data: { folders: [], billIds: [], matches: [] } });
  mocks.patch.mockReset();
});
afterEach(cleanup);
describe('Phase 3 preparation workflow', () => {
  it('lets a bill inspect past published agendas without treating them as testimony', async () => {
    mocks.post.mockImplementation(async (_url, input) => ({
      data: {
        items: input.to
          ? [
              {
                id: 'state-fl-past',
                title: 'Past published notice',
                date: '2026-02-24',
                eventStatus: 'scheduled',
                chamber: 'Senate',
              },
            ]
          : [],
        total: input.to ? 1 : 0,
        page: 1,
        pageSize: 200,
      },
    }));
    render(<BillAgenda billId="fl-2026-s0174" />, { wrapper: wrapper() });
    await screen.findByText(/No upcoming appearances/);
    fireEvent.click(screen.getByRole('button', { name: 'Past dates' }));
    expect(await screen.findByRole('link', { name: 'Past published notice' })).toBeTruthy();
    expect(screen.getByText(/Past scheduled dates do not establish/)).toBeTruthy();
    expect(mocks.post.mock.calls.at(-1)?.[1]).toMatchObject({
      billIds: ['fl-2026-s0174'],
      to: expect.any(String),
    });
    expect(mocks.post.mock.calls.at(-1)?.[1]).not.toHaveProperty('from');
  });
  it('keeps the capability dark and starts no work during a read', () => {
    mocks.enabled = false;
    render(<PreparationPanel event={event} />, { wrapper: wrapper() });
    expect(screen.queryByRole('button', { name: 'Create prep draft' })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows official agenda order, unresolved identifiers, deadlines and encoded directory links', () => {
    render(<PreparationPanel event={event} />, { wrapper: wrapper() });
    const agenda = screen.getAllByRole('list')[0]!;
    expect(agenda.textContent?.indexOf('PCB 1')).toBeLessThan(agenda.textContent!.indexOf('HB 2'));
    expect(screen.getByText('Bill reference awaiting resolution')).toBeTruthy();
    expect(screen.getByText(/Amendment deadline/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Committee profile and calendar' }).getAttribute('href'),
    ).toBe('/directory/state-committees/ocd-organization%2Ftest');
    expect(screen.getByRole('link', { name: 'HB 2' }).getAttribute('href')).toBe(
      '/bills/ocd-bill%2Ftwo',
    );
    expect(screen.getByText(/Start time is not confirmed/)).toBeTruthy();
  });
  it('freezes the chosen scope, creates one Workspace draft and never requests attendance', async () => {
    const context = {
      mode: 'preparation',
      snapshotId: 'snapshot-a',
      event: { revision: 3 },
      folderContext: [{ internalComments: 'Permitted internal note' }],
    };
    mocks.post.mockImplementation(async (url: string) => ({
      data: url.endsWith('/scope')
        ? {
            folders: [{ id: 'folder-a', name: 'Selected private folder' }],
            billIds: [],
            matches: [],
          }
        : url.startsWith('/workspace-api')
          ? { id: 'draft-a' }
          : { draft: { docTitle: 'Prep' }, context, sources: [] },
    }));
    render(<PreparationPanel event={event} clientId="client-a" folderId="folder-a" />, {
      wrapper: wrapper(),
    });
    await screen.findByRole('option', { name: 'Selected private folder' });
    fireEvent.click(screen.getByRole('button', { name: 'Create prep draft' }));
    await screen.findByRole('link', { name: 'Open in Workspace' });
    expect(mocks.post.mock.calls).toEqual([
      ['/intel-api/legiwatch/calendar/scope', { clientId: 'client-a', jurisdiction: 'FL' }],
      [
        '/intel-api/legiwatch/calendar/events/state-fl-test/preparation',
        { clientId: 'client-a', folderIds: ['folder-a'] },
      ],
      ['/workspace-api/drafts', { docTitle: 'Prep' }],
      [
        '/workspace-api/drafts/draft-a/context',
        expect.objectContaining({
          kind: 'free-text',
          payload: expect.objectContaining({
            text: expect.stringContaining('Permitted internal note'),
          }),
        }),
      ],
    ]);
    expect(mocks.patch).toHaveBeenCalledWith('/workspace-api/drafts/draft-a', {
      config: expect.objectContaining({
        legiwatch: { mode: 'preparation', snapshotId: 'snapshot-a', contentHash: undefined },
        sections: expect.arrayContaining(['Published schedule', 'Ordered agenda']),
      }),
    });
    const config = mocks.patch.mock.calls[0]![1].config;
    expect(JSON.stringify(config)).not.toContain('Permitted internal note');
  });
  it('warns about changed source revisions without modifying the saved draft', async () => {
    mocks.get.mockResolvedValue({
      data: { stale: true, hearingId: 'state-fl-test', preparedRevision: 3, currentRevision: 4 },
    });
    render(
      <PreparationRevisionNotice
        config={{ legiwatch: { mode: 'preparation', snapshotId: 'snapshot-a' } }}
      />,
      { wrapper: wrapper() },
    );
    await screen.findByText(/published calendar changed/i);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/legiwatch/hearings/state-fl-test');
  });
  it('does not reuse a prior tenant’s source status after impersonation changes', async () => {
    mocks.get
      .mockResolvedValueOnce({
        data: { stale: true, hearingId: 'state-fl-test', preparedRevision: 3, currentRevision: 4 },
      })
      .mockRejectedValueOnce(Error('Forbidden'));
    const config = { legiwatch: { mode: 'preparation', snapshotId: 'snapshot-a' } };
    const ui = render(<PreparationRevisionNotice config={config} />, { wrapper: wrapper() });
    await screen.findByText(/published calendar changed/i);
    mocks.actor = 'tenant-b:user-a';
    ui.rerender(<PreparationRevisionNotice config={config} />);
    await waitFor(() => expect(screen.queryByText(/published calendar changed/i)).toBeNull());
    await screen.findByText(/source could not be checked/i);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
});
