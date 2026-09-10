import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemorySourceEvidence } from './VNextMemoryGovernanceCenter.js';

describe('governed source evidence for correction', () => {
  it('labels the accepted source separately from unchanged approved memory and links its evidence', () => {
    render(
      <MemorySourceEvidence
        evidence={{
          status: 'available',
          explanation:
            'Review this source before suggesting a correction. The approved memory remains unchanged.',
          factText: 'name: FortressHUMS; platforms: ["UH-72"]; testAircraft: 2',
          acceptedAt: '2026-08-25T12:00:00.000Z',
          links: [{ label: 'Source letter', url: 'https://example.test/letter' }],
        }}
      />,
    );
    expect(screen.getByText('Original source for correction')).toBeInTheDocument();
    expect(screen.getByText(/FortressHUMS/)).toBeInTheDocument();
    expect(screen.getByText(/approved memory remains unchanged/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Source letter' });
    expect(link).toHaveAttribute('href', 'https://example.test/letter');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the unavailable source limitation without presenting missing facts as recovered', () => {
    render(
      <MemorySourceEvidence
        evidence={{
          status: 'unavailable',
          explanation: 'The original accepted finding is unavailable in this client scope.',
        }}
      />,
    );
    expect(screen.getByText(/unavailable in this client scope/)).toBeInTheDocument();
    expect(screen.queryByText('Accepted client finding')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not show source recovery for unrelated memory or an older API response', () => {
    const { container } = render(<MemorySourceEvidence evidence={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
