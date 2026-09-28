import { PDFDocument, StandardFonts } from 'pdf-lib';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { MeriChatAttachmentReadService } from './meri-chat-attachment-read.service.js';
import { withMeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';
import { withMeriToolExecutionControl } from './meri-tool-request-control.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const VERSION = new Date('2026-09-28T12:00:00.000Z');
const CURSOR_PREFIX_FOR_TEST = 'chat-attachment:v1:';
const uuid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;

interface MessageRow {
  id: string;
  conversationId: string;
  tenantId: string;
  userId: string;
  clientId: string | null;
  role: string;
  metadata: { attachments: Array<{ id: string; filename: string; kind: string; status: string }> };
  createdAt: Date;
}

interface AttachmentRow {
  id: string;
  tenantId: string;
  userId: string;
  messageId: string;
  filename: string;
  kind: string;
  status: string;
  reason: string | null;
  mediaType: string;
  byteSize: number;
  pages: number | null;
  data: Buffer | null;
  createdAt: Date;
}

async function pdf(pages: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pages; page += 1) {
    const value = document.addPage([612, 792]);
    value.drawText(`Literal page ${page} evidence marker P-${page}`, { x: 50, y: 700, font, size: 14 });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function largePagePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 30_000]);
  for (let index = 0; index < 490; index += 1) {
    page.drawText(`${String(index).padStart(4, '0')}: ${'native PDF evidence '.repeat(5)}`, {
      x: 20,
      y: 29_970 - index * 25,
      font,
      size: 8,
    });
  }
  page.drawText('UNREAD_TAIL_SENTINEL_AFTER_40000_CHARS', {
    x: 20,
    y: 14_000,
    font,
    size: 8,
  });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}


function nonCanonicalUnusedBits(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decoded = Buffer.from(value, 'base64url');
  const lastIndex = alphabet.indexOf(value.at(-1)!);
  for (let candidate = 0; candidate < alphabet.length; candidate += 1) {
    if (candidate === lastIndex) continue;
    const changed = `${value.slice(0, -1)}${alphabet[candidate]}`;
    if (Buffer.from(changed, 'base64url').equals(decoded)) return changed;
  }
  throw new Error('fixture has no noncanonical unused-bit mutation');
}

async function pptx(): Promise<Buffer> {
  const deck = new PptxGenJS();
  for (let slideNumber = 1; slideNumber <= 6; slideNumber += 1) {
    const slide = deck.addSlide();
    slide.addText(`Literal slide ${slideNumber} evidence`, { x: 1, y: 1, w: 8, h: 2 });
    if (slideNumber === 6) {
      (slide as unknown as { addNotes(notes: string): void }).addNotes(
        'Speaker-only instruction: preserve the FY28 caveat.',
      );
    }
  }
  return Buffer.from((await deck.write({ outputType: 'nodebuffer' })) as ArrayBuffer);
}

async function xlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('First').addRow(['not requested']);
  workbook.addWorksheet('Second').addRow(['also not requested']);
  const third = workbook.addWorksheet('Three Turns Ago');
  third.getCell('A1').value = 'Program';
  third.getCell('B1').value = 'Amount';
  third.getCell('A2').value = 'Sentinel radar';
  third.getCell('B2').value = 17;
  third.getCell('B3').value = 25;
  third.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 42 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function attachment(
  id: string,
  messageId: string,
  filename: string,
  kind: string,
  data: Buffer,
  status = 'parsed',
): AttachmentRow {
  const mediaType = kind === 'pdf'
    ? 'application/pdf'
    : kind === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : kind === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/plain';
  return {
    id,
    tenantId: TENANT,
    userId: USER,
    messageId,
    filename,
    kind,
    status,
    reason: status === 'failed' ? 'cached upload extraction failed' : null,
    mediaType,
    byteSize: data.length,
    pages: kind === 'pdf' ? 80 : null,
    data,
    createdAt: new Date('2026-09-28T10:00:00.000Z'),
  };
}

function message(row: AttachmentRow, index = 1, clientId: string | null = null): MessageRow {
  return {
    id: row.messageId,
    conversationId: CONVERSATION,
    tenantId: TENANT,
    userId: USER,
    clientId,
    role: 'user',
    metadata: {
      attachments: [{ id: row.id, filename: row.filename, kind: row.kind, status: row.status }],
    },
    createdAt: new Date(Date.UTC(2026, 8, 28, 10, index)),
  };
}

function harness(input: {
  attachments: AttachmentRow[];
  messages: MessageRow[];
  clientId?: string | null;
  wallAllowed?: boolean;
  revokeAfterDecode?: boolean;
  changeHashAfterDecode?: boolean;
  changeConversationAfterDecode?: boolean;
  revokeWallAfterDecode?: boolean;
  conversationVersion?: Date;
}) {
  let sourceReads = 0;
  let conversationReads = 0;
  let wallReads = 0;
  const clientId = input.clientId ?? null;
  const tx = {
    $queryRawUnsafe: jest.fn(async () => {
      wallReads += 1;
      return [{ allowed: input.revokeWallAfterDecode && wallReads > 1 ? false : input.wallAllowed !== false }];
    }),
    clioConversation: {
      findFirst: jest.fn(async () => {
        conversationReads += 1;
        if (input.changeConversationAfterDecode && conversationReads > 1) {
          return { id: CONVERSATION, clientId: null, updatedAt: VERSION };
        }
        return { id: CONVERSATION, clientId, updatedAt: input.conversationVersion ?? VERSION };
      }),
    },
    clioAttachment: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        sourceReads += 1;
        const row = input.attachments.find((candidate) => candidate.id === where.id) ?? null;
        if (!row || (input.revokeAfterDecode && sourceReads > 1)) return null;
        if (input.changeHashAfterDecode && sourceReads > 1 && row.data) {
          const changed = Buffer.from(row.data);
          changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
          return { ...row, data: changed };
        }
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) => {
        const ids = where.id?.in ?? input.attachments.map((row) => row.id);
        return input.attachments.filter((row) => ids.includes(row.id));
      }),
    },
    clioMessage: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; conversationId: string } }) =>
        input.messages.find(
          (candidate) => candidate.id === where.id && candidate.conversationId === where.conversationId,
        ) ?? null,
      ),
      findMany: jest.fn(async ({ where, take }: {
        where: { OR?: Array<{ createdAt?: { lt: Date } | Date; id?: { lte: string } }> };
        take: number;
      }) => {
        let rows = [...input.messages].sort((left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        );
        if (where.OR) {
          const date = where.OR[1]!.createdAt as Date;
          const id = where.OR[1]!.id!.lte;
          rows = rows.filter((row) => row.createdAt < date || (row.createdAt.getTime() === date.getTime() && row.id <= id));
        }
        return rows.slice(0, take);
      }),
    },
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (value: typeof tx) => unknown) => run(tx)) };
  return { service: new MeriChatAttachmentReadService(prisma as never), tx };
}

async function run(
  service: MeriChatAttachmentReadService,
  body: Record<string, unknown>,
  selectedClientId: string | null = null,
) {
  const controller = new AbortController();
  return withMeriChatAttachmentReadScope(
    { tenantId: TENANT, userId: USER, conversationId: CONVERSATION, selectedClientId },
    () => withMeriToolExecutionControl(
      { signal: controller.signal, deadlineAt: Date.now() + 30_000 },
      () => service.read({ tenantId: TENANT, userId: USER } as never, body),
    ),
  );
}

beforeAll(() => {
  process.env.MERI_ATTACHMENT_CURSOR_SECRET = 'synthetic-cursor-secret-at-least-16';
});

afterAll(() => {
  delete process.env.MERI_ATTACHMENT_CURSOR_SECRET;
});

describe('MeriChatAttachmentReadService original-byte typed reads', () => {
  it('reads only PDF page 4 from a real 80-page source and keeps file coverage incomplete', async () => {
    const bytes = await pdf(80);
    const row = attachment(uuid(1), uuid(101), 'eighty-pages.pdf', 'pdf', bytes, 'failed');
    const h = harness({ attachments: [row], messages: [message(row)] });
    const result = await run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      section: 4,
      limit: 6000,
    }) as any;
    expect(result.records[0].payload.text).toContain('Literal page 4 evidence marker P-4');
    expect(result.records[0].payload.text).not.toContain('Literal page 3');
    expect(result.source).toMatchObject({
      originalBytesHash: sha256Bytes(bytes),
      persistedExtractionStatus: 'failed',
      sourceKind: 'pdf',
    });
    expect(result.coverage).toMatchObject({
      sectionKind: 'page',
      sectionCount: 80,
      contentComplete: false,
      complete: false,
      paginationComplete: false,
      extractionStatus: 'complete',
    });
    expect(result.coverage.nextCursor).toEqual(expect.any(String));
  });

  it('reads a large native PDF page through bounded signed windows without gaps or duplication', async () => {
    const bytes = await largePagePdf();
    const row = attachment(uuid(8), uuid(108), 'large-page.pdf', 'pdf', bytes);
    const h = harness({ attachments: [row], messages: [message(row)] });
    let cursor: string | undefined;
    let expectedStart = 0;
    let text = '';
    let last: any;
    for (let call = 0; call < 20; call += 1) {
      const result = await run(h.service, {
        conversationId: CONVERSATION,
        attachmentId: row.id,
        limit: 6000,
        ...(cursor ? { cursor } : {}),
      }) as any;
      expect(result.coverage.characterStart).toBe(expectedStart);
      expect(result.coverage.characterEnd - result.coverage.characterStart).toBeLessThanOrEqual(6000);
      const part = result.records[0]?.payload.text ?? '';
      expect(part.length).toBe(result.coverage.characterEnd - result.coverage.characterStart);
      text += part;
      expectedStart = result.coverage.characterEnd;
      cursor = result.coverage.nextCursor ?? undefined;
      last = result;
      if (!cursor) break;
    }
    expect(text).toContain('UNREAD_TAIL_SENTINEL_AFTER_40000_CHARS');
    expect(text).toHaveLength(last.coverage.sectionCharacters);
    expect(last.coverage).toMatchObject({
      extractionStatus: 'complete',
      limitation: null,
      paginationComplete: true,
      truncated: false,
    });
    expect(cursor).toBeUndefined();
  });


  it('reads real PowerPoint slide 6 and speaker notes without returning prior slides', async () => {
    const bytes = await pptx();
    const row = attachment(uuid(2), uuid(102), 'six-slides.pptx', 'pptx', bytes);
    const h = harness({ attachments: [row], messages: [message(row)] });
    const result = await run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      section: 6,
    }) as any;
    const text = result.records[0].payload.text;
    expect(text).toContain('Literal slide 6 evidence');
    expect(text).toContain('Speaker-only instruction: preserve the FY28 caveat.');
    expect(text).not.toContain('Literal slide 5');
    expect(result.coverage).toMatchObject({
      sectionKind: 'slide_with_notes',
      sectionCount: 6,
      coordinates: { slide: 6, includesSpeakerNotes: true },
    });
  });

  it('reads worksheet 3 from real bytes with coordinates and labels cached formula semantics', async () => {
    const bytes = await xlsx();
    const row = attachment(uuid(3), uuid(103), 'three-turns-ago.xlsx', 'xlsx', bytes);
    const h = harness({ attachments: [row], messages: [message(row, 1)] });
    const result = await run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      section: 3,
      rowStart: 1,
    }) as any;
    const text = result.records[0].payload.text;
    expect(text).toContain("'Three Turns Ago'!A2 = \"Sentinel radar\"");
    expect(text).toContain("'Three Turns Ago'!B4 = \"42\" (saved cached formula result; not recalculated)");
    expect(text).not.toContain('SUM(B2:B3)');
    expect(result.coverage.coordinates).toMatchObject({
      sheet: 3,
      sheetName: 'Three Turns Ago',
      rowStart: 1,
      cellCoordinatesIncluded: true,
    });
    expect(result.coverage.limitation).toContain('formulas were not recalculated');
    expect(result.coverage.complete).toBe(false);
  });

  it('pages a finite manifest beyond the recent 20 without claiming content completeness', async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      attachment(uuid(200 + index), uuid(500 + index), `prior-${index + 1}.txt`, 'text', Buffer.from(`body ${index + 1}`)),
    );
    const messages = rows.map((row, index) => message(row, index));
    const h = harness({ attachments: rows, messages });
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      const result = await run(h.service, {
        conversationId: CONVERSATION,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      }) as any;
      seen.push(...result.records.map((record: any) => record.filename));
      expect(result.coverage.contentComplete).toBe(false);
      expect(result.coverage.total).toBeNull();
      cursor = result.coverage.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(30);
    expect(seen).toContain('prior-1.txt');
    expect(cursor).toBeUndefined();
  });

  it('supports literal section search and signed continuation while rejecting tampering and stale bytes', async () => {
    const bytes = await pdf(3);
    const row = attachment(uuid(4), uuid(104), 'search.pdf', 'pdf', bytes);
    const h = harness({ attachments: [row], messages: [message(row)] });
    const first = await run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      query: 'P-2',
      section: 1,
    }) as any;
    expect(first.records).toEqual([]);
    const cursor = first.coverage.nextCursor as string;
    const second = await run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      query: 'P-2',
      cursor,
    }) as any;
    expect(second.records[0].payload.text).toContain('P-2');
    const signatureStart = cursor.lastIndexOf('.') + 1;
    const signatureFirst = cursor[signatureStart]!;
    const tampered = `${cursor.slice(0, signatureStart)}${signatureFirst === 'A' ? 'B' : 'A'}${cursor.slice(signatureStart + 1)}`;
    await expect(run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      query: 'P-2',
      cursor: tampered,
    })).rejects.toThrow('Invalid chat attachment cursor');

    const [prefix, encodedAndSignature] = cursor.split('chat-attachment:v1:');
    expect(prefix).toBe('');
    const [encodedPayload, signature] = encodedAndSignature!.split('.');
    const nonCanonicalSignature = `${CURSOR_PREFIX_FOR_TEST}${encodedPayload}.${nonCanonicalUnusedBits(signature!)}`;
    for (const nonCanonical of [
      nonCanonicalSignature,
      `${CURSOR_PREFIX_FOR_TEST}${encodedPayload}.${signature}=`,
      `${CURSOR_PREFIX_FOR_TEST}${encodedPayload}.${signature} `,
      `${CURSOR_PREFIX_FOR_TEST}${encodedPayload}=.${signature}`,
    ]) {
      await expect(run(h.service, {
        conversationId: CONVERSATION,
        attachmentId: row.id,
        query: 'P-2',
        cursor: nonCanonical,
      })).rejects.toThrow('Invalid chat attachment cursor');
    }

    const stale = harness({
      attachments: [row],
      messages: [message(row)],
      changeHashAfterDecode: true,
    });
    await expect(run(stale.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      section: 1,
    })).rejects.toThrow('Attachment changed since the previous page');

    const staleVersion = harness({
      attachments: [row],
      messages: [message(row)],
      conversationVersion: new Date(VERSION.getTime() + 1_000),
    });
    await expect(run(staleVersion.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
      query: 'P-2',
      cursor,
    })).rejects.toThrow('cursor is stale or outside the current scope');
  });

  it.each([
    ['revoked source after decode', { revokeAfterDecode: true }, null],
    ['conversation selection changes after decode', { changeConversationAfterDecode: true }, CLIENT],
    ['memory wall is revoked after decode', { revokeWallAfterDecode: true }, CLIENT],
  ] as const)('fails closed when %s', async (_label, flags, selectedClientId) => {
    const bytes = await pdf(1);
    const row = attachment(uuid(5), uuid(105), 'revoked.pdf', 'pdf', bytes);
    const clientId = selectedClientId;
    const h = harness({
      attachments: [row],
      messages: [message(row, 1, clientId)],
      clientId,
      ...flags,
    });
    await expect(run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
    }, selectedClientId)).rejects.toThrow();
  });

  it('rejects guessed conversations, selected-client drift, denied walls, and cross-message bindings', async () => {
    const bytes = await pdf(1);
    const row = attachment(uuid(6), uuid(106), 'scoped.pdf', 'pdf', bytes);
    const denied = harness({
      attachments: [row],
      messages: [message(row, 1, CLIENT)],
      clientId: CLIENT,
      wallAllowed: false,
    });
    await expect(run(denied.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
    }, CLIENT)).rejects.toThrow('Chat attachment scope is unavailable');
    await expect(withMeriChatAttachmentReadScope(
      { tenantId: TENANT, userId: USER, conversationId: uuid(999), selectedClientId: CLIENT },
      () => denied.service.read({ tenantId: TENANT, userId: USER } as never, {
        conversationId: CONVERSATION,
        attachmentId: row.id,
      }),
    )).rejects.toThrow('Chat attachment scope is unavailable');
    const wrongBinding = harness({
      attachments: [row],
      messages: [{ ...message(row), metadata: { attachments: [] } }],
    });
    await expect(run(wrongBinding.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
    })).rejects.toThrow('Attachment not found in the current chat');
  });

  it('blocks oversized original bytes before parsing and reports no synthetic content', async () => {
    const bytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 4)]);
    const row = attachment(uuid(7), uuid(107), 'oversized.pdf', 'pdf', bytes);
    const h = harness({ attachments: [row], messages: [message(row)] });
    await expect(run(h.service, {
      conversationId: CONVERSATION,
      attachmentId: row.id,
    })).rejects.toThrow('exceeds the 10MB reading limit');
  });
});
