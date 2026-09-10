import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriSavedPrompt } from './meri-vnext-api.js';
import { buildApiClient } from '../../lib/api-client.js';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  auth: { orgId: 'org', userId: 'user' },
  impersonation: { actAsTenantSlug: null as string | null },
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks.auth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => mocks.impersonation }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));
vi.mock('./meri-connector-logos.js', () => ({ ConnectorMark: () => null }));
vi.mock('../../components/chat/managed-mcp-apps.js', () => ({
  useManagedMcpApps: () => ({ apps: [] }),
}));
vi.mock('./MeriAnalysisChartCard.js', () => ({ MeriAnalysisChartCard: () => null }));
vi.mock('./MeriMessageFeedback.js', () => ({ MeriMessageFeedback: () => null }));
vi.mock('./MeriMemoryCallout.js', () => ({ MeriMemoryCallout: () => null }));
vi.mock('./meri-start-work.js', () => ({
  meriStartWorkCards: ({ prompts = [] }: { prompts?: MeriSavedPrompt[] }) => ({
    skills: [],
    prompts: prompts.map((p) => ({
      id: p.id,
      title: p.title,
      fill: p.body,
      desc: p.body,
      needsClient: false,
      kind: 'prompt',
      icon: 'Bookmark',
      tag: 'YOUR PROMPT',
    })),
  }),
}));
import { MeriSavePromptButton, MeriSavedPromptManager } from './MeriSavedPromptWorkflow.js';
import { MeriStartWork } from './MeriStartWork.js';
import { VNextMeriComposer } from './VNextMeriComposer.js';
import { VNextMeriMessage } from './VNextMeriMessage.js';

let records: MeriSavedPrompt[];
let index = 0;
const saved = (
  title = 'Client briefing',
  body = 'Draft from current client evidence.',
): MeriSavedPrompt => ({
  id: 'prompt/a',
  title,
  body,
  createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z',
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
function mount(children: React.ReactNode, queryClient = client()) {
  return {
    ...render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>),
    queryClient,
  };
}
function controller(): MeriChatController {
  return {
    activeConversationId: 'thread',
    isStreaming: false,
    selectedClientValue: 'sightline',
    persistedClientId: 'sightline',
    clients: [{ id: 'sightline', name: 'Sightline' }],
    stagedAttachments: [
      {
        localId: 'a',
        id: 'attachment-a',
        filename: 'evidence.txt',
        kind: 'text',
        status: 'parsed',
        reason: null,
      },
    ],
    scopePersistStatus: 'idle',
    sendMessage: vi.fn().mockResolvedValue(true),
    handleStop: vi.fn(),
    changeSessionClient: vi.fn(),
    removeStagedAttachment: vi.fn(),
    lastUserMessageId: 'message',
  } as unknown as MeriChatController;
}
const composer = (value: MeriChatController) => (
  <VNextMeriComposer controller={value} variant="landing" hasThread onOpenIntegrations={vi.fn()} />
);
const textarea = () => screen.getByRole('textbox', { name: 'Message Meri' });
const change = (field: HTMLElement, value: string) =>
  fireEvent.change(field, { target: { value } });
function openSave() {
  fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));
  return screen.getByRole('dialog', { name: 'Save prompt' });
}
beforeEach(() => {
  records = [];
  mocks.auth.orgId = `org-${++index}`;
  mocks.auth.userId = 'user';
  mocks.impersonation.actAsTenantSlug = null;
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mocks.api.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/saved-prompts'))
      return { data: { prompts: records.map((row) => ({ ...row })) } };
    if (path.endsWith('/skills')) return { data: { skills: [] } };
    return { data: { reasoningMode: 'standard' } };
  });
  mocks.api.post.mockImplementation(
    async (_path: string, input: Pick<MeriSavedPrompt, 'title' | 'body'>) => {
      const row = { ...saved(), ...input };
      records.push(row);
      return { data: row };
    },
  );
  mocks.api.patch.mockImplementation(
    async (_path: string, input: Pick<MeriSavedPrompt, 'title' | 'body'>) => {
      records = records.map((row) => ({ ...row, ...input }));
      return { data: records[0] };
    },
  );
  mocks.api.delete.mockImplementation(async () => {
    records = [];
    return { data: { ok: true } };
  });
});

describe('Phase 4 saved prompts', () => {
  test('saves from a user message and reuses from both entry points after remount without auto-send or changing client/files', async () => {
    const value = controller();
    const message = {
      id: 'message',
      role: 'user',
      content: 'Draft from approved evidence.',
      createdAt: new Date(),
    } as ChatMessage;
    const original = mount(
      <VNextMeriMessage
        message={message}
        controller={value}
        isLastAssistant={false}
        isStreaming={false}
        onOpenMemory={vi.fn()}
        onOpenSourceDetail={vi.fn()}
        onOpenTurnInspector={vi.fn()}
      />,
    );
    const dialog = openSave();
    expect(within(dialog).getByRole('textbox', { name: 'Prompt text' })).toHaveValue(
      message.content,
    );
    expect(within(dialog).getByRole('button', { name: 'Save prompt' })).toBeDisabled();
    change(within(dialog).getByRole('textbox', { name: 'Prompt name' }), 'Evidence briefing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.api.post).toHaveBeenCalledWith(
      '/api/clio/vnext/saved-prompts',
      {
        title: 'Evidence briefing',
        body: message.content,
      },
      { signal: expect.any(AbortSignal) },
    );
    original.unmount();
    mount(
      <>
        <MeriStartWork controller={value} />
        {composer(value)}
      </>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'PROMPTS' }));
    fireEvent.click(await screen.findByRole('button', { name: /Evidence briefing.*YOUR PROMPT/ }));
    expect(textarea()).toHaveValue(message.content);
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(value.changeSessionClient).not.toHaveBeenCalled();
    expect(value.removeStagedAttachment).not.toHaveBeenCalled();
    expect(screen.getByText('evidence.txt')).toBeInTheDocument();
    change(textarea(), 'A different draft');
    fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Saved prompts/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Evidence briefing/ }));
    expect(textarea()).toHaveValue(message.content);
    expect(value.sendMessage).not.toHaveBeenCalled();
    change(textarea(), `${message.content} Focus on next week.`);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(value.sendMessage).toHaveBeenCalledWith(`${message.content} Focus on next week.`),
    );
  });
  test('save failure preserves edits for retry and rejects blank or oversized text', async () => {
    mocks.api.post.mockRejectedValueOnce(new Error('temporary failure'));
    mount(<MeriSavePromptButton body="Original text" />);
    const dialog = openSave();
    const name = within(dialog).getByRole('textbox', { name: 'Prompt name' });
    const body = within(dialog).getByRole('textbox', { name: 'Prompt text' });
    const save = within(dialog).getByRole('button', { name: 'Save prompt' });
    change(name, 'Review notes');
    change(body, 'x'.repeat(24_001));
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('24,000');
    change(body, '  ');
    expect(save).toBeDisabled();
    change(body, 'Edited notes');
    fireEvent.click(save);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your changes are still here',
    );
    expect(name).toHaveValue('Review notes');
    expect(body).toHaveValue('Edited notes');
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(records[0]).toMatchObject({ title: 'Review notes', body: 'Edited notes' });
  });
  test('renames/edits via Start work, preserves a failed edit, and deletes durably through composer management with retry', async () => {
    records = [saved()];
    const value = controller();
    const original = mount(<MeriStartWork controller={value} />);
    fireEvent.click(screen.getByRole('tab', { name: 'PROMPTS' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage prompts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Client briefing' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit saved prompt' });
    change(within(dialog).getByRole('textbox', { name: 'Prompt name' }), 'Weekly briefing');
    change(within(dialog).getByRole('textbox', { name: 'Prompt text' }), 'Prepare weekly actions.');
    mocks.api.patch.mockRejectedValueOnce(new Error('temporary failure'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be saved');
    expect(within(dialog).getByRole('textbox', { name: 'Prompt name' })).toHaveValue(
      'Weekly briefing',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Edit Weekly briefing' });
    expect(mocks.api.patch).toHaveBeenLastCalledWith(
      '/api/clio/vnext/saved-prompts/prompt%2Fa',
      {
        title: 'Weekly briefing',
        body: 'Prepare weekly actions.',
      },
      { signal: expect.any(AbortSignal) },
    );
    original.unmount();
    const reloaded = mount(composer(value));
    fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Saved prompts/ }));
    await screen.findByRole('menuitem', { name: /Weekly briefing/ });
    fireEvent.click(screen.getByRole('button', { name: 'Manage prompts' }));
    mocks.api.delete.mockRejectedValueOnce(new Error('temporary failure'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Weekly briefing' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be deleted');
    expect(screen.getByRole('button', { name: 'Use Weekly briefing' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Weekly briefing' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use Weekly briefing' })).not.toBeInTheDocument(),
    );
    reloaded.unmount();
    mount(<MeriSavedPromptManager onClose={vi.fn()} onReuse={vi.fn()} />);
    expect(await screen.findByText(/No saved prompts yet/)).toBeInTheDocument();
  });
  test('reports failed loading and supports retry instead of presenting a false empty state', async () => {
    mocks.api.get.mockRejectedValueOnce(new Error('temporary failure'));
    records = [saved()];
    mount(<MeriSavedPromptManager onClose={vi.fn()} onReuse={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText(/No saved prompts yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Use Client briefing' });
  });
  test('pending save prevents duplicate clicks and cannot report success into a different account', async () => {
    let resolve!: (result: { data: MeriSavedPrompt }) => void;
    mocks.api.post.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const queryClient = client();
    const view = mount(<MeriSavePromptButton body="Account A text" />, queryClient);
    const dialog = openSave();
    change(within(dialog).getByRole('textbox', { name: 'Prompt name' }), 'Private A prompt');
    const save = within(dialog).getByRole('button', { name: 'Save prompt' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(mocks.api.post).toHaveBeenCalledTimes(1);
    const signal = mocks.api.post.mock.calls[0]![2].signal as AbortSignal;
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled();
    mocks.auth.userId = 'different-user';
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MeriSavePromptButton body="Account B text" />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve({ data: saved('Private A prompt') });
    });
    expect(mocks.toast.success).not.toHaveBeenCalled();
    const next = openSave();
    expect(within(next).getByRole('textbox', { name: 'Prompt name' })).toHaveValue('');
    expect(within(next).getByRole('textbox', { name: 'Prompt text' })).toHaveValue(
      'Account B text',
    );
  });
  test.each(['create', 'edit', 'delete'] as const)(
    '%s cannot dispatch an old account write when token acquisition finishes after identity change',
    async (operation) => {
      records = [saved('Private A prompt')];
      let finishToken!: (token: string) => void;
      const getToken = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishToken = resolve;
          }),
      );
      const authenticatedApi = buildApiClient(getToken);
      const dispatch = vi.fn();
      authenticatedApi.defaults.adapter = dispatch;
      // Only the mutation goes through the real delayed-auth client. List fixtures
      // still use the backend fixture above so the requested item can be selected.
      const method = operation === 'create' ? 'post' : operation === 'edit' ? 'patch' : 'delete';
      mocks.api[method].mockImplementation(authenticatedApi[method].bind(authenticatedApi));
      const queryClient = client();
      const contents = () =>
        operation === 'create' ? (
          <MeriSavePromptButton body="Private account A instructions" />
        ) : (
          <MeriSavedPromptManager onClose={vi.fn()} onReuse={vi.fn()} />
        );
      const view = mount(contents(), queryClient);
      if (operation === 'create') {
        const dialog = openSave();
        change(within(dialog).getByRole('textbox', { name: 'Prompt name' }), 'Private A prompt');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save prompt' }));
      } else if (operation === 'edit') {
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Private A prompt' }));
        change(
          screen.getByRole('textbox', { name: 'Prompt text' }),
          'Private account A instructions',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      } else {
        fireEvent.click(await screen.findByRole('button', { name: 'Delete Private A prompt' }));
      }
      await waitFor(() => expect(getToken).toHaveBeenCalledOnce());
      if (operation === 'delete') {
        const dialog = screen.getByRole('dialog', { name: 'Manage saved prompts' });
        expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(dialog).toBeInTheDocument();
      }
      const call = mocks.api[method].mock.calls[0]!;
      const signal = (operation === 'delete' ? call[1] : call[2]).signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      mocks.auth.orgId = 'new-organization';
      records = [];
      view.rerender(<QueryClientProvider client={queryClient}>{contents()}</QueryClientProvider>);
      expect(signal.aborted).toBe(true);
      await act(async () => {
        finishToken('new-organization-token');
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.toast.success).not.toHaveBeenCalled();
      expect(screen.queryByText('Private A prompt')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );
  test('account changes clear the previous prompt editor and content', async () => {
    records = [saved('Private A prompt')];
    const queryClient = client();
    const view = mount(<MeriSavedPromptManager onClose={vi.fn()} onReuse={vi.fn()} />, queryClient);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Private A prompt' }));
    records = [saved('Private B prompt')];
    mocks.auth.userId = 'different-user';
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <MeriSavedPromptManager onClose={vi.fn()} onReuse={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('dialog', { name: 'Edit saved prompt' })).not.toBeInTheDocument();
    expect(screen.queryByText('Private A prompt')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Use Private B prompt' });
  });
  test('dialog traps keyboard focus and Escape cancels without saving', () => {
    mount(<MeriSavePromptButton body="Review the evidence." />);
    const trigger = screen.getByRole('button', { name: 'Save prompt' });
    trigger.focus();
    const dialog = openSave();
    const name = within(dialog).getByRole('textbox', { name: 'Prompt name' });
    expect(name).toHaveFocus();
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(mocks.api.post).not.toHaveBeenCalled();
  });
  test('active composer offers the functioning Stop control and accepts the next submission when idle', async () => {
    const value = controller();
    value.isStreaming = true;
    const view = mount(composer(value));
    expect(textarea()).toBeDisabled();
    expect(textarea().getAttribute('placeholder')).toMatch(/Stop/);
    expect(textarea().getAttribute('placeholder')).not.toMatch(/guidance/i);
    const stop = screen.getByRole('button', { name: /Stop/ });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(value.handleStop).toHaveBeenCalledOnce();
    value.isStreaming = false;
    view.rerender(
      <QueryClientProvider client={view.queryClient}>{composer(value)}</QueryClientProvider>,
    );
    await waitFor(() => expect(textarea()).toBeEnabled());
    change(textarea(), 'Next inquiry');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(value.sendMessage).toHaveBeenCalledWith('Next inquiry'));
  });
});
