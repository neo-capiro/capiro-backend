import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  newSession: vi.fn(),
  changeScope: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../lib/use-api.js', () => {
  const client = { get: mocks.get, patch: mocks.patch };
  return { useApi: () => client };
});

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({
    data: {
      user: {
        id: 'user-1',
        email: 'maya.reyes@example.com',
        firstName: 'Maya',
        lastName: 'Reyes',
        title: 'Analyst',
      },
      tenant: { id: 'tenant-1', slug: 'capiro-internal', name: 'Ardent Federal Strategies' },
      role: 'standard_user',
      features: { meriv3Chat: true },
    },
    isLoading: false,
  }),
}));

vi.mock('./managed-mcp-apps.js', () => ({
  ManagedMcpAppsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./MeriWorkspaceThreadRail.js', () => ({
  MeriWorkspaceThreadRail: () => <div data-testid="thread-rail">Threads</div>,
}));

vi.mock('./MeriWorkspaceConversation.js', () => ({
  MeriWorkspaceConversation: () => <div data-testid="workspace-chat">Conversation</div>,
}));

import { MeriWorkspaceWindow } from './MeriWorkspaceWindow.js';

function controller(overrides: Record<string, unknown> = {}) {
  return {
    activeConversationId: 'conv-1',
    sessionTitle: 'C2 weekly brief',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'What changed?',
        createdAt: new Date('2026-08-07T18:00:00-04:00'),
      },
    ],
    isStreaming: false,
    selectedClientValue: 'client-1',
    clients: [
      { id: 'client-1', name: 'C2 Strategies' },
      { id: 'client-2', name: 'Maven Advocacy Partners' },
    ],
    changeSessionClient: mocks.changeScope,
    sendMessage: mocks.sendMessage,
    metaError: null,
    handleNewSession: mocks.newSession,
    ...overrides,
  } as never;
}

describe('MeriWorkspaceWindow prototype parity', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.newSession.mockReset();
    mocks.changeScope.mockReset();
    mocks.sendMessage.mockReset();
    mocks.newSession.mockResolvedValue(undefined);
    mocks.changeScope.mockResolvedValue(undefined);
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'standard' } });
    mocks.patch.mockResolvedValue({ data: { reasoningMode: 'deep' } });
  });

  test('renders the prototype rail, thread header, user footer and conversation surface', async () => {
    render(<MeriWorkspaceWindow controller={controller()} />);

    expect(screen.getByRole('region', { name: 'Meri workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBeTruthy();
    expect(screen.getByText('Meri')).toBeTruthy();
    expect(screen.getByText('ARDENT FEDERAL STRATEGIES · CAPIRO-INTERNAL')).toBeTruthy();
    expect(screen.getByTestId('thread-rail')).toBeTruthy();
    expect(screen.getByTestId('workspace-chat')).toBeTruthy();
    expect(screen.getByText('C2 weekly brief')).toBeTruthy();
    expect(screen.getByText('SCOPED · C2 STRATEGIES')).toBeTruthy();
    expect(screen.getByText('Maya Reyes')).toBeTruthy();
    expect(screen.getByText('ANALYST')).toBeTruthy();

    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/clio/v3/conversations/conv-1/reasoning-mode'),
    );
  });

  test('runs a contextual Ask Meri prompt once in an already-clean thread when scope matches', async () => {
    window.history.replaceState(
      {},
      '',
      '/?meriWindow=1&meriPrompt=Analyze%20this%20award&meriClient=client-1',
    );

    render(
      <MeriWorkspaceWindow
        controller={controller({ messages: [], sessionTitle: 'Chat session' })}
      />,
    );

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith('Analyze this award'));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(mocks.changeScope).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('meriPrompt')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('meriClient')).toBeNull();
    expect(new URLSearchParams(window.location.search).get('meriWindow')).toBe('1');
  });

  test('starts a fresh thread instead of appending contextual analysis to an unrelated conversation', async () => {
    window.history.replaceState(
      {},
      '',
      '/?meriWindow=1&meriPrompt=Analyze%20this%20award&meriClient=client-1',
    );

    render(<MeriWorkspaceWindow controller={controller()} />);

    await waitFor(() => expect(mocks.newSession).toHaveBeenCalledTimes(1));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('meriPrompt')).toBe(
      'Analyze this award',
    );
  });

  test('does not send a client-scoped contextual prompt before the requested scope is established', async () => {
    window.history.replaceState(
      {},
      '',
      '/?meriWindow=1&meriPrompt=Analyze%20this%20award&meriClient=client-2',
    );

    render(
      <MeriWorkspaceWindow
        controller={controller({ messages: [], sessionTitle: 'Chat session' })}
      />,
    );

    await waitFor(() => expect(mocks.changeScope).toHaveBeenCalledWith('client-2'));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  test('renders an empty durable conversation as the prototype New thread state', () => {
    render(
      <MeriWorkspaceWindow
        controller={controller({ messages: [], sessionTitle: 'Chat session' })}
      />,
    );
    expect(screen.getByText('New thread')).toBeTruthy();
    expect(screen.queryByText('SCOPED · C2 STRATEGIES')).toBeNull();
    expect(screen.queryByRole('button', { name: /MODE · STANDARD/i })).toBeNull();
  });

  test('removes obsolete runtime and close controls and uses the prototype Pro Tip/minimize controls', () => {
    render(<MeriWorkspaceWindow controller={controller()} />);

    expect(screen.queryByText('MeriV3')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close Meri window' })).toBeNull();
    expect(screen.getByRole('button', { name: /PRO TIP/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeTruthy();
  });

  test('opens the prototype Pro Tip content', () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    fireEvent.click(screen.getByRole('button', { name: /PRO TIP/i }));
    expect(screen.getByRole('dialog', { name: 'Get more out of Meri' })).toBeTruthy();
    expect(screen.getByText('Tell Meri to remember things')).toBeTruthy();
    expect(screen.getByText('Turn a routine into a skill')).toBeTruthy();
  });

  test('keeps reasoning modes as a design-system header chip rather than the old button', async () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    const trigger = screen.getByRole('button', { name: /MODE · STANDARD/i });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const deepOption = screen.getByRole('menuitemradio', { name: /Deep/i });
    await act(async () => {
      fireEvent.click(deepOption);
    });

    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/api/clio/v3/conversations/conv-1/reasoning-mode', {
        reasoningMode: 'deep',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /MODE · DEEP/i })).toBeTruthy(),
    );
  });

  test('starts a new production conversation from the prototype rail', () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    fireEvent.click(screen.getByRole('button', { name: /\+?\s*New thread/i }));
    expect(mocks.newSession).toHaveBeenCalledTimes(1);
  });
});
