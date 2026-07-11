import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MeriInboxBanner } from './MeriInboxBanner.js';
import type { MeriAlert } from './chat-store.js';

const alerts: MeriAlert[] = [
  {
    id: 'critical-1',
    alertType: 'scheduled_task',
    title: 'Appropriations briefing',
    body: 'The scheduled briefing is ready.',
    priority: 'critical',
    status: 'pending',
    clientId: null,
    createdAt: '2026-07-11T12:00:00.000Z',
  },
  {
    id: 'info-1',
    alertType: 'meeting_briefing',
    title: 'Meeting briefing',
    body: 'Your meeting briefing is ready.',
    priority: 'info',
    status: 'pending',
    clientId: null,
    createdAt: '2026-07-11T13:00:00.000Z',
  },
];

describe('MeriInboxBanner', () => {
  test('is absent when no pending alerts exist', () => {
    const { container } = render(
      <MeriInboxBanner
        alerts={[]}
        count={0}
        expanded={false}
        onExpandedChange={vi.fn()}
        onDismiss={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('renders schedule alerts with priority styling and dismissal controls', () => {
    const onDismiss = vi.fn();
    const onClearAll = vi.fn();
    render(
      <MeriInboxBanner
        alerts={alerts}
        count={2}
        expanded
        onExpandedChange={vi.fn()}
        onDismiss={onDismiss}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Appropriations briefing').closest('article')?.className).toContain(
      'chat-alert-item--critical',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Appropriations briefing' }));
    expect(onDismiss).toHaveBeenCalledWith('critical-1');
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });
});
