import { act, fireEvent, render as renderRaw, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

const mocks = vi.hoisted(() => {
  const get = vi.fn();
  const patch = vi.fn();
  return {
    get,
    patch,
    api: { get, patch },
    auth: { orgId: 'org', userId: 'user' },
    impersonation: { actAsTenantSlug: null as string | null },
    toast: { success: vi.fn(), error: vi.fn() },
  };
});
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks.auth }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => mocks.impersonation }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('../../components/chat/managed-mcp-apps.js', () => ({
  useManagedMcpApps: () => ({ apps: [] }),
}));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));
vi.mock('./meri-connector-logos.js', () => ({ ConnectorMark: () => null }));
vi.mock('./meri-start-work.js', () => ({
  meriStartWorkCards: () => ({ skills: [], prompts: [] }),
}));
vi.mock('./meri-vnext-api.js', () => ({
  listMeriSavedPrompts: vi.fn(),
  deleteMeriSavedPrompt: vi.fn(),
}));
vi.mock('../../components/chat/chat-attachments.js', () => ({
  truncateFilenameMiddle: (name: string) => name,
}));

import { VNextMeriComposer } from './VNextMeriComposer.js';
import { VNextMeriReasoningControl } from './VNextMeriReasoningControl.js';
import { moveMeriComposerDraft, restoreMeriComposerDraft } from './meri-composer-drafts.js';

async function render(ui: Parameters<typeof renderRaw>[0]) {
  let view!: ReturnType<typeof renderRaw>;
  await act(async () => {
    view = renderRaw(ui);
  });
  return {
    ...view,
    rerender: async (next: Parameters<typeof renderRaw>[0]) => {
      await act(async () => {
        view.rerender(next);
      });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const textarea = () => screen.getByRole('textbox', { name: 'Message Meri' });
function enter(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}
function controller(id: string | null = 'thread-a', sendMessage = vi.fn().mockResolvedValue(true)) {
  return {
    activeConversationId: id,
    isStreaming: false,
    clients: [],
    selectedClientValue: null,
    stagedAttachments: [],
    scopePersistStatus: 'idle',
    sendMessage,
  } as unknown as MeriChatController;
}
function composer(value = controller(), integrations = vi.fn()) {
  return (
    <VNextMeriComposer
      controller={value}
      variant="pinned"
      hasThread={Boolean(value.activeConversationId)}
      onOpenIntegrations={integrations}
    />
  );
}
async function openImport() {
  fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Import from workspace/ }));
  await screen.findByRole('button', { name: /Briefing draft/ });
}
function importRoutes(path: string) {
  if (path === '/workspace-api/drafts?scope=all')
    return Promise.resolve({ data: [{ id: 'draft-a', docTitle: 'Briefing draft' }] });
  if (path.endsWith('/documents/meri-import'))
    return Promise.resolve({ data: [{ id: 'doc-a', name: 'Client evidence' }] });
  if (path.includes('/documents/doc-a/'))
    return Promise.resolve({
      data: {
        id: 'doc-a',
        name: 'Client evidence',
        body: { blocks: [{ content: 'Approved meeting facts' }] },
      },
    });
  return Promise.resolve({ data: { reasoningMode: 'standard' } });
}

let testId = 0;
beforeEach(() => {
  mocks.get.mockReset().mockImplementation(importRoutes);
  mocks.patch.mockReset().mockResolvedValue({ data: { reasoningMode: 'standard' } });
  mocks.auth.orgId = `org-${++testId}`;
  mocks.auth.userId = 'user';
  mocks.impersonation.actAsTenantSlug = null;
  window.sessionStorage.clear();
});

describe('conversation composer drafts', () => {
  test.each(['Integrations / Back', 'Dock / reopen'])(
    'keeps unsent text after %s unmounts the composer',
    async () => {
      const integrations = vi.fn();
      const view = await render(composer(controller(), integrations));
      enter('  Draft briefing\nwith an early constraint  ');
      fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Connect HubSpot/ }));
      expect(integrations).toHaveBeenCalledOnce();
      view.unmount();
      await render(composer());
      expect(textarea()).toHaveValue('  Draft briefing\nwith an early constraint  ');
    },
  );

  test('keeps independent drafts for every thread and the record-free new thread', async () => {
    const view = await render(composer());
    enter('Thread A evidence');
    await view.rerender(composer(controller('thread-b')));
    expect(textarea()).toHaveValue('');
    enter('Thread B draft');
    await view.rerender(composer(controller(null)));
    expect(textarea()).toHaveValue('');
    enter('New thread draft');
    await view.rerender(composer());
    expect(textarea()).toHaveValue('Thread A evidence');
    await view.rerender(composer(controller('thread-b')));
    expect(textarea()).toHaveValue('Thread B draft');
    await view.rerender(composer(controller(null)));
    expect(textarea()).toHaveValue('New thread draft');
  });

  test.each(['user', 'organization', 'impersonation'])(
    'does not show a draft to a different %s',
    async (kind) => {
      const view = await render(composer());
      enter('Private client draft');
      if (kind === 'user') mocks.auth.userId = 'other-user';
      if (kind === 'organization') mocks.auth.orgId = 'other-org';
      if (kind === 'impersonation') mocks.impersonation.actAsTenantSlug = 'other-tenant';
      await view.rerender(composer());
      expect(textarea()).toHaveValue('');
    },
  );

  test('restores exact unsent text when Send reports that the server did not accept it', async () => {
    await render(composer(controller('thread-a', vi.fn().mockResolvedValue(false))));
    enter('  Keep formatting\nand constraints  ');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(textarea()).toHaveValue('  Keep formatting\nand constraints  '));
  });

  test('a late failure restores only its origin even after navigation and unmount', async () => {
    const pending = deferred<boolean>();
    const view = await render(
      composer(
        controller(
          'thread-a',
          vi.fn(() => pending.promise),
        ),
      ),
    );
    enter('Unaccepted A prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await view.rerender(composer(controller('thread-b')));
    enter('Independent B draft');
    await act(async () => pending.reject(new Error('offline')));
    expect(textarea()).toHaveValue('Independent B draft');
    view.unmount();
    await render(composer());
    expect(textarea()).toHaveValue('Unaccepted A prompt');
  });

  test('does not overwrite a newly edited draft when an earlier send fails', async () => {
    const pending = deferred<boolean>();
    await render(
      composer(
        controller(
          'thread-a',
          vi.fn(() => pending.promise),
        ),
      ),
    );
    enter('First prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    enter('Follow-up written while waiting');
    await act(async () => pending.resolve(false));
    expect(textarea()).toHaveValue('Follow-up written while waiting');
  });

  test('an accepted turn clears the submitted text durably across remount', async () => {
    const view = await render(composer());
    enter('Accepted prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    view.unmount();
    await render(composer());
    expect(textarea()).toHaveValue('');
  });

  test('only an explicit first-send handoff moves a new-thread follow-up and restores an unaccepted first prompt', async () => {
    const view = await render(composer(controller(null)));
    enter('Unsent follow-up typed during thread creation');
    const identity = `${mocks.auth.orgId}:user`;
    act(() => moveMeriComposerDraft(identity, null, 'created-thread'));
    await view.rerender(composer(controller('created-thread')));
    expect(textarea()).toHaveValue('Unsent follow-up typed during thread creation');
    act(() => restoreMeriComposerDraft(identity, 'created-thread', 'First prompt'));
    expect(textarea()).toHaveValue('Unsent follow-up typed during thread creation');
    enter('');
    act(() => restoreMeriComposerDraft(identity, 'created-thread', 'First prompt'));
    expect(textarea()).toHaveValue('First prompt');
    await view.rerender(composer(controller(null)));
    expect(textarea()).toHaveValue('');
  });
});

describe('workspace import disclosure', () => {
  test('expands, collapses and reopens cached documents repeatedly without another fetch', async () => {
    await render(composer());
    await openImport();
    const draft = screen.getByRole('button', { name: /Briefing draft/ });
    fireEvent.click(draft);
    await screen.findByRole('button', { name: /Client evidence/ });
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(draft);
      expect(draft).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: /Client evidence/ })).toBeNull();
      fireEvent.click(draft);
      expect(draft).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: /Client evidence/ })).toBeTruthy();
    }
    expect(
      mocks.get.mock.calls.filter(
        ([url]) => url === '/workspace-api/drafts/draft-a/documents/meri-import',
      ),
    ).toHaveLength(1);
  });

  test('an unsuccessful expansion can be retried directly', async () => {
    let attempts = 0;
    mocks.get.mockImplementation((path: string) =>
      path.endsWith('/documents/meri-import') && attempts++ === 0
        ? Promise.reject(new Error('offline'))
        : importRoutes(path),
    );
    await render(composer());
    await openImport();
    fireEvent.click(screen.getByRole('button', { name: /Briefing draft/ }));
    await screen.findByText('The workspace draft could not be loaded.');
    const draft = screen.getByRole('button', { name: /Briefing draft/ });
    expect(draft).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(draft);
    await screen.findByRole('button', { name: /Client evidence/ });
  });

  test('a collapsed pending expansion stays collapsed when the response arrives', async () => {
    const pending = deferred<{ data: Array<{ id: string; name: string }> }>();
    mocks.get.mockImplementation((path: string) =>
      path.endsWith('/documents/meri-import') ? pending.promise : importRoutes(path),
    );
    await render(composer());
    await openImport();
    const draft = screen.getByRole('button', { name: /Briefing draft/ });
    fireEvent.click(draft);
    fireEvent.click(draft);
    await act(async () => pending.resolve({ data: [{ id: 'doc-a', name: 'Client evidence' }] }));
    expect(draft).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Client evidence/ })).toBeNull();
    fireEvent.click(draft);
    expect(screen.getByRole('button', { name: /Client evidence/ })).toBeTruthy();
  });

  test.each(['route', 'identity', 'cancel', 'unmount'])(
    'rejects a delayed document body after %s changes',
    async (kind) => {
      const pending = deferred<unknown>();
      mocks.get.mockImplementation((path: string) =>
        path.includes('/documents/doc-a/') ? pending.promise : importRoutes(path),
      );
      const view = await render(composer());
      enter('Original draft');
      await openImport();
      fireEvent.click(screen.getByRole('button', { name: /Briefing draft/ }));
      fireEvent.click(await screen.findByRole('button', { name: /Client evidence/ }));
      if (kind === 'route') await view.rerender(composer(controller('thread-b')));
      if (kind === 'identity') {
        mocks.auth.userId = 'other-user';
        await view.rerender(composer());
      }
      if (kind === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      if (kind === 'unmount') {
        view.unmount();
        await render(composer());
      }
      await act(async () =>
        pending.resolve({
          data: {
            id: 'doc-a',
            name: 'Client evidence',
            body: { blocks: [{ content: 'Stale secret' }] },
          },
        }),
      );
      expect(textarea()).toHaveValue(
        kind === 'route' || kind === 'identity' ? '' : 'Original draft',
      );
    },
  );

  test('a valid import appends editable text and remains a draft after remount', async () => {
    const send = vi.fn();
    const view = await render(composer(controller('thread-a', send)));
    enter('My instructions');
    await openImport();
    fireEvent.click(screen.getByRole('button', { name: /Briefing draft/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Client evidence/ }));
    await waitFor(() =>
      expect((textarea() as HTMLTextAreaElement).value).toContain('Approved meeting facts'),
    );
    expect(send).not.toHaveBeenCalled();
    view.unmount();
    await render(composer());
    expect((textarea() as HTMLTextAreaElement).value).toContain('My instructions');
    expect((textarea() as HTMLTextAreaElement).value).toContain(
      'Review this material before relying on it.',
    );
  });
});

test('Add Reasoning Standard persists and immediately updates the thread-header control', async () => {
  mocks.get.mockImplementation((path: string) =>
    path.includes('/reasoning-mode')
      ? Promise.resolve({ data: { reasoningMode: 'max' } })
      : importRoutes(path),
  );
  await render(
    <>
      <VNextMeriReasoningControl conversationId="thread-a" />
      {composer()}
    </>,
  );
  await screen.findByRole('button', { name: 'Reasoning depth: Max' });
  fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Reasoning/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Standard/ }));
  await waitFor(() =>
    expect(mocks.patch).toHaveBeenCalledWith('/api/clio/v3/conversations/thread-a/reasoning-mode', {
      reasoningMode: 'standard',
    }),
  );
  await screen.findByRole('button', { name: 'Reasoning depth: Standard' });
});

test.each(['saved', 'rejected'])(
  'Send waits for a %s reasoning update from the thread header',
  async (outcome) => {
    const pending = deferred<unknown>();
    mocks.patch.mockImplementation(() => pending.promise);
    mocks.get.mockImplementation((path: string) =>
      path.includes('/reasoning-mode')
        ? Promise.resolve({ data: { reasoningMode: 'max' } })
        : importRoutes(path),
    );
    const send = vi.fn().mockResolvedValue(true);
    await render(
      <>
        <VNextMeriReasoningControl conversationId="thread-a" />
        {composer(controller('thread-a', send))}
      </>,
    );
    enter('Prompt must use the chosen depth');
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning depth: Max' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Standard/ }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue('Prompt must use the chosen depth');
    await act(async () =>
      outcome === 'saved'
        ? pending.resolve({ data: { reasoningMode: 'standard' } })
        : pending.reject(new Error('offline')),
    );
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
    await screen.findByRole('button', {
      name: `Reasoning depth: ${outcome === 'saved' ? 'Standard' : 'Max'}`,
    });
    if (outcome === 'rejected') expect(screen.getAllByRole('alert')).toHaveLength(2);
  },
);
