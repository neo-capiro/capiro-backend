import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadContextOverlay } from './UploadContextOverlay.js';
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

function content(state = 'active', scope = 'client', client = 'client-one', extra = '') {
  return `---\ndocument_type: strategy_brief\nschema_version: "1.0"\nstate: ${state}\nscope: ${scope}\nclient_id: ${client}\nauthority: client_approved\nconfidentiality: client_confidential\nsource_of_truth: true\nas_of: 2026-09-01\n${extra}---\n# Updated source\nEvidence`;
}
function paste(text: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'Paste' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Document · Required' }), { target: { value: text } });
}
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
  it('previews only the one matching active supersession target', () => {
    render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
    paste(content());
    expect(screen.getByText('Same client source')).toBeInTheDocument();
    expect(screen.queryByText('Other client source')).not.toBeInTheDocument();
    expect(screen.queryByText('Draft source')).not.toBeInTheDocument();
    expect(screen.getByText(/supersedes 1 existing/)).toBeInTheDocument();
  });

  it('never says a draft upload retires live documents', () => {
    render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
    paste(content('draft'));
    expect(screen.getByText('This upload is not active and will not supersede an existing document.')).toBeInTheDocument();
    expect(screen.queryByText('Same client source')).not.toBeInTheDocument();
  });

  it('keeps the selected client and submitted front matter identical', () => {
    render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
    paste(content());
    expect(screen.getByRole('combobox', { name: 'Client · Optional' })).toHaveValue('client-one');
    fireEvent.change(screen.getByRole('combobox', { name: 'Client · Optional' }), { target: { value: 'client-two' } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload document' }));
    expect(mocks.upload).toHaveBeenCalledWith({ content: expect.stringContaining('client_id: client-two'), clientId: 'client-two' }, expect.any(Object));
  });

  it('does not let a slower previous file read overwrite the most recently chosen file', async () => {
    let resolveFirst!: (text: string) => void;
    const first = { name: 'first.md', size: 100, text: () => new Promise<string>((resolve) => { resolveFirst = resolve; }), arrayBuffer: () => Promise.reject(new Error('unavailable')) };
    const second = { name: 'second.md', size: 100, text: () => Promise.resolve(content('draft')), arrayBuffer: () => Promise.reject(new Error('unavailable')) };
    const view = render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
    const input = view.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [first] } });
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeDisabled();
    fireEvent.change(input, { target: { files: [second] } });
    await waitFor(() => expect(screen.getByText('This upload is not active and will not supersede an existing document.')).toBeInTheDocument());
    await act(async () => resolveFirst(content('active')));
    expect(screen.getByText('second.md')).toBeInTheDocument();
    expect(screen.getByText('This upload is not active and will not supersede an existing document.')).toBeInTheDocument();
    expect(screen.getByText(/Hash unavailable/)).toBeInTheDocument();
  });

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
});
