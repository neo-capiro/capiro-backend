import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextDocumentVNext } from './ContextDocumentVNext.js';
import { ContextLibraryVNext } from './ContextLibraryVNext.js';
import { StewardReviewVNext } from './StewardReviewVNext.js';

const mocks = vi.hoisted(() => ({
  document: {} as any, documents: {} as any, facts: {} as any,
  archive: vi.fn(), extract: vi.fn(),
}));
vi.mock('../ScopeBar.js', () => ({ ScopeBar: () => null }));
vi.mock('../../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({ selectedClientId: null }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ data: { features: { agenticMeri: true, contextSteward: true } } }) }));
vi.mock('../strategies-api.js', () => ({
  clientName: () => 'Client', useClientsLite: () => ({ data: [] }),
  useContextDocument: () => mocks.document,
  useContextDocuments: () => mocks.documents,
  useContextFacts: () => mocks.facts,
  useContextHealth: () => ({ data: undefined }),
  useContextConflicts: () => ({ data: [], isSuccess: true }),
  useContextSections: () => ({ data: [] }),
  useContextLocate: () => ({ data: null }),
  useArchiveContextDocument: () => ({ mutate: mocks.archive }),
  useExtractContextFacts: () => ({ mutate: mocks.extract }),
  useRejectContextFact: () => ({ mutate: vi.fn() }),
  useDismissContextConflict: () => ({ mutate: vi.fn() }),
}));

const document = {
  id: 'document-1', title: 'Grounded plan source', content: '# Source\nTrusted evidence',
  templateKey: '01_strategy_brief', state: 'active', scope: 'strategy', clientId: null,
  frontmatter: { authority: 'firm_approved', as_of: '2026-09-01' },
  checksum: 'a'.repeat(64), createdAt: '2026-09-01', updatedAt: '2026-09-01',
};
function success(data: unknown) {
  return { data, isSuccess: true, isError: false, isLoading: false, refetch: vi.fn(), dataUpdatedAt: 1 };
}
function Location() { return <output data-testid="location">{useLocation().search}</output>; }
function renderDocument() {
  return render(<MemoryRouter initialEntries={['/strategies/context/document-1']}><Routes>
    <Route path="/strategies/context/:documentId" element={<ContextDocumentVNext />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  mocks.document = success(document);
  mocks.documents = success([document]);
  mocks.facts = success([]);
  mocks.archive.mockReset();
});

describe('Context production regressions', () => {
  it('keeps a previously loaded source visible when a background refresh fails', () => {
    mocks.document = { ...mocks.document, isSuccess: false, isError: true, isRefetchError: true };
    renderDocument();
    expect(screen.getByText('Trusted evidence')).toBeInTheDocument();
    expect(screen.getByText(/Refresh failed — showing data/)).toBeInTheDocument();
  });

  it.each(['loading', 'error'])('does not permit archive while the fact ledger is %s', (state) => {
    mocks.facts = { ...success(undefined), isSuccess: false, isLoading: state === 'loading', isError: state === 'error' };
    renderDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('rechecks fact eligibility when an archive confirmation is already open', () => {
    const view = renderDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    mocks.facts = success([{ id: 'fact-1', documentId: document.id, state: 'active' }]);
    view.rerender(<MemoryRouter initialEntries={['/strategies/context/document-1']}><Routes>
      <Route path="/strategies/context/:documentId" element={<ContextDocumentVNext />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Confirm archive' })).toBeDisabled();
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it('preserves loaded library rows on a failed background refresh', () => {
    mocks.documents = { ...mocks.documents, isSuccess: false, isError: true, isRefetchError: true };
    render(<MemoryRouter><ContextLibraryVNext /></MemoryRouter>);
    expect(screen.getByText(document.title)).toBeInTheDocument();
    expect(screen.getByText(/Refresh failed — showing data/)).toBeInTheDocument();
  });

  it('opens a deep-linked retired fact by changing its state and clearing both hiding filters atomically', async () => {
    mocks.facts = success([{
      id: 'retired-fact', state: 'rejected', fact: 'The referenced rejected finding',
      clientId: 'client-one', documentId: 'document-1', sourceRef: 'heading:Source',
      createdAt: '2026-09-01', updatedAt: '2026-09-01',
    }]);
    render(<MemoryRouter initialEntries={['/strategies/context/steward?fact=retired-fact&client=another-client&q=unrelated']}>
      <StewardReviewVNext /><Location />
    </MemoryRouter>);
    await waitFor(() => expect(screen.getByText('The referenced rejected finding')).toBeInTheDocument());
    const params = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
    expect(params.get('state')).toBe('rejected');
    expect(params.has('client')).toBe(false);
    expect(params.has('q')).toBe(false);
  });
});
