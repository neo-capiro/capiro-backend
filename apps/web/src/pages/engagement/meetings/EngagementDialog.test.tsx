import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EngagementDialog } from './EngagementDialog.js';

/**
 * EngagementDialog is the shared shell behind the Engagement production windows
 * that were previously inline or missing (client assignment, attendees, edit
 * prep, edit meeting notes, edit debrief, transcript and attachments, and the
 * Outreach V3 draft revision window).
 *
 * The closeout requires every one of those windows to support focus trapping,
 * Escape, an explicit close control, scrim dismissal *only when safe*, focus
 * return, a loading state, an error state, submission controls disabled while
 * pending, and dirty-form protection. Those guarantees live here rather than in
 * each caller, so they are asserted here once against the real component.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

function Harness({
  busy = false,
  dirty = false,
  error = null,
  onClose,
  initialOpen = true,
}: {
  busy?: boolean;
  dirty?: boolean;
  error?: string | null;
  onClose?: () => void;
  /** Start closed so a test can focus the trigger first, as a real user would. */
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <EngagementDialog
        open={open}
        title="Client assignment"
        description="Associate this meeting with a client."
        busy={busy}
        dirty={dirty}
        error={error}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        footer={
          <button type="button" disabled={busy}>
            Save assignment
          </button>
        }
      >
        <label>
          Client
          <select>
            <option value="">No client</option>
          </select>
        </label>
      </EngagementDialog>
    </>
  );
}

describe('EngagementDialog', () => {
  test('exposes real dialog semantics and labels', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Client assignment');
    // An explicit close control, not only the scrim.
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  test('moves focus into the window and restores it to the opener on close', async () => {
    render(<Harness initialOpen={false} />);
    const opener = screen.getByTestId('opener');
    // Focus the trigger and open from it, which is what the dialog captures as
    // the element to restore focus to.
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);

    // The dialog focuses its first focusable node on open.
    await waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Focus returns to whatever was focused before the window opened.
    expect(document.activeElement).toBe(opener);
  });

  test('traps Tab and Shift+Tab inside the window', async () => {
    render(<Harness />);
    const dialog = await screen.findByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, select, [tabindex]:not([tabindex="-1"])'),
    );
    expect(focusable.length).toBeGreaterThan(0);

    // Tabbing from the last node must not land on the opener behind the scrim.
    focusable[focusable.length - 1]!.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByTestId('opener'));

    focusable[0]!.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByTestId('opener'));
  });

  test('Escape and scrim close a clean window', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    unmount();

    const scrimClose = vi.fn();
    render(<Harness onClose={scrimClose} />);
    // mousedown on the layer itself (not the panel) is the scrim.
    const layer = document.querySelector('.engagement-dialog-layer')!;
    fireEvent.mouseDown(layer);
    await waitFor(() => expect(scrimClose).toHaveBeenCalledTimes(1));
  });

  test('a mousedown that starts inside the panel never dismisses the window', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('while pending: submission is disabled, a loading state shows, and closing is refused', async () => {
    const onClose = vi.fn();
    render(<Harness busy onClose={onClose} />);

    expect(screen.getByRole('button', { name: 'Save assignment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    // A visible, announced loading state — not a silently frozen window.
    expect(screen.getByRole('status')).toHaveTextContent('Working…');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.engagement-dialog-layer')!);
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
  });

  test('renders a failure inside the window as an alert', () => {
    render(<Harness error="Could not update the meeting client." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not update the meeting client.');
  });

  test('dirty-form protection: a declined confirm keeps the window open', async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Harness dirty onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test('locks background scroll while open and restores it on close', async () => {
    const { unmount } = render(<Harness />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'));
  });
});
