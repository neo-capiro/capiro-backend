import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { BillCard } from './tracker-components.js';
import type { BoardBill } from './tracker-api.js';

/**
 * Gate D phase g — board status nuance (P2-09) and hover-free detail (P2-10).
 *
 * P2-09: the board has four coarse lanes but the detector classifies far more,
 * so a FAILED governing rule used to render as an ordinary card in whichever
 * lane its stage mapped to — visually identical to a bill that is progressing.
 *
 * P2-10: the change indicator was a colored dot whose only content was a
 * `title`, the latest action was a `title` on the date, and unread was a bare
 * dot. None of it was reachable by touch or by a screen reader.
 */

function bill(over: Partial<BoardBill> = {}): BoardBill {
  return {
    billId: '119-hr-1200',
    displayNum: 'H.R. 1200',
    title: 'Grid Modernization Act',
    stage: 'passed',
    probability: 0.42,
    tags: ['grid'],
    isManual: true,
    trackedAt: '2026-03-01T00:00:00.000Z',
    unread: false,
    change: null,
    latestActionDate: '2026-03-09',
    latestActionText: 'On agreeing to the resolution Failed by the Yeas and Nays: 198 - 224.',
    ...over,
  } as BoardBill;
}

function renderCard(b: BoardBill, onOpen = vi.fn()) {
  const utils = render(
    <div className="lw-root">
      <BillCard
        bill={b}
        issueSet={new Set(['grid'])}
        justLanded={false}
        onUntrack={vi.fn()}
        onOpen={onOpen}
      />
    </div>,
  );
  return { ...utils, onOpen };
}

describe('P2-09 — canonical status and terminal risk', () => {
  /** g-8 case 1. */
  test('terminalRisk gets the distinct class; a normal card does not', () => {
    const { container: risky } = renderCard(bill({ terminalRisk: true }));
    expect(risky.querySelector('.bcard')!.className).toContain('terminal-risk');

    const { container: normal } = renderCard(bill({ terminalRisk: false }));
    expect(normal.querySelector('.bcard')!.className).not.toContain('terminal-risk');
  });

  /** g-8 case 2. */
  test('the canonical status chip renders its label', () => {
    renderCard(bill({ canonicalStatus: 'Rule failed — stalled on the floor' }));
    expect(screen.getByText('Rule failed — stalled on the floor')).toBeInTheDocument();
  });

  test('a terminal-risk status is styled distinctly from an ordinary one', () => {
    const { container } = renderCard(
      bill({ canonicalStatus: 'Vetoed', terminalRisk: true }),
    );
    expect(container.querySelector('.b-status')!.className).toContain('terminal');
  });

  test('a card with no canonicalStatus (legacy board) renders no status line', () => {
    const { container } = renderCard(bill({ canonicalStatus: null }));
    expect(container.querySelector('.b-status')).toBeNull();
  });
});

describe('P2-10 — detail is visible without hovering', () => {
  /**
   * g-8 case 3 — queried by TEXT, never by title attribute. A `title` is
   * exactly what this finding is about, so asserting on one would pass while
   * the bug remained.
   */
  test('the change label, latest action, and unread state are all in the DOM', () => {
    const { container } = renderCard(
      bill({
        unread: true,
        change: { tone: 'critical', label: 'Rule failed — stalled on the floor', dot: true },
      }),
    );

    // The change label is real text, not a hover title.
    expect(screen.getByText('Rule failed — stalled on the floor')).toBeInTheDocument();
    // The latest action text is visible, not a title on the date.
    expect(
      screen.getByText(/Failed by the Yeas and Nays: 198 - 224/),
    ).toBeInTheDocument();
    // Unread is a labelled chip, not a bare dot.
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(container.querySelector('[aria-label="Unread"]')).not.toBeNull();
  });

  test('the date stamp no longer hides the action text in a title', () => {
    const { container } = renderCard(bill());
    const stamp = container.querySelector('.b-foot .num');
    expect(stamp?.getAttribute('title')).toBeNull();
  });

  test('Details is a real button that opens the drawer without opening the card', () => {
    const onOpen = vi.fn();
    renderCard(bill(), onOpen);
    const details = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(details);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('a card with no action text renders no action line', () => {
    const { container } = renderCard(bill({ latestActionText: null }));
    expect(container.querySelector('.b-action')).toBeNull();
  });
});
