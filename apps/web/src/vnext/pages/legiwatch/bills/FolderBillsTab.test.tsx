import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FolderBillsTab } from './FolderBillsTab.js';
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
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[entry]}>
          <FolderBillsTab scope={scope} clients={clients as Client[]} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
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
  fireEvent.click(screen.getByRole('button', { name: 'Find bills' }));
  await screen.findByRole('button', { name: 'HB 2' });
  const call = mocks.get.mock.calls.find(([url]) => url.endsWith('/search'));
  expect(call![1].params).toMatchObject({
    folderId: scoped.id,
    jurisdiction: 'FL',
    sessionKey: '2099',
  });
  expect(call![1].params).not.toHaveProperty('clientId');
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
