import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FolderBillsTab } from './FolderBillsTab.js';
import { FOLDER_BASE } from './folder-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
const mocks = vi.hoisted(() => ({
  identity: 'workspace-a',
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.identity }));
vi.mock('./Bill360Drawer.js', () => ({ Bill360Drawer: () => null }));
const folder = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Synthetic folder',
  code: null,
  archived: false,
  clientId: null,
  ownerClerkId: 'owner',
  otherUserAccess: 'read_change',
  defaultSession: '2099',
  jurisdiction: 'FL',
  version: 0,
  canEdit: true,
  canManage: true,
  count: 1,
};
/** Last matching API call (test lib predates Array.prototype.findLast). */
function lastCall(
  calls: Array<unknown[]>,
  suffix: string,
): [string, { params: Record<string, unknown> }] | undefined {
  const hits = (calls as Array<[string, { params: Record<string, unknown> }]>).filter(([url]) =>
    url.endsWith(suffix),
  );
  return hits[hits.length - 1];
}
const row = {
  id: 'fl-2099-hb1',
  assignmentId: 'assignment1',
  folderId: folder.id,
  number: 'HB 1',
  title: 'Synthetic title',
  sponsor: 'Synthetic sponsor',
  status: 'introduced',
  jurisdiction: 'FL',
  sessionKey: '2099',
  latestAction: 'Referred',
  latestActionAt: '2099-01-20',
  topPriority: true,
  importance: 'high',
  position: 'oppose',
  internalComments: 'Private original',
  externalComments: 'External original',
  version: 0,
};
beforeEach(() => {
  mocks.identity = 'workspace-a';
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.put.mockReset();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/sessions/FL')) return { data: [{ key: '2099', label: '2099 Regular' }] };
    if (url.endsWith('/folders')) return { data: [folder] };
    if (url.endsWith('/board')) return { data: { rows: [row], total: 1, nextCursor: null } };
    throw new Error('Unexpected request ' + url);
  });
});
afterEach(cleanup);
function mount(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  scope = '',
  entry = '/legiwatch?tab=bills&folder=' + folder.id,
  clients: Array<{ id: string; name: string }> = [],
) {
  const locationRef = { search: entry.slice(entry.indexOf('?')) };
  const Probe = () => {
    locationRef.search = useLocation().search;
    return null;
  };
  return {
    qc,
    locationRef,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <Probe />
          <FolderBillsTab scope={scope} clients={clients as Client[]} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
test('folderQ keeps the folder board request out of public search', async () => {
  mount(undefined, '', '/legiwatch?tab=bills&folder=' + folder.id + '&folderQ=committee');
  await screen.findByRole('button', { name: 'HB 1' });
  expect(mocks.get.mock.calls.some(([url]) => url.endsWith('/search'))).toBe(false);
  const call = lastCall(mocks.get.mock.calls, '/board');
  expect(call).toBeTruthy();
  expect(call![1].params).toMatchObject({ folderId: folder.id, q: 'committee' });
});
test('view controls hide columns and reveal only explicitly selected comment visibility', async () => {
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  expect(screen.queryByText('Private original')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'View' }));
  const dialog = screen.getByRole('dialog', { name: 'Table view' });
  fireEvent.change(within(dialog).getByLabelText('Display comments'), {
    target: { value: 'external' },
  });
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Sponsor' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.getByText('External original', { exact: false })).toBeTruthy();
  expect(screen.queryByText('Private original', { exact: false })).toBeNull();
  expect(screen.queryByRole('columnheader', { name: 'Sponsor' })).toBeNull();
});
test('a version conflict keeps the context draft until explicit reload or discard', async () => {
  mocks.put.mockRejectedValue({
    response: { status: 409, data: { message: 'FOLDER_CONTEXT_CHANGED' } },
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const draft = screen.getByLabelText(/Folder internal comments/);
  fireEvent.change(draft, { target: { value: 'My unsaved correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save context' }));
  await waitFor(() => expect(mocks.put).toHaveBeenCalled());
  expect(draft).toHaveValue('My unsaved correction');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Discard your unsaved changes?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText(/Folder internal comments/)).toHaveValue('My unsaved correction');
});
test('switching workspace does not expose the previous cached table while the new scope loads', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/legiwatch?tab=bills&folder=' + folder.id]}>
        <FolderBillsTab scope="" clients={[]} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const app = render(tree());
  await screen.findByRole('button', { name: 'HB 1' });
  mocks.identity = 'workspace-b';
  mocks.get.mockImplementation(() => new Promise(() => {}));
  app.rerender(tree());
  expect(screen.queryByRole('button', { name: 'HB 1' })).toBeNull();
});

test('jurisdiction changes atomically clear the prior session and load that jurisdiction', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url, ...args) =>
    url.endsWith('/sessions/US')
      ? { data: [{ key: '119', label: '119th Congress' }] }
      : original(url, ...args),
  );
  mount(undefined, '', '/legiwatch?tab=bills&folder=' + folder.id + '&session=2099');
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'US' } });
  await waitFor(() =>
    expect(mocks.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/board$/),
      expect.objectContaining({
        params: expect.objectContaining({ jurisdiction: 'US', sessionKey: '119' }),
      }),
    ),
  );
  expect(screen.getByLabelText('Jurisdiction')).toHaveValue('US');
  expect(screen.getByLabelText('Session')).toHaveValue('119');
});

test('All folder assignments clears the specific folder in the authoritative board request', async () => {
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  mocks.get.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'All folder assignments' }));
  await screen.findByRole('heading', { name: 'All folder assignments' });
  await waitFor(() => {
    const call = mocks.get.mock.calls.find(([url]) => url.endsWith('/board'));
    expect(call).toBeTruthy();
    expect(call![1].params).not.toHaveProperty('folderId');
  });
});

test('client lens selects its own folder and canonical search can discover unassigned bills', async () => {
  const scoped = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Client B folder',
    clientId: 'client-b',
  };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url, ...args) => {
    if (url.endsWith('/folders')) return { data: [folder, scoped] };
    if (url.endsWith('/search'))
      return {
        data: {
          rows: [{ ...row, id: 'fl-2099-hb2', number: 'HB 2', assignmentId: null }],
          total: 1,
          nextCursor: null,
        },
      };
    return original(url, ...args);
  });
  mount(undefined, 'client-b', '/legiwatch?tab=bills');
  await screen.findByRole('heading', { name: 'Client B folder' });
  expect(screen.queryByRole('button', { name: /Synthetic folder/ })).toBeNull();
  expect(mocks.get).toHaveBeenCalledWith(
    expect.stringMatching(/\/board$/),
    expect.objectContaining({
      params: expect.objectContaining({ folderId: scoped.id, clientId: 'client-b' }),
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Search all bills' }));
  await screen.findByRole('button', { name: 'HB 2' });
  const call = mocks.get.mock.calls.find(([url]) => url.endsWith('/search'));
  // Global corpus search is public: private folder/client context must never
  // be sent; the jurisdiction/session that scoped the board stay as explicit
  // corpus filters the user can widen or clear.
  // Default global corpus search spans every ingested jurisdiction/session;
  // the user narrows via the dynamic corpus-metadata dropdowns.
  expect(call![1].params).not.toHaveProperty('jurisdiction');
  expect(call![1].params).not.toHaveProperty('sessionKey');
  expect(call![1].params).not.toHaveProperty('clientId');
  expect(call![1].params).not.toHaveProperty('folderId');
});

test('global search table aligns Jurisdiction/Session/Sponsor cells with headers', async () => {
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/sessions/FL')) return { data: [{ key: '2099', label: '2099 Regular' }] };
    if (url.endsWith('/folders')) return { data: [folder] };
    if (url.endsWith('/search'))
      return {
        data: {
          rows: [
            {
              ...row,
              assignmentId: null,
              number: 'HB 9',
              title: 'Corpus bill',
              sponsor: 'Sponsor Z',
              jurisdiction: 'GA',
              sessionKey: '2097xA',
            },
          ],
          total: 1,
          nextCursor: null,
        },
      };
    if (url.endsWith('/board')) return { data: { rows: [row], total: 1, nextCursor: null } };
    throw new Error('Unexpected request ' + url);
  });
  mount(undefined, '', '/legiwatch?tab=bills&folder=' + folder.id + '&folderSearch=1&folderQ=corpus');
  await screen.findByRole('button', { name: 'HB 9' });
  const table = screen.getByRole('table', { name: 'Folder bill table' });
  const headers = within(table)
    .getAllByRole('columnheader')
    .filter((h) => !h.closest('[hidden]') && !(h as HTMLTableCellElement).hidden)
    .map((h) => h.textContent);
  const dataCells = within(table)
    .getAllByRole('cell')
    .filter((c) => !c.closest('[hidden]') && !(c as HTMLTableCellElement).hidden);
  const ji = headers.indexOf('Jurisdiction');
  const si = headers.indexOf('Session');
  const spi = headers.indexOf('Sponsor');
  expect(ji).toBeGreaterThan(-1);
  expect(si).toBe(ji + 1);
  expect(spi).toBe(si + 1);
  // The row's visible cells line up under those headers in the same order.
  expect(dataCells[ji]!.textContent).toBe('GA');
  expect(dataCells[si]!.textContent).toBe('2097xA');
  expect(dataCells[spi]!.textContent).toBe('Sponsor Z');
});

test('picking a folder from the rail exits global corpus search entirely', async () => {
  const scoped = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000007',
    name: 'Other folder',
  };
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/sessions/FL')) return { data: [{ key: '2099', label: '2099 Regular' }] };
    if (url.endsWith('/folders')) return { data: [folder, scoped] };
    if (url.endsWith('/search')) return { data: { rows: [], total: 0, nextCursor: null } };
    if (url.endsWith('/board')) return { data: { rows: [row], total: 1, nextCursor: null } };
    throw new Error('Unexpected request ' + url);
  });
  // Mount in a live corpus-search URL state (query + scope triggers set).
  const { locationRef } = mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' +
      folder.id +
      '&folderSearch=1&folderQ=corpus&folderJurisdiction=all&folderSessionSearch=2099',
  );
  await screen.findByRole('heading', { name: 'All available bills' });
  // The rail lists the folders that do NOT match the active scope search; the
  // other folder is reachable via the Find folder filter.
  fireEvent.change(screen.getByLabelText('Find folder'), { target: { value: 'Other' } });
  fireEvent.click(await screen.findByRole('button', { name: /Other folder/ }));
  await waitFor(() => {
    const p = new URLSearchParams(locationRef.search);
    expect(p.get('folder')).toBe(scoped.id);
    // Every corpus-search trigger is cleared — the folder board returns.
    expect(p.get('folderSearch')).toBeNull();
    expect(p.get('folderQ')).toBeNull();
    expect(p.get('folderJurisdiction')).toBeNull();
    expect(p.get('folderSessionSearch')).toBeNull();
  });
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/board');
    expect(call).toBeTruthy();
    expect(call![1].params).toMatchObject({ folderId: scoped.id });
  });
});

test('All folder assignments exits global corpus search entirely', async () => {
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/sessions/FL')) return { data: [{ key: '2099', label: '2099 Regular' }] };
    if (url.endsWith('/folders')) return { data: [folder] };
    if (url.endsWith('/search')) return { data: { rows: [], total: 0, nextCursor: null } };
    if (url.endsWith('/board')) return { data: { rows: [row], total: 1, nextCursor: null } };
    throw new Error('Unexpected request ' + url);
  });
  const { locationRef } = mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' + folder.id + '&folderSearch=1&folderQ=corpus&folderJurisdiction=all',
  );
  await screen.findByRole('heading', { name: 'All available bills' });
  fireEvent.click(screen.getByRole('button', { name: 'All folder assignments' }));
  await waitFor(() => {
    const p = new URLSearchParams(locationRef.search);
    expect(p.get('folderAll')).toBe('1');
    expect(p.get('folder')).toBeNull();
    expect(p.get('folderSearch')).toBeNull();
    expect(p.get('folderQ')).toBeNull();
    expect(p.get('folderJurisdiction')).toBeNull();
    expect(p.get('folderSessionSearch')).toBeNull();
  });
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/board');
    expect(call).toBeTruthy();
    expect(call![1].params).not.toHaveProperty('folderId');
  });
});

test('copy selected posts the exact canonical bill ids to chosen targets and retains originals', async () => {
  const second = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000009',
    name: 'Target folder',
  };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/folders')) return { data: [folder, second] };
    if (url.endsWith('/members'))
      return {
        data: {
          members: [{ id: 'owner', name: 'Owner Name' }],
          currentActor: 'owner',
          canAssignOwner: true,
        },
      };
    return original(url, ...args);
  });
  mocks.post.mockResolvedValue({ data: { results: [{ billId: row.id, status: 'added' }] } });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  // Select the row, copy it into another folder.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select HB 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy selected' }));
  // Copy mode shows the chosen bills read-only — no display-label editing.
  const modal = screen.getByRole('dialog');
  expect(within(modal).queryByLabelText(/Bill numbers/)).toBeNull();
  expect(within(modal).queryByRole('button', { name: 'Resolve bills' })).toBeNull();
  expect(within(modal).getByText('HB 1')).toBeTruthy();
  fireEvent.click(within(modal).getByRole('checkbox', { name: /Target folder/ }));
  fireEvent.click(within(modal).getByRole('button', { name: /Copy 1 bill to 1 folder/ }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(`${FOLDER_BASE}/${second.id}/bills`, {
      action: 'add',
      billIds: [row.id],
    }),
  );
  // The original membership was never removed (no remove action posted).
  const calls = mocks.post.mock.calls.filter(([, body]) => (body as { action?: string }).action);
  expect(calls.every(([, body]) => (body as { action?: string }).action === 'add')).toBe(true);
  // Result copy uses the display number, and duplication is a reported no-op.
  await screen.findByText(/Target folder \/ HB 1: added/);
});

test('copy selected dedupes the same canonical bill chosen once per folder in All assignments', async () => {
  const second = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000009',
    name: 'Target folder',
  };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/folders')) return { data: [folder, second] };
    if (url.endsWith('/members'))
      return {
        data: {
          members: [{ id: 'owner', name: 'Owner Name' }],
          currentActor: 'owner',
          canAssignOwner: true,
        },
      };
    if (url.endsWith('/board'))
      return {
        data: {
          rows: [
            { ...row, assignmentId: 'assignment1', folderId: folder.id },
            { ...row, assignmentId: 'assignment2', folderId: 'another-folder' },
          ],
          total: 2,
          nextCursor: null,
        },
      };
    return original(url, ...args);
  });
  mocks.post.mockResolvedValue({ data: { results: [{ billId: row.id, status: 'added' }] } });
  mount(undefined, '', '/legiwatch?tab=bills&folderAll=1');
  // The same canonical bill appears once per assignment.
  const occurrences = await screen.findAllByRole('button', { name: 'HB 1' });
  expect(occurrences.length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select this page' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy selected' }));
  const modal = screen.getByRole('dialog');
  // Display dedupes to one chosen bill even though two assignments were selected.
  expect(within(modal).getByRole('button', { name: /Copy 1 bill/ })).toBeTruthy();
  fireEvent.click(within(modal).getByRole('checkbox', { name: /Target folder/ }));
  fireEvent.click(within(modal).getByRole('button', { name: /Copy 1 bill to 1 folder/ }));
  await waitFor(() => {
    const posts = mocks.post.mock.calls.filter(([url]) => url.endsWith('/bills'));
    expect(posts).toHaveLength(1);
  });
  const posts = mocks.post.mock.calls.filter(([url]) => url.endsWith('/bills'));
  expect(posts[0]![0]).toBe(`${FOLDER_BASE}/${second.id}/bills`);
  // Exactly one canonical id is posted despite two selected assignments.
  expect(posts[0]![1]).toEqual({ action: 'add', billIds: [row.id] });
});

test('copy selected accumulates per-target failures and still refreshes successful ones', async () => {
  const second = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000009',
    name: 'Target folder',
  };
  const third = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Failing target',
  };
  const fourth = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000012',
    name: 'Second failing target',
  };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/folders')) return { data: [folder, second, third, fourth] };
    if (url.endsWith('/members'))
      return {
        data: {
          members: [{ id: 'owner', name: 'Owner Name' }],
          currentActor: 'owner',
          canAssignOwner: true,
        },
      };
    return original(url, ...args);
  });
  mocks.post.mockImplementation(async (url: string) => {
    if (url === `${FOLDER_BASE}/${third.id}/bills` || url === `${FOLDER_BASE}/${fourth.id}/bills`)
      throw { response: { status: 500, data: { message: 'SOURCE_UNAVAILABLE' } } };
    return { data: { results: [{ billId: row.id, status: 'added' }] } };
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  const baselineBoardCalls = mocks.get.mock.calls.filter(([url]) => url.endsWith('/board')).length;
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select HB 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy selected' }));
  const modal = screen.getByRole('dialog');
  fireEvent.click(within(modal).getByRole('checkbox', { name: /Target folder/ }));
  fireEvent.click(within(modal).getByRole('checkbox', { name: /Failing target/ }));
  fireEvent.click(within(modal).getByRole('checkbox', { name: /Second failing target/ }));
  fireEvent.click(within(modal).getByRole('button', { name: /Copy 1 bill to 3 folders/ }));
  // Success outcome for target 1 remains visible even though two targets failed.
  await screen.findByText(/Target folder \/ HB 1: added/);
  // Every failed target is reported, not just the last one.
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Failing target/);
  expect(alert).toHaveTextContent(/Second failing target/);
  // The successful mutation refreshed the board (baseline count increased).
  await waitFor(() => {
    const now = mocks.get.mock.calls.filter(([url]) => url.endsWith('/board')).length;
    expect(now).toBeGreaterThan(baselineBoardCalls);
  });
});

test('copy to a read-only target is not selectable and the action stays disabled', async () => {
  const failing = {
    ...folder,
    id: '00000000-0000-4000-8000-000000000010',
    name: 'Read only target',
    canEdit: false,
  };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/folders')) return { data: [folder, failing] };
    if (url.endsWith('/members'))
      return {
        data: {
          members: [{ id: 'owner', name: 'Owner Name' }],
          currentActor: 'owner',
          canAssignOwner: true,
        },
      };
    return original(url, ...args);
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select HB 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy selected' }));
  const modal = screen.getByRole('dialog');
  // Read-only targets are not selectable; the add button stays disabled.
  const readonly = within(modal).getByRole('checkbox', { name: /Read only target/ });
  expect(readonly).toBeDisabled();
  expect(within(modal).getByRole('button', { name: /Copy 1 bill/ })).toBeDisabled();
});

test('copy selected prefill keeps ordinary FastTagger resolve behavior separate', async () => {
  mocks.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/resolve'))
      return {
        data: [
          {
            token: 'HB 9',
            status: 'resolved',
            bill: { ...row, id: 'fl-2099-hb9', number: 'HB 9' },
            reason: null,
            alreadyIn: [],
          },
        ],
      };
    return { data: { results: [{ billId: 'fl-2099-hb9', status: 'added' }] } };
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.click(screen.getByRole('button', { name: 'Add bills by number' }));
  const modal = screen.getByRole('dialog');
  fireEvent.change(within(modal).getByLabelText(/Bill numbers/), { target: { value: 'HB 9' } });
  fireEvent.click(within(modal).getByRole('button', { name: 'Resolve bills' }));
  await within(modal).findByText(/resolved/);
  fireEvent.click(within(modal).getByRole('button', { name: /Add 1 selected bill/ }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(`${FOLDER_BASE}/${folder.id}/bills`, {
      action: 'add',
      billIds: ['fl-2099-hb9'],
    }),
  );
});

test('new folders default to the active client and explicitly independent folders retain the lens', async () => {
  const scoped = { ...folder, clientId: 'client-b', name: 'Client B original' };
  const created = { ...scoped, id: '00000000-0000-4000-8000-000000000002', name: 'Client B new' };
  const folderList = [scoped];
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url, ...args) => {
    if (url.endsWith('/folders')) return { data: [...folderList] };
    if (url.endsWith('/members'))
      return {
        data: {
          members: [{ id: 'owner', name: 'Owner' }],
          currentActor: 'owner',
          canAssignOwner: true,
        },
      };
    return original(url, ...args);
  });
  mocks.post.mockImplementation(async (_url, values) => {
    const result = { ...created, ...values };
    folderList.push(result);
    return { data: result };
  });
  mount(undefined, 'client-b', '/legiwatch?tab=bills&folder=' + folder.id, [
    { id: 'client-b', name: 'Client B' },
  ]);
  await screen.findByRole('heading', { name: scoped.name });
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  expect(screen.getByLabelText('Client link')).toHaveValue('client-b');
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: created.name } });
  fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
  await screen.findByRole('heading', { name: created.name });
  expect(mocks.post).toHaveBeenCalledWith(
    expect.stringMatching(/\/folders$/),
    expect.objectContaining({ clientId: 'client-b' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
  fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Independent new' } });
  fireEvent.change(screen.getByLabelText('Client link'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save folder' }));
  await screen.findByText(/Folder created outside this client lens/);
  expect(screen.getByRole('heading', { name: created.name })).toBeTruthy();
});

test('advanced filters are sent to the board request and reset pagination state', async () => {
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.click(screen.getByRole('button', { name: 'More filters/details' }));
  // Wrapper labels include help text — match by prefix.
  fireEvent.change(screen.getByLabelText(/^Summary text/), { target: { value: 'insurance' } });
  fireEvent.change(screen.getByLabelText(/^Latest action text/), { target: { value: 'referred' } });
  fireEvent.change(screen.getByLabelText(/^Bill type/), { target: { value: 'B' } });
  fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: 'health' } });
  fireEvent.change(screen.getByLabelText(/^Current committee/), {
    target: { value: 'Fiscal Policy' },
  });
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/board');
    expect(call).toBeTruthy();
    expect(call![1].params).toMatchObject({
      summary: 'insurance',
      actionText: 'referred',
      classification: 'B',
      subject: 'health',
      committee: 'Fiscal Policy',
    });
  });
});

test('show summaries requests the projection and renders summary, committee and subjects', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/board'))
      return {
        data: {
          rows: [
            {
              ...row,
              summary: 'Revises health care coverage requirements.',
              classifications: ['bill'],
              subjects: ['Health Care', 'Insurance'],
              currentCommittee: 'Fiscal Policy',
            },
          ],
          total: 1,
          nextCursor: null,
        },
      };
    return original(url, ...args);
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  expect(screen.queryByText('Revises health care coverage requirements.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'More filters/details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show summaries' }));
  await screen.findByText('Revises health care coverage requirements.');
  expect(screen.getByText(/Committee: Fiscal Policy/)).toBeTruthy();
  expect(screen.getByText(/Subjects: Health Care, Insurance/)).toBeTruthy();
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/board');
    expect(call![1].params).toMatchObject({ summaryIncluded: 'true' });
  });
});

test('daily activity view queries the activities route with folder scope and opens Bill 360', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [
            {
              id: 'act-1',
              billId: 'fl-2099-hb1',
              number: 'HB 1',
              title: 'Synthetic title',
              jurisdiction: 'FL',
              sessionKey: '2099',
              date: '2099-01-21',
              kind: 'action',
              text: 'Referred to Fiscal Policy',
              url: 'https://www.flsenate.gov/Session/Bill/2099/1',
              providerDocumentId: 123,
              chamber: 'lower',
              provenance: 'published_record',
            },
          ],
          total: 1,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: {
            jurisdiction: 'FL',
            sessionKey: '2099',
            folderId: folder.id,
            clientId: null,
            onlyTracked: false,
            chamber: null,
          },
        },
      };
    return original(url, ...args);
  });
  mount();
  await screen.findByRole('button', { name: 'HB 1' });
  fireEvent.click(screen.getByRole('button', { name: 'Daily activity' }));
  await screen.findByText(/Referred to Fiscal Policy/);
  const call = mocks.get.mock.calls.find(([url]) => url.endsWith('/activities'));
  expect(call![1].params).toMatchObject({
    jurisdiction: 'FL',
    sessionKey: '2099',
    kind: 'action',
    folderId: folder.id,
  });
  // The selected date defaults to local today and is sent as the day window.
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  expect(call![1].params).toMatchObject({ from: todayStr, to: todayStr });
  // The scope label is human context, not opaque wire metadata.
  expect(screen.getAllByText(/Synthetic folder/).length).toBeGreaterThan(0);
  expect(screen.getByText(/1 action · Synthetic folder/)).toBeTruthy();
  // Chamber renders as a readable label, not a raw lower/upper code.
  expect(screen.getAllByText(/House \/ Assembly/).length).toBeGreaterThan(0);
  expect(screen.queryByText(/ · lower$/)).toBeNull();
  // Source link preserved.
  expect(screen.getByRole('link', { name: 'Original source' })).toHaveAttribute(
    'href',
    'https://www.flsenate.gov/Session/Bill/2099/1',
  );
  // Kind and day navigation drive the same request.
  fireEvent.change(screen.getByLabelText('Record type'), { target: { value: 'text' } });
  await waitFor(() => {
    const next = lastCall(mocks.get.mock.calls, '/activities');
    expect(next![1].params).toMatchObject({ kind: 'text' });
  });
  fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
  await waitFor(() => {
    const next = lastCall(mocks.get.mock.calls, '/activities');
    const params = next![1].params as { from: string; to: string };
    expect(params.from).toBe(params.to);
    expect(params.from < todayStr).toBe(true);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
  await waitFor(() => {
    const next = lastCall(mocks.get.mock.calls, '/activities');
    expect(next![1].params).toMatchObject({ from: todayStr, to: todayStr });
  });
  // Returning to bills restores the folder table.
  fireEvent.click(screen.getByRole('button', { name: 'Back to bills' }));
  await screen.findByRole('button', { name: 'HB 1' });
});

test('daily activity in All assignments sends onlyTracked and the client lens, not a folder id', async () => {
  const scopedFolder = { ...folder, clientId: 'client-b' };
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/folders')) return { data: [scopedFolder] };
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(undefined, 'client-b', '/legiwatch?tab=bills&folderAll=1');
  await screen.findByRole('heading', { name: 'All folder assignments' });
  fireEvent.click(screen.getByRole('button', { name: 'Daily activity' }));
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call).toBeTruthy();
    expect(call![1].params).toMatchObject({ clientId: 'client-b', onlyTracked: 'true' });
    expect(call![1].params).not.toHaveProperty('folderId');
  });
  // Board-only actions are hidden while the daily view is active.
  expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add bills by number' })).toBeNull();
});

test('daily activity passes the chamber filter from the board filters', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' + folder.id + '&folderChamber=lower&folderActivity=1',
  );
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call).toBeTruthy();
    expect(call![1].params).toMatchObject({ chamber: 'lower' });
  });
});

test('daily activity restores kind and pinned date from the URL (deep-link navigation)', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'amendment',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' +
      folder.id +
      '&folderActivity=1&folderActivityKind=amendment&folderActivityDate=2099-02-03',
  );
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call).toBeTruthy();
    expect(call![1].params).toMatchObject({
      kind: 'amendment',
      from: '2099-02-03',
      to: '2099-02-03',
    });
  });
  // The controls reflect the restored state.
  expect(screen.getByLabelText('Record type')).toHaveValue('amendment');
  expect(screen.getByLabelText(/^Selected date/)).toHaveValue('2099-02-03');
});

test('federal text/amendment activity shows source-unavailable, never a zero-event claim', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/sessions/US')) return { data: [{ key: '2099', label: '2099 Congress' }] };
    if (url.endsWith('/activities')) {
      const params = (args[0] as { params: Record<string, unknown> }).params;
      if (params.jurisdiction === 'US' && params.kind !== 'action')
        return {
          data: {
            rows: [],
            total: 0,
            nextCursor: null,
            availability: 'unavailable',
            reason:
              params.kind === 'text'
                ? 'Federal text filing activity is not available from the retained activity sources.'
                : 'Federal amendment activity is not available from the retained activity sources.',
            kind: params.kind,
            from: null,
            to: null,
            scope: null,
          },
        };
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          availability: 'available',
          reason: null,
          kind: params.kind,
          from: null,
          to: null,
          scope: null,
        },
      };
    }
    return original(url, ...args);
  });
  mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' + folder.id + '&folderActivity=1&folderActivityKind=text',
  );
  await waitFor(() => expect(lastCall(mocks.get.mock.calls, '/activities')).toBeTruthy());
  // Switch the board jurisdiction to Federal; session re-loads for US.
  fireEvent.change(screen.getByLabelText('Jurisdiction'), { target: { value: 'US' } });
  await screen.findByText(
    /Federal text filing activity is not available from the retained activity sources\./,
  );
  expect(screen.getByText(/Choose Actions to view retained federal action history\./)).toBeTruthy();
  // No zero-event count, empty-state claim, or pagination for an unavailable source.
  expect(screen.queryByText(/No recorded texts filed/)).toBeNull();
  expect(screen.queryByText(/0 texts filed/)).toBeNull();
  expect(screen.queryByText(/0 results/)).toBeNull();
  // All controls stay usable, including switching back to Actions.
  expect(screen.getByLabelText('Record type')).toHaveValue('text');
  fireEvent.change(screen.getByLabelText('Record type'), { target: { value: 'amendment' } });
  await screen.findByText(
    /Federal amendment activity is not available from the retained activity sources\./,
  );
  expect(screen.queryByText(/No recorded amendments/)).toBeNull();
  expect(screen.queryByText(/0 results/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Record type'), { target: { value: 'action' } });
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call![1].params).toMatchObject({ jurisdiction: 'US', kind: 'action' });
  });
  // Supported federal Actions keep the normal (possibly zero) results chrome.
  await screen.findByText(/0 results/);
  expect(screen.queryByText(/not available from the retained activity sources/)).toBeNull();
});

test('daily activity all-dates state is explicit in the URL and restores without a date window', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' + folder.id + '&folderActivity=1&folderActivityDate=all',
  );
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call).toBeTruthy();
    expect(call![1].params).not.toHaveProperty('from');
    expect(call![1].params).not.toHaveProperty('to');
  });
  expect(screen.getByLabelText(/^Selected date/)).toHaveValue('');
  expect(screen.getAllByText(/all dates/).length).toBeGreaterThan(0);
});

test('changing kind and day writes the URL state that captureCurrentViewState consumes', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  // Probe the live router location — captureCurrentViewState reads the same
  // query string from window.location under the production BrowserRouter.
  let routerSearch = '';
  const Probe = () => {
    routerSearch = useLocation().search;
    return null;
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={['/legiwatch?tab=bills&folder=' + folder.id + '&folderActivity=1']}
      >
        <Probe />
        <FolderBillsTab scope="" clients={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(lastCall(mocks.get.mock.calls, '/activities')).toBeTruthy());
  // Kind change → folderActivityKind param.
  fireEvent.change(screen.getByLabelText('Record type'), { target: { value: 'text' } });
  await waitFor(() => {
    expect(new URLSearchParams(routerSearch).get('folderActivityKind')).toBe('text');
  });
  // Day navigation → pinned date param (no longer the dynamic default).
  fireEvent.click(screen.getByRole('button', { name: 'Previous day' }));
  await waitFor(() => {
    expect(new URLSearchParams(routerSearch).get('folderActivityDate')).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
  // Clearing the date → explicit all-dates state, not a deleted param.
  fireEvent.change(screen.getByLabelText(/^Selected date/), { target: { value: '' } });
  await waitFor(() => {
    expect(new URLSearchParams(routerSearch).get('folderActivityDate')).toBe('all');
  });
  // Canonical scope keys are intact alongside the new activity params.
  const params = new URLSearchParams(routerSearch);
  expect(params.get('folder')).toBe(folder.id);
  expect(params.get('folderActivity')).toBe('1');
  expect(params.get('tab')).toBe('bills');
});

test('absent date param keeps the dynamic local-today default', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(undefined, '', '/legiwatch?tab=bills&folder=' + folder.id + '&folderActivity=1');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call![1].params).toMatchObject({ from: todayStr, to: todayStr });
  });
});

test('daily mode hides board-only filters and the stale board count, keeping jurisdiction/session/chamber', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(undefined, '', '/legiwatch?tab=bills&folder=' + folder.id + '&folderActivity=1');
  await waitFor(() => expect(lastCall(mocks.get.mock.calls, '/activities')).toBeTruthy());
  // Board-only controls are hidden while the activities query ignores them.
  expect(screen.queryByLabelText(/^Search bill or title/)).toBeNull();
  expect(screen.queryByLabelText(/^Sponsor/)).toBeNull();
  expect(screen.queryByLabelText(/^Sort by/)).toBeNull();
  expect(screen.queryByLabelText(/^Comments/)).toBeNull();
  expect(screen.queryByLabelText(/^Priority/)).toBeNull();
  expect(screen.queryByLabelText(/^Importance/)).toBeNull();
  expect(screen.queryByLabelText(/^Position/)).toBeNull();
  expect(screen.queryByLabelText(/^Public status/)).toBeNull();
  expect(screen.queryByLabelText(/^Summary text/)).toBeNull();
  expect(screen.queryByLabelText(/^Latest action text/)).toBeNull();
  expect(screen.queryByLabelText(/^Bill type/)).toBeNull();
  expect(screen.queryByLabelText(/^Subject/)).toBeNull();
  expect(screen.queryByLabelText(/^Current committee/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show summaries' })).toBeNull();
  // Daily-relevant controls remain.
  expect(screen.getByLabelText('Jurisdiction')).toBeTruthy();
  expect(screen.getByLabelText('Session')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'More filters/details' }));
  expect(screen.getByLabelText('Chamber')).toBeTruthy();
  expect(screen.getByLabelText('Record type')).toBeTruthy();
  expect(screen.getByLabelText(/^Selected date/)).toBeTruthy();
  // Heading shows the activity scope, not a stale board count.
  expect(screen.queryByText(/2 assignments|1 assignments|0 assignments/)).toBeNull();
  expect(screen.getByText(/Daily original-record activity · Synthetic folder/)).toBeTruthy();
});

test('search mode + daily activity means the whole-session feed, and Find bills exits activity', async () => {
  const original = mocks.get.getMockImplementation()!;
  mocks.get.mockImplementation(async (url: string, ...args: unknown[]) => {
    if (url.endsWith('/activities'))
      return {
        data: {
          rows: [],
          total: 0,
          nextCursor: null,
          kind: 'action',
          from: null,
          to: null,
          scope: null,
        },
      };
    return original(url, ...args);
  });
  mount(
    undefined,
    '',
    '/legiwatch?tab=bills&folder=' + folder.id + '&folderSearch=1&folderActivity=1',
  );
  await waitFor(() => {
    const call = lastCall(mocks.get.mock.calls, '/activities');
    expect(call).toBeTruthy();
    // Whole-session scope: no folderId, no onlyTracked, no clientId.
    expect(call![1].params).not.toHaveProperty('folderId');
    expect(call![1].params).not.toHaveProperty('onlyTracked');
    expect(call![1].params).not.toHaveProperty('clientId');
  });
  // Heading shows the selected folder as the activity scope; the whole-session
  // contract is asserted on the /activities request params above.
  expect(screen.getByText(/Daily original-record activity · Synthetic folder/)).toBeTruthy();
  // Find bills / Back to folder exits daily mode into the real search table.
  fireEvent.click(screen.getByRole('button', { name: 'Back to folder' }));
  await waitFor(() => {
    const params = new URLSearchParams(window.location.search);
    expect(params.get('folderActivity')).toBeNull();
  });
});
