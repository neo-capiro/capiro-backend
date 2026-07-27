import { useEffect, type RefObject } from 'react';

/**
 * P1-12 / P2-12 (Gate D h-2): focus trapping for the tracker's TWO CUSTOM
 * modals — `AddBillModal` and `VerifyOtpModal`, which are hand-rolled overlays
 * rather than antd `Modal`s.
 *
 * Without this a keyboard user Tabs straight out of an open modal and into the
 * page behind it, which is still there and still focusable, with no way back
 * and no way to close.
 *
 * Deliberately NOT used inside an antd `Modal` (MemoComposerDrawer,
 * DistrictBriefComposerDrawer): antd already traps focus, and a second trap
 * fights the first (edge case 14).
 *
 * Does three things, all of which a dialog owes a keyboard user:
 *   1. moves focus to the first control on open;
 *   2. wraps Tab / Shift+Tab at the boundaries;
 *   3. closes on Escape and RESTORES focus to whatever opened it.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // offsetParent is null for display:none; a visible element in jsdom has
    // none either, so also accept anything with layout or an explicit size.
    (el) => !el.hasAttribute('aria-hidden') && el.getAttribute('tabindex') !== '-1',
  );
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose?: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;

    // Remember the opener so Escape (or an unmount) can hand focus back.
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const initial = focusableWithin(root)[0];
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableWithin(root);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      // Wrap at both ends. Also pulls focus back in if it has escaped the
      // dialog entirely (a click on the page behind, say).
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, ref]);
}
