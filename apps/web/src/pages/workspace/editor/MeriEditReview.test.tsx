import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MeriEditReview } from './MeriEditReview.js';

const document = {
  sections: ['Overview', 'Policy Ask'],
  content: {
    Overview: '<p>Old overview text.</p>',
    'Policy Ask': '<p>Request $10 million.</p>',
  },
  meta: {},
};

const edits = [
  {
    op: 'replace_section' as const,
    section: 'Policy Ask',
    content: '<p>Request $12 million now.</p>',
    note: 'Updates the amount and makes the ask action-oriented.',
  },
  {
    op: 'remove_section' as const,
    section: 'Overview',
    note: 'Removes redundant background.',
  },
];

describe('MeriEditReview', () => {
  it('shows before, after, diff, rationale, and destructive warning', () => {
    render(
      <MeriEditReview
        edits={edits}
        document={document}
        confidence={{ level: 'high', label: 'All checked claims are supported' }}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText('Request $10 million.')).toBeTruthy();
    expect(screen.getByText('Request $12 million now.')).toBeTruthy();
    expect(screen.getByText(/Updates the amount/)).toBeTruthy();
    expect(screen.getByText('Destructive')).toBeTruthy();
    expect(screen.getAllByText(/No source citations attached/).length).toBeGreaterThan(0);
  });

  it('requires explicit confirmation before applying a removal', () => {
    const apply = vi.fn().mockResolvedValue({ status: 'saved' });
    render(
      <MeriEditReview
        edits={edits}
        document={document}
        confidence={{ level: 'high', label: 'Verified' }}
        onApply={apply}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 selected' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove 1 section?');
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal and apply' }));
    expect(apply).toHaveBeenCalledWith(edits);
  });

  it('never labels local application as saved when persistence failed', async () => {
    const apply = vi.fn().mockResolvedValue({
      status: 'save_failed',
      message: 'Draft settings and main document did not save.',
    });
    const retry = vi.fn().mockResolvedValue({ status: 'saved' });
    const undo = vi.fn().mockResolvedValue({ status: 'saved' });
    render(
      <MeriEditReview
        edits={[edits[0]!]}
        document={document}
        confidence={{ level: 'unknown', label: 'Unknown' }}
        onApply={apply}
        onDismiss={vi.fn()}
        onRetrySave={retry}
        onUndo={undo}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Applied locally; save failed'));
    expect(screen.queryByText('Applied and saved.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Applied and saved.')).toBeTruthy());
  });

  it('offers a one-click safe subset only when verification passed', () => {
    const apply = vi.fn().mockResolvedValue({ status: 'saved' });
    render(
      <MeriEditReview
        edits={edits}
        document={document}
        confidence={{ level: 'high', label: 'Verified' }}
        onApply={apply}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Apply all verified non-destructive edits' }),
    );
    expect(apply).toHaveBeenCalledWith([edits[0]]);
  });
});
