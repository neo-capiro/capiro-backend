import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextInspector, type TrustContextPacket } from './ContextInspector.js';

const packet: TrustContextPacket = {
  packetId: '01234567-89ab-cdef-0123-456789abcdef',
  persisted: true,
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
    expect(screen.getByTitle(packet.packetId!)).toHaveTextContent('Packet 01234567');
  });

  it('never displays a generated id when persistence failed', () => {
    const generatedOnly = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    render(
      <ContextInspector
        packet={{
          packetId: generatedOnly,
          persisted: false,
          persistenceErrorCode: 'context_packet_error',
          items: [],
          exclusions: [],
          degraded: true,
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));

    expect(screen.getByRole('alert')).toHaveTextContent('durable context provenance trace');
    expect(screen.queryByTitle(generatedOnly)).toBeNull();
    expect(screen.queryByText(/Packet aaaaaaaa/)).toBeNull();
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

  it('counts every identity-withheld reason and renders none of their identities', () => {
    render(
      <ContextInspector
        packet={{
          items: [],
          exclusions: [
            { id: 'a', label: 'A', type: 'firm-soul', reason: 'unauthorized' },
            { id: 'b', label: 'Other client compass', type: 'client-compass', reason: 'wrong-client' },
            { id: 'c', label: 'Restricted brief', type: 'firm-compass', reason: 'sensitivity-denied' },
            { id: 'd', label: 'Old playbook', type: 'playbook', reason: 'superseded' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText(/3 restricted items/)).toBeTruthy();
    expect(screen.queryByText('Other client compass')).toBeNull();
    expect(screen.queryByText('Restricted brief')).toBeNull();
    expect(screen.getByText(/Old playbook/)).toBeTruthy();
  });

  it('labels a v2 governed authority in plain English instead of printing the slug', () => {
    render(
      <ContextInspector
        packet={{
          items: [
            {
              id: 'mi-1',
              label: 'Firm Soul',
              type: 'firm-soul',
              scope: 'firm',
              authority: 'model_inferred',
              selection: 'automatic',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText('Authority · Model inferred')).toBeTruthy();
    expect(screen.queryByText(/model_inferred/)).toBeNull();
  });

  it('labels the new v2 exclusion reasons rather than showing a raw slug', () => {
    render(
      <ContextInspector
        packet={{
          items: [],
          exclusions: [
            { id: 'x', label: 'Draft position', type: 'client-compass', reason: 'unapproved' },
            { id: 'y', label: 'Legacy note', type: 'firm-soul', reason: 'legacy-unclassified' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText(/Not approved for use yet/)).toBeTruthy();
    expect(screen.getByText(/Unclassified — awaiting governance review/)).toBeTruthy();
  });
});
