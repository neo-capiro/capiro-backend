import { readMeriControlledSource } from './meri-controlled-read-fixture.js';
import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ownMailMessageWhere } from '../engagement/engagement-access.helpers.js';
import { MemoryAuthorizationService } from '../memory/memory-authorization.service.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { ClientsService } from '../clients/clients.service.js';
import { ClientCapabilitiesService } from '../clients/client-capabilities.service.js';
import { ClientPeopleService } from '../clients/client-people.service.js';
import { ClientFacilitiesService } from '../clients/client-facilities.service.js';
import { ClientAdvocacyMatterService } from '../clients/client-advocacy-matter.service.js';
import { MeriToolsService } from './meri-tools.service.js';

export type MeriSourceKind = 'email' | 'client' | 'memory' | 'document' | 'controlled_read';
export interface MeriSourceRequest {
  kind: MeriSourceKind;
  recordId: string;
  conversationId?: string;
  threadId?: string;
  clientId?: string;
  section?: string;
  cursor?: string;
  version?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** A source viewer, not a tool gateway. Each branch is read-only and reuses the
 * owning service's live access rules. Cursors are positions, never authority. */
@Injectable()
export class MeriSourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    private readonly clients: ClientsService,
    private readonly capabilities: ClientCapabilitiesService,
    private readonly people: ClientPeopleService,
    private readonly facilities: ClientFacilitiesService,
    private readonly advocacy: ClientAdvocacyMatterService,
    private readonly meriTools: MeriToolsService,
    private readonly memoryAuthorization: MemoryAuthorizationService,
  ) {}

  async read(ctx: TenantContext, input: MeriSourceRequest): Promise<Record<string, any>> {
    if (
      !['email', 'client', 'memory', 'document', 'controlled_read'].includes(input.kind) ||
      !UUID.test(input.recordId) ||
      (input.clientId && !UUID.test(input.clientId)) ||
      (input.threadId && !UUID.test(input.threadId)) ||
      (input.conversationId && !UUID.test(input.conversationId)) ||
      (input.cursor?.length ?? 0) > 4000
    ) {
      throw new BadRequestException('Use an exact supported source identifier.');
    }
    if (input.kind === 'controlled_read') return readMeriControlledSource(this.prisma, ctx, input);
    if (input.clientId && input.kind !== 'client') await this.assertClientAccess(ctx, input.clientId);
    switch (input.kind) {
      case 'email': return this.email(ctx, input);
      case 'client': return this.client(ctx, input);
      case 'memory': return this.memory(ctx, input);
      case 'document': return this.document(ctx, input);
    }
  }

  private async assertClientAccess(ctx: TenantContext, clientId: string) {
    const denied = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId,
      (tx) => fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId));
    if (denied.includes(clientId)) throw new NotFoundException('Source not found or no longer accessible.');
    return this.clients.get(ctx, clientId);
  }

  private version(input: MeriSourceRequest, currentVersion: string) {
    return { currentVersion, versionStatus: input.version
      ? input.version === currentVersion ? 'matches_cited_version' : 'changed_since_citation'
      : 'current_version_only' };
  }

  private cursor(ctx: TenantContext, input: MeriSourceRequest, currentVersion: string) {
    const scope = hash([ctx.tenantId, ctx.userId, input.kind, input.recordId, input.clientId ?? null, input.threadId ?? null, input.section ?? null]);
    let position = { message: 0, offset: 0, section: 1 };
    let textHash: string | undefined;
    if (input.cursor) {
      let decoded: Record<string, any>;
      try { decoded = record(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))); }
      catch { throw new BadRequestException('Invalid source continuation.'); }
      if (decoded.scope !== scope || decoded.version !== currentVersion ||
        !['message', 'offset', 'section'].every((key) => Number.isSafeInteger(decoded[key]) && decoded[key] >= 0)) {
        throw new BadRequestException('Source content or access scope changed. Restart the source read.');
      }
      position = { message: decoded.message, offset: decoded.offset, section: decoded.section };
      textHash = typeof decoded.textHash === 'string' ? decoded.textHash : undefined;
    }
    return { position, textHash, at: (next: typeof position, nextTextHash?: string) => Buffer.from(JSON.stringify({ scope, version: currentVersion, ...next, ...(nextTextHash ? { textHash: nextTextHash } : {}) })).toString('base64url') };
  }

  private async email(ctx: TenantContext, input: MeriSourceRequest) {
    let threadId = input.threadId;
    if (!threadId) {
      // Old mail citations stored only the message UUID. Resolve its real parent
      // through the same active-message/connection-owner predicate as mail reads.
      const message = await this.prisma.withTenant(ctx.tenantId, (tx) => tx.mailMessage.findFirst({
        where: { id: input.recordId, tenantId: ctx.tenantId, ...ownMailMessageWhere(ctx.userId) }, select: { threadId: true },
      }));
      threadId = message?.threadId ?? input.recordId;
    }
    const thread = await this.engagement.getMailThread(ctx, threadId);
    if (thread.clientId) await this.assertClientAccess(ctx, thread.clientId);
    if (input.recordId !== thread.id && !thread.messages.some((message) => message.id === input.recordId)) {
      throw new NotFoundException('Cited message is no longer active in this thread.');
    }
    const currentVersion = hash(thread.messages.map((message) => [message.id, message.bodyText, message.subject, message.fromEmail,
      message.toRecipients, message.ccRecipients, message.sentAt, message.receivedAt, message.metadata]));
    const continuation = this.cursor(ctx, input, currentVersion);
    const { message: messageIndex, offset } = continuation.position;
    const message = thread.messages[messageIndex];
    if (!message && messageIndex !== 0) throw new BadRequestException('Invalid source position.');
    const body = message?.bodyText ?? '';
    if (offset > body.length) throw new BadRequestException('Invalid source position.');
    let end = Math.min(body.length, offset + 6000);
    if (end < body.length && /[\uD800-\uDBFF]/.test(body.charAt(end - 1))) end -= 1;
    const next = end < body.length ? { message: messageIndex, offset: end, section: 1 }
      : messageIndex + 1 < thread.messages.length ? { message: messageIndex + 1, offset: 0, section: 1 } : null;
    return {
      kind: 'email', status: 'available', recordId: input.recordId, title: thread.subject,
      threadId: thread.id, totalMessages: thread.messages.length, mailbox: thread.connectionEmail,
      ...this.version(input, currentVersion), nextCursor: next ? continuation.at(next) : null,
      message: message ? { id: message.id, threadId: thread.id, subject: message.subject,
        from: { email: message.fromEmail, name: message.fromName }, to: message.toRecipients, cc: message.ccRecipients,
        sentAt: message.sentAt, receivedAt: message.receivedAt,
        bodyText: body.slice(offset, end), offset, endOffset: end, bodyLength: body.length,
        bodyCompleteness: typeof record(message.metadata).bodyCompleteness === 'string' ? record(message.metadata).bodyCompleteness : 'unknown',
        messageNumber: messageIndex + 1 } : null,
      notice: 'This is the current stored thread. All message pages can be read below. Provider-side missing or partial bodies remain incomplete.',
    };
  }

  private async client(ctx: TenantContext, input: MeriSourceRequest) {
    const clientId = input.clientId ?? input.recordId;
    const client = await this.assertClientAccess(ctx, clientId);
    let source: Record<string, any> = client;
    if (input.recordId !== clientId) {
      let rows: Array<Record<string, any>> = [];
      switch (input.section) {
        case 'capabilities': rows = await this.capabilities.listCapabilities(ctx, clientId); break;
        case 'people': rows = await this.people.listPeople(ctx, clientId); break;
        case 'facilities': rows = await this.facilities.listFacilities(ctx, clientId); break;
        case 'submissionHistory': rows = await this.capabilities.listClientHistory(ctx, clientId, null); break;
        case 'advocacyMatters': rows = [await this.advocacy.getMatter(ctx, clientId, input.recordId)]; break;
        default: return { kind: 'client', status: 'record_navigation', recordId: input.recordId,
          title: client.name, location: `/clients?clientId=${clientId}`, versionStatus: 'current_version_only',
          notice: 'Open the current client profile to inspect this record. Its cited snapshot is not stored in the source viewer.' };
      }
      source = rows.find((row) => row.id === input.recordId) ?? {};
      if (!source.id) throw new NotFoundException('The cited profile record was removed or is no longer accessible.');
    }
    return { kind: 'client', status: 'record_navigation', recordId: source.id, clientId,
      title: source.name ?? source.title ?? client.name, updatedAt: source.updatedAt ?? client.updatedAt,
      location: `/clients?clientId=${clientId}`, ...this.version(input, new Date(source.updatedAt ?? client.updatedAt).toISOString()),
      notice: 'Open the current client profile for the complete record. The original answer excerpt remains below; it is not a stored full snapshot.' };
  }

  private async memory(ctx: TenantContext, input: MeriSourceRequest) {
    // Old citations have only an item UUID. Resolve its actual authorized
    // association, never the currently selected workspace client.
    const clientId = input.clientId ?? (await this.memoryAuthorization.requireItem(ctx, input.recordId, 'read')).clientId ?? undefined;
    const result = await this.meriTools.readGovernedMemorySource(ctx, {
      memoryItemId: input.recordId, clientId, contentCursor: input.cursor,
    });
    if (typeof result.error === 'string') throw new BadRequestException(result.error);
    const row = record('records' in result ? result.records?.[0] : undefined);
    if (!row.recordId) return { kind: 'memory', status: 'unavailable', recordId: input.recordId,
      notice: 'The governed memory is unavailable or no longer eligible for recall. It may have been revoked, superseded, deleted, or access may have changed.' };
    const payload = record(row.payload), content = record(payload.content), provenance = record(row.provenance);
    return { kind: 'memory', status: 'available', recordId: row.recordId, title: payload.title,
      text: payload.value, governance: payload.governance, contentStatus: payload.contentStatus,
      notice: payload.contentLimitation, sourceVersion: provenance.sourceVersion,
      updatedAt: row.updatedAt, provenance, offset: content.offset, totalCharacters: content.totalCharacters,
      nextCursor: record(content.nextRead).contentCursor ?? null,
      ...this.version(input, String(content.hash ? `content:${content.hash}` : 'unknown')) };
  }

  private async document(ctx: TenantContext, input: MeriSourceRequest) {
    if (!input.clientId) throw new BadRequestException('The document citation is missing its original client identifier.');
    // Section reads use canonical parser/OCR and current ACL + readiness checks.
    // Decode only the requested position first; the hash/scope validation below
    // rechecks it against the actual currently authorized document bytes.
    let requestedSection = 1;
    if (input.cursor) {
      try { requestedSection = record(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))).section; }
      catch { throw new BadRequestException('Invalid source continuation.'); }
      if (!Number.isSafeInteger(requestedSection) || requestedSection < 1 || requestedSection > 100000) throw new BadRequestException('Invalid document section.');
    }
    const source = await this.engagement.extractAttachmentText(ctx, input.recordId, { clientId: input.clientId, section: requestedSection });
    const continuation = this.cursor(ctx, input, source.contentHash);
    const text = source.text, offset = continuation.position.offset;
    // OCR can yield different text from unchanged bytes after its cache expires.
    // Never append a later slice of a different extraction to an earlier page.
    if (offset > 0 && continuation.textHash !== hash(text)) throw new BadRequestException('Extracted source text changed. Restart the source read.');
    if (offset > text.length) throw new BadRequestException('Invalid source position.');
    let end = Math.min(text.length, offset + 6000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
    const full = record(source), sectionCount = Number(full.sectionCount ?? 1);
    const next = end < text.length ? { message: 0, offset: end, section: requestedSection }
      : requestedSection < sectionCount ? { message: 0, offset: 0, section: requestedSection + 1 } : null;
    return { kind: 'document', status: 'available', recordId: input.recordId, clientId: input.clientId,
      title: source.fileName, text: text.slice(offset, end), offset, totalCharacters: text.length,
      section: requestedSection, sectionCount, sectionLabel: full.sectionLabel,
      readability: full.readability, truncated: full.truncated, disclosure: full.disclosure,
      location: `/clients?clientId=${input.clientId}&tab=documents`,
      ...this.version(input, source.contentHash), nextCursor: next ? continuation.at(next, next.offset > 0 ? hash(text) : undefined) : null };
  }
}
