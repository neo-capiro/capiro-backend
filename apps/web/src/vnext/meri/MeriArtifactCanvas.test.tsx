import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeriArtifactCanvas } from './MeriArtifactCanvas.js';

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
    const blob = new Blob(['PK'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:word-document');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let filename: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    const getAuthHeaders = vi.fn().mockResolvedValue({ Authorization: 'Bearer test' });
    render(<MeriArtifactCanvas artifact={artifact} onClose={vi.fn()} apiBaseUrl="https://api.example.test" getAuthHeaders={getAuthHeaders} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download .docx' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledWith(blob));
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/clio/artifacts/artifact-qa-briefing/download', {
      headers: { Authorization: 'Bearer test' },
    });
    expect(filename).toBe('capiro-2-0-pdf-page-22-internal-qa-briefing.docx');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:word-document');
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

  test('renders embedded PNGs and escapes document text rather than executing HTML or remote images', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6GQAAAAASUVORK5CYII=';
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
