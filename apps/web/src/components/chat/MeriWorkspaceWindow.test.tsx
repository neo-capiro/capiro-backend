import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  newSession: vi.fn(),
  saveMeta: vi.fn(),
  changeScope: vi.fn(),
}));

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, patch: mocks.patch }),
}));
vi.mock('./ChatDrawer.js', () => ({
  MeriLegacyDrawer: () => <div data-testid="production-chat">Production chat</div>,
}));
vi.mock('./SessionRail.js', () => ({
  SessionRail: () => <div data-testid="thread-rail">Threads</div>,
}));
vi.mock('../../assets/chat/meri-bubble.png', () => ({ default: '/meri.png' }));

import { MeriWorkspaceWindow } from './MeriWorkspaceWindow.js';

function controller() {
  return {
    activeConversationId: 'conv-1',
    sessionTitle: 'C2 weekly brief',
    setSessionTitle: vi.fn(),
    saveConversationMeta: mocks.saveMeta,
    selectedClientValue: 'client-1',
    clients: [
      { id: 'client-1', name: 'C2 Strategies' },
      { id: 'client-2', name: 'Maven Advocacy Partners' },
    ],
    changeSessionClient: mocks.changeScope,
    isSavingMeta: false,
    metaError: null,
    handleNewSession: mocks.newSession,
  } as never;
}

describe('MeriWorkspaceWindow', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.patch.mockReset();
    mocks.newSession.mockReset();
    mocks.saveMeta.mockReset();
    mocks.changeScope.mockReset();
    mocks.get.mockResolvedValue({ data: { reasoningMode: 'standard' } });
    mocks.patch.mockResolvedValue({ data: { reasoningMode: 'deep' } });
    mocks.changeScope.mockResolvedValue(undefined);
  });

  test('renders the prototype shell around the production chat and thread rail', async () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    expect(screen.getByRole('region', { name: 'Meri workspace' })).toBeTruthy();
    expect(screen.getByText('AI Chief of Staff')).toBeTruthy();
    expect(screen.getByTestId('thread-rail')).toBeTruthy();
    expect(screen.getByTestId('production-chat')).toBeTruthy();
    expect(screen.getByDisplayValue('C2 weekly brief')).toBeTruthy();
    expect(screen.getByLabelText('Conversation client scope')).toHaveValue('client-1');
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('/api/clio/v3/conversations/conv-1/reasoning-mode'),
    );
  });

  test('persists a reasoning-mode change on the conversation', async () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    const trigger = await screen.findByRole('button', { name: 'Reasoning mode: Standard' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Deep/ }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/clio/v3/conversations/conv-1/reasoning-mode',
        { reasoningMode: 'deep' },
      ),
    );
    expect(screen.getByRole('button', { name: 'Reasoning mode: Deep' })).toBeTruthy();
  });

  test('persists the displayed client scope immediately', () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    fireEvent.change(screen.getByLabelText('Conversation client scope'), {
      target: { value: 'client-2' },
    });
    expect(mocks.changeScope).toHaveBeenCalledWith('client-2');
  });

  test('starts a new production conversation from the sidebar', () => {
    render(<MeriWorkspaceWindow controller={controller()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(mocks.newSession).toHaveBeenCalledTimes(1);
  });
});
