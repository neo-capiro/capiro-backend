import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageFeedback } from './MessageFeedback.js';

describe('MessageFeedback', () => {
  it('captures bounded reason codes and optional text for a down rating', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<MessageFeedback currentRating={null} onSubmit={submit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Factually wrong'));
    fireEvent.click(screen.getByLabelText('Wrong client context'));
    fireEvent.change(screen.getByLabelText(/Optional note/i), {
      target: { value: 'The response used the wrong client.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));

    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith({
        rating: 'down',
        reasons: ['factually_wrong', 'wrong_client_context'],
        note: 'The response used the wrong client.',
      }),
    );
  });

  it('submits an up rating without opening the reason dialog', () => {
    const submit = vi.fn();
    render(<MessageFeedback currentRating={null} onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Helpful' }));
    expect(submit).toHaveBeenCalledWith({ rating: 'up' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clears an existing down rating without inventing new reasons', () => {
    const submit = vi.fn();
    render(<MessageFeedback currentRating="down" onSubmit={submit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not helpful' }));
    expect(submit).toHaveBeenCalledWith({ rating: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
