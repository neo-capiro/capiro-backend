import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MeriMessageFeedback } from './MeriMessageFeedback.js';
import { mapPersistedFeedback } from './meri-route-state.js';

describe('Phase 4 feedback hydration and recoverable controls', () => {
  it.each(['up', 'down', null] as const)('restores the saved %s selection from history', (rating) => {
    const saved = mapPersistedFeedback({ role: 'assistant', userId: 'owner', metadata: { feedback: { rating, userId: 'owner' } } });
    render(<MeriMessageFeedback currentRating={saved} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', String(rating === 'up'));
    expect(screen.getByRole('button', { name: 'Not helpful' })).toHaveAttribute('aria-pressed', String(rating === 'down'));
  });

  it('ignores malformed, user-message and mismatched-owner ratings', () => {
    for (const message of [
      { role: 'assistant', metadata: { feedback: { rating: 'invalid' } } },
      { role: 'user', metadata: { feedback: { rating: 'up' } } },
      { role: 'assistant', userId: 'owner', metadata: { feedback: { rating: 'up', userId: 'another' } } },
      { role: 'assistant', metadata: null },
    ]) expect(mapPersistedFeedback(message)).toBeNull();
  });

  it('keeps the failure visible, retains reasons and note, and retries the same payload', async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Feedback could not be saved. Please try again.')).mockResolvedValue(undefined);
    render(<MeriMessageFeedback onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Outdated' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Needs current date' } });
    fireEvent.click(screen.getByRole('button', { name: 'SUBMIT FEEDBACK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Feedback could not be saved');
    expect(screen.getByRole('checkbox', { name: 'Outdated' })).toBeChecked();
    expect(screen.getByRole('textbox')).toHaveValue('Needs current date');
    fireEvent.click(screen.getByRole('button', { name: 'SUBMIT FEEDBACK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ rating: 'down', reasons: ['outdated'], note: 'Needs current date' });
    expect(onSubmit.mock.calls[1]![0]).toEqual(onSubmit.mock.calls[0]![0]);
  });

  it('blocks duplicate clicks while saving and handles a failed quick rating without an unhandled rejection', async () => {
    let reject!: (error: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    render(<MeriMessageFeedback currentRating="up" onSubmit={onSubmit} />);
    const helpful = screen.getByRole('button', { name: 'Helpful' });
    fireEvent.click(helpful);
    expect(helpful).toBeDisabled();
    fireEvent.click(helpful);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ rating: null });
    reject(new Error('Save failed'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed');
    expect(helpful).not.toBeDisabled();
  });
});
