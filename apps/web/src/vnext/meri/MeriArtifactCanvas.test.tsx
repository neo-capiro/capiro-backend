import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeriArtifactCanvas } from './MeriArtifactCanvas.js';
import { MeriCanvas } from '../../components/chat/MeriCanvas.js';
import { artifactDownloadResponse, VALID_GENERATED_PNG_BASE64 } from '../../test/meri-artifact-download-fixtures.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));

// The persisted WordSpec shape produced by the canonical API document service.
const wordSpec = {
  title: 'Capiro 2.0 PDF Page 22: Internal QA Briefing',
  subtitle: 'Product documentation · 7 September 2026',
  sections: [{
    heading: 'Observed statement',
    paragraphs: ['Meeting preparation uses earlier evidence. Capiro 2.0.pdf, page 22 [56].'],
    bullets: ['Read 840 characters using openai_pdf; page-only visual extraction.'],
    tables: [{ headers: ['Source', 'Page'], rows: [['Capiro 2.0.pdf [56]', '22']] }],
    imageArtifactIds: [],
    images: [],
  }, {
    heading: 'Practical implication and limitations',
    paragraphs: ['Use for internal meeting preparation. This is not a claim about L3 Harris.'],
    bullets: ['The original OCR transcription was not independently verified.'],
    tables: [],
    imageArtifactIds: [],
    images: [],
  }],
} as const;

const artifact = {
  id: 'artifact-qa-briefing',
  title: wordSpec.title,
  kind: 'word_document',
  bodyText: JSON.stringify(wordSpec),
};

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('MeriArtifactCanvas Word preview', () => {
  test.each([['workspace', MeriArtifactCanvas], ['drawer', MeriCanvas]] as const)('%s text download uses saved bytes rather than a local rewritten export', async (_surface, Canvas) => {
    const text = 'Synthetic Aster briefing v1\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { headers: {
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': '28',
      'Content-Disposition': 'attachment; filename="aster-synthetic-briefing.txt"',
      'X-Capiro-Artifact-Id': artifact.id,
      'X-Capiro-Artifact-Sha256': 'c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53',
      'X-Capiro-Artifact-Byte-Authority': 'persisted_at_creation_v1',
      'X-Capiro-Artifact-Operation-Id': '44444444-4444-4444-8444-444444444444',
    } })));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-text');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
    render(<Canvas artifact={{ ...artifact, kind: 'text_document', bodyText: 'changed local preview' }} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={async () => ({ Authorization: 'Bearer unit-user' })} />);
    fireEvent.click(screen.getByRole('button', { name: _surface === 'drawer' ? 'Download document' : 'Download .txt' }));
    await waitFor(() => expect(filenames).toEqual(['aster-synthetic-briefing.txt']));
    const blob = create.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toBe(text);
  });
  test.each([['workspace', MeriArtifactCanvas], ['drawer', MeriCanvas]] as const)('%s offers PDF and Word from one saved document without downloading its JSON spec', async (_surface, Canvas) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const mime = url.endsWith('format=pdf')
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      return artifactDownloadResponse({ mime, artifactId: artifact.id });
    });
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-document');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
    const getAuthHeaders = async () => ({ Authorization: 'Bearer current-user' });
    const view = render(<Canvas artifact={artifact} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={getAuthHeaders} />);
    fireEvent.click(screen.getByText('Download .pdf'));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/pdf' })));
    fireEvent.click(screen.getByText('Download .docx'));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })));
    expect(filenames.map((filename) => filename.split('.').pop())).toEqual(['pdf', 'docx']);
    expect(artifact.bodyText).toBe(JSON.stringify(wordSpec));
    view.unmount();
    render(<Canvas artifact={JSON.parse(JSON.stringify(artifact))} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={getAuthHeaders} />);
    fireEvent.click(screen.getByText('Download .pdf'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download?format=pdf',
      'https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download',
      'https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download?format=pdf',
    ]);
  });

  test('reopens a native PDF artifact with its readable preview and a Word alternative', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(artifactDownloadResponse({ mime: 'application/pdf', artifactId: artifact.id }))
      .mockResolvedValueOnce(artifactDownloadResponse({ artifactId: artifact.id }));
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-pdf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    render(<MeriArtifactCanvas artifact={{ ...artifact, kind: 'pdf_document' }} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={async () => ({ Authorization: 'Bearer current-user' })} />);
    expect(screen.getByRole('article', { name: 'PDF document preview' })).toHaveTextContent(wordSpec.sections[0].paragraphs[0]);
    expect(screen.getByRole('button', { name: 'Download .docx' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Download .pdf' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download');
    expect(filename).toMatch(/\.pdf$/);
    fireEvent.click(screen.getByRole('button', { name: 'Download .docx' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })));
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download?format=docx');
    expect(filename).toMatch(/\.docx$/);
  });

  test('keeps conversion failure visible, preserves the document and offers a retry or Word download', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ code: 'MERI_DOCUMENT_RENDER_FAILED' }) })
      .mockResolvedValueOnce(artifactDownloadResponse({ mime: 'application/pdf', artifactId: artifact.id }));
    vi.stubGlobal('fetch', fetchMock);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-pdf');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} getAuthHeaders={async () => ({ Authorization: 'Bearer current-user' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF conversion failed');
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Download .docx' })).toBeEnabled();
    expect(screen.getByRole('article')).toHaveTextContent(wordSpec.sections[0].paragraphs[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Download .pdf' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an unauthorized PDF download returns an access error without making a file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-exist');
    render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} getAuthHeaders={async () => ({ Authorization: 'Bearer unauthorized-user' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .pdf' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer have access');
    expect(create).not.toHaveBeenCalled();
  });

  test('renders the saved document as headings, paragraphs, lists and tables with its citations and limitations', () => {
    const view = render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} />);
    const preview = within(screen.getByRole('article', { name: 'Word document preview' }));
    expect(preview.getByRole('heading', { name: wordSpec.title, level: 1 })).toBeVisible();
    expect(preview.getByText(wordSpec.subtitle)).toBeVisible();
    expect(preview.getByRole('heading', { name: 'Observed statement', level: 2 })).toBeVisible();
    expect(preview.getByText(wordSpec.sections[0].paragraphs[0])).toBeVisible();
    expect(preview.getAllByRole('listitem')).toHaveLength(2);
    expect(preview.getByRole('cell', { name: 'Capiro 2.0.pdf [56]' })).toBeVisible();
    expect(preview.getByRole('cell', { name: '22' })).toBeVisible();
    expect(preview.getByText(wordSpec.sections[1].bullets[0])).toBeVisible();
    expect(screen.queryByText(/"paragraphs"\s*:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download .docx' })).toBeEnabled();

    // Reopening a saved artifact takes the same persisted bodyText path.
    view.unmount();
    render(<MeriArtifactCanvas artifact={JSON.parse(JSON.stringify(artifact))} onClose={vi.fn()} />);
    expect(screen.getByRole('article')).toHaveTextContent('Capiro 2.0.pdf, page 22 [56]');
  });

  test('copies readable document text, preserving tables, citations and limitations', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain(`${wordSpec.title}\n\n${wordSpec.subtitle}`);
    expect(copied).toContain('Source\tPage\nCapiro 2.0.pdf [56]\t22');
    expect(copied).toContain(`• ${wordSpec.sections[1].bullets[0]}`);
    expect(copied).not.toContain('"sections"');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  test('downloads the authenticated canonical DOCX binary without replacing its persisted spec', async () => {
    const fetchMock = vi.fn().mockResolvedValue(artifactDownloadResponse({
      artifactId: artifact.id,
      disposition: 'attachment; filename="saved-qa-briefing.docx"',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:word-document');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    const getAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer test' });
    render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={getAuthHeaders} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .docx' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })));
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download', {
      headers: { Authorization: 'Bearer test' },
      signal: expect.any(AbortSignal), cache: 'no-store', redirect: 'error',
    });
    expect(filename).toBe('saved-qa-briefing.docx');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(artifact.bodyText).toBe(JSON.stringify(wordSpec));
  });

  test('does not offer raw JSON as a Markdown download when a Word artifact has no saved identity', async () => {
    render(<MeriArtifactCanvas artifact={{ ...artifact, id: undefined }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .docx' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not available for download yet');
  });

  test.each([
    '{"title":"Unfinished","sections":[',
    JSON.stringify({ title: 'Malformed', sections: [{ heading: 'Invalid', paragraphs: { text: 'hidden' } }] }),
    JSON.stringify({ title: 'Wrong schema', sections: null }),
  ])('handles unreadable structured content without crashing or showing raw JSON: %s', (bodyText) => {
    render(<MeriArtifactCanvas artifact={{ ...artifact, bodyText }} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('This document preview is unavailable.');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download .docx' })).toBeEnabled();
    expect(screen.queryByText(bodyText)).not.toBeInTheDocument();
  });

  test.each(['word_document', 'markdown_document'])('preserves plain text artifacts for kind %s', (kind) => {
    render(<MeriArtifactCanvas artifact={{ ...artifact, kind, bodyText: 'Earlier plain-text briefing [56].' }} onClose={vi.fn()} />);
    expect(screen.getByText('Earlier plain-text briefing [56].')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('injects registered markers and strips unresolved markers only for enforce artifacts', () => {
    const citation = { n: 6, type: 'file', id: 'file-6', title: 'Evidence page 6', url: null, snippet: null, tool: 'open_file' };
    const { rerender } = render(<MeriArtifactCanvas artifact={{ kind: 'markdown_document', bodyText: 'Supported [6] and missing [53].', citations: [citation], evidenceAccuracy: 'enforce' }} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: '[6]' })).toBeVisible();
    expect(screen.queryByText(/\[53\]/)).not.toBeInTheDocument();
    rerender(<MeriArtifactCanvas artifact={{ kind: 'markdown_document', bodyText: 'Legacy [53].', citations: [citation] }} onClose={vi.fn()} />);
    expect(screen.getByText('Legacy [53].')).toBeVisible();
  });

  test('renders embedded PNGs and escapes document text rather than executing HTML or remote images', () => {
    const png = VALID_GENERATED_PNG_BASE64;
    const bodyText = JSON.stringify({
      ...wordSpec,
      sections: [{
        ...wordSpec.sections[0],
        paragraphs: ['<script>alert("test")</script>', '<img src="https://tracker.example.test/pixel">'],
        images: [{ dataBase64: png }, { dataBase64: 'https://tracker.example.test/pixel' }],
      }],
    });
    const { container } = render(<MeriArtifactCanvas artifact={{ ...artifact, bodyText }} onClose={vi.fn()} />);
    expect(screen.getByText('<script>alert("test")</script>')).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/png;base64,${png}`);
    expect(screen.getByText('This embedded chart could not be previewed. Check the Word download.')).toBeVisible();
  });
});
