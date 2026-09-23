import {
  briefToMemoDocInput,
  HearingBriefExportService,
  htmlToParagraphs,
  sourceToMemoSource,
} from './hearing-brief-export.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

describe('htmlToParagraphs', () => {
  it('turns paragraphs, list items and <br> into separate plain-text lines', () => {
    expect(
      htmlToParagraphs('<p>First line.</p><ul><li>One</li><li>Two</li></ul><p>Last<br>line.</p>'),
    ).toEqual(['First line.', 'One', 'Two', 'Last', 'line.']);
  });

  it('decodes entities and strips inline tags', () => {
    expect(htmlToParagraphs('<p>Fish &amp; chips &mdash; <strong>bold</strong> text</p>')).toEqual([
      'Fish & chips — bold text',
    ]);
  });

  it('drops blank lines and handles empty input', () => {
    expect(htmlToParagraphs('<p></p><p>  </p>')).toEqual([]);
    expect(htmlToParagraphs('')).toEqual([]);
  });
});

describe('sourceToMemoSource', () => {
  it('maps each known kind to a label, with a url when the record carries one', () => {
    expect(sourceToMemoSource({ kind: 'official_page', url: 'https://x' })).toEqual({
      label: 'Official hearing page',
      url: 'https://x',
    });
    expect(sourceToMemoSource({ kind: 'hearing', path: '/legiwatch/hearings/h1' })).toEqual({
      label: 'Hearing detail',
      url: '/legiwatch/hearings/h1',
    });
    expect(sourceToMemoSource({ kind: 'intelligence_finding', segmentId: 's1' })).toEqual({
      label: 'Intelligence finding referenced in this brief',
      url: null,
    });
    expect(sourceToMemoSource({ kind: 'model_cited', label: 'Official page' })).toEqual({
      label: 'Official page',
      url: null,
    });
  });

  it('falls back to a generic label for an unrecognized kind', () => {
    expect(sourceToMemoSource({ kind: 'mystery' })).toEqual({ label: 'mystery', url: null });
    expect(sourceToMemoSource({})).toEqual({ label: 'Source', url: null });
  });

  it('never lets a non-string url/path through for official_page or hearing', () => {
    expect(sourceToMemoSource({ kind: 'official_page', url: ['not', 'a', 'string'] })).toEqual({
      label: 'Official hearing page',
      url: null,
    });
    expect(sourceToMemoSource({ kind: 'hearing', path: { nested: true } })).toEqual({
      label: 'Hearing detail',
      url: null,
    });
  });
});

describe('briefToMemoDocInput', () => {
  it('shapes the brief into a MemoDocInput, defaulting the client name', () => {
    const memo = briefToMemoDocInput({
      title: 'Defense posture hearing recap',
      mode: 'recap',
      sections: [{ name: 'Executive summary', content: '<p>Short summary.</p>' }],
      sources: [{ kind: 'model_cited', label: 'Official page' }],
    });
    expect(memo.clientName).toBe('All Clients');
    expect(memo.reLine).toBe('Defense posture hearing recap');
    expect(memo.sections).toEqual([
      { heading: 'Executive summary', paragraphs: ['Short summary.'] },
    ]);
    expect(memo.sources).toEqual([{ label: 'Official page', url: null }]);
  });

  it('uses the given client name when present', () => {
    const memo = briefToMemoDocInput({
      title: 'x',
      mode: 'preparation',
      sections: [],
      clientName: 'Acme Aerospace',
    });
    expect(memo.clientName).toBe('Acme Aerospace');
  });

  it('placeholders a section whose content has no renderable text, instead of dropping it', () => {
    const memo = briefToMemoDocInput({
      title: 'x',
      mode: 'preparation',
      sections: [
        { name: 'Members to watch', content: '' },
        { name: 'Empty tags only', content: '<p></p><p>   </p>' },
      ],
    });
    expect(memo.sections).toEqual([
      { heading: 'Members to watch', paragraphs: ['This section had no content.'] },
      { heading: 'Empty tags only', paragraphs: ['This section had no content.'] },
    ]);
  });
});

describe('HearingBriefExportService', () => {
  function harness() {
    const clientDocuments = {
      createAttachmentFromBuffer: jest.fn(async () => ({
        id: 'attachment-1',
        fileName: 'defense-posture-hearing-recap.docx',
        s3Key: 'k',
      })),
    };
    const service = new HearingBriefExportService(clientDocuments as never);
    return { service, clientDocuments };
  }

  const input = {
    title: 'Defense posture hearing recap',
    mode: 'recap' as const,
    sections: [{ name: 'Executive summary', content: '<p>Short summary.</p>' }],
    sources: [],
    clientName: 'Acme Aerospace',
  };

  it('renders a non-empty docx buffer and a safe filename', async () => {
    const { service } = harness();
    const file = await service.exportDocx(input);
    expect(file.buffer.byteLength).toBeGreaterThan(0);
    expect(file.fileName).toBe('defense-posture-hearing-recap.docx');
  });

  it('saves the rendered docx to the client via the governed writer, with hearing provenance', async () => {
    const { service, clientDocuments } = harness();
    const result = await service.saveToClient(ctx, 'hearing-1', { ...input, clientId: 'client-1' });
    expect(clientDocuments.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        fileName: 'defense-posture-hearing-recap.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'legiwatch_hearing_brief',
        sourceEntityType: 'hearing_session',
        sourceEntityId: 'hearing-1',
        idempotencyKey: 'legiwatch-hearing-brief:hearing-1',
      }),
    );
    expect(result).toEqual({ attachmentId: 'attachment-1', fileName: 'defense-posture-hearing-recap.docx' });
  });
});
