import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ReportWorkspace } from './ReportWorkspace.js';
import { defaultSettings, type Run } from './report-api.js';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  scope: 'workspace-a',
  enabled: true,
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => api.scope }));
const report = {
  id: 'report-a',
  name: 'Synthetic report A',
  folderIds: ['folder-a'],
  jurisdiction: 'FL',
  sessionKey: '2026',
  version: 4,
  settings: defaultSettings,
  canEdit: true,
};
const folder = {
  id: 'folder-a',
  name: 'Synthetic folder',
  canEdit: true,
  version: 0,
  jurisdiction: 'FL',
  defaultSession: '2026',
};
const run: Run = {
  id: 'run-a',
  reportId: report.id,
  audience: 'external',
  complete: true,
  generatedAt: '2026-09-10T12:00:00Z',
  cutoff: '2026-09-10',
  contentHash: 'a'.repeat(64),
  definitionVersion: 4,
  rendered: {
    html: '<html><body><h1>Frozen synthetic report</h1></body></html>',
    text: 'Frozen synthetic report',
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  api.scope = 'workspace-a';
  api.enabled = true;
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/feature-flags'))
      return {
        data: { legiwatch_reports_updates_v1: api.enabled, legiwatch_report_delivery_v1: true },
      };
    if (url.endsWith('/recipients'))
      return { data: { contacts: [], lists: [], senderEmail: 'operator@example.invalid' } };
    if (url.endsWith('/folders')) return { data: [folder] };
    if (url.endsWith('/sessions/FL')) return { data: [{ key: '2026', label: '2026 session' }] };
    if (url.endsWith('/reports')) return { data: api.scope === 'workspace-a' ? [report] : [] };
    if (url.endsWith('/runs/run-a')) return { data: run };
    return { data: [] };
  });
});
afterEach(cleanup);
function mount(initialTab?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ReportWorkspace initialTab={initialTab} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, refreshScope: () => view.rerender(ui()) };
}
test('a disabled workspace exposes no report controls or private directory requests', async () => {
  api.enabled = false;
  mount();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByRole('heading', { name: 'Reports & updates' })).toBeNull();
  expect(api.get.mock.calls.every(([url]) => url.endsWith('/feature-flags'))).toBe(true);
});
test('an edit preserves a conflict draft and keeps display windows separate from selection filters', async () => {
  api.put.mockRejectedValue({ response: { status: 409 } });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit report' });
  fireEvent.change(within(dialog).getByLabelText('Report name'), {
    target: { value: 'Preserved draft' },
  });
  fireEvent.change(within(dialog).getByLabelText('Action display'), {
    target: { value: 'five_days' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save report' }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      '/intel-api/legiwatch/reports/report-a',
      expect.objectContaining({
        name: 'Preserved draft',
        expectedVersion: 4,
        settings: expect.objectContaining({ actions: 'five_days' }),
      }),
    ),
  );
  expect((within(dialog).getByLabelText('Report name') as HTMLInputElement).value).toBe(
    'Preserved draft',
  );
  expect(
    (
      within(dialog).getByLabelText(
        'Select bills with action on or after (optional)',
      ) as HTMLInputElement
    ).value,
  ).toBe('');
});
test('generation opens the frozen run and requires a separate exact recipient review before sending', async () => {
  api.post.mockImplementation(async (url: string) =>
    url.endsWith('/generate')
      ? { data: run }
      : url.endsWith('/compose')
        ? {
            data: {
              complete: true,
              approvalHash: 'reviewed-hash',
              composition: {
                subject: 'Legislative report',
                introduction: '',
                recipients: [{ email: 'operator@example.invalid', role: 'bcc', contacts: [] }],
              },
            },
          }
        : { data: { state: 'queued' } },
  );
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Generate' }));
  const dialog = await screen.findByRole('dialog', { name: 'Report preview' });
  expect(within(dialog).getByTitle('Frozen legislative report').getAttribute('srcdoc')).toBe(
    run.rendered!.html,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review delivery' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Copy me (Bcc)' }));
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/send'))).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview exact recipients' }));
  fireEvent.click(
    await within(dialog).findByRole('button', { name: 'Approve and queue 1 recipients' }),
  );
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/intel-api/legiwatch/reports/runs/run-a/send',
      expect.objectContaining({
        approvalHash: 'reviewed-hash',
        selection: [{ kind: 'manual', role: 'bcc', email: 'operator@example.invalid' }],
      }),
    ),
  );
});
test('tenant switching discards an in-flight report result and private recipient state', async () => {
  let resolve!: (value: { data: Run }) => void;
  api.post.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Generate' }));
  api.scope = 'workspace-b';
  view.refreshScope();
  await screen.findByText('No report definitions yet. Create a report or review staged imports.');
  await act(async () => resolve({ data: run }));
  expect(screen.queryByRole('dialog', { name: 'Report preview' })).toBeNull();
  expect(screen.queryByText(report.name)).toBeNull();
});
test('daily schedules default to a draft and never activate as a side effect of saving', async () => {
  api.post.mockResolvedValue({
    data: {
      id: 'sub-a',
      reportId: report.id,
      mode: 'draft',
      enabled: false,
      version: 0,
      timezone: 'America/New_York',
      localMinutes: 480,
      recipients: [],
      baselineAt: null,
    },
  });
  mount('updates');
  fireEvent.click(await screen.findByRole('button', { name: 'Create schedule' }));
  const dialog = screen.getByRole('dialog', { name: 'Daily report schedule' });
  expect((within(dialog).getByLabelText('Occurrence mode') as HTMLSelectElement).value).toBe(
    'draft',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save disabled schedule' }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/intel-api/legiwatch/reports/subscriptions',
      expect.objectContaining({ mode: 'draft', catchUp: 'draft', selection: [] }),
    ),
  );
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/activation'))).toBe(false);
});

test('rule review shows current staff channels and blocks activation while source coverage needs review', async () => {
  const getDefault = api.get.getMockImplementation()!;
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/rules'))
      return {
        data: [
          {
            id: 'rule-a',
            name: 'Published records',
            folderIds: ['folder-a'],
            recipients: [{ userId: 'staff-a', email: true, inApp: false }],
            cadence: 'end_of_day',
            state: 'needs_review',
            version: 1,
            timezone: 'America/New_York',
            localMinutes: 1020,
            issues: [],
          },
        ],
      };
    if (url.endsWith('/members'))
      return { data: { members: [{ id: 'staff-a', name: 'Current staff' }] } };
    if (url.endsWith('/readiness'))
      return {
        data: {
          ready: false,
          issues: ['Fresh source checks required'],
          examples: [
            { key: 'event-a', number: 'HB93', date: '2026-09-10', text: 'Referred to committee' },
          ],
        },
      };
    return getDefault(url);
  });
  mount('alerts');
  fireEvent.click(await screen.findByRole('button', { name: 'Review rule' }));
  const dialog = await screen.findByRole('dialog');
  expect(await within(dialog).findByText('Current staff')).toBeTruthy();
  expect(within(dialog).getByLabelText('Email')).toBeChecked();
  expect(within(dialog).getByLabelText('In-app')).not.toBeChecked();
  expect(within(dialog).getByRole('button', { name: 'Activate from now' })).toBeDisabled();
  expect(within(dialog).getByText('Fresh source checks required')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
