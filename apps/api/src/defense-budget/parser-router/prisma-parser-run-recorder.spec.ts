import type { PrismaClient } from '@prisma/client';
import { PrismaParserRunRecorder } from './prisma-parser-run-recorder.js';

function fakePrisma(input?: {
  existing?: Record<string, unknown>;
  createError?: unknown;
  conflictRow?: Record<string, unknown>;
}) {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (input?.createError) throw input.createError;
    return { id: 'parse-job-created', ...data };
  });
  const findMany = jest.fn(async () => (input?.existing ? [input.existing] : []));
  const findFirst = jest.fn(async () => input?.conflictRow ?? null);
  const update = jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  return {
    client: {
      documentParseJob: { findMany, create, findFirst, update },
    } as unknown as PrismaClient,
    create,
    findMany,
    findFirst,
    update,
  };
}

const recordInput = {
  sourceDocumentId: '00000000-0000-0000-0000-000000000001',
  method: 'deterministic_pdfplumber' as const,
  mode: 'local',
  pageStart: 1,
  pageEnd: 3,
  exactPageList: [1, 3],
  inputSha256: 'a'.repeat(64),
  outputLocator: '/shared/parser-artifacts/result.json',
  outputByteSha256: 'b'.repeat(64),
  outputContentSha256: 'c'.repeat(64),
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'd'.repeat(64),
  status: 'completed' as const,
  metrics: { pagesProcessed: 2 },
};

describe('PrismaParserRunRecorder', () => {
  it('records exact pages and both output hashes in DocumentParseJob metadata', async () => {
    const prisma = fakePrisma();
    const recorder = new PrismaParserRunRecorder(prisma.client);
    expect(await recorder.record(recordInput)).toEqual({ parseJobId: 'parse-job-created' });
    expect(prisma.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceDocumentId: recordInput.sourceDocumentId,
        provider: 'deterministic_pdfplumber',
        pageStart: 1,
        pageEnd: 3,
        inputSha256: recordInput.inputSha256,
        outputJsonS3Key: recordInput.outputLocator,
        status: 'succeeded',
        metadata: expect.objectContaining({
          exactPageList: [1, 3],
          outputByteSha256: recordInput.outputByteSha256,
          outputContentSha256: recordInput.outputContentSha256,
          parserVersion: recordInput.parserVersion,
          parserConfigSha256: recordInput.parserConfigSha256,
        }),
      }),
      select: { id: true },
    });
  });

  it('reuses an exact existing terminal parser job without creating another row', async () => {
    const first = fakePrisma();
    const firstRecorder = new PrismaParserRunRecorder(first.client);
    await firstRecorder.record(recordInput);
    const metadata = (first.create.mock.calls[0]![0].data as { metadata: Record<string, unknown> })
      .metadata;
    const existing = {
      id: 'existing-parse-job',
      status: 'succeeded',
      metadata,
    };
    const second = fakePrisma({ existing });
    const recorder = new PrismaParserRunRecorder(second.client);
    expect(await recorder.record(recordInput)).toEqual({ parseJobId: 'existing-parse-job' });
    expect(second.create).not.toHaveBeenCalled();
  });

  it('fails closed when SourceDocument or exact pages are absent', async () => {
    const prisma = fakePrisma();
    const recorder = new PrismaParserRunRecorder(prisma.client);
    await expect(recorder.record({ ...recordInput, sourceDocumentId: undefined })).rejects.toThrow(
      /sourceDocumentId/,
    );
    await expect(
      recorder.record({
        ...recordInput,
        exactPageList: [],
        pageStart: undefined,
        pageEnd: undefined,
      }),
    ).rejects.toThrow(/page set/);
  });

  it('upserts on P2002 unique conflict instead of failing the handoff retry', async () => {
    // Live canary: prior partial handoff already owns
    // (source_document_id, input_sha256, provider, page_start, page_end).
    const prisma = fakePrisma({
      createError: { code: 'P2002', meta: { target: ['source_document_id', 'input_sha256'] } },
      conflictRow: { id: 'conflict-parse-job' },
    });
    const recorder = new PrismaParserRunRecorder(prisma.client);
    expect(await recorder.record(recordInput)).toEqual({ parseJobId: 'conflict-parse-job' });
    expect(prisma.create).toHaveBeenCalled();
    expect(prisma.findFirst).toHaveBeenCalled();
    expect(prisma.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conflict-parse-job' },
        data: expect.objectContaining({
          status: 'succeeded',
          outputJsonS3Key: recordInput.outputLocator,
        }),
      }),
    );
  });

  it('rethrows non-unique create failures', async () => {
    const prisma = fakePrisma({ createError: { code: 'P2025', message: 'other' } });
    const recorder = new PrismaParserRunRecorder(prisma.client);
    await expect(recorder.record(recordInput)).rejects.toMatchObject({ code: 'P2025' });
    expect(prisma.update).not.toHaveBeenCalled();
  });
});
