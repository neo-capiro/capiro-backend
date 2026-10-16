import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import * as documentExtraction from './meri-attachment-document.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { authorizedAttachmentSources } from './meri-attachment-continuity.js';
import { formatAttachmentContext } from './meri-attachment.helpers.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;
const file = {
  buffer: Buffer.from('attachment text'),
  mimetype: 'text/plain',
  originalname: 'notes.txt',
  size: 15,
};
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const accuracyKeys = [
  'MERI_EVIDENCE_ACCURACY_MODE',
  'MERI_EVIDENCE_ACCURACY_TENANTS',
  'MERI_EVIDENCE_ACCURACY_SURFACES',
] as const;

function buildService() {
  let nextId = 0;
  const rows: Array<Record<string, any>> = [];
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `attachment-${++nextId}`, messageId: null, createdAt: new Date(), ...data };
    rows.push(row);
    return row;
  });
  const tx = {
    clioAttachment: {
      create,
      deleteMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async ({ where }: { where: { id?: { in?: string[] } } }) =>
        rows.filter((row) => !where.id?.in || where.id.in.includes(row.id)),
      ),
    },
    clioMessage: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new MeriService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { resolveProvider: jest.fn(async () => null) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, create, prisma, rows };
}

async function makeWorkbook(build: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function setAccuracyMode(mode: 'off' | 'enforce') {
  process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
  process.env.MERI_EVIDENCE_ACCURACY_TENANTS = TENANT;
  process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'chat';
}

describe('MeriService.uploadAttachment content-state persistence', () => {
  const previousEnv = Object.fromEntries(accuracyKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of accuracyKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test.each([
    ['scanned', 'No text layer was found.', 'metadata_only'],
    ['unsupported', 'No parser is available.', 'unsupported'],
  ] as const)(
    'enforce persists %s extraction with bytes and limitation',
    async (status, reason, contentState) => {
      setAccuracyMode('enforce');
      jest.spyOn(documentExtraction, 'extractMeriDocument').mockResolvedValue({
        status,
        text: null,
        pages: status === 'scanned' ? 2 : null,
        truncated: false,
        reason,
      });
      const { service, create } = buildService();

      const result = await service.uploadAttachment(ctx, file);

      expect(result).toMatchObject({
        id: 'attachment-1',
        status,
        contentState,
        limitation: reason,
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status,
            reason,
            textContent: null,
            data: file.buffer,
          }),
        }),
      );
    },
  );

  test('enforce persists extraction failures with bytes and an explicit failed state', async () => {
    setAccuracyMode('enforce');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockRejectedValue(new Error('encrypted'));
    const { service, create } = buildService();

    const result = await service.uploadAttachment(ctx, file);

    expect(result).toMatchObject({
      id: 'attachment-1',
      status: 'failed',
      contentState: 'failed',
      limitation: expect.stringContaining('Could not read this document'),
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          reason: expect.stringContaining('Could not read this document'),
          textContent: null,
          data: file.buffer,
        }),
      }),
    );
  });

  test.each([
    [
      'scanned result',
      async () => ({
        status: 'scanned' as const,
        text: null,
        pages: 2,
        truncated: false,
        reason: 'No text layer was found.',
      }),
    ],
    [
      'unsupported result',
      async () => ({
        status: 'unsupported' as const,
        text: null,
        pages: null,
        truncated: false,
        reason: 'No parser is available.',
      }),
    ],
    [
      'thrown extraction',
      async () => {
        throw new Error('encrypted');
      },
    ],
  ])(
    'off preserves the legacy null-id response and creates no row for a %s',
    async (_name, extraction) => {
      setAccuracyMode('off');
      jest.spyOn(documentExtraction, 'extractMeriDocument').mockImplementation(extraction);
      const { service, create } = buildService();

      const result = await service.uploadAttachment(ctx, file);

      expect(result.id).toBeNull();
      expect(result).not.toHaveProperty('contentState');
      expect(result).not.toHaveProperty('limitation');
      expect(create).not.toHaveBeenCalled();
    },
  );

  test('readable enforce response is ready while off deep-equals the pre-content-state shape', async () => {
    const extraction = {
      status: 'parsed' as const,
      text: 'attachment text',
      pages: null,
      truncated: false,
      reason: null,
    };
    const extract = jest
      .spyOn(documentExtraction, 'extractMeriDocument')
      .mockResolvedValue(extraction);
    setAccuracyMode('enforce');
    const enforced = await buildService().service.uploadAttachment(ctx, file);
    expect(enforced).toMatchObject({ contentState: 'ready', limitation: null });

    setAccuracyMode('off');
    extract.mockResolvedValue(extraction);
    const legacy = await buildService().service.uploadAttachment(ctx, file);
    expect(legacy).toEqual({
      id: 'attachment-1',
      filename: 'notes.txt',
      kind: 'text',
      status: 'parsed',
      pages: null,
      truncated: false,
      reason: null,
      chars: 15,
    });
  });

  test('actual XLSX upload persists source bytes and exact extraction for authorized next-turn continuity', async () => {
    setAccuracyMode('enforce');
    const buffer = await makeWorkbook((workbook) => {
      const budget = workbook.addWorksheet('Budget');
      budget.getCell('A1').value = 'Program';
      budget.getCell('C4').value = 'Falcon';
      budget.getCell('D4').value = { formula: 'SUM(20,22)', result: 42 };
      budget.getCell('E4').value = new Date('2027-01-15T00:00:00.000Z');
      const hidden = workbook.addWorksheet('Hidden Assumptions', { state: 'hidden' });
      hidden.getCell('B2').value = 'Draft only';
      workbook.addWorksheet('Empty');
    });
    const upload = {
      buffer,
      mimetype: XLSX_MIME,
      originalname: 'FY27 budget.xlsx',
      size: buffer.length,
    };
    const { service, prisma, rows } = buildService();

    const result = await service.uploadAttachment(ctx, upload);

    expect(result).toMatchObject({
      id: 'attachment-1',
      kind: 'xlsx',
      status: 'parsed',
      contentState: 'ready',
    });
    const persisted = rows[0]!;
    expect(persisted).toMatchObject({
      kind: 'xlsx',
      mediaType: XLSX_MIME,
      byteSize: buffer.length,
      pages: null,
      textContent: expect.stringContaining('\'Budget\'!C4 = "Falcon"'),
    });
    expect(Buffer.from(persisted.data)).toEqual(buffer);
    expect(sha256Bytes(Buffer.from(persisted.data))).toBe(sha256Bytes(buffer));
    expect(persisted.textContent).toContain(`Source SHA-256: ${sha256Bytes(buffer)}`);

    persisted.messageId = 'message-1';
    const nextTurn = await authorizedAttachmentSources(
      prisma as never,
      ctx,
      'conversation-1',
      [result.id!],
      ['message-1'],
    );
    expect(nextTurn).toHaveLength(1);
    const context = formatAttachmentContext(
      nextTurn[0]!.filename,
      nextTurn[0]!.textContent!,
      undefined,
      nextTurn[0]!,
      'ready',
    );
    expect(context).toContain(
      '\'Budget\'!D4 = "42" (saved cached formula result; not recalculated)',
    );
    expect(context).toContain(`Source SHA-256: ${sha256Bytes(buffer)}`);
    expect(context).toContain('\'Budget\'!E4 = "2027-01-15"');
    expect(context).toContain('Worksheet 2: "Hidden Assumptions" (hidden)');
    expect(context).toContain('\'Hidden Assumptions\'!B2 = "Draft only"');
    expect(context).toContain('Worksheet 3: "Empty" (visible)\n[no non-empty cells]');

    const replacement = await makeWorkbook((workbook) => {
      workbook.addWorksheet('Replacement').getCell('A1').value = 'REPLACED-TEXT';
    });
    expect(sha256Bytes(replacement)).not.toBe(sha256Bytes(buffer));
    persisted.data = replacement;
    await expect(
      authorizedAttachmentSources(
        prisma as never,
        ctx,
        'conversation-1',
        [result.id!],
        ['message-1'],
      ),
    ).resolves.toEqual([]);

    persisted.data = null;
    await expect(
      authorizedAttachmentSources(
        prisma as never,
        ctx,
        'conversation-1',
        [result.id!],
        ['message-1'],
      ),
    ).resolves.toEqual([]);

    const mismatched = Buffer.from(buffer);
    mismatched[mismatched.length - 1] = mismatched[mismatched.length - 1]! ^ 1;
    persisted.data = mismatched;
    await expect(
      authorizedAttachmentSources(
        prisma as never,
        ctx,
        'conversation-1',
        [result.id!],
        ['message-1'],
      ),
    ).resolves.toEqual([]);
  });

  test('XLSX admission rejects damaged ZIPs, wrong roots, and macro content before persistence', async () => {
    setAccuracyMode('enforce');
    const valid = await makeWorkbook((workbook) => {
      workbook.addWorksheet('Data').getCell('A1').value = 'safe';
    });
    const wrongRoot = await new JSZip()
      .file('[Content_Types].xml', '<Types/>')
      .file('_rels/.rels', '<Relationships/>')
      .file('word/document.xml', '<document/>')
      .generateAsync({ type: 'nodebuffer' });
    const macro = await JSZip.loadAsync(valid);
    macro.file('xl/vbaProject.bin', Buffer.from('never execute'));
    const inputs = [
      { bytes: valid.subarray(0, valid.length - 30), reason: 'valid Excel' },
      { bytes: wrongRoot, reason: 'valid Excel' },
      { bytes: await macro.generateAsync({ type: 'nodebuffer' }), reason: 'Macro-enabled' },
    ];

    for (const input of inputs) {
      const { service, create } = buildService();
      const result = await service.uploadAttachment(ctx, {
        buffer: input.bytes,
        mimetype: XLSX_MIME,
        originalname: 'unsafe.xlsx',
        size: input.bytes.length,
      });
      expect(result).toMatchObject({ id: null, kind: 'xlsx', status: 'unsupported' });
      expect(result.reason).toContain(input.reason);
      expect(create).not.toHaveBeenCalled();
    }
  });
});
