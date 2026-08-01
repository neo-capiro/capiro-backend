import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'http://api.test' } }));
// The work log resolves its context packet through the real axios client, which
// needs a ClerkProvider this surface-only fixture deliberately does not mount.
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn().mockRejectedValue(new Error('unavailable in fixture')) }),
}));
vi.mock('./SessionRail.js', () => ({
  SessionRail: () => (
    <div className="meri-session-rail" data-testid="visual-history">
      <strong>Today</strong>
      <span>C2 — weekly brief</span>
    </div>
  ),
}));

import { MeriOverlaySurface } from './MeriOverlay.js';
import { createMeriVisualController } from './MeriOverlay.visual-fixture.js';
import { resetChatStoreForTests, setMeriSurfaceMode } from './chat-store.js';

describe('MeriOverlay production visual fixture', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  });

  test('renders the real docked production conversation surface', () => {
    setMeriSurfaceMode('docked');
    const { container } = render(<MeriOverlaySurface controller={createMeriVisualController()} />);
    expect(container.querySelector('section.meri-overlay')?.className).toContain(
      'meri-overlay--docked',
    );
    expect(screen.getByText('What changed for C2 Strategies today?')).toBeTruthy();
    expect(screen.getByText(/Three developments need attention today/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
  });

  test('renders the real undocked empty home and history shell', () => {
    setMeriSurfaceMode('undocked');
    const { container } = render(
      <MeriOverlaySurface controller={createMeriVisualController({ empty: true })} />,
    );
    expect(container.querySelector('section.meri-overlay')?.className).toContain(
      'meri-overlay--undocked',
    );
    expect(screen.getAllByTestId('visual-history')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Good afternoon.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /brief me on today/i })).toBeTruthy();
  });
});
