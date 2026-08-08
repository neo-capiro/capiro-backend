import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  newSession: vi.fn(),
  changeScope: vi.fn(),
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
    selectedClientValue: 'client-1',
    clients: [
      { id: 'client-1', name: 'C2 Strategies' },
      { id: 'client-2', name: 'Maven Advocacy Partners' },
    ],
    changeSessionClient: mocks.changeScope,
    metaError: null,
    handleNewSession: mocks.newSession,
    ...overrides,
  } as never;
}

describe('MeriWorkspaceWindow prototype parity', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.newSession.mockReset();
    mocks.changeScope.mockReset();
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
