import { createHash } from 'node:crypto';
import { isWellFormedMailText } from './mail-body-section.js';
import type { MailReplyIdentity } from './single-mail-reply.js';

/** First forward slice: complete plain text only; no inherited incoming files. */
export const FORWARD_UNAVAILABLE =
  'Forward is available for complete plain-text originals up to 6,000 characters without incoming files. Forward this message from your mailbox.';
export type MailForwardBody = { bodyText: string; bodySha256: string };
export type MailForwardInput = { source: MailReplyIdentity; body: MailForwardBody };
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function forwardBody(text: unknown): MailForwardBody | null {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > 6000 ||
    !isWellFormedMailText(text) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  )
    return null;
  return { bodyText: text, bodySha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function storedForwardBody(value: unknown): MailForwardBody | null {
  const raw = object(value),
    proof = forwardBody(raw.bodyText);
  return Object.keys(raw).sort().join(',') === 'bodySha256,bodyText' &&
    proof?.bodySha256 === raw.bodySha256
    ? proof
    : null;
}

function plainGmailPayload(value: unknown): Record<string, unknown> | null {
  const raw = object(value),
    payload = object(raw.payload);
  if (
    payload.mimeType !== 'text/plain' ||
    payload.filename ||
    (payload.parts !== undefined && (!Array.isArray(payload.parts) || payload.parts.length)) ||
    !Array.isArray(payload.headers) ||
    payload.headers.length > 200
  )
    return null;
  for (const item of payload.headers) {
    const header = object(item);
    if (typeof header.name !== 'string' || typeof header.value !== 'string') return null;
    const name = header.name.toLowerCase();
    if (name === 'content-id' || name === 'content-disposition') return null;
  }
  return payload;
}

/** Only the stored complete body is exposed; provider metadata never becomes an HTTP field. */
export function prepareForwardBody(
  source: {
    bodyText: unknown;
    metadata: unknown;
    hasAttachments: boolean;
    raw: unknown;
  },
  graph: boolean,
): MailForwardBody | null {
  const metadata = object(source.metadata),
    raw = object(source.raw);
  if (source.hasAttachments || metadata.bodyCompleteness !== 'full') return null;
  if (
    graph
      ? metadata.bodyContentType !== 'text' ||
        String(object(raw.body).contentType).toLowerCase() !== 'text' ||
        raw.hasAttachments !== false
      : !plainGmailPayload(raw)
  )
    return null;
  return forwardBody(source.bodyText);
}

/** Fresh full Gmail message must be a single plain-text part, never a snippet. */
export function gmailForwardBody(value: unknown): MailForwardBody | null {
  const payload = plainGmailPayload(value),
    encoded = object(payload?.body).data;
  if (
    !payload ||
    typeof encoded !== 'string' ||
    encoded.length > 32000 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) ||
    object(payload.body).attachmentId
  )
    return null;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded.replace(/=+$/, '')) return null;
    return forwardBody(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** hasAttachments excludes inline files in Graph: an empty complete attachment page is also required. */
export function graphForwardBody(value: unknown, attachments: unknown): MailForwardBody | null {
  const raw = object(value),
    body = object(raw.body),
    files = object(attachments);
  if (
    raw.hasAttachments !== false ||
    typeof body.contentType !== 'string' ||
    body.contentType.toLowerCase() !== 'text' ||
    typeof body.content !== 'string' ||
    files['@odata.nextLink'] ||
    !Array.isArray(files.value) ||
    files.value.length
  )
    return null;
  return forwardBody(body.content.trim());
}

export function forwardSubject(original: string): string | null {
  const subject = /^fwd?:\s/i.test(original) ? original : `Fwd: ${original}`;
  return subject.length <= 300 && !/[\r\n]/.test(subject) ? subject : null;
}

/** Server appends this immutable source after the editable comment; no HTML from the original is executed. */
export function forwardedMessageHtml(source: MailReplyIdentity, body: MailForwardBody): string {
  const escape = (text: string) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  return `<p>---------- Forwarded message ----------<br>From: ${escape(source.fromEmail)}<br>Subject: ${escape(source.subject)}</p><blockquote>${escape(body.bodyText).replace(/\r\n?|\n/g, '<br>')}</blockquote>`;
}

/** Bounded source read, under the existing provider deadline. Never reads a file attachment. */
export async function readForwardSourceJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Forward source body unavailable');
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 262144) throw new Error('Forward source exceeds read limit');
      parts.push(item.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
