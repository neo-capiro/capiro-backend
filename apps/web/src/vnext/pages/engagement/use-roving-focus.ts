import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Arrow-key movement for a horizontal strip of buttons (the campaign step rail,
 * the Engagement destination tabs).
 *
 * The strips were mouse-only: every button was individually tabbable and no
 * arrow key did anything, so reaching the seventh step meant seven Tab presses
 * and there was no way to move along the rail with the keyboard at all.
 *
 * Implements the standard pattern:
 *   - ArrowLeft / ArrowRight move by one, skipping disabled buttons
 *   - Home / End jump to the first / last enabled button
 *   - movement wraps, so End is reachable from the start
 *
 * Focus moves without activating. On this rail activation is a real state
 * change (it jumps the builder to another step and re-renders the section
 * below), so auto-activating on arrow would fire six step changes while the
 * user was simply looking for the seventh. The user presses Enter or Space —
 * which native buttons already handle — to commit.
 *
 * Reads the DOM rather than taking an index: the caller's `items` array and the
 * rendered buttons can disagree (a disabled step is rendered but not
 * focusable), and the DOM is the thing the user is actually moving through.
 */
export function useRovingFocus() {
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const { key } = event;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') {
      return;
    }
    // `currentTarget` is the container the handler is bound to, so this works
    // whether the event started on a button or on a span inside one.
    const container = event.currentTarget;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    );
    if (buttons.length === 0) return;

    const active = document.activeElement;
    const currentIndex = buttons.findIndex((button) => button === active || button.contains(active));

    let nextIndex: number;
    if (key === 'Home') {
      nextIndex = 0;
    } else if (key === 'End') {
      nextIndex = buttons.length - 1;
    } else {
      const delta = key === 'ArrowRight' ? 1 : -1;
      // From nothing focused, ArrowRight starts at the first button and
      // ArrowLeft at the last, rather than doing nothing.
      if (currentIndex < 0) {
        nextIndex = delta > 0 ? 0 : buttons.length - 1;
      } else {
        nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
      }
    }

    const next = buttons[nextIndex];
    if (!next) return;
    // Only now, once a move is certain — so an ArrowLeft at the very start of
    // an empty strip still scrolls the page as the user expects.
    event.preventDefault();
    next.focus();
  }, []);
}
