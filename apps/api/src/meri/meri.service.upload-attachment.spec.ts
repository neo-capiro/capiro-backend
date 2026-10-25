import type { TenantContext } from '@capiro/shared';
import { MeriService, type NativeAttachmentRegistration } from './meri.service.js';
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
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null),
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
  return { service, create, prisma, rows, tx };
}

function registration(tx: ReturnType<typeof buildService>['tx'], bytes: Buffer = file.buffer): NativeAttachmentRegistration {
  return { tx: tx as unknown as NativeAttachmentRegistration['tx'],
    attachmentId: '33333333-3333-5333-a333-333333333333', beforeWrite: jest.fn(async () => {}),
    object: { objectId: '44444444-4444-4444-8444-444444444444', versionId: 'immutable-storage-version',
      sha256: sha256Bytes(bytes), bytes: bytes.length,
      scopes: [{ tenantId: TENANT, kind: 'client', resourceId: '55555555-5555-4555-8555-555555555555', policyRevision: 'policy' }] } };
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
        sha256: sha256Bytes(file.buffer),
        bytes: file.buffer.length,
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
      sha256: sha256Bytes(file.buffer),
      bytes: file.buffer.length,
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
      expect(result).not.toHaveProperty('sha256');
      expect(result).not.toHaveProperty('bytes');
      expect(result).not.toHaveProperty('contentState');
      expect(result).not.toHaveProperty('limitation');
      expect(create).not.toHaveBeenCalled();
    },
  );

  test('readable uploads add byte receipts while preserving content-state mode behavior', async () => {
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
    expect(enforced).toMatchObject({ contentState: 'ready', limitation: null,
      sha256: sha256Bytes(file.buffer), bytes: file.buffer.length });

    setAccuracyMode('off');
    extract.mockResolvedValue(extraction);
    const legacy = await buildService().service.uploadAttachment(ctx, file);
    expect(legacy).toEqual({
      id: 'attachment-1',
      sha256: sha256Bytes(file.buffer),
      bytes: file.buffer.length,
      filename: 'notes.txt',
      kind: 'text',
      status: 'parsed',
      pages: null,
      truncated: false,
      reason: null,
      chars: 15,
    });
  });

  test.each([
    ['text', Buffer.from('original source text'), 'text/plain', 'original.txt'],
    ['image', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=', 'base64'), 'image/png', 'original.png'],
  ] as const)('the %s receipt and persisted bytes survive caller mutation across awaits', async (kind, buffer, mimetype, originalname) => {
    setAccuracyMode('off');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockResolvedValue({
      status: 'parsed', text: 'original source text', pages: null, truncated: false, reason: null,
    });
    const original = Buffer.from(buffer);
    const upload = { buffer: Buffer.from(buffer), mimetype, originalname, size: 1 };
    const suppliedBuffer = upload.buffer;
    const { service, rows } = buildService();

    const pending = service.uploadAttachment(ctx, upload);
    suppliedBuffer.fill(0);
    upload.buffer = Buffer.from('replacement');
    upload.size = 999_999;
    const result = await pending;

    expect(result).toMatchObject({ id: 'attachment-1', kind,
      sha256: sha256Bytes(original), bytes: original.length });
    expect(rows[0]).toMatchObject({ tenantId: TENANT, userId: USER, messageId: null,
      filename: originalname, mediaType: mimetype, byteSize: original.length });
    expect(rows[0]!.data).toEqual(original);
    expect(rows[0]!.data).not.toBe(suppliedBuffer);
    expect(sha256Bytes(rows[0]!.data)).toBe(result.sha256);
  });

  test('document extraction cannot mutate the original bytes used by persistence and its receipt', async () => {
    setAccuracyMode('off');
    jest.spyOn(documentExtraction, 'extractMeriDocument').mockImplementation(async ({ bytes }) => {
      bytes.fill(0);
      return { status: 'parsed', text: 'extracted text', pages: null, truncated: false, reason: null };
    });
    const { service, rows } = buildService();

    const result = await service.uploadAttachment(ctx, { ...file, size: 1 });

    expect(rows[0]!.data).toEqual(file.buffer);
    expect(rows[0]!.byteSize).toBe(file.buffer.length);
    expect(result).toMatchObject({ sha256: sha256Bytes(file.buffer), bytes: file.buffer.length });
  });

  test('rejected admission keeps the null-id response without a byte receipt', async () => {
    const { service, create } = buildService();

    const result = await service.uploadAttachment(ctx, { ...file, mimetype: 'image/png' });

    expect(result).toMatchObject({ id: null, status: 'unsupported' });
    expect(result).not.toHaveProperty('sha256');
    expect(result).not.toHaveProperty('bytes');
    expect(create).not.toHaveBeenCalled();
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
      sha256: sha256Bytes(buffer),
      bytes: buffer.length,
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
      expect(result).not.toHaveProperty('sha256');
      expect(result).not.toHaveProperty('bytes');
      expect(result.reason).toContain(input.reason);
      expect(create).not.toHaveBeenCalled();
    }
  });
});

describe('MeriService.registerNativeAttachment durable raw custody', () => {
  afterEach(() => jest.restoreAllMocks());

  test('a lost acknowledgement retry reuses the original row and receipt without text extraction', async () => {
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument');
    const { service, tx, create, rows, prisma } = buildService();
    const internal = registration(tx);
    const first = await service.registerNativeAttachment(ctx, { ...file, size: 1 }, internal);
    const retried = await service.registerNativeAttachment(ctx, { ...file, originalname: 'renamed.md', mimetype: 'text/markdown' }, registration(tx));

    expect(retried).toEqual(first);
    expect(first).toMatchObject({ id: internal.attachmentId, filename: file.originalname, status: 'pending',
      sha256: sha256Bytes(file.buffer), bytes: file.buffer.length, pages: null, truncated: false, chars: 0,
      reason: 'Original file registered for approved filing; text extraction was not run.' });
    expect(rows[0]).toMatchObject({ tenantId: TENANT, userId: USER, messageId: null,
      data: file.buffer, byteSize: file.buffer.length, mediaType: 'text/plain', textContent: null });
    expect(create).toHaveBeenCalledTimes(1);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(tx.clioAttachment.deleteMany).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });

  test('keeps the original byte snapshot while approval checks await', async () => {
    const { service, tx, rows } = buildService();
    const original = Buffer.from(file.buffer), upload = { ...file, buffer: Buffer.from(file.buffer), size: 1 };
    const internal = registration(tx, original);
    internal.beforeWrite = jest.fn(async () => { upload.buffer.fill(0); upload.buffer = Buffer.from('replacement'); });
    const result = await service.registerNativeAttachment(ctx, upload, internal);
    expect(rows[0]!.data).toEqual(original);
    expect(result).toMatchObject({ sha256: sha256Bytes(original), bytes: original.length });
  });

  test.each(['sha256', 'bytes'] as const)('rejects an approved %s mismatch before database effects', async field => {
    const { service, tx, create } = buildService();
    const internal = registration(tx);
    if (field === 'sha256') internal.object.sha256 = 'b'.repeat(64);
    else internal.object.bytes += 1;
    await expect(service.registerNativeAttachment(ctx, file, internal)).rejects.toThrow('does not match the approved object');
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ['tenantId', 'another-tenant'], ['userId', 'another-user'], ['messageId', 'live-message'],
    ['byteSize', 1], ['data', Buffer.from('different bytes')], ['data', null],
    ['mediaType', 'application/pdf'], ['kind', 'pdf'],
  ])('refuses a retained row with mismatched %s', async (field, value) => {
    const { service, tx, rows, create } = buildService();
    await service.registerNativeAttachment(ctx, file, registration(tx));
    rows[0]![field] = value;
    await expect(service.registerNativeAttachment(ctx, file, registration(tx))).rejects.toThrow('retained upload does not match');
    expect(create).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('checks authority before returning or creating a row (existing=%s)', async existing => {
    const { service, tx, create } = buildService();
    if (existing) await service.registerNativeAttachment(ctx, file, registration(tx));
    const internal = registration(tx);
    internal.beforeWrite = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('approval revoked'));
    await expect(service.registerNativeAttachment(ctx, file, internal)).rejects.toThrow('approval revoked');
    expect(create).toHaveBeenCalledTimes(existing ? 1 : 0);
  });

  test('validates XLSX locally and registers pending without invoking extraction or OCR', async () => {
    const buffer = await makeWorkbook(workbook => { workbook.addWorksheet('Original').getCell('A1').value = 'original'; });
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument');
    const { service, tx, rows } = buildService();
    const internal = registration(tx, buffer);
    const result = await service.registerNativeAttachment(ctx,
      { buffer, mimetype: XLSX_MIME, originalname: 'original.xlsx', size: 1 }, internal);
    expect(result).toMatchObject({ id: internal.attachmentId, kind: 'xlsx', status: 'pending', sha256: sha256Bytes(buffer), bytes: buffer.length });
    expect(rows[0]!.data).toEqual(buffer);
    expect(internal.beforeWrite).toHaveBeenCalledTimes(3);
    expect(extract).not.toHaveBeenCalled();
  });

  test('checks authority again after asynchronous XLSX package validation', async () => {
    const buffer = await makeWorkbook(workbook => { workbook.addWorksheet('Original').getCell('A1').value = 'original'; });
    const { service, tx, create } = buildService();
    const internal = registration(tx, buffer);
    internal.beforeWrite = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('approval expired'));
    await expect(service.registerNativeAttachment(ctx,
      { buffer, mimetype: XLSX_MIME, originalname: 'original.xlsx', size: buffer.length }, internal)).rejects.toThrow('approval expired');
    expect(tx.clioAttachment.findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('rejects invalid admission and macro workbooks before storing raw custody', async () => {
    const macro = await new JSZip().file('[Content_Types].xml', '<Types/>').file('xl/vbaProject.bin', 'macro')
      .generateAsync({ type: 'nodebuffer' });
    const cases = [
      { buffer: Buffer.alloc(10 * 1024 * 1024 + 1), mimetype: 'text/plain', originalname: 'oversized.txt', size: 1 },
      { ...file, mimetype: 'application/pdf', originalname: 'spoofed.pdf' },
      { buffer: macro, mimetype: XLSX_MIME, originalname: 'macro.xlsx', size: macro.length },
    ];
    for (const upload of cases) {
      const { service, tx, create } = buildService();
      await expect(service.registerNativeAttachment(ctx, upload, registration(tx, upload.buffer))).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    }
  });

  test('a swept staging row can be recreated at the same ID without external extraction', async () => {
    const extract = jest.spyOn(documentExtraction, 'extractMeriDocument');
    const { service, tx, rows } = buildService();
    const first = await service.registerNativeAttachment(ctx, file, registration(tx));
    rows.splice(0, rows.length);
    const recreated = await service.registerNativeAttachment(ctx, file, registration(tx));
    expect(recreated).toEqual(first);
    expect(rows).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
  });
});
