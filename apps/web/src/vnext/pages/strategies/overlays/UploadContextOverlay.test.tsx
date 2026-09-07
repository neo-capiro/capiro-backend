import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadContextOverlay } from './UploadContextOverlay.js';

const mocks = vi.hoisted(() => ({
  api: {}, upload: vi.fn(), resolve: vi.fn(), analyze: vi.fn(), save: vi.fn(),
  invalidate: vi.fn(), navigate: vi.fn(),
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }));
vi.mock('react-router-dom', async () => ({ ...await vi.importActual('react-router-dom'), useNavigate: () => mocks.navigate }));
vi.mock('../strategies-api.js', () => ({
  useClientsLite: () => ({ data: [{ id: 'client-one', name: 'First client' }, { id: 'client-two', name: 'Second client' }] }),
  useStrategies: () => ({ data: [{ id: 'strategy-one', clientId: 'client-one', title: 'First strategy' }, { id: 'strategy-two', clientId: 'client-two', title: 'Second strategy' }] }),
}));
vi.mock('../context/context-import-api.js', async () => ({
  ...await vi.importActual('../context/context-import-api.js'),
  uploadContextSource: (...args: unknown[]) => mocks.upload(...args),
  resolveContextImport: (...args: unknown[]) => mocks.resolve(...args),
  analyzeContextImport: (...args: unknown[]) => mocks.analyze(...args),
  saveContextImport: (...args: unknown[]) => mocks.save(...args),
}));
vi.mock('./StrategiesModalShell.js', () => ({
  StrategiesModalShell: ({ children, title, onPrimary, primaryDisabled, primaryLabel, primaryBusy, dirty }: any) => (
    <div data-testid="shell" data-busy={String(Boolean(primaryBusy))} data-dirty={String(Boolean(dirty))}>
      <h2>{title}</h2>{children}<button disabled={primaryDisabled || primaryBusy} onClick={onPrimary}>{primaryLabel}</button>
    </div>
  ),
}));

const source = { attachmentId: 'attachment-one', fileName: 'briefing.docx', contentHash: 'source-hash' };
function preview(token = 'preview-one', id = 'document-one', title = 'Client objective') {
  return { token, source, warnings: [], documents: [{ id, documentType: 'strategy_brief', title,
    sections: [{ heading: 'Objective', content: 'Secure a committee briefing.', evidence: [{ sourceRef: 'page:2', quote: 'Request a committee briefing.' }] }],
  }] };
}
function attach(names = ['briefing.docx']) {
  fireEvent.change(screen.getByLabelText('Choose context files'), { target: { files: names.map((name) => new File(['source material'], name)) } });
}
function setup() {
  const result = render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-one' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Use this information for' }), { target: { value: 'strategy-one' } });
  return result;
}
async function read() {
  fireEvent.click(screen.getByRole('button', { name: 'Read and organize files' }));
  await screen.findByRole('heading', { name: 'Review what Meri found' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upload.mockReset().mockResolvedValue({ id: 'attachment-one' });
  mocks.resolve.mockReset().mockResolvedValue({ source, chunks: [{ token: 'chunk-one', index: 0 }], warnings: [] });
  mocks.analyze.mockReset().mockResolvedValue(preview());
  mocks.save.mockReset().mockResolvedValue({ documents: [{ id: 'saved-one', title: 'Client objective', templateKey: '01_strategy_brief' }], warnings: [] });
  mocks.invalidate.mockResolvedValue(undefined);
});

describe('Everyday document import', () => {
  it('explains all 14 areas, accepts several files, and requires a real client', () => {
    render(<MemoryRouter><UploadContextOverlay /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Read and organize files' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: /frontmatter/i })).not.toBeInTheDocument();
    expect(screen.getByText('One file can cover several areas.')).toBeInTheDocument();
    const guide = screen.getByText('What can these files contain?');
    fireEvent.click(guide);
    expect(guide.parentElement?.querySelectorAll('section')).toHaveLength(14);
    attach(['briefing.docx', 'firm-blueprint.pptx']);
    expect(screen.getByText('briefing.docx')).toBeInTheDocument();
    expect(screen.getByText('firm-blueprint.pptx')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read and organize files' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-one' } });
    expect(screen.getByRole('button', { name: 'Read and organize files' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove briefing.docx' }));
    expect(screen.queryByText('briefing.docx')).not.toBeInTheDocument();
  });

  it('uploads once, reviews cited information, and saves only the selected categories', async () => {
    const result = preview();
    result.documents.push({ ...result.documents[0]!, id: 'document-two', title: 'Alternative ask', documentType: 'ask_and_options' });
    mocks.analyze.mockResolvedValue(result);
    setup(); attach(); await read();
    expect(mocks.upload).toHaveBeenCalledWith(mocks.api, expect.any(File), 'client-one');
    expect(mocks.resolve).toHaveBeenCalledWith(mocks.api, { attachmentId: 'attachment-one', clientId: 'client-one', strategyId: 'strategy-one' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getAllByText('briefing.docx · Page 2')).toHaveLength(2);
    fireEvent.click(screen.getByRole('checkbox', { name: /Alternative ask/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    await screen.findByRole('button', { name: 'Back to library' });
    expect(mocks.save).toHaveBeenCalledWith(mocks.api, 'preview-one', ['document-one']);
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['strategy', 'context-documents'] });
    expect(screen.getByTestId('shell')).toHaveAttribute('data-dirty', 'false');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('does not resave successful files after a partial save failure', async () => {
    mocks.resolve.mockResolvedValue({ source, chunks: [{ token: 'chunk-one', index: 0 }, { token: 'chunk-two', index: 1 }], warnings: [] });
    mocks.analyze.mockResolvedValueOnce(preview()).mockResolvedValueOnce(preview('preview-two', 'document-two', 'Constraints'));
    mocks.save.mockResolvedValueOnce({ documents: [{ id: 'saved-one' }], warnings: [] }).mockRejectedValueOnce(new Error('Please try again.'))
      .mockResolvedValueOnce({ documents: [{ id: 'saved-two' }], warnings: [] });
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 selected items' }));
    await screen.findByText(/Some information could not be saved/);
    expect(screen.queryByRole('button', { name: 'Back to library' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    await screen.findByRole('button', { name: 'Back to library' });
    expect(mocks.save.mock.calls.map((call) => call[1])).toEqual(['preview-one', 'preview-two', 'preview-two']);
  });

  it('retries only failed analysis sections and keeps earlier reviewed selections', async () => {
    mocks.resolve.mockResolvedValue({ source, chunks: [{ token: 'chunk-one', index: 0 }, { token: 'chunk-two', index: 1 }], warnings: [] });
    mocks.analyze.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('Temporary reading failure.'))
      .mockResolvedValueOnce(preview('preview-two', 'document-two', 'Constraints'));
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('checkbox', { name: /Client objective/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry file' }));
    await screen.findByRole('checkbox', { name: /Constraints/ });
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).not.toBeChecked();
    expect(mocks.analyze.mock.calls.map((call) => call[1])).toEqual(['chunk-one', 'chunk-two', 'chunk-two']);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it('clears prior scope and analysis when returning to choose a different client', async () => {
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('button', { name: 'Back to files and client selection' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-two' } });
    expect(screen.getByRole('combobox', { name: 'Use this information for' })).toHaveValue('');
    expect(screen.queryByRole('option', { name: 'First strategy' })).not.toBeInTheDocument();
    expect(screen.queryByText('Client objective')).not.toBeInTheDocument();
    await read();
    expect(mocks.upload).toHaveBeenLastCalledWith(mocks.api, expect.any(File), 'client-two');
    expect(mocks.resolve).toHaveBeenLastCalledWith(mocks.api, { attachmentId: 'attachment-one', clientId: 'client-two' });
  });

  it('prevents concurrent reads, scope changes, and saves while a request is running', async () => {
    let finish!: (value: unknown) => void;
    mocks.analyze.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    setup(); attach();
    fireEvent.click(screen.getByRole('button', { name: 'Read and organize files' }));
    await waitFor(() => expect(mocks.analyze).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('combobox', { name: 'Client' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reading files…' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: 'client-two' } });
    await act(async () => finish(preview()));
    await screen.findByRole('heading', { name: 'Review what Meri found' });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    let finishSave!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await act(async () => finishSave({ documents: [{ id: 'saved-one' }], warnings: [] }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('keeps failed files visible when another file is saved', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('Unable to upload source.')).mockResolvedValueOnce({ id: 'attachment-two' });
    setup(); attach(['bad.pdf', 'good.docx']); await read();
    expect(screen.getByText('Unable to upload source.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    await screen.findByText(/1 item was added to your context/);
    expect(screen.getByRole('button', { name: 'Retry file' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Back to library' })).not.toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('rejects an unsupported file honestly and keeps the 10-file limit', () => {
    setup(); attach(['archive.zip']);
    expect(screen.getByText(/We cannot read this format yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read and organize files' })).toBeDisabled();
    attach(Array.from({ length: 12 }, (_, index) => `notes-${index}.txt`));
    expect(screen.getByRole('list', { name: 'Files to organize' }).children).toHaveLength(10);
    expect(screen.getByText(/You can add up to 10 files/)).toBeInTheDocument();
  });

  it('does not show completion if the server did not confirm every selected item', async () => {
    mocks.save.mockResolvedValueOnce({ documents: [], warnings: [] });
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    await screen.findByText(/The server did not confirm all selected information/);
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Back to library' })).not.toBeInTheDocument();
  });

  it('keeps previous analysis when adding a file without changing the client or strategy', async () => {
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('checkbox', { name: /Client objective/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to files and client selection' }));
    attach(['meeting-notes.txt']);
    mocks.analyze.mockResolvedValueOnce(preview('second-preview', 'second-document', 'Meeting commitments'));
    await read();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.analyze).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Meeting commitments/ })).toBeChecked();
  });

  it.each(['CONTEXT_IMPORT_EXPIRED', 'CONTEXT_IMPORT_SOURCE_CHANGED'])('refreshes %s reviews without losing previously saved context', async (code) => {
    mocks.resolve.mockResolvedValue({ source, chunks: [{ token: 'chunk-one', index: 0 }, { token: 'chunk-two', index: 1 }], warnings: [] });
    mocks.analyze.mockResolvedValueOnce(preview()).mockResolvedValueOnce(preview('preview-two', 'document-two', 'Constraints'));
    mocks.save.mockResolvedValueOnce({ documents: [{ id: 'saved-one' }], warnings: [] }).mockRejectedValueOnce({ response: { status: 409, data: { code, message: 'Read the source again.' } } });
    setup(); attach(); await read();
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 selected items' }));
    await screen.findByRole('button', { name: 'Read this file again' });
    expect(screen.getByRole('button', { name: 'Add 0 selected items' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).toBeDisabled();
    mocks.analyze.mockResolvedValueOnce(preview('fresh-one')).mockResolvedValueOnce(preview('fresh-two', 'document-two', 'Updated constraints'));
    fireEvent.click(screen.getByRole('button', { name: 'Read this file again' }));
    await screen.findByRole('checkbox', { name: /Updated constraints/ });
    expect(screen.getByRole('checkbox', { name: /Updated constraints/ })).not.toBeChecked();
    expect(screen.getAllByRole('checkbox', { name: /Client objective/ })).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /Client objective/ })).toBeDisabled();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    mocks.save.mockResolvedValueOnce({ documents: [{ id: 'saved-two' }], warnings: [] });
    fireEvent.click(screen.getByRole('checkbox', { name: /Updated constraints/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 selected item' }));
    await screen.findByText(/1 item was added to your context/);
    expect(mocks.save).toHaveBeenLastCalledWith(mocks.api, 'fresh-two', ['document-two']);
  });
});
