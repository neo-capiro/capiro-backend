import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MeriEvidenceTab } from './MeriEvidenceTab.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

describe('stable citation markers in the Evidence inspector', () => {
  it('retains the answer numbers when only a subset of retrieved sources was cited', () => {
    const sources = [6, 7, 15].map((n) => ({
      citationNumber: n,
      icon: 'File05' as const,
      provider: 'CLIENT FILES',
      title: `Evidence page ${n}`,
      snippet: `Verified excerpt ${n}`,
      date: 'RETRIEVED THIS TURN',
      locator: `PAGE ${n}`,
    }));
    const onOpenSource = vi.fn();
    render(
      <MeriEvidenceTab
        sources={sources}
        verifyStats={[]}
        claims={[]}
        groundingCaveat={null}
        retrieval={null}
        onOpenSource={onOpenSource}
      />,
    );
    expect(screen.getByText('[6] Evidence page 6')).toBeInTheDocument();
    expect(screen.getByText('[7] Evidence page 7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /\[15\] Evidence page 15/ }));
    expect(onOpenSource).toHaveBeenCalledWith(sources[2], 2);
    expect(screen.queryByText('[1] Evidence page 6')).not.toBeInTheDocument();
  });

  it('does not invent a positional marker for an unnumbered enforce source', () => {
    const source = {
      icon: 'File05' as const,
      provider: 'CLIENT FILES',
      title: 'Unnumbered appendix',
      snippet: 'Context only',
      date: 'RETRIEVED THIS TURN',
      locator: 'APPENDIX',
    };
    render(<MeriEvidenceTab sources={[source]} verifyStats={[]} claims={[]} groundingCaveat={null} retrieval={null} evidenceAccuracy="enforce" />);
    expect(screen.getByText('Unnumbered appendix')).toBeInTheDocument();
    expect(screen.queryByText('[1] Unnumbered appendix')).not.toBeInTheDocument();
  });
});
