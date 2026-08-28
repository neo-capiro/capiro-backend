import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRovingFocus } from './use-roving-focus.js';

/**
 * The campaign step rail and the Engagement destination tabs were mouse-only:
 * seven separate Tab stops and no arrow-key movement at all. These tests pin
 * the three properties that matter, including the one that is easy to get
 * wrong: arrows move focus WITHOUT activating, because on the step rail
 * activation jumps the builder to another step.
 */

function Strip({ onActivate }: { onActivate?: (label: string) => void }) {
  const onKeyDown = useRovingFocus();
  return (
    <nav aria-label="Campaign steps" onKeyDown={onKeyDown}>
      {['Goal', 'Targets', 'Delivery', 'Context', 'Examples', 'Drafts', 'Send'].map(
        (label, index) => (
          <button
            key={label}
            type="button"
            // Drafts + Send unreached, exactly as the rail renders them before
            // the campaign is ready.
            disabled={index >= 5}
            onClick={() => onActivate?.(label)}
          >
            {label}
          </button>
        ),
      )}
    </nav>
  );
}

describe('useRovingFocus', () => {
  it('moves focus with ArrowRight/ArrowLeft and skips disabled buttons', () => {
    render(<Strip />);
    const nav = screen.getByRole('navigation', { name: 'Campaign steps' });
    const goal = screen.getByRole('button', { name: 'Goal' });

    goal.focus();
    expect(goal).toHaveFocus();

    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: 'Targets' })).toHaveFocus();

    fireEvent.keyDown(nav, { key: 'ArrowLeft' });
    expect(goal).toHaveFocus();

    // ArrowLeft from the first enabled button wraps to the LAST ENABLED one —
    // Examples, not Drafts or Send, which are disabled.
    fireEvent.keyDown(nav, { key: 'ArrowLeft' });
    expect(screen.getByRole('button', { name: 'Examples' })).toHaveFocus();

    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(goal).toHaveFocus();
  });

  it('jumps to the first and last enabled button with Home and End', () => {
    render(<Strip />);
    const nav = screen.getByRole('navigation', { name: 'Campaign steps' });
    screen.getByRole('button', { name: 'Context' }).focus();

    fireEvent.keyDown(nav, { key: 'End' });
    expect(screen.getByRole('button', { name: 'Examples' })).toHaveFocus();

    fireEvent.keyDown(nav, { key: 'Home' });
    expect(screen.getByRole('button', { name: 'Goal' })).toHaveFocus();
  });

  it('moves focus without activating, so scanning the rail fires no step changes', () => {
    const onActivate = vi.fn();
    render(<Strip onActivate={onActivate} />);
    const nav = screen.getByRole('navigation', { name: 'Campaign steps' });
    screen.getByRole('button', { name: 'Goal' }).focus();

    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    fireEvent.keyDown(nav, { key: 'End' });

    expect(onActivate).not.toHaveBeenCalled();
    // Enter/Space is the commit, handled natively by <button>.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('ignores keys it does not own, so typing and vertical scroll are untouched', () => {
    render(<Strip />);
    const nav = screen.getByRole('navigation', { name: 'Campaign steps' });
    const goal = screen.getByRole('button', { name: 'Goal' });
    goal.focus();

    for (const key of ['ArrowUp', 'ArrowDown', 'a', 'Tab', 'PageDown']) {
      fireEvent.keyDown(nav, { key });
      expect(goal).toHaveFocus();
    }
  });
});
