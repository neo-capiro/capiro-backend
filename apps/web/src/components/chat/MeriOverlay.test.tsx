import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { setAlerts, setChatOpen, resetChatStoreForTests } from './chat-store.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  newSession: vi.fn(),
}));

vi.mock('./useMeriChatController.js', async () => {
  const store = await import('./chat-store.js');
  return {
    useMeriChatController: () => ({
      alertsBadge: 3,
      hideMeriFab: false,
      handleClose: () => {
        mocks.close();
        store.setChatOpen(false);
      },
      handleNewSession: mocks.newSession,
      sessionTitle: 'C2 — weekly brief',
      researchMode: false,
      writeMode: false,
      setResearchMode: vi.fn(),
      setWriteMode: vi.fn(),
      researchSessionRef: { current: null },
      setResearchAwaitingAnswers: vi.fn(),
      setResearchQuestions: vi.fn(),
    }),
  };
});

vi.mock('./ChatDrawer.js', () => ({
  MeriLegacyDrawer: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="shared-conversation" data-embedded={String(Boolean(embedded))}>
      Shared production conversation
    </div>
  ),
}));

vi.mock('./SessionRail.js', () => ({
  SessionRail: () => <div data-testid="history-sidebar">History</div>,
}));

import { MeriOverlay } from './MeriOverlay.js';

describe('MeriOverlay window state integration', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setAlerts(
      ['a1', 'a2', 'a3'].map((id) => ({
        id,
        alertType: 'scheduled_task',
        title: 'Briefing',
        body: 'Ready',
        priority: 'info',
        status: 'pending',
        clientId: null,
        createdAt: '2026-07-11T12:00:00.000Z',
      })),
    );
    window.localStorage.clear();
    mocks.close.mockClear();
    mocks.newSession.mockClear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  });

  test('opens docked, undocks without replacing conversation state, redocks, and closes', () => {
    render(<MeriOverlay selectedClientName="C2 Strategies" />);
    const launcher = screen.getByRole('button', { name: 'Open Meri' });
    expect(screen.getByText('3')).toBeTruthy();
    fireEvent.click(launcher);

    expect(screen.getByLabelText('Meri assistant').className).toContain('meri-overlay--docked');
    expect(screen.getByTestId('shared-conversation')).toHaveTextContent(
      'Shared production conversation',
    );

    fireEvent.click(screen.getByRole('button', { name: /undock/i }));
    expect(screen.getByLabelText('Meri assistant').className).toContain('meri-overlay--undocked');
    expect(screen.getByTestId('shared-conversation')).toHaveTextContent(
      'Shared production conversation',
    );
    expect(screen.getByTestId('history-sidebar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conversation settings' }));
    expect(screen.getAllByLabelText('Meri assistant')[0]!.className).toContain(
      'meri-overlay--details-open',
    );

    fireEvent.click(screen.getByRole('button', { name: /re-dock/i }));
    expect(screen.getByLabelText('Meri assistant').className).toContain('meri-overlay--docked');

    fireEvent.click(screen.getByRole('button', { name: 'Close Meri' }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Open Meri' })).toBeTruthy();
  });

  test('renders an already-open legacy caller as the docked surface', () => {
    setChatOpen(true);
    render(<MeriOverlay />);
    expect(screen.getByLabelText('Meri assistant').className).toContain('meri-overlay--docked');
  });
});
