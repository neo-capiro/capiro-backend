import { fireEvent, render, screen } from '@testing-library/react';
import { listMeriQuickActions } from '@capiro/shared/meri-skills';
import { describe, expect, test, vi } from 'vitest';
import { MeriQuickActionsPanelView } from './MeriQuickActionsPanel.js';

describe('MeriQuickActionsPanelView', () => {
  test('renders the five canonical Quick Actions in a fresh chat', () => {
    render(
      <MeriQuickActionsPanelView
        skills={listMeriQuickActions()}
        hasThread={false}
        open
        onOpenChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Research a Company')).toBeTruthy();
    expect(screen.getByText('Relationship Brief')).toBeTruthy();
    expect(screen.getByText('Client Changes')).toBeTruthy();
    expect(screen.getByText('Portfolio Changes')).toBeTruthy();
    expect(screen.getByText('Portfolio Overlap')).toBeTruthy();
    expect(screen.getByText(/nothing runs until you review/i)).toBeTruthy();
  });

  test('clicking inserts a workspace-scoped client prompt but never sends it', () => {
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MeriQuickActionsPanelView
        skills={listMeriQuickActions()}
        clientName="TitanForge"
        hasThread
        open
        onOpenChange={onOpenChange}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /client changes/i }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      skillId: 'client_changes',
      prompt: expect.stringContaining('for this client'),
      requiresClient: true,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('non-client skills do not request a client selection', () => {
    const onSelect = vi.fn();
    render(
      <MeriQuickActionsPanelView
        skills={listMeriQuickActions()}
        hasThread={false}
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /portfolio changes/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'portfolio_changes',
        requiresClient: false,
      }),
    );
  });

  test('remains available in an existing conversation as a compact trigger', () => {
    const onOpenChange = vi.fn();
    render(
      <MeriQuickActionsPanelView
        skills={listMeriQuickActions()}
        hasThread
        open={false}
        onOpenChange={onOpenChange}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Quick Actions' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
