import { BadRequestException } from '@nestjs/common';
import {
  assertAttachmentConversation,
  authorizedAttachmentSources,
  compactedAttachmentContext,
  previousAttachmentManifest,
} from './meri-attachment-continuity.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

const ctx = { tenantId: 'tenant', userId: 'user' } as never;

function prismaWith(tx: Record<string, unknown>) {
  return {
    withTenant: jest.fn(async (_tenant: string, callback: (value: unknown) => unknown) =>
      callback(tx),
    ),
  } as never;
}

describe('attachment continuity authorization', () => {
  test('accepts messages from the same conversation and rejects a foreign message id', async () => {
    const findMany = jest.fn(async () => [{ id: 'same' }]);
    const tx = { clioMessage: { findMany } } as never;
    await expect(
      assertAttachmentConversation(tx, ctx, 'conversation', [{ messageId: 'same' }]),
    ).resolves.toBeUndefined();
    findMany.mockResolvedValueOnce([]);
    await expect(
      assertAttachmentConversation(tx, ctx, 'conversation', [{ messageId: 'foreign' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversationId: 'conversation',
          tenantId: 'tenant',
          userId: 'user',
          role: 'user',
        }),
      }),
    );
  });

  test('returns only tenant/user attachments bound to an authorized conversation message', async () => {
    const rows = [
      {
        id: 'visible',
        filename: 'a',
        kind: 'text',
        textContent: 'a',
        status: 'parsed',
        reason: null,
        messageId: 'visible-message',
      },
      {
        id: 'earlier',
        filename: 'b',
        kind: 'text',
        textContent: 'b',
        status: 'parsed',
        reason: null,
        messageId: 'earlier-message',
      },
      {
        id: 'foreign',
        filename: 'c',
        kind: 'text',
        textContent: 'c',
        status: 'parsed',
        reason: null,
        messageId: 'foreign-message',
      },
    ];
    const tx = {
      clioAttachment: { findMany: jest.fn(async () => rows) },
      clioMessage: { findMany: jest.fn(async () => [{ id: 'earlier-message' }]) },
    };
    const result = await authorizedAttachmentSources(
      prismaWith(tx),
      ctx,
      'conversation',
      rows.map((row) => row.id),
      ['visible-message'],
    );
    expect(result.map((row) => row.id)).toEqual(['visible', 'earlier']);
    expect(tx.clioAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['visible', 'earlier', 'foreign'] },
          tenantId: 'tenant',
          userId: 'user',
        },
      }),
    );
  });

  test('fails closed when saved XLSX bytes are replaced, omitted, or disagree with cached source text', async () => {
    const original: Buffer = Buffer.from('original-xlsx-bytes');
    const row = {
      id: 'xlsx',
      filename: 'source.xlsx',
      kind: 'xlsx',
      textContent: `Source SHA-256: ${sha256Bytes(original)}\n'Sheet1'!A1 = "ORIGINAL"`,
      status: 'parsed',
      reason: null,
      messageId: 'visible-message',
      data: original,
    };
    const findMany = jest.fn(async ({ select }: { select: Record<string, boolean> }) =>
      select.data && Object.keys(select).length === 2 ? [{ id: row.id, data: row.data }] : [row],
    );
    const tx = { clioAttachment: { findMany }, clioMessage: { findMany: jest.fn(async () => []) } };
    const authorize = () =>
      authorizedAttachmentSources(
        prismaWith(tx),
        ctx,
        'conversation',
        [row.id],
        ['visible-message'],
      );

    await expect(authorize()).resolves.toHaveLength(1);
    row.data = Buffer.from('replacement-xlsx-bytes');
    await expect(authorize()).resolves.toEqual([]);
    row.data = null as unknown as Buffer;
    await expect(authorize()).resolves.toEqual([]);
    row.data = original;
    row.textContent = `Source SHA-256: ${'0'.repeat(64)}\n'Sheet1'!A1 = "ORIGINAL"`;
    await expect(authorize()).resolves.toEqual([]);
    row.textContent = `'Sheet1'!A1 = "ORIGINAL"`;
    await expect(authorize()).resolves.toEqual([]);
  });

  test('caps compacted context at eight most recent references in order', async () => {
    const refs = Array.from({ length: 9 }, (_, index) => ({
      id: `attachment-${index}`,
      filename: `${index}.txt`,
      kind: 'text',
      status: 'parsed',
    }));
    const tx = {
      clioMessage: {
        findMany: jest.fn(async () =>
          refs.map((ref, index) => ({
            id: `message-${index}`,
            metadata: { attachments: [ref] },
          })),
        ),
      },
      clioAttachment: {
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.map((id: string) => {
            const index = Number(id.split('-')[1]);
            return {
              ...refs[index],
              textContent: `text-${index}`,
              reason: null,
              messageId: `message-${index}`,
            };
          }),
        ),
      },
    };
    const result = await compactedAttachmentContext(prismaWith(tx), ctx, 'conversation', []);
    expect(result).toContain('attachment-0');
    expect(result).toContain('attachment-7');
    expect(result).not.toContain('attachment-8');
    expect(result.indexOf('attachment-0')).toBeLessThan(result.indexOf('attachment-1'));
  });

  test('builds a metadata-only prior manifest in newest-first order and caps queries at twenty', async () => {
    const messages = [
      { id: 'm2', createdAt: new Date('2026-02-01') },
      { id: 'm1', createdAt: new Date('2026-01-01') },
    ];
    const attachments = [
      {
        id: 'a2',
        filename: 'same.pdf',
        status: 'failed',
        textContent: null,
        reason: 'encrypted',
        kind: 'pdf',
        pages: 1,
        createdAt: new Date('2026-02-01'),
        messageId: 'm2',
      },
      {
        id: 'a1',
        filename: 'same.pdf',
        status: 'parsed',
        textContent: 'read me',
        reason: null,
        kind: 'pdf',
        pages: 1,
        createdAt: new Date('2026-01-01'),
        messageId: 'm1',
      },
    ];
    const tx = {
      clioMessage: { findMany: jest.fn(async () => messages) },
      clioAttachment: { findMany: jest.fn(async () => attachments) },
    };
    await expect(
      previousAttachmentManifest(prismaWith(tx), ctx, 'conversation', 'current'),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'a2', turn: 2, state: 'failed', extractedChars: 0 }),
      expect.objectContaining({ id: 'a1', turn: 1, state: 'ready', extractedChars: 7 }),
    ]);
    expect(tx.clioMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'current' } }) }),
    );
    expect(tx.clioAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 20,
        select: expect.not.objectContaining({ text: true, data: true }),
      }),
    );
  });

  test('service owner manifest verifies current XLSX sources and rejects cross-user or cross-conversation reads', async () => {
    const original = Buffer.from('original-xlsx-bytes');
    const replacement = Buffer.from('replacement-xlsx-bytes');
    const sourceText = `Source SHA-256: ${sha256Bytes(original)}\n'Sheet1'!A1 = "ORIGINAL"`;
    const messages = [
      {
        id: 'owner-message',
        conversationId: 'owner-conversation',
        tenantId: 'tenant',
        userId: 'user',
        role: 'user',
        createdAt: new Date('2026-03-01'),
      },
    ];
    const attachments = [
      {
        id: 'unchanged',
        filename: 'unchanged.xlsx',
        kind: 'xlsx',
        status: 'parsed',
        textContent: sourceText,
        reason: null,
        pages: null,
        data: original,
      },
      {
        id: 'changed',
        filename: 'changed.xlsx',
        kind: 'xlsx',
        status: 'parsed',
        textContent: sourceText,
        reason: null,
        pages: null,
        data: replacement,
      },
      {
        id: 'missing',
        filename: 'missing.xlsx',
        kind: 'xlsx',
        status: 'parsed',
        textContent: sourceText,
        reason: null,
        pages: null,
        data: null,
      },
      {
        id: 'hashless',
        filename: 'hashless.xlsx',
        kind: 'xlsx',
        status: 'parsed',
        textContent: `'Sheet1'!A1 = "ORIGINAL"`,
        reason: null,
        pages: null,
        data: original,
      },
      {
        id: 'text',
        filename: 'notes.txt',
        kind: 'text',
        status: 'parsed',
        textContent: 'notes',
        reason: null,
        pages: null,
        data: Buffer.from('notes'),
      },
    ].map((row, index) => ({
      ...row,
      tenantId: 'tenant',
      userId: 'user',
      messageId: 'owner-message',
      createdAt: new Date(Date.UTC(2026, 2, 5 - index)),
    }));
    const project = (row: Record<string, unknown>, select: Record<string, boolean>) =>
      Object.fromEntries(
        Object.keys(select).flatMap((key) => (select[key] ? [[key, row[key]]] : [])),
      );
    const attachmentFindMany = jest.fn(
      async ({ where, select }: { where: any; select: Record<string, boolean> }) =>
        attachments
          .filter(
            (row) =>
              row.tenantId === where.tenantId &&
              row.userId === where.userId &&
              (!where.kind || row.kind === where.kind) &&
              (!where.id?.in || where.id.in.includes(row.id)) &&
              (!where.messageId?.in || where.messageId.in.includes(row.messageId)),
          )
          .map((row) => project(row, select)),
    );
    const messageFindMany = jest.fn(
      async ({ where, select }: { where: any; select: Record<string, boolean> }) =>
        messages
          .filter(
            (message) =>
              message.conversationId === where.conversationId &&
              message.tenantId === where.tenantId &&
              message.userId === where.userId &&
              message.role === where.role,
          )
          .map((message) => project(message, select)),
    );
    const prisma = prismaWith({
      clioMessage: { findMany: messageFindMany },
      clioAttachment: { findMany: attachmentFindMany },
    });

    const manifest = await previousAttachmentManifest(prisma, ctx, 'owner-conversation', null);
    expect(manifest).toEqual([
      expect.objectContaining({
        id: 'unchanged',
        state: 'ready',
        extractedChars: sourceText.length,
      }),
      expect.objectContaining({ id: 'changed', state: 'failed', extractedChars: 0 }),
      expect.objectContaining({ id: 'missing', state: 'failed', extractedChars: 0 }),
      expect.objectContaining({ id: 'hashless', state: 'failed', extractedChars: 0 }),
      expect.objectContaining({ id: 'text', state: 'ready', extractedChars: 5 }),
    ]);
    const sourceRead = attachmentFindMany.mock.calls.find(
      ([query]) => query.select.data === true,
    )?.[0];
    expect(sourceRead).toEqual({
      where: {
        id: { in: ['unchanged', 'changed', 'missing', 'hashless'] },
        tenantId: 'tenant',
        userId: 'user',
        messageId: { in: ['owner-message'] },
        kind: 'xlsx',
      },
      select: { id: true, data: true },
    });
    expect(JSON.stringify(manifest)).not.toContain('ORIGINAL');
    expect(JSON.stringify(manifest)).not.toContain('xlsx-bytes');

    await expect(
      previousAttachmentManifest(
        prisma,
        { tenantId: 'tenant', userId: 'other-user' } as never,
        'owner-conversation',
        null,
      ),
    ).resolves.toEqual([]);
    await expect(
      previousAttachmentManifest(prisma, ctx, 'other-conversation', null),
    ).resolves.toEqual([]);
  });
});
