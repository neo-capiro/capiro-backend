import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { MeriEmptyState } from './MeriEmptyState.js';

describe('MeriEmptyState', () => {
  test('docked starter sends its production prompt', () => {
    const onSend = vi.fn();
    render(<MeriEmptyState surface="docked" onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /prepare me for my next meeting/i }));
    expect(onSend).toHaveBeenCalledWith('Prepare me for my next meeting');
  });

  test('undocked home renders the prototype four-card grid', () => {
    const onSend = vi.fn();
    render(<MeriEmptyState surface="undocked" onSend={onSend} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /review the portfolio/i }));
    expect(onSend).toHaveBeenCalledWith('Show me which clients need attention and why.');
  });
});
