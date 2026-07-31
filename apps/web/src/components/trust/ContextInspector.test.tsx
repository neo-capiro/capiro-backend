import { fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
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
      status: 'active',
      rationale: 'Firm identity always steers firm-scoped drafting.',
      selection: 'automatic',
    },
    {
      id: 'client-1',
      label: 'Client policy position',
      type: 'client-compass',
      scope: 'client',
      clientName: 'Acme',
      status: 'stale',
      selection: 'explicit',
      lastConfirmedAt: '2026-07-20T12:00:00.000Z',
    },
  ],
  exclusions: [
    { id: 'old-1', label: 'Old playbook', type: 'playbook', reason: 'superseded' },
    {
      id: 'secret-id',
      label: 'Must never render',
      type: 'client-compass',
      reason: 'unauthorized',
    },
  ],
  degraded: true,
  degradedReason: 'Client documents were temporarily unavailable.',
};

function summaryFor(container: HTMLElement): HTMLElement {
  const summary = container.querySelector('summary');
  if (!summary) throw new Error('Context Inspector summary not found');
  return summary;
}

describe('ContextInspector', () => {
  it('shows included, excluded, and degraded context without exposing unauthorized identity', () => {
    render(<ContextInspector packet={packet} />);
    fireEvent.click(screen.getByText(/Context used/i));

    expect(screen.getByText('Firm Compass')).toBeTruthy();
    expect(screen.getByText('Client policy position')).toBeTruthy();
    expect(screen.getByText('Lifecycle · Active')).toBeTruthy();
    expect(screen.getByText('Lifecycle · Stale — review due')).toBeTruthy();
    expect(screen.getByText(/Old playbook/)).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Client documents were temporarily unavailable',
    );
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText(/1 restricted item/)).toBeTruthy();
    expect(screen.queryByText('Must never render')).toBeNull();
    expect(screen.queryByText('secret-id')).toBeNull();
    expect(screen.getByTitle(packet.packetId!)).toHaveTextContent('Packet 01234567');
  });

  it('uses unique per-instance IDs and valid aria-labelledby references', () => {
    const { container } = render(
      <>
        <ContextInspector packet={packet} label="First context" />
        <ContextInspector packet={packet} label="Second context" />
      </>,
    );

    const idElements = Array.from(container.querySelectorAll<HTMLElement>('[id]'));
    const ids = idElements.map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);

    const labelledElements = Array.from(
      container.querySelectorAll<HTMLElement>('[aria-labelledby]'),
    );
    expect(labelledElements.length).toBeGreaterThan(0);
    for (const element of labelledElements) {
      const references =
        element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(idElements.filter((candidate) => candidate.id === reference)).toHaveLength(1);
      }
    }
  });

  it('supports explicit Enter and Space keyboard expand/collapse with synchronized semantics', () => {
    const { container } = render(<ContextInspector packet={packet} />);
    const details = container.querySelector('details');
    const summary = summaryFor(container);
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(summary).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(summary, { key: 'Enter' });
    expect(details?.open).toBe(true);
    expect(summary).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(summary, { key: ' ' });
    expect(details?.open).toBe(false);
    expect(summary).toHaveAttribute('aria-expanded', 'false');
  });

  it('provides a screen-reader summary label and a valid controlled body target', () => {
    const { container } = render(<ContextInspector packet={packet} />);
    const summary = summaryFor(container);
    expect(summary).toHaveAttribute(
      'aria-label',
      'Context used. 2 included context items. 2 excluded context items. Context degraded',
    );
    const bodyId = summary.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[id]')).filter(
        (node) => node.id === bodyId,
      ),
    ).toHaveLength(1);
  });

  it('passes automated accessibility checks in the expanded state', async () => {
    const { container } = render(
      <ContextInspector packet={packet} onReviewContext={() => {}} />,
    );
    fireEvent.keyDown(summaryFor(container), { key: 'Enter' });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
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

  it('never displays an id when persistence evidence is absent', () => {
    const unproven = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    render(
      <ContextInspector
        packet={{
          packetId: unproven,
          items: [],
          exclusions: [],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));

    expect(screen.queryByTitle(unproven)).toBeNull();
    expect(screen.queryByText(/Packet bbbbbbbb/)).toBeNull();
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
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('counts every identity-withheld reason and renders none of their identities', () => {
    const { container } = render(
      <ContextInspector
        packet={{
          items: [],
          exclusions: [
            {
              id: 'restricted-id-alpha',
              label: 'Restricted Alpha',
              type: 'firm-soul',
              reason: 'unauthorized',
            },
            {
              id: 'restricted-id-beta',
              label: 'Other client compass',
              type: 'client-compass',
              reason: 'wrong-client',
            },
            {
              id: 'restricted-id-gamma',
              label: 'Restricted brief',
              type: 'firm-compass',
              reason: 'sensitivity-denied',
            },
            { id: 'visible-id', label: 'Old playbook', type: 'playbook', reason: 'superseded' },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText(/3 restricted items/)).toBeTruthy();
    expect(screen.queryByText('Restricted Alpha')).toBeNull();
    expect(screen.queryByText('Other client compass')).toBeNull();
    expect(screen.queryByText('Restricted brief')).toBeNull();
    expect(container.textContent).not.toContain('restricted-id-alpha');
    expect(container.textContent).not.toContain('restricted-id-beta');
    expect(container.textContent).not.toContain('restricted-id-gamma');
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

  it('renders an unknown authority as Unknown without echoing its internal slug', () => {
    render(
      <ContextInspector
        packet={{
          items: [
            {
              id: 'mi-authority',
              label: 'Future authority',
              type: 'firm-soul',
              scope: 'firm',
              authority: 'future_internal_authority',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText('Authority · Unknown')).toBeTruthy();
    expect(screen.queryByText(/future_internal_authority/)).toBeNull();
  });

  it('renders an unknown lifecycle without echoing an internal slug', () => {
    render(
      <ContextInspector
        packet={{
          items: [
            {
              id: 'mi-status',
              label: 'Unknown lifecycle',
              type: 'firm-soul',
              scope: 'firm',
              status: 'future_internal_state',
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByText(/Context used/i));
    expect(screen.getByText('Lifecycle · Unknown')).toBeTruthy();
    expect(screen.queryByText(/future_internal_state/)).toBeNull();
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
