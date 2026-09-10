import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalClientFilter } from '../../../../state/client-filter.js';
import { ContextDocumentVNext } from './ContextDocumentVNext.js';
import { ContextLibraryVNext } from './ContextLibraryVNext.js';
import { StewardReviewVNext } from './StewardReviewVNext.js';

const mocks = vi.hoisted(() => ({
  document: {} as any, documents: {} as any, facts: {} as any, clients: [] as Array<{ id: string; name: string }>,
  archive: vi.fn(), extract: vi.fn(), approve: vi.fn(), role: 'user_admin',
}));
vi.mock('./context-workflows-api.js', () => ({
  useContextAssociation: () => ({ data: { state: 'active', strategy: { id: 'current-plan', title: 'Current plan' } } }),
  useContextReassignmentTargets: () => ({ data: [{ id: 'next-plan', clientId: 'client-a', title: 'Next plan' }] }),
  useReassignContextDocument: () => ({ mutate: vi.fn() }),
}));
vi.mock('../ScopeBar.js', () => ({ ScopeBar: () => null }));
vi.mock('../../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({ selectedClientId: null }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ data: { role: mocks.role, features: { agenticMeri: true, contextSteward: true } } }) }));
vi.mock('../strategies-api.js', () => ({
  clientName: () => 'Client', useClientsLite: () => ({ data: mocks.clients }),
  useContextDocument: () => mocks.document,
  useContextDocuments: () => mocks.documents,
  useContextFacts: () => mocks.facts,
  useContextFact: (id: string) => ({ data: mocks.facts.data?.find((fact: { id: string }) => fact.id === id), isSuccess: true }),
  useContextHealth: () => ({ data: undefined }),
  useContextConflicts: () => ({ data: [], isSuccess: true }),
  useContextSections: () => ({ data: [] }),
  useContextLocate: () => ({ data: null }),
  // F06: the library now resolves card associations through the batched
  // projection hook — stub it here like every other context hook.
  useContextAssociations: () => ({ data: {}, isLoading: false, isError: false }),
  useApproveContextDocument: () => ({ mutate: mocks.approve }),
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
  setGlobalClientFilter(null);
  mocks.document = success(document);
  mocks.documents = success([document]);
  mocks.facts = success([]);
  mocks.archive.mockReset();
  mocks.approve.mockReset();
  mocks.role = 'user_admin';
  mocks.clients = [{ id: 'client-a', name: 'Client A' }, { id: 'client-b', name: 'Client B' }];
});

describe('Context production regressions', () => {
  it('clears a reassignment review when navigating directly to another cached document', () => {
    mocks.document = success({ ...document, clientId: 'client-a', scopeRef: 'current-plan' });
    render(<MemoryRouter initialEntries={['/strategies/context/document-1']}>
      <Link to="/strategies/context/document-2">Next source</Link>
      <Routes><Route path="/strategies/context/:documentId" element={<ContextDocumentVNext />} /></Routes>
    </MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Change strategy' }));
    fireEvent.change(screen.getByLabelText('New strategy'), { target: { value: 'next-plan' } });
    expect(screen.getByRole('button', { name: 'Create working revision' })).toBeEnabled();

    mocks.document = success({ ...mocks.document.data, id: 'document-2', title: 'Another cached source', checksum: 'b'.repeat(64) });
    fireEvent.click(screen.getByRole('link', { name: 'Next source' }));

    expect(screen.getByRole('heading', { name: 'Another cached source' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create working revision' })).not.toBeInTheDocument();
  });
  it('uses the selected client for document rows and summary counts while labeling shared firm context', () => {
    mocks.documents = success([
      { ...document, id: 'a', title: 'A source', clientId: 'client-a' },
      { ...document, id: 'b', title: 'B source', clientId: 'client-b' },
      { ...document, id: 'firm', title: 'Firm source', clientId: null, scope: 'firm' },
    ]);
    setGlobalClientFilter('client-a');
    render(<MemoryRouter><ContextLibraryVNext /></MemoryRouter>);
    expect(screen.getByText('A source')).toBeInTheDocument();
    expect(screen.getByText('Firm source')).toBeInTheDocument();
    expect(screen.queryByText('B source')).not.toBeInTheDocument();
    expect(screen.getByText('2 documents · organized by topic')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Client B' }));
    expect(screen.getByText('B source')).toBeInTheDocument();
    expect(screen.queryByText('A source')).not.toBeInTheDocument();
  });
  it('offers canonical clients with no facts in the review selector', () => {
    render(<MemoryRouter><StewardReviewVNext /></MemoryRouter>);
    expect(screen.getByRole('option', { name: 'Client B' })).toBeInTheDocument();
    expect(screen.queryByText('Healthy · no open conflicts')).not.toBeInTheDocument();
  });
  it('offers the firm filter even when the current result page contains only client records', () => {
    mocks.documents = success([{ ...document, clientId: 'client-a' }]);
    render(<MemoryRouter><ContextLibraryVNext /><Location /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Firm' }));
    expect(screen.getByTestId('location')).toHaveTextContent('client=firm');
  });

  it('keeps a previously loaded source visible when a background refresh fails', () => {
    mocks.document = { ...mocks.document, isSuccess: false, isError: true, isRefetchError: true };
    renderDocument();
    expect(within(screen.getByLabelText('Document reading view')).getByText('Trusted evidence')).toBeInTheDocument();
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

it('requires explicit review confirmation and binds approval to the viewed checksum', () => {
  mocks.document = success({ ...document, frontmatter: { authority: 'working_draft', source_of_truth: false, confidentiality: 'client_confidential' } });
  renderDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve for client reports' }));
  expect(mocks.approve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
  expect(mocks.approve).toHaveBeenCalledWith({ id: document.id, expectedChecksum: document.checksum }, expect.any(Object));
});
it('explains the approval role requirement to a member', () => {
  mocks.role = 'staff';
  mocks.document = success({ ...document, frontmatter: { authority: 'working_draft', confidentiality: 'client_confidential' } });
  renderDocument();
  expect(screen.queryByRole('button', { name: 'Approve for client reports' })).not.toBeInTheDocument();
  expect(screen.getByText('An administrator can approve this document.')).toBeInTheDocument();
});

it('does not silently approve a version refreshed after the review confirmation opened', () => {
  mocks.document = success({ ...document, frontmatter: { authority: 'working_draft', source_of_truth: false, confidentiality: 'client_confidential' } });
  const view = renderDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve for client reports' }));
  mocks.document = success({ ...mocks.document.data, checksum: 'b'.repeat(64) });
  view.rerender(<MemoryRouter initialEntries={['/strategies/context/document-1']}><Routes><Route path="/strategies/context/:documentId" element={<ContextDocumentVNext />} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
  expect(mocks.approve).toHaveBeenCalledWith({ id: document.id, expectedChecksum: document.checksum }, expect.any(Object));
});
