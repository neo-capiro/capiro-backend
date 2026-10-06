import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { getChatStateSnapshot, resetChatStoreForTests, setConversations, type MeriConversation } from '../../components/chat/chat-store.js';
import { normalizeConversation } from './meri-route-state.js';
import type { MeriWorkspace } from './meri-vnext-api.js';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  auth: { orgId: 'org', userId: 'user' },
  impersonation: { actAsTenantSlug: null as string | null },
  toast: { success: vi.fn(), error: vi.fn() }, navigate: vi.fn(),
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks.auth }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
// The running-jobs section has its own tests; keep its /me read out of this API call sequence.
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: undefined }) }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => mocks.impersonation }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));
import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';

let workspaces: MeriWorkspace[];
let records: MeriConversation[];
let sequence = 0;
const date = '2026-09-09T10:00:00Z';
const workspace = (id: string, name: string, clientId: string | null): MeriWorkspace => ({ id, name, clientId, createdAt: date, updatedAt: date });
const thread = (id: string, title: string, clientId: string | null): MeriConversation => ({
  id, title, clientId, client: clientId ? { id: clientId, name: clientId === 'sightline' ? 'Sightline' : 'Other client' } : null,
  workspaceId: null, workspace: null, updatedAt: date, latestMessage: { body: 'Original answer', createdAt: date },
});
const reloadHistory = () => setConversations(records.map((row) => normalizeConversation(JSON.parse(JSON.stringify(row)))!));
function mount(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const controller = {
    clients: [{ id: 'sightline', name: 'Sightline' }, { id: 'other', name: 'Other client' }],
    selectedClientValue: 'sightline', changeSessionClient: vi.fn(),
  } as unknown as MeriChatController;
  const props = { controller, historyError: null, onRetryHistory: vi.fn(reloadHistory), onArchiveThread: vi.fn(),
    onRenameThread: vi.fn(), onRestoreThread: vi.fn(), searchQuery: '', onSearchQueryChange: vi.fn(),
    searchInputRef: { current: null }, onCollapse: vi.fn(), onOpenPalette: vi.fn() };
  const view = () => <QueryClientProvider client={queryClient}><VNextMeriThreadRail {...props} /></QueryClientProvider>;
  return { ...render(view()), controller, props, queryClient, view };
}
function options(title = 'Wyden notes') {
  const row = screen.getByRole('button', { name: new RegExp(`^${title}`) }).closest('[data-meri-thread-row]')!;
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Chat options' }));
}
function openAssignment(label = 'Add to workspace') {
  options(); fireEvent.click(screen.getByRole('menuitem', { name: label }));
  return screen.getByRole('dialog', { name: 'Move chat to workspace' });
}
async function assign(value: string, label = 'Add to workspace') {
  const dialog = openAssignment(label);
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move chat to workspace' })).toBeNull());
}
beforeEach(() => {
  vi.clearAllMocks(); resetChatStoreForTests();
  mocks.auth.orgId = `org-${++sequence}`; mocks.auth.userId = 'user'; mocks.impersonation.actAsTenantSlug = null;
  workspaces = [workspace('all', 'Team work', null), workspace('other-work', 'Other work', 'other')];
  records = [thread('notes', 'Wyden notes', 'sightline'), thread('general', 'General question', null)];
  reloadHistory();
  mocks.api.get.mockImplementation(async () => ({ data: { workspaces: workspaces.map((row) => ({
    ...row, threadCount: records.filter((conversation) => conversation.workspaceId === row.id).length,
  })) } }));
  mocks.api.post.mockImplementation(async (_path: string, input: Pick<MeriWorkspace, 'name' | 'clientId'>) => {
    const row = workspace('new-work', input.name, input.clientId); workspaces.push(row); return { data: row };
  });
  mocks.api.patch.mockImplementation(async (path: string, input: { workspaceId: string | null }) => {
    const id = decodeURIComponent(path.split('/').at(-2)!);
    const row = records.find((item) => item.id === id)!;
    row.workspaceId = input.workspaceId;
    const target = workspaces.find((item) => item.id === input.workspaceId);
    row.workspace = target ? { id: target.id, name: target.name, clientId: target.clientId } : null;
    return { data: { id, workspaceId: input.workspaceId } };
  });
  mocks.api.delete.mockImplementation(async (path: string) => {
    const id = decodeURIComponent(path.split('/').at(-1)!);
    workspaces = workspaces.filter((row) => row.id !== id);
    records.forEach((row) => { if (row.workspaceId === id) { row.workspaceId = null; row.workspace = null; } });
    return { data: { ok: true, id } };
  });
});

describe('Phase 4 canonical workspace membership', () => {
  test('creates, assigns, opens through workspace, reloads, moves and removes without retargeting the chat', async () => {
    let mounted = mount();
    await screen.findByRole('button', { name: /^Team work/ });
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Create workspace' });
    expect(within(dialog).getByRole('combobox', { name: 'Workspace client' })).toHaveValue('sightline');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Workspace name' }), { target: { value: 'Wyden engagement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    await screen.findByRole('button', { name: /^Wyden engagement Sightline · 0 threads/ });
    await assign('new-work');
    expect(mocks.api.patch).toHaveBeenLastCalledWith('/api/clio/vnext/conversations/notes/workspace', { workspaceId: 'new-work' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(await screen.findByRole('button', { name: /^Wyden engagement Sightline · 1 thread/ }));
    expect(screen.queryByRole('button', { name: /^General question/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Wyden notes/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/meri/t/notes');
    expect(mounted.controller.changeSessionClient).not.toHaveBeenCalled();
    mounted.unmount(); reloadHistory(); mounted = mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Wyden engagement Sightline · 1 thread/ }));
    await assign('all', 'Move to workspace');
    expect(screen.queryByRole('button', { name: /^Wyden notes/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Team work All clients · 1 thread/ }));
    options(); fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from workspace' }));
    await waitFor(() => expect(getChatStateSnapshot().conversations.find((row) => row.id === 'notes')?.workspaceId).toBeNull());
    mounted.unmount(); reloadHistory(); mount();
    await screen.findByRole('button', { name: /^Team work All clients · 0 threads/ });
    expect(getChatStateSnapshot().conversations.find((row) => row.id === 'notes')).toMatchObject({ clientId: 'sightline', latestMessage: { body: 'Original answer' }, workspaceId: null });
    expect(screen.getByRole('button', { name: /^Wyden notes/ })).toBeInTheDocument();
  });

  test('disables another client workspace and accepts All clients without changing scope', async () => {
    const { controller } = mount(); await screen.findByRole('button', { name: /^Other work/ });
    const dialog = openAssignment();
    expect(within(dialog).getByRole('option', { name: 'Other work — different client' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: 'other-work' } });
    expect(within(dialog).getByRole('button', { name: 'Save workspace' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(records[0]!.workspaceId).toBe('all'));
    expect(controller.changeSessionClient).not.toHaveBeenCalled();
  });

  test('retains selection on failed assignment and allows retry with no false local success', async () => {
    mocks.api.patch.mockRejectedValueOnce({ response: { data: { message: 'The chat changed. Reload and try again.' } } });
    mount(); await screen.findByRole('button', { name: /^Team work/ });
    const dialog = openAssignment();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The chat changed');
    expect(getChatStateSnapshot().conversations[0]!.workspaceId).toBeNull();
    expect(within(dialog).getByRole('combobox', { name: 'Workspace' })).toHaveValue('all');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(records[0]!.workspaceId).toBe('all');
  });

  test('rejects an unconfirmed server response instead of claiming membership', async () => {
    mocks.api.patch.mockResolvedValueOnce({ data: { id: 'different-chat', workspaceId: 'all' } });
    mount(); await screen.findByRole('button', { name: /^Team work/ });
    const dialog = openAssignment();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('server did not confirm');
    expect(getChatStateSnapshot().conversations[0]!.workspaceId).toBeNull();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  test('ignores an old identity assignment response even if the new identity has the same chat id', async () => {
    let resolve!: (value: unknown) => void;
    mocks.api.patch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const mounted = mount(); await screen.findByRole('button', { name: /^Team work/ });
    const dialog = openAssignment();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save workspace' }));
    const signal = mocks.api.patch.mock.calls[0]![2].signal as AbortSignal;
    mocks.auth.userId = 'other-user'; mounted.rerender(mounted.view());
    act(() => setConversations([thread('notes', 'New identity notes', 'other')]));
    await act(async () => resolve({ data: { id: 'notes', workspaceId: 'all' } }));
    expect(signal.aborted).toBe(true);
    expect(getChatStateSnapshot().conversations[0]).toMatchObject({ title: 'New identity notes', workspaceId: null });
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mounted.props.onRetryHistory).not.toHaveBeenCalled();
  });

  test('uses durable active membership counts beyond locally loaded chats and surfaces list retry', async () => {
    mocks.api.get.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce({ data: { workspaces: [{ ...workspaces[0], threadCount: 12 }] } });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Workspaces could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Team work All clients · 12 threads/ })).toBeInTheDocument();
  });

  test('deletes workspace membership while retaining the chats and client', async () => {
    records[0]!.workspaceId = 'all'; reloadHistory();
    mount(); await screen.findByRole('button', { name: /^Team work All clients · 1 thread/ });
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace Team work' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete workspace Team work' })).toBeNull());
    expect(getChatStateSnapshot().conversations).toHaveLength(2);
    expect(getChatStateSnapshot().conversations.find((row) => row.id === 'notes')).toMatchObject({ clientId: 'sightline', workspaceId: null });
    expect(screen.getByRole('button', { name: /^Wyden notes/ })).toBeInTheDocument();
  });
});
