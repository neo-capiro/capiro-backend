import { describeAttachmentContentState, retryAttachmentExtraction } from './meri-attachment-content-state.js';
import * as documentExtraction from './meri-attachment-document.js';

describe('describeAttachmentContentState', () => {
  test.each([
    ['parsed text', { status: 'parsed', textContent: ' readable ' }, { state: 'ready', readable: true, extractedChars: 8, limitation: null }],
    ['truncated text', { status: 'truncated', textContent: 'abc', reason: 'Only the first 40k characters are included.' }, { state: 'partial', readable: true, extractedChars: 3, limitation: 'Only the first 40k characters are included.' }],
    ['scanned PDF', { status: 'scanned', textContent: null, kind: 'pdf', pages: 12 }, { state: 'metadata_only', readable: false, extractedChars: 0, limitation: 'No extractable text; OCR is capped at 8 pages.' }],
    ['image metadata', { status: 'image_ready', textContent: null, kind: 'image' }, { state: 'metadata_only', readable: false, extractedChars: 0, limitation: 'No extractable text; OCR is capped at 8 pages.' }],
    ['unsupported', { status: 'unsupported', textContent: null, reason: 'No parser.' }, { state: 'unsupported', readable: false, extractedChars: 0, limitation: 'No parser.' }],
    ['failed', { status: 'failed', textContent: null, reason: 'retry_attempted: encrypted' }, { state: 'failed', readable: false, extractedChars: 0, limitation: 'encrypted' }],
    ['pending', { status: 'pending', textContent: null }, { state: 'pending', readable: false, extractedChars: 0, limitation: 'Document extraction is pending.' }],
    ['empty parsed result', { status: 'parsed', textContent: '  ' }, { state: 'metadata_only', readable: false, extractedChars: 0, limitation: 'No readable extracted text is available.' }],
  ])('%s', (_name, input, expected) => {
    expect(describeAttachmentContentState(input)).toEqual(expected);
  });
});

describe('retryAttachmentExtraction', () => {
  test('extracts stored bytes once and marks the row', async () => {
    const row = { id: 'attachment', kind: 'text', status: 'failed', textContent: null,
      reason: 'initial failure', pages: null, data: Buffer.from('recovered') };
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data));
    const prisma = { withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) => callback({
      clioAttachment: { findFirst: jest.fn(async () => row), update },
    })) };
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument').mockResolvedValue({
      status: 'parsed', text: 'recovered', reason: null, truncated: false, pages: null,
    });

    await expect(retryAttachmentExtraction(prisma as never, row.id, 'tenant', 'user', async () => null))
      .resolves.toMatchObject({ state: 'ready', readable: true, extractedChars: 9 });
    await retryAttachmentExtraction(prisma as never, row.id, 'tenant', 'user', async () => null);

    expect(extract).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      reason: 'retry_attempted', textContent: 'recovered', status: 'parsed',
    }) }));
  });
});
