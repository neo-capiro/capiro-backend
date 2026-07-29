import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextInspector, type TrustContextPacket } from './ContextInspector.js';

const packet: TrustContextPacket = {
  packetId: '01234567-89ab-cdef-0123-456789abcdef',
  compiledAt: '2026-07-28T14:00:00.000Z',
  items: [
    {
      id: 'firm-1',
      label: 'Firm Compass',
      type: 'firm-compass',
      scope: 'firm',
      authority: 'human-approved',
      rationale: 'Firm identity always steers firm-scoped drafting.',
      selection: 'automatic',
    },
    {
      id: 'client-1',
      label: 'Client policy position',
      type: 'client-compass',
      scope: 'client',
      clientName: 'Acme',
      selection: 'explicit',
      lastConfirmedAt: '2026-07-20T12:00:00.000Z',
    },
  ],
  exclusions: [
    { id: 'old-1', label: 'Old playbook', type: 'playbook', reason: 'superseded' },
    { id: 'secret-id', label: 'Must never render', type: 'client-compass', reason: 'unauthorized' },
  ],
  degraded: true,
  degradedReason: 'Client documents were temporarily unavailable.',
};

describe('ContextInspector', () => {
  it('shows included, excluded, and degraded context without exposing unauthorized identity', () => {
    render(<ContextInspector packet={packet} />);
    fireEvent.click(screen.getByText(/Context used/i));

    expect(screen.getByText('Firm Compass')).toBeTruthy();
    expect(screen.getByText('Client policy position')).toBeTruthy();
    expect(screen.getByText(/Old playbook/)).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Client documents were temporarily unavailable');
    expect(screen.getByText(/1 restricted item/)).toBeTruthy();
    expect(screen.queryByText('Must never render')).toBeNull();
    expect(screen.queryByText('secret-id')).toBeNull();
  });

  it('links to the review surface instead of editing canonical context inline', () => {
    const review = vi.fn();
    render(<ContextInspector packet={packet} onReviewContext={review} />);
    fireEvent.click(screen.getByText(/Context used/i));
    fireEvent.click(screen.getByRole('button', { name: 'Review context' }));
    expect(review).toHaveBeenCalledOnce();
  });

  it('states when context details are unavailable', () => {
    render(<ContextInspector packet={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('details unavailable');
  });
});
