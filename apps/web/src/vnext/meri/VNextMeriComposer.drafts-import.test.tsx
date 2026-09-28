import {
  act,
  fireEvent,
  render as renderRaw,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { StagedAttachment } from '../../components/chat/chat-attachments.js';

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
vi.mock('../../components/chat/managed-mcp-apps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/chat/managed-mcp-apps.js')>()),
  useManagedMcpApps: () => ({
    apps: [
      {
        id: 'hubspot',
        name: 'HubSpot',
        description: 'CRM',
        status: 'connected',
        connected: true,
        available: true,
        needsReauth: false,
        lastError: null,
      },
    ],
    busyAppId: null,
    error: null,
  }),
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
  fireEvent.click(screen.getByRole('menuitem', { name: /Import Saved Docs/ }));
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
  mocks.toast.success.mockClear();
});

describe('client-note filing preparation', () => {
  const clients = [
    { id: 'client-sightline', name: 'Sightline Intelligence' },
    { id: 'client-other', name: 'Other Client' },
  ];
  const withClients = (selectedClientValue: string | null = 'client-sightline', id = 'thread-a') =>
    ({
      ...controller(id),
      clients,
      selectedClientValue,
      persistedClientId: selectedClientValue,
      changeSessionClient: vi.fn().mockResolvedValue(undefined),
    }) as unknown as MeriChatController;
  const openNote = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /File a client note/ }));
    return screen.getByRole('dialog', { name: 'File a client note' });
  };

  test('requires actual notes and a target, then prepares an explicit request without claiming a save', async () => {
    const value = withClients();
    await render(composer(value));
    enter('Existing draft instructions');
    const dialog = openNote();
    expect(within(dialog).getByRole('combobox', { name: 'Client' })).toHaveValue(
      'client-sightline',
    );
    const prepare = within(dialog).getByRole('button', { name: 'Add to message' });
    expect(prepare).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), {
      target: { value: '   ' },
    });
    expect(prepare).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Policy lead will send the follow-up by September 14. BLUE-ORBIT-47' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title (optional)' }), {
      target: { value: 'Sen. Wyden engagement' },
    });
    fireEvent.click(prepare);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(value.changeSessionClient).toHaveBeenCalledWith('client-sightline');
    const message = (textarea() as HTMLTextAreaElement).value;
    expect(message).toContain('Existing draft instructions');
    expect(message).toContain('Save the following note under client "Sightline Intelligence".');
    expect(message).toContain('Sen. Wyden engagement');
    expect(message).toContain('BLUE-ORBIT-47');
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Note prepared for Sightline Intelligence. Send the message to request filing.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(value.sendMessage).toHaveBeenCalledWith(message));
  });

  test('portfolio scope requires choosing a client and cancel preserves the composer', async () => {
    await render(composer(withClients(null)));
    enter('Preserve this draft');
    const dialog = openNote();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Actual notes' },
    });
    const prepare = within(dialog).getByRole('button', { name: 'Add to message' });
    expect(prepare).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Client' }), {
      target: { value: 'client-other' },
    });
    expect(prepare).not.toBeDisabled();
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'Notes' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(textarea()).toHaveValue('Preserve this draft');
  });

  test('a picker change does not retarget an open note, while thread navigation closes it', async () => {
    const view = await render(composer(withClients()));
    openNote();
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Sightline note' },
    });
    const changedScope = withClients('client-other');
    const pending = deferred<void>();
    changedScope.changeSessionClient = vi.fn(() => pending.promise);
    await view.rerender(composer(changedScope));
    expect(screen.getByRole('combobox', { name: 'Client' })).toHaveValue('client-sightline');
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }));
    await waitFor(() =>
      expect(changedScope.changeSessionClient).toHaveBeenCalledWith('client-sightline'),
    );
    expect(textarea()).toHaveValue('');
    await view.rerender(composer(withClients('client-sightline')));
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect((textarea() as HTMLTextAreaElement).value).toContain('client "Sightline Intelligence"');
    expect((textarea() as HTMLTextAreaElement).value).not.toContain('Other Client');
    openNote();
    await view.rerender(composer(withClients('client-other', 'thread-b')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(textarea()).toHaveValue('');
  });

  test('a failed scope change preserves notes and cannot prepare or send under a different client', async () => {
    const initial = withClients(null);
    const pending = deferred<void>();
    initial.changeSessionClient = vi.fn(() => pending.promise);
    const view = await render(composer(initial));
    const dialog = openNote();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Client' }), {
      target: { value: 'client-sightline' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Keep these unsaved notes' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to message' }));
    await waitFor(() =>
      expect(initial.changeSessionClient).toHaveBeenCalledWith('client-sightline'),
    );
    await view.rerender(composer({ ...initial, scopePersistStatus: 'error' }));
    await act(async () => pending.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent('Your notes are still here');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('Keep these unsaved notes');
    expect(textarea()).toHaveValue('');
    expect(initial.sendMessage).not.toHaveBeenCalled();
  });

  test('a delayed client-scope response cannot fill a different thread', async () => {
    const initial = withClients();
    const pending = deferred<void>();
    initial.changeSessionClient = vi.fn(() => pending.promise);
    const view = await render(composer(initial));
    const dialog = openNote();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Notes' }), {
      target: { value: 'Original-thread notes' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to message' }));
    await waitFor(() => expect(initial.changeSessionClient).toHaveBeenCalled());
    await view.rerender(composer(withClients('client-other', 'thread-b')));
    await act(async () => pending.resolve());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(textarea()).toHaveValue('');
  });
});

describe('attachment readiness and coverage', () => {
  const file = (
    status: StagedAttachment['status'],
    overrides: Partial<StagedAttachment> = {},
  ): StagedAttachment => ({
    localId: 'file-a',
    id: 'attachment-a',
    filename: 'letter.docx',
    kind: 'docx',
    status,
    reason: null,
    pages: 2,
    chars: 240,
    ...overrides,
  });
  const withFiles = (files: StagedAttachment[], sendMessage = vi.fn().mockResolvedValue(true)) =>
    ({
      ...controller('thread-a', sendMessage),
      stagedAttachments: files,
      removeStagedAttachment: vi.fn(),
      handleAttachFiles: vi.fn(),
    }) as unknown as MeriChatController;

  test('shows actual parse counts and truncation details for every file', async () => {
    await render(
      composer(
        withFiles([
          file('parsed'),
          file('truncated', {
            localId: 'file-b',
            filename: 'appendix.pdf',
            kind: 'pdf',
            pages: 40,
            reason: '40 of 210 pages were read.',
          }),
        ]),
      ),
    );
    expect(screen.getByText('PARSED · 2 PAGES')).toBeInTheDocument();
    expect(screen.getByText('TRUNCATED · 40 PAGES')).toBeInTheDocument();
    expect(screen.getByText(/40 of 210 pages were read/)).toBeInTheDocument();
    expect(screen.getByText(/Attached for this chat/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  });

  test.each(['uploading', 'scanned', 'unsupported', 'error'] as const)(
    '%s files cannot be silently omitted by Send or Enter',
    async (status) => {
      const send = vi.fn().mockResolvedValue(true);
      const pendingFile = file(status, {
        id: null,
        reason: status === 'error' ? 'Encrypted PDF. Upload an unlocked copy.' : null,
      });
      const value = withFiles(
        [file('parsed'), { ...pendingFile, localId: 'file-b', filename: 'unreadable.pdf' }],
        send,
      );
      const view = await render(composer(value));
      enter('Extract the facts from every attachment.');
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
      fireEvent.keyDown(textarea(), { key: 'Enter' });
      expect(send).not.toHaveBeenCalled();
      if (status !== 'uploading')
        expect(screen.getByRole('alert')).toHaveTextContent('Remove unavailable files');
      if (status === 'error') expect(screen.getByText(/Encrypted PDF/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove unreadable.pdf' }));
      expect(value.removeStagedAttachment).toHaveBeenCalledWith('file-b');
      await view.rerender(composer(withFiles([file('parsed')], send)));
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(send).toHaveBeenCalledWith('Extract the facts from every attachment.'),
      );
    },
  );
});

describe('conversation composer drafts', () => {
  test.each(['Integrations / Back', 'Dock / reopen'])(
    'keeps unsent text after %s unmounts the composer',
    async () => {
      const integrations = vi.fn();
      const view = await render(composer(controller(), integrations));
      enter('  Draft briefing\nwith an early constraint  ');
      fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /^HubSpot/ }));
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
  test.each(['Escape', 'backdrop'])(
    'dismisses with %s, restores focus and preserves the draft',
    async (dismissal) => {
      await render(composer());
      enter('Unsent client briefing');
      await openImport();
      const dialog = screen.getByRole('dialog', { name: 'Import Saved Docs' });
      expect(dialog).toHaveFocus();
      expect(dialog).toHaveAccessibleDescription(/Select a document to add as editable text/);
      // Clicking content does not accidentally dismiss the dialog.
      fireEvent.mouseDown(screen.getByText('Import Saved Docs'));
      expect(dialog).toBeInTheDocument();
      if (dismissal === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      else fireEvent.mouseDown(dialog.parentElement!);
      expect(screen.queryByRole('dialog', { name: 'Import Saved Docs' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Add to conversation' })).toHaveFocus();
      expect(textarea()).toHaveValue('Unsent client briefing');
    },
  );

  test('keeps keyboard focus within the import dialog, including while loading', async () => {
    const pending = deferred<unknown>();
    mocks.get.mockImplementation((path: string) =>
      path === '/workspace-api/drafts?scope=all' ? pending.promise : importRoutes(path),
    );
    await render(composer());
    fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Import Saved Docs/ }));
    const dialog = screen.getByRole('dialog', { name: 'Import Saved Docs' });
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await act(async () =>
      pending.resolve({ data: [{ id: 'draft-a', docTitle: 'Briefing draft' }] }),
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Tab' });
    const first = screen.getByRole('button', { name: /Briefing draft/ });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

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

  test.each(['route', 'identity', 'cancel', 'Escape', 'backdrop', 'unmount'])(
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
      if (kind === 'Escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      if (kind === 'backdrop') fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
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
