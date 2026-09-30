import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import mammoth from 'mammoth';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { extractPptxSlide } from '../engagement/pptx-extract.js';
import { extractMeriXlsxSection, MeriXlsxValidationError } from './meri-attachment-document.js';
import { extractPdfText } from './meri-attachment-extract.js';
import {
  attachmentRefsFromMetadata,
  MAX_ATTACHMENT_BYTES,
  verifyMagicBytes,
  type AttachmentKind,
} from './meri-attachment.helpers.js';
import { sha256Bytes, validateDocumentArtifactBytes } from './meri-artifact-integrity.js';
import { currentMeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';
import {
  assertMeriToolRequestActive,
  meriToolRequestControl,
} from './meri-tool-request-control.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const CURSOR_PREFIX = 'chat-attachment:v1:';
const MESSAGE_SCAN_PAGE = 25;
const XLSX_ROWS_PER_SECTION = 100;
const TEXT_SECTION_CHARS = 20_000;
const MAX_DECODED_TEXT_CHARS = 2_000_000;
const PDF_PAGE_WINDOW_CHARS = 40_000;

type SectionLocator = { section: number; rowStart: number; offset: number };
type ManifestLocator = { createdAt: string; messageId: string; attachmentIndex: number };

type CursorPayload =
  | {
      v: 1;
      mode: 'manifest';
      tenantId: string;
      userId: string;
      conversationId: string;
      clientId: string | null;
      conversationVersion: string;
      query: string;
      locator: ManifestLocator;
    }
  | {
      v: 1;
      mode: 'read';
      tenantId: string;
      userId: string;
      conversationId: string;
      clientId: string | null;
      conversationVersion: string;
      query: string;
      attachmentId: string;
      messageId: string;
      originalBytesHash: string;
      locator: SectionLocator;
    };

interface ParsedInput {
  conversationId: string;
  attachmentId?: string;
  query: string;
  limit: number;
  locator: SectionLocator;
  cursor?: CursorPayload;
}

interface AuthorizedConversation {
  id: string;
  clientId: string | null;
  version: string;
}

interface AuthorizedSource {
  id: string;
  messageId: string;
  filename: string;
  kind: AttachmentKind;
  status: string;
  reason: string | null;
  mediaType: string | null;
  byteSize: number;
  pages: number | null;
  data: Buffer;
  originalBytesHash: string;
}

interface ExtractedSection {
  text: string;
  textStart?: number;
  sectionCharacters?: number;
  locator: SectionLocator;
  sectionKind: 'page' | 'slide_with_notes' | 'sheet_rows' | 'text_section';
  sectionLabel: string;
  sectionCount: number;
  nextLocator: SectionLocator | null;
  extractionStatus: 'complete' | 'partial' | 'unreadable';
  limitation: string | null;
  coordinates?: Record<string, unknown>;
}

function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new BadRequestException(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function exactString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new BadRequestException(`${name} is invalid`);
  return value.trim();
}

function cursorSecret(): string {
  const secret = process.env.MERI_ATTACHMENT_CURSOR_SECRET ?? process.env.INTERNAL_SERVICE_SECRET;
  if (!secret || secret.length < 16)
    throw new ServiceUnavailableException('Chat attachment continuation is not configured');
  return secret;
}

function signCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', cursorSecret()).update(encoded).digest('base64url');
  return `${CURSOR_PREFIX}${encoded}.${signature}`;
}

function decodeCursor(value: unknown): CursorPayload {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith(CURSOR_PREFIX))
    throw new BadRequestException('Invalid chat attachment cursor');
  const parts = value.slice(CURSOR_PREFIX.length).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new BadRequestException('Invalid chat attachment cursor');
  let encodedPayload: Buffer;
  let supplied: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
      throw new Error('alphabet');
    encodedPayload = Buffer.from(parts[0], 'base64url');
    supplied = Buffer.from(parts[1], 'base64url');
    if (
      encodedPayload.toString('base64url') !== parts[0] ||
      supplied.toString('base64url') !== parts[1]
    )
      throw new Error('noncanonical');
  } catch {
    throw new BadRequestException('Invalid chat attachment cursor');
  }
  const expected = createHmac('sha256', cursorSecret()).update(parts[0]).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new BadRequestException('Invalid chat attachment cursor');
  try {
    const payload = JSON.parse(encodedPayload.toString('utf8')) as CursorPayload;
    if (
      payload.v !== 1 ||
      (payload.mode !== 'manifest' && payload.mode !== 'read') ||
      !UUID.test(payload.tenantId) ||
      !UUID.test(payload.userId) ||
      !UUID.test(payload.conversationId) ||
      (payload.clientId !== null && !UUID.test(payload.clientId)) ||
      typeof payload.conversationVersion !== 'string' ||
      typeof payload.query !== 'string'
    )
      throw new Error('shape');
    if (payload.mode === 'read') {
      if (
        !UUID.test(payload.attachmentId) ||
        !UUID.test(payload.messageId) ||
        !HASH.test(payload.originalBytesHash) ||
        !Number.isSafeInteger(payload.locator.section) ||
        payload.locator.section < 1 ||
        !Number.isSafeInteger(payload.locator.rowStart) ||
        payload.locator.rowStart < 1 ||
        !Number.isSafeInteger(payload.locator.offset) ||
        payload.locator.offset < 0
      )
        throw new Error('shape');
    } else if (
      !UUID.test(payload.locator.messageId) ||
      !Number.isSafeInteger(payload.locator.attachmentIndex) ||
      payload.locator.attachmentIndex < 0 ||
      Number.isNaN(Date.parse(payload.locator.createdAt))
    )
      throw new Error('shape');
    return payload;
  } catch {
    throw new BadRequestException('Invalid chat attachment cursor');
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  const allowed = new Set([
    'conversationId',
    'attachmentId',
    'query',
    'section',
    'rowStart',
    'characterOffset',
    'cursor',
    'limit',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key)))
    throw new BadRequestException('Unknown chat attachment read input');
  const conversationId = exactString(raw.conversationId, 'conversationId', 80);
  if (!UUID.test(conversationId)) throw new BadRequestException('conversationId must be a UUID');
  const attachmentId =
    raw.attachmentId === undefined ? undefined : exactString(raw.attachmentId, 'attachmentId', 80);
  if (attachmentId && !UUID.test(attachmentId))
    throw new BadRequestException('attachmentId must be a UUID');
  const query = raw.query === undefined ? '' : exactString(raw.query, 'query', 240);
  const limit =
    raw.limit === undefined
      ? attachmentId
        ? 5000
        : 10
      : safeInteger(raw.limit, 'limit', 1, attachmentId ? 6000 : 20);
  let locator: SectionLocator = {
    section: raw.section === undefined ? 1 : safeInteger(raw.section, 'section', 1, 500),
    rowStart: raw.rowStart === undefined ? 1 : safeInteger(raw.rowStart, 'rowStart', 1, 1_000_000),
    offset:
      raw.characterOffset === undefined
        ? 0
        : safeInteger(raw.characterOffset, 'characterOffset', 0, MAX_DECODED_TEXT_CHARS),
  };
  let cursor: CursorPayload | undefined;
  if (raw.cursor !== undefined) {
    if (
      raw.section !== undefined ||
      raw.rowStart !== undefined ||
      raw.characterOffset !== undefined
    )
      throw new BadRequestException('Use cursor or an explicit locator, not both');
    cursor = decodeCursor(raw.cursor);
    locator = cursor.mode === 'read' ? cursor.locator : locator;
  }
  if (
    !attachmentId &&
    (raw.section !== undefined || raw.rowStart !== undefined || raw.characterOffset !== undefined)
  )
    throw new BadRequestException('Section locators require attachmentId');
  if (cursor?.mode === 'read' && attachmentId !== cursor.attachmentId)
    throw new BadRequestException('Cursor does not match attachmentId');
  if (cursor?.mode === 'manifest' && attachmentId)
    throw new BadRequestException('Manifest cursor cannot read attachment content');
  if (cursor && (cursor.conversationId !== conversationId || cursor.query !== query))
    throw new BadRequestException('Cursor does not match the conversation or query');
  return { conversationId, attachmentId, query, limit, locator, cursor };
}

@Injectable()
export class MeriChatAttachmentReadService {
  constructor(private readonly prisma: PrismaService) {}

  async read(ctx: TenantContext, rawInput: Record<string, unknown>) {
    assertMeriToolRequestActive();
    const input = parseInput(rawInput);
    const conversation = await this.authorizeConversation(ctx, input.conversationId);
    this.assertCursorScope(ctx, input, conversation);
    return input.attachmentId
      ? this.readAttachment(ctx, input, conversation)
      : this.readManifest(ctx, input, conversation);
  }

  private async authorizeConversation(
    ctx: TenantContext,
    conversationId: string,
  ): Promise<AuthorizedConversation> {
    const served = currentMeriChatAttachmentReadScope();
    if (
      !served ||
      served.tenantId !== ctx.tenantId ||
      served.userId !== ctx.userId ||
      served.conversationId !== conversationId
    )
      throw new NotFoundException('Chat attachment scope is unavailable');
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const conversation = await tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true, updatedAt: true },
      });
      if (!conversation || conversation.clientId !== served.selectedClientId)
        throw new NotFoundException('Chat attachment scope is unavailable');
      if (
        conversation.clientId &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, conversation.clientId))
      )
        throw new NotFoundException('Chat attachment scope is unavailable');
      return {
        id: conversation.id,
        clientId: conversation.clientId,
        version: conversation.updatedAt.toISOString(),
      };
    });
  }

  private assertCursorScope(
    ctx: TenantContext,
    input: ParsedInput,
    conversation: AuthorizedConversation,
  ): void {
    const cursor = input.cursor;
    if (!cursor) return;
    if (
      cursor.tenantId !== ctx.tenantId ||
      cursor.userId !== ctx.userId ||
      cursor.conversationId !== conversation.id ||
      cursor.clientId !== conversation.clientId ||
      cursor.conversationVersion !== conversation.version
    )
      throw new BadRequestException('Chat attachment cursor is stale or outside the current scope');
  }

  private async authorizeSource(
    ctx: TenantContext,
    conversation: AuthorizedConversation,
    attachmentId: string,
    expected?: { messageId: string; originalBytesHash: string },
  ): Promise<AuthorizedSource> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await tx.clioAttachment.findFirst({
        where: { id: attachmentId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: {
          id: true,
          messageId: true,
          filename: true,
          kind: true,
          status: true,
          reason: true,
          mediaType: true,
          byteSize: true,
          pages: true,
          data: true,
        },
      });
      if (!row?.messageId || !row.data)
        throw new NotFoundException('Attachment not found in the current chat');
      const message = await tx.clioMessage.findFirst({
        where: {
          id: row.messageId,
          conversationId: conversation.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: conversation.clientId,
          role: 'user',
        },
        select: { id: true, metadata: true },
      });
      if (
        !message ||
        !attachmentRefsFromMetadata(message.metadata).some((reference) => reference.id === row.id)
      )
        throw new NotFoundException('Attachment not found in the current chat');
      const data = Buffer.from(row.data);
      const originalBytesHash = sha256Bytes(data);
      if (
        expected &&
        (row.messageId !== expected.messageId || originalBytesHash !== expected.originalBytesHash)
      )
        throw new BadRequestException(
          'Attachment changed since the previous page; restart the read',
        );
      if (row.byteSize !== data.length)
        throw new UnprocessableEntityException(
          'Attachment byte receipt does not match the persisted source',
        );
      if (data.length > MAX_ATTACHMENT_BYTES)
        throw new UnprocessableEntityException(
          `Attachment exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB reading limit`,
        );
      const kind = row.kind as AttachmentKind;
      const magic = verifyMagicBytes(kind, data);
      if (!magic.ok)
        throw new UnprocessableEntityException(
          `Attachment bytes are not readable: ${magic.reason}`,
        );
      return {
        id: row.id,
        messageId: row.messageId,
        filename: row.filename,
        kind,
        status: row.status,
        reason: row.reason,
        mediaType: row.mediaType,
        byteSize: row.byteSize,
        pages: row.pages,
        data,
        originalBytesHash,
      };
    });
  }

  private async readManifest(
    ctx: TenantContext,
    input: ParsedInput,
    conversation: AuthorizedConversation,
  ) {
    const cursor = input.cursor?.mode === 'manifest' ? input.cursor : undefined;
    const locator = cursor?.locator;
    const messages = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          conversationId: conversation.id,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: conversation.clientId,
          role: 'user',
          ...(locator
            ? {
                OR: [
                  { createdAt: { lt: new Date(locator.createdAt) } },
                  { createdAt: new Date(locator.createdAt), id: { lte: locator.messageId } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MESSAGE_SCAN_PAGE + 1,
        select: { id: true, createdAt: true, metadata: true },
      }),
    );
    if (locator && messages[0]?.id !== locator.messageId)
      throw new BadRequestException('Chat attachment manifest changed; restart the listing');
    const scanned = messages.slice(0, MESSAGE_SCAN_PAGE);
    const candidates: Array<{
      messageId: string;
      messageCreatedAt: Date;
      attachmentIndex: number;
      reference: ReturnType<typeof attachmentRefsFromMetadata>[number];
    }> = [];
    for (const message of scanned) {
      const refs = attachmentRefsFromMetadata(message.metadata);
      const start = locator && message.id === locator.messageId ? locator.attachmentIndex : 0;
      for (let index = start; index < refs.length; index += 1) {
        const reference = refs[index]!;
        if (!input.query || reference.filename.toLowerCase().includes(input.query.toLowerCase()))
          candidates.push({
            messageId: message.id,
            messageCreatedAt: message.createdAt,
            attachmentIndex: index,
            reference,
          });
      }
    }
    const pageCandidates = candidates.slice(0, input.limit);
    const ids = pageCandidates.map((candidate) => candidate.reference.id);
    const rows = ids.length
      ? await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          tx.clioAttachment.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId, userId: ctx.userId },
            select: {
              id: true,
              messageId: true,
              filename: true,
              kind: true,
              status: true,
              reason: true,
              byteSize: true,
              pages: true,
              data: true,
              createdAt: true,
            },
          }),
        )
      : [];
    const records = pageCandidates.flatMap((candidate) => {
      const row = rows.find(
        (item) => item.id === candidate.reference.id && item.messageId === candidate.messageId,
      );
      if (!row) return [];
      const bytes = row.data ? Buffer.from(row.data) : null;
      return [
        {
          attachmentId: row.id,
          filename: row.filename,
          kind: row.kind,
          sourceMessageId: candidate.messageId,
          uploadedAt: row.createdAt,
          extractionStatus: row.status,
          extractionReason: row.reason,
          byteSize: row.byteSize,
          pages: row.pages,
          originalBytesAvailable: Boolean(bytes),
          originalBytesHash: bytes ? sha256Bytes(bytes) : null,
        },
      ];
    });
    let nextLocator: ManifestLocator | null = null;
    if (candidates.length > pageCandidates.length) {
      const next = candidates[pageCandidates.length]!;
      nextLocator = {
        createdAt: next.messageCreatedAt.toISOString(),
        messageId: next.messageId,
        attachmentIndex: next.attachmentIndex,
      };
    } else if (messages.length > MESSAGE_SCAN_PAGE) {
      const next = messages[MESSAGE_SCAN_PAGE]!;
      nextLocator = {
        createdAt: next.createdAt.toISOString(),
        messageId: next.id,
        attachmentIndex: 0,
      };
    }
    const nextCursor = nextLocator
      ? signCursor({
          v: 1,
          mode: 'manifest',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          conversationId: conversation.id,
          clientId: conversation.clientId,
          conversationVersion: conversation.version,
          query: input.query,
          locator: nextLocator,
        })
      : null;
    for (const record of records) {
      if (!record.originalBytesHash) continue;
      await this.authorizeSource(ctx, conversation, record.attachmentId, {
        messageId: record.sourceMessageId,
        originalBytesHash: record.originalBytesHash,
      });
    }
    const currentConversation = await this.authorizeConversation(ctx, conversation.id);
    if (currentConversation.version !== conversation.version)
      throw new BadRequestException('Chat attachment manifest changed; restart the listing');
    return {
      tool: 'read_chat_attachments',
      authoritativeOwner: 'clio_chat_attachment',
      currentStatus: 'available',
      generatedAt: new Date().toISOString(),
      conversationId: conversation.id,
      clientId: conversation.clientId,
      coverage: {
        mode: 'manifest',
        total: null,
        returned: records.length,
        unavailableInPage: pageCandidates.length - records.length,
        scannedMessages: scanned.length,
        paginationComplete: !nextCursor,
        complete: !nextCursor,
        contentComplete: false,
        nextCursor,
        query: input.query || null,
        queryAppliesTo: 'filename',
        note: 'This is a finite metadata manifest, not file content. Follow nextCursor until paginationComplete before treating the inventory as complete.',
      },
      records,
    };
  }

  private async readAttachment(
    ctx: TenantContext,
    input: ParsedInput,
    conversation: AuthorizedConversation,
  ) {
    const readCursor = input.cursor?.mode === 'read' ? input.cursor : undefined;
    const source = await this.authorizeSource(
      ctx,
      conversation,
      input.attachmentId!,
      readCursor
        ? { messageId: readCursor.messageId, originalBytesHash: readCursor.originalBytesHash }
        : undefined,
    );
    assertMeriToolRequestActive();
    let extracted: ExtractedSection;
    try {
      extracted = await this.extractSection(source, input.locator);
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof UnprocessableEntityException)
        throw error;
      const reason =
        error instanceof MeriXlsxValidationError
          ? error.code
          : error instanceof Error
            ? error.message
            : 'section_decode_failed';
      throw new UnprocessableEntityException(`Attachment section could not be read: ${reason}`);
    }
    assertMeriToolRequestActive();
    const currentConversation = await this.authorizeConversation(ctx, conversation.id);
    if (currentConversation.version !== conversation.version)
      throw new BadRequestException('Chat attachment scope changed during the read; restart it');
    await this.authorizeSource(ctx, conversation, source.id, {
      messageId: source.messageId,
      originalBytesHash: source.originalBytesHash,
    });

    const textStart = extracted.textStart ?? 0;
    const sectionCharacters = extracted.sectionCharacters ?? extracted.text.length;
    const localOffset = input.locator.offset - textStart;
    if (localOffset < 0 || localOffset > extracted.text.length)
      throw new BadRequestException('characterOffset is outside this attachment section');
    const lower = extracted.text.toLowerCase();
    const match = input.query ? lower.indexOf(input.query.toLowerCase(), localOffset) : localOffset;
    const start =
      match < 0 ? extracted.text.length : Math.max(localOffset, match - (input.query ? 240 : 0));
    let end = Math.min(
      extracted.text.length,
      Math.max(start + input.limit, match + input.query.length),
    );
    while (end > start && JSON.stringify(extracted.text.slice(start, end)).length > 6500) end -= 1;
    const characterStart = textStart + start;
    const characterEnd = textStart + end;
    const moreText = end < extracted.text.length;
    const nextLocator =
      match < 0
        ? extracted.nextLocator
        : moreText
          ? { ...extracted.locator, offset: characterEnd }
          : extracted.nextLocator;
    const nextCursor = nextLocator
      ? signCursor({
          v: 1,
          mode: 'read',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          conversationId: conversation.id,
          clientId: conversation.clientId,
          conversationVersion: conversation.version,
          query: input.query,
          attachmentId: source.id,
          messageId: source.messageId,
          originalBytesHash: source.originalBytesHash,
          locator: nextLocator,
        })
      : null;
    const text = extracted.text.slice(start, end);
    const sectionComplete =
      characterStart === 0 &&
      characterEnd === sectionCharacters &&
      extracted.extractionStatus === 'complete';
    const contentComplete = sectionComplete && extracted.locator.section === 1 && !nextCursor;
    const reference = `${source.id}:${source.originalBytesHash.slice(0, 16)}:${extracted.sectionKind}:${extracted.locator.section}:${characterStart}-${characterEnd}`;
    return {
      tool: 'read_chat_attachments',
      authoritativeOwner: 'clio_chat_attachment',
      currentStatus: 'available',
      generatedAt: new Date().toISOString(),
      conversationId: conversation.id,
      clientId: conversation.clientId,
      source: {
        attachmentId: source.id,
        sourceMessageId: source.messageId,
        filename: source.filename,
        sourceKind: source.kind,
        mediaType: source.mediaType,
        byteSize: source.byteSize,
        originalBytesHash: source.originalBytesHash,
        persistedExtractionStatus: source.status,
        persistedExtractionReason: source.reason,
      },
      coverage: {
        mode: 'section',
        locator: extracted.locator,
        sectionKind: extracted.sectionKind,
        sectionLabel: extracted.sectionLabel,
        sectionCount: extracted.sectionCount,
        coordinates: extracted.coordinates ?? null,
        characterStart,
        characterEnd,
        sectionCharacters,
        extractionStatus: extracted.extractionStatus,
        limitation: extracted.limitation,
        matched: input.query ? match >= 0 : null,
        query: input.query || null,
        sectionComplete,
        contentComplete,
        paginationComplete: !nextCursor,
        truncated: Boolean(nextCursor) || extracted.extractionStatus !== 'complete',
        complete: contentComplete,
        nextCursor,
        note: 'Content was decoded from the currently authorized original persisted bytes. Follow nextCursor for remaining text or typed sections; an empty or partial section is not evidence that later sections are empty.',
      },
      records: text.trim()
        ? [
            {
              domain: 'chat_attachments',
              recordId: reference,
              payload: {
                id: reference,
                attachmentId: source.id,
                title: source.filename,
                sourceKind: source.kind,
                sectionKind: extracted.sectionKind,
                sectionLabel: extracted.sectionLabel,
                coordinates: extracted.coordinates ?? null,
                characterStart,
                characterEnd,
                text,
              },
              provenance: {
                sourceType: 'ordinary_chat_attachment_original_bytes',
                sourceRecordId: source.id,
                sourceMessageId: source.messageId,
                conversationId: conversation.id,
                clientId: conversation.clientId,
                originalBytesHash: source.originalBytesHash,
                locator: extracted.locator,
                trust: 'external_untrusted',
              },
            },
          ]
        : [],
    };
  }

  private async extractSection(
    source: AuthorizedSource,
    locator: SectionLocator,
  ): Promise<ExtractedSection> {
    const signal = meriToolRequestControl()?.signal;
    if (signal?.aborted) throw signal.reason;
    if (source.kind === 'pdf') {
      const remainingReadableCharacters = Math.max(0, MAX_DECODED_TEXT_CHARS - locator.offset);
      const extracted = await extractPdfText(source.data, {
        firstPage: locator.section,
        limits: {
          pages: 1,
          characters: Math.min(PDF_PAGE_WINDOW_CHARS, remainingReadableCharacters),
        },
        pageWindow: { offset: locator.offset },
        preserveLineBreaks: true,
        ...(signal ? { signal } : {}),
      });
      if (locator.section > extracted.pages)
        throw new BadRequestException('PDF page does not exist');
      const selectedPage = extracted.selectedPage;
      if (!selectedPage) throw new Error('PDF_PAGE_WINDOW_MISSING');
      if (locator.offset > selectedPage.nativeCharacters)
        throw new BadRequestException('characterOffset is outside this attachment section');
      const unreadable = extracted.unreadablePages.includes(locator.section);
      const readableCharacters = Math.min(selectedPage.nativeCharacters, MAX_DECODED_TEXT_CHARS);
      const hardLimitReached =
        selectedPage.nativeCharacters > MAX_DECODED_TEXT_CHARS &&
        selectedPage.characterEnd >= MAX_DECODED_TEXT_CHARS;
      const nextLocator =
        selectedPage.characterEnd < readableCharacters
          ? { ...locator, offset: selectedPage.characterEnd }
          : !hardLimitReached && locator.section < extracted.pages
            ? { section: locator.section + 1, rowStart: 1, offset: 0 }
            : null;
      return {
        text: extracted.text,
        textStart: selectedPage.characterStart,
        sectionCharacters: selectedPage.nativeCharacters,
        locator,
        sectionKind: 'page',
        sectionLabel: `PDF page ${locator.section}`,
        sectionCount: extracted.pages,
        nextLocator,
        extractionStatus: unreadable ? 'unreadable' : hardLimitReached ? 'partial' : 'complete',
        limitation: unreadable
          ? 'This page has no readable native text. No OCR or provider transcription was substituted.'
          : hardLimitReached
            ? `Native page text exceeds the ${MAX_DECODED_TEXT_CHARS}-character safety limit; the range after character ${MAX_DECODED_TEXT_CHARS} is unavailable.`
            : null,
        coordinates: {
          page: locator.section,
          selectedCharacterStart: selectedPage.characterStart,
          selectedCharacterEnd: selectedPage.characterEnd,
          nativeCharacters: selectedPage.nativeCharacters,
          selectedPageTruncated: selectedPage.truncated,
        },
      };
    }
    if (source.kind === 'pptx') {
      await validateDocumentArtifactBytes('pptx', source.data);
      const slide = await extractPptxSlide(source.data, locator.section);
      const blocks = [
        slide.text ? `Slide text:\n${slide.text}` : '',
        slide.notes ? `Speaker notes:\n${slide.notes}` : '',
      ].filter(Boolean);
      return {
        text: blocks.join('\n\n'),
        locator,
        sectionKind: 'slide_with_notes',
        sectionLabel: `PowerPoint slide ${locator.section} with speaker notes`,
        sectionCount: slide.slideCount,
        nextLocator:
          locator.section < slide.slideCount
            ? { section: locator.section + 1, rowStart: 1, offset: 0 }
            : null,
        extractionStatus: !slide.readable ? 'unreadable' : slide.truncated ? 'partial' : 'complete',
        limitation: !slide.readable
          ? 'No readable slide text or speaker notes were found. Images and charts are not transcribed.'
          : slide.truncated
            ? 'Slide XML reached the bounded reading limit; returned text is partial.'
            : 'Images and charts are not transcribed.',
        coordinates: { slide: locator.section, includesSpeakerNotes: true },
      };
    }
    if (source.kind === 'xlsx') {
      const sheet = await extractMeriXlsxSection(source.data, {
        sheet: locator.section,
        rowStart: locator.rowStart,
        rowLimit: XLSX_ROWS_PER_SECTION,
      });
      const nextLocator =
        sheet.rowEnd < sheet.rowCount
          ? { section: sheet.sheet, rowStart: sheet.rowEnd + 1, offset: 0 }
          : sheet.sheet < sheet.sheetCount
            ? { section: sheet.sheet + 1, rowStart: 1, offset: 0 }
            : null;
      return {
        text: sheet.text,
        locator,
        sectionKind: 'sheet_rows',
        sectionLabel: `Worksheet ${sheet.sheet}: ${sheet.sheetName}, rows ${sheet.rowStart}-${sheet.rowEnd}`,
        sectionCount: sheet.sheetCount,
        nextLocator,
        extractionStatus: sheet.reason ? 'partial' : 'complete',
        limitation: sheet.reason,
        coordinates: {
          sheet: sheet.sheet,
          sheetName: sheet.sheetName,
          rowStart: sheet.rowStart,
          rowEnd: sheet.rowEnd,
          rowCount: sheet.rowCount,
          cellCoordinatesIncluded: true,
        },
      };
    }
    if (source.kind === 'image' || source.kind === 'unsupported')
      throw new UnprocessableEntityException(
        'This attachment kind has no bounded text-section reader; use the original image-view path.',
      );
    let raw: string;
    if (source.kind === 'docx') {
      await validateDocumentArtifactBytes('docx', source.data);
      raw = (await mammoth.extractRawText({ buffer: source.data })).value;
    } else raw = new TextDecoder('utf-8', { fatal: true }).decode(source.data);
    if (raw.includes('\u0000')) throw new Error('binary_text_attachment');
    const sourceTruncated = raw.length > MAX_DECODED_TEXT_CHARS;
    raw = raw.slice(0, MAX_DECODED_TEXT_CHARS);
    const sectionCount = Math.max(1, Math.ceil(raw.length / TEXT_SECTION_CHARS));
    if (locator.section > sectionCount)
      throw new BadRequestException('Text section does not exist');
    const start = (locator.section - 1) * TEXT_SECTION_CHARS;
    const text = raw.slice(start, start + TEXT_SECTION_CHARS);
    return {
      text,
      locator,
      sectionKind: 'text_section',
      sectionLabel: `Text section ${locator.section}`,
      sectionCount,
      nextLocator:
        locator.section < sectionCount
          ? { section: locator.section + 1, rowStart: 1, offset: 0 }
          : null,
      extractionStatus: sourceTruncated ? 'partial' : 'complete',
      limitation: sourceTruncated
        ? `Decoded text exceeds the ${MAX_DECODED_TEXT_CHARS}-character safety limit; later content is unavailable.`
        : null,
      coordinates: { section: locator.section },
    };
  }
}
