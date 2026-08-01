import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { citationHref, ProofPackPanel } from './ProofPackPanel.js';
import type { ProgramElementSourceItem } from './types.js';

function setupAntdBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

function src(over: Partial<ProgramElementSourceItem> = {}): ProgramElementSourceItem {
  return {
    id: 's1',
    docType: 'R',
    exhibitType: 'R-2A',
    fy: 2027,
    sourceUrl: 'http://x/r2a.pdf',
    pageNumber: 42,
    pageEnd: null,
    snippet: 'AA1 Defense Research Sciences',
    publisher: 'DoD Comptroller (Army)',
    confidence: 0.9,
    sourceDocument: { title: 'RDT&E R-2A', budgetCycle: 'pb', sha256: 'a'.repeat(64) },
    ...over,
  };
}

describe('ProofPackPanel', () => {
  beforeAll(setupAntdBrowserMocks);

  it('renders citations with an open-at-page deep link + honest fingerprint badge', () => {
      render(<ProofPackPanel sources={[src()]} />);
      expect(screen.getByText('R-2A')).toBeInTheDocument();
      const link = screen.getByRole('link', { name: 'Open at page' });
      expect(link).toHaveAttribute('href', 'http://x/r2a.pdf#page=42');
      expect(screen.getByTestId('pe-proof-fingerprint')).toHaveTextContent(/sha256 /i);
      expect(screen.queryByText('fingerprinted')).toBeNull();
      expect(screen.getByText(/ingested source bytes only/i)).toBeInTheDocument();
    });

  it('shows an honest empty state when there are no citations', () => {
    render(<ProofPackPanel sources={[]} />);
    expect(screen.getByText(/No source citations recorded/)).toBeInTheDocument();
  });

  it('citationHref appends #page only when a page is present', () => {
    expect(citationHref({ sourceUrl: 'u', pageNumber: 3 })).toBe('u#page=3');
    expect(citationHref({ sourceUrl: 'u', pageNumber: null })).toBe('u');
    expect(citationHref({ sourceUrl: null as unknown as string, pageNumber: 3 })).toBeNull();
  });
});
