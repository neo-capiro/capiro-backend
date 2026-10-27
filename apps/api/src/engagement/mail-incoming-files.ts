import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mailboxProviderRequest, withMailboxProviderBudget } from './mailbox-provider-transport.js';

export const INCOMING_FILE_MAX_BYTES = 3 * 1024 * 1024;
export const INCOMING_FILES_MAX_COUNT = 50;
const RESPONSE_BYTES = 4 * 1024 * 1024 + 262144;
export const incomingObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const incomingHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x20]/.test(v);
const unavailable = () => new ServiceUnavailableException('Incoming files could not be read. Open the original message in your mailbox.');
export class IncomingFilesHandoff extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export type IncomingProviderSource =
  | { provider: 'gmail'; messageId: string; threadId: string; version: string }
  | { provider: 'microsoft_graph'; messageId: string; threadId: string; version: string };
export interface IncomingFile {
  key: string;
  name: string;
  contentType: string;
  bytes: number;
  handoff: string | null;
  /** Provider selectors and bytes remain server-only. */
  providerId: string | null;
  data?: string;
}
export interface IncomingFilesRead {
  files: IncomingFile[];
  manifestSha256: string;
  imported?: { file: IncomingFile; buffer: Buffer };
}
export type IncomingImportSelection = { fileKey: string; manifestSha256: string };

function entry(identity: unknown, name: unknown, mime: unknown, bytes: unknown,
  providerId: string | null, handoff: string | null, data?: string): IncomingFile {
  if (typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) ||
      typeof mime !== 'string' || mime.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ||
      !Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new IncomingFilesHandoff('unsupported_file_metadata');
  return { key: incomingHash(identity), name, contentType: mime.toLowerCase(), bytes: bytes as number,
    handoff: handoff ?? ((bytes as number) > INCOMING_FILE_MAX_BYTES ? 'file_too_large' : null), providerId,
    ...(data === undefined ? {} : { data }) };
}

/** MIME containers are traversed, never treated as files. Embedded messages are explicit handoffs. */
export function gmailIncomingFiles(value: unknown, source: IncomingProviderSource): IncomingFile[] {
  const raw = incomingObject(value);
  if (raw.id !== source.messageId || raw.threadId !== source.threadId || raw.historyId !== source.version)
    throw new ConflictException('The original message changed. Refresh it before importing files.');
  const files: IncomingFile[] = [], partIds = new Set<string>(), attachmentIds = new Set<string>();
  let parts = 0;
  const visit = (value: unknown, depth: number) => {
    if (++parts > 100 || depth > 8) throw new IncomingFilesHandoff('mime_structure_limit');
    const part = incomingObject(value), body = incomingObject(part.body);
    if (typeof part.partId !== 'string' || part.partId.length > 128 || partIds.has(part.partId))
      throw new IncomingFilesHandoff('ambiguous_mime_parts');
    partIds.add(part.partId);
    if (!Array.isArray(part.headers) || part.headers.length > 200 || typeof part.mimeType !== 'string')
      throw new IncomingFilesHandoff('unsupported_mime_structure');
    const headers = part.headers.map(incomingObject);
    const named = (name: string) => headers.filter(h => typeof h.name === 'string' && h.name.toLowerCase() === name);
    const dispositions = named('content-disposition'), cids = named('content-id');
    if (dispositions.length > 1 || cids.length > 1) throw new IncomingFilesHandoff('ambiguous_mime_headers');
    const disposition = dispositions[0]?.value;
    if (disposition !== undefined && (typeof disposition !== 'string' || /[\r\n]/.test(disposition)))
      throw new IncomingFilesHandoff('unsupported_mime_headers');
    const mime = part.mimeType.toLowerCase(), name = part.filename;
    const file = (typeof name === 'string' && name.length > 0) || cids.length ||
      (typeof disposition === 'string' && /^(attachment|inline)(?:\s*;|$)/i.test(disposition)) || mime === 'message/rfc822';
    if (mime.startsWith('multipart/') && !file) {
      if (!['multipart/mixed', 'multipart/alternative', 'multipart/related'].includes(mime))
        throw new IncomingFilesHandoff('unsupported_mime_container');
      if (!Array.isArray(part.parts) || !part.parts.length) throw new IncomingFilesHandoff('unsupported_mime_structure');
      for (const child of part.parts) visit(child, depth + 1);
      return;
    }
    if (!file) {
      if (part.parts || !['text/plain', 'text/html'].includes(mime)) throw new IncomingFilesHandoff('unsupported_mime_part');
      return;
    }
    if (files.length === INCOMING_FILES_MAX_COUNT) throw new IncomingFilesHandoff('file_count_limit');
    const attachmentId = body.attachmentId;
    if (attachmentId !== undefined && (!id(attachmentId) || attachmentIds.has(attachmentId)))
      throw new IncomingFilesHandoff('ambiguous_attachment_ids');
    if (typeof attachmentId === 'string') attachmentIds.add(attachmentId);
    const reason = cids.length || (typeof disposition === 'string' && /^inline(?:\s*;|$)/i.test(disposition))
      ? 'inline_or_cid' : mime === 'message/rfc822' || part.parts ? 'embedded_message'
        : typeof disposition !== 'string' || !/^attachment(?:\s*;|$)/i.test(disposition) ? 'unsupported_disposition' : null;
    if (!reason && !attachmentId && typeof body.data !== 'string') throw new IncomingFilesHandoff('missing_file_body');
    files.push(entry([source, part.partId, attachmentId ?? null], typeof name === 'string' && name ? name : 'mailbox-part',
      mime, body.size, typeof attachmentId === 'string' ? attachmentId : null, reason,
      typeof body.data === 'string' ? body.data : undefined));
  };
  visit(raw.payload, 0);
  return files;
}

export function graphIncomingFiles(value: unknown, source: IncomingProviderSource): IncomingFile[] {
  const page = incomingObject(value);
  if (!Array.isArray(page.value) || page.value.length > INCOMING_FILES_MAX_COUNT || page['@odata.nextLink'])
    throw new IncomingFilesHandoff('file_count_or_page_limit');
  const ids = new Set<string>();
  return page.value.map(value => {
    const file = incomingObject(value);
    if (!id(file.id) || ids.has(file.id)) throw new IncomingFilesHandoff('ambiguous_attachment_ids');
    ids.add(file.id);
    const ordinary = file['@odata.type'] === '#microsoft.graph.fileAttachment';
    const reason = !ordinary ? 'item_or_reference_attachment' : file.isInline !== false || file.contentId ? 'inline_or_cid' : null;
    return entry([source, file.id], file.name, file.contentType ?? 'application/octet-stream', file.size, file.id, reason);
  });
}

export function decodeIncomingFile(value: unknown, bytes: number, encoding: 'base64' | 'base64url'): Buffer {
  if (bytes > INCOMING_FILE_MAX_BYTES || typeof value !== 'string' || value.length > 4 * Math.ceil(INCOMING_FILE_MAX_BYTES / 3) + 2 ||
      !(encoding === 'base64' ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9_-]*={0,2}$/).test(value)) throw unavailable();
  const result = Buffer.from(value, encoding);
  if (result.byteLength !== bytes || result.toString(encoding).replace(/=+$/, '') !== value.replace(/=+$/, '')) throw unavailable();
  return result;
}

/** Fixed-provider GET only, bounded bytes/deadline, no redirects or provider error text. */
export async function incomingProviderGet(url: string, token: string, headers: Record<string, string> = {}): Promise<unknown> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port ||
      !['gmail.googleapis.com', 'graph.microsoft.com'].includes(target.hostname)) throw unavailable();
  return mailboxProviderRequest(async signal => {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers } });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) throw new NotFoundException('The original file is no longer available in this mailbox.');
      throw unavailable();
    }
    if (!response.body) throw unavailable();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RESPONSE_BYTES) throw new IncomingFilesHandoff('provider_response_limit');
        chunks.push(chunk.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw unavailable(); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  });
}

/** Adapters supply their existing owned credentials. Caller values never select a URL/nextLink. */
export async function readIncomingProviderFiles(source: IncomingProviderSource,
  get: (url: string, headers?: Record<string, string>) => Promise<unknown>, selection: IncomingImportSelection | undefined,
  allowedType: (mime: string) => boolean): Promise<IncomingFilesRead> {
  return withMailboxProviderBudget(async () => {
    const graph = source.provider === 'microsoft_graph';
    const base = graph ? `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(source.messageId)}`
      : `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(source.messageId)}`;
    const headers: Record<string, string> = graph ? { Prefer: 'IdType="ImmutableId"' } : {};
    const originalUrl = graph ? `${base}?$select=id,conversationId,changeKey,isDraft` : `${base}?format=full`;
    const checkGraph = (value: unknown) => {
      const row = incomingObject(value);
      if (row.id !== source.messageId || row.conversationId !== source.threadId || row.changeKey !== source.version || row.isDraft !== false)
        throw new ConflictException('The original message changed. Refresh it before importing files.');
    };
    const original = await get(originalUrl, headers);
    if (graph) checkGraph(original);
    const files = graph ? graphIncomingFiles(await get(`${base}/attachments?$select=id,name,contentType,size,isInline&$top=51`, headers), source)
      : gmailIncomingFiles(original, source);
    const manifestSha256 = incomingHash([source, files.map(({ data, ...file }) => ({ ...file,
      ...(data === undefined ? {} : { dataSha256: incomingHash(data) }) }))]);
    if (!selection) return { files, manifestSha256 };
    if (selection.manifestSha256 !== manifestSha256) throw new ConflictException('The file list changed. Refresh it before importing.');
    const file = files.find(file => file.key === selection.fileKey);
    if (!file) throw new BadRequestException('Choose a file from the current selected message.');
    if (file.handoff) throw new IncomingFilesHandoff(file.handoff);
    if (!allowedType(file.contentType)) throw new IncomingFilesHandoff('unsupported_file_type');
    let buffer: Buffer;
    if (graph) {
      const raw = incomingObject(await get(`${base}/attachments/${encodeURIComponent(file.providerId!)}`, headers));
      const observed = graphIncomingFiles({ value: [raw] }, source)[0]!;
      if (observed.handoff) throw new IncomingFilesHandoff(observed.handoff);
      if (JSON.stringify(observed) !== JSON.stringify(file)) throw new ConflictException('The selected file changed. Refresh it before importing.');
      buffer = decodeIncomingFile(raw.contentBytes, file.bytes, 'base64');
      checkGraph(await get(originalUrl, headers));
    } else {
      const raw = file.providerId ? incomingObject(await get(`${base}/attachments/${encodeURIComponent(file.providerId)}`)) : { data: file.data, size: file.bytes };
      if (raw.size !== file.bytes) throw unavailable();
      buffer = decodeIncomingFile(raw.data, file.bytes, 'base64url');
      // Gmail historyId can change independently of file content; stale proof refuses safely.
      gmailIncomingFiles(await get(originalUrl), source);
    }
    return { files, manifestSha256, imported: { file, buffer } };
  });
}
