import { act, fireEvent, render as renderRaw, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn() },
  auth: { orgId: 'org', userId: 'user' },
  impersonation: { actAsTenantSlug: null as string | null },
  toast: { success: vi.fn(), error: vi.fn() },
  me: { features: { meriJobs: false } as { meriJobs?: boolean } },
}));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => mocks.auth }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: mocks.me }) }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => mocks.impersonation }));
vi.mock('../components/feedback/toast.js', () => ({ useCapiroToast: () => mocks.toast }));
vi.mock('../../components/chat/managed-mcp-apps.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/chat/managed-mcp-apps.js')>()),
  useManagedMcpApps: () => ({ apps: [], busyAppId: null, error: null }),
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

function controller(delegateJob = vi.fn().mockResolvedValue(true)) {
  return {
    activeConversationId: 'thread-a',
    isStreaming: false,
    clients: [],
    selectedClientValue: null,
    stagedAttachments: [],
    scopePersistStatus: 'idle',
    sendMessage: vi.fn().mockResolvedValue(true),
    delegateJob,
  } as unknown as MeriChatController;
}

async function renderComposer(value: MeriChatController) {
  await act(async () => {
    renderRaw(
      <VNextMeriComposer controller={value} variant="pinned" hasThread onOpenIntegrations={vi.fn()} />,
    );
  });
}

const textarea = () => screen.getByRole('textbox', { name: 'Message Meri' });
const openAdd = () => fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));

describe('Delegate this', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.me.features = { meriJobs: false };
    mocks.api.get.mockResolvedValue({ data: {} });
    mocks.api.patch.mockResolvedValue({ data: {} });
  });

  test('is not offered unless the tenant has jobs', async () => {
    await renderComposer(controller());
    fireEvent.change(textarea(), { target: { value: 'Write an office brief' } });
    openAdd();
    expect(screen.queryByRole('menuitem', { name: /Delegate this/ })).toBeNull();
  });

  test('delegates the draft as a deliverable job instead of sending it', async () => {
    mocks.me.features = { meriJobs: true };
    const value = controller();
    await renderComposer(value);
    fireEvent.change(textarea(), { target: { value: 'Write an office brief on HR 1' } });
    openAdd();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delegate this/ }));
    });
    expect(value.delegateJob).toHaveBeenCalledWith('Write an office brief on HR 1');
    expect(value.sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect((textarea() as HTMLTextAreaElement).value).toBe(''));
  });

  test('restores the draft when the job is refused', async () => {
    mocks.me.features = { meriJobs: true };
    const value = controller(vi.fn().mockResolvedValue(false));
    await renderComposer(value);
    fireEvent.change(textarea(), { target: { value: 'Write an office brief' } });
    openAdd();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Delegate this/ }));
    });
    await waitFor(() =>
      expect((textarea() as HTMLTextAreaElement).value).toBe('Write an office brief'),
    );
  });
});
