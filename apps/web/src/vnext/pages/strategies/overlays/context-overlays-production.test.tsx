import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResolveConflictOverlay } from './ResolveConflictOverlay.js';

const mocks = vi.hoisted(() => ({
  docs: [] as any[], facts: [] as any[], conflicts: [] as any[], upload: vi.fn(), resolve: vi.fn(),
  dismiss: vi.fn(), dismissPending: false, params: { conflictId: 'conflict-one' },
}));
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual('react-router-dom'), useParams: () => mocks.params,
}));
vi.mock('../strategies-api.js', () => ({
  clientName: (_: unknown, id: string) => id,
  useClientsLite: () => ({ data: [{ id: 'client-one', name: 'First client' }, { id: 'client-two', name: 'Second client' }] }),
  useContextDocuments: () => ({ data: mocks.docs }),
  useUploadContextDocument: () => ({ mutate: mocks.upload }),
  useContextFacts: () => ({ data: mocks.facts }),
  useContextConflicts: () => ({ data: mocks.conflicts }),
  useContextLocate: () => ({ data: null }),
  useResolveContextConflict: () => ({ mutate: mocks.resolve }),
  useDismissContextConflict: () => ({ mutate: mocks.dismiss, isPending: mocks.dismissPending }),
}));
vi.mock('./StrategiesModalShell.js', () => ({
  StrategiesModalShell: ({ children, primaryDisabled, onPrimary, primaryLabel, primaryBusy }: any) => (
    <div data-testid="shell" data-busy={String(Boolean(primaryBusy))}>{children}
      <button disabled={primaryDisabled || primaryBusy} onClick={onPrimary}>{primaryLabel}</button>
    </div>
  ),
}));

const doc = { id: 'doc-one', title: 'Same client source', templateKey: '01_strategy_brief', scope: 'client', scopeRef: null, clientId: 'client-one', state: 'active', createdAt: '2026-09-01', frontmatter: { document_id: 'explicit-document' } };
const factA = { id: 'fact-a', fact: 'Controlling evidence', state: 'active' };
const factB = { id: 'fact-b', fact: 'Losing evidence', state: 'active' };
const conflict = { id: 'conflict-one', factA, factB, factAId: factA.id, factBId: factB.id, state: 'open', createdAt: '2026-09-01' };

beforeEach(() => {
  mocks.docs = [doc, { ...doc, id: 'doc-other', clientId: 'client-two', title: 'Other client source' }, { ...doc, id: 'doc-draft', state: 'draft', title: 'Draft source' }];
  mocks.facts = [factA, factB]; mocks.conflicts = [conflict]; mocks.params = { conflictId: 'conflict-one' };
  mocks.upload.mockReset(); mocks.resolve.mockReset(); mocks.dismiss.mockReset(); mocks.dismissPending = false;
});

describe('Context overlay production regressions', () => {
  it('reports the real rejected outcome and requires a rationale before resolving', () => {
    render(<MemoryRouter><ResolveConflictOverlay /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Fact A/ }));
    expect(screen.getByRole('button', { name: 'Resolve conflict' })).toBeDisabled();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Decision note · Required' }), { target: { value: 'Newer client approval controls.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));
    expect(mocks.resolve).toHaveBeenCalledWith({ conflictId: conflict.id, input: { controllingFactId: factA.id, note: 'Newer client approval controls.' } }, expect.any(Object));
  });

  it('does not select a retired controlling fact or change a retired losing state in the preview', () => {
    mocks.facts = [{ ...factA, state: 'superseded' }, factB];
    render(<MemoryRouter><ResolveConflictOverlay /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /Fact A/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Fact B/ }));
    expect(screen.getByText('Superseded')).toBeInTheDocument();
  });

  it('keeps the modal busy while a dismissal is in flight', () => {
    mocks.dismissPending = true;
    render(<MemoryRouter><ResolveConflictOverlay /></MemoryRouter>);
    expect(screen.getByTestId('shell')).toHaveAttribute('data-busy', 'true');
  });

  it('shows imported source files and readable excerpts while preserving legacy quotations', () => {
    mocks.facts = [{ ...factA, citation: JSON.stringify({
      attachmentId: 'private-attachment-id', fileName: 'Client briefing.pptx', contentHash: 'private-content-hash',
      evidence: [
        { sourceRef: 'slide:3#part1', quote: 'The client approved the revised committee request.' },
        { sourceRef: 'slide:5#part2', quote: 'The earlier request is withdrawn.' },
      ],
    }) }, { ...factB, citation: 'Client email: Continue with the original request.' }];
    render(<MemoryRouter><ResolveConflictOverlay /></MemoryRouter>);
    expect(screen.getByText('Client briefing.pptx · Slide 3, part 1')).toBeInTheDocument();
    expect(screen.getByText('Client briefing.pptx · Slide 5, part 2')).toBeInTheDocument();
    expect(screen.getByText('The client approved the revised committee request.')).toBeInTheDocument();
    expect(screen.getByText('The earlier request is withdrawn.')).toBeInTheDocument();
    expect(screen.getByText('Client email: Continue with the original request.')).toBeInTheDocument();
    expect(screen.queryByText(/private-attachment-id|private-content-hash/)).not.toBeInTheDocument();
  });

  it('preserves unrecognized or malformed citation text without crashing', () => {
    const malformed = '{"fileName":"briefing.pdf","evidence":[null]}';
    mocks.facts = [{ ...factA, citation: malformed }, { ...factB, citation: '{incomplete citation' }];
    render(<MemoryRouter><ResolveConflictOverlay /></MemoryRouter>);
    expect(screen.getByText(malformed)).toBeInTheDocument();
    expect(screen.getByText('{incomplete citation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve conflict' })).toBeDisabled();
  });
});
