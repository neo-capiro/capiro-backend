/** Shared pure MIME bytes; extracted without altering Gmail encoding or headers. */
import { randomBytes } from 'node:crypto';
import type { EngagementSendMailInput } from './mail-sender.service.js';

export function buildMailMime(input: EngagementSendMailInput): Buffer {
  const isHtml = (input.bodyContentType ?? 'Text') === 'HTML';
  const bodyContentType = isHtml ? 'text/html; charset="UTF-8"' : 'text/plain; charset="UTF-8"';
  const attachments = input.attachments ?? [];

  const headers: string[] = [];
  headers.push(`To: ${formatAddressList(input.toRecipients)}`);
  const cc = formatAddressList(input.ccRecipients ?? []);
  if (cc) headers.push(`Cc: ${cc}`);
  const bcc = formatAddressList(input.bccRecipients ?? []);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject ?? '')}`);
  if (input.reply) {
    headers.push(`In-Reply-To: ${input.reply.inReplyTo}`);
    headers.push(`References: ${input.reply.references}`);
  }
  headers.push('MIME-Version: 1.0');
  // Phase 0 — outbound-only correlation so a message in Sent Items can be tied
  // back to its outreach_deliveries row. Sanitized through the same CR/LF strip
  // as every other header value, and restricted to id-safe characters so a
  // caller-supplied value can never inject a header. NOT tracking: nothing is
  // fetched, rewritten, or reported when the recipient opens the mail.
  const correlationHeader = sanitizeCorrelationId(input.correlationId);
  if (correlationHeader) headers.push(`X-Capiro-Delivery-Id: ${correlationHeader}`);

  const bodyBase64 = wrapBase64(Buffer.from(input.body ?? '', 'utf8').toString('base64'));

  let mime: string;
  if (!attachments.length) {
    headers.push(`Content-Type: ${bodyContentType}`);
    headers.push('Content-Transfer-Encoding: base64');
    mime = `${headers.join('\r\n')}\r\n\r\n${bodyBase64}`;
  } else {
    const boundary = `capiro_${randomBytes(16).toString('hex')}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts: string[] = [];
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${bodyContentType}`,
        'Content-Transfer-Encoding: base64',
        '',
        bodyBase64,
      ].join('\r\n'),
    );
    for (const att of attachments) {
      const name = att.name || 'attachment';
      parts.push(
        [
          `--${boundary}`,
          `Content-Type: ${sanitizeContentType(att.contentType)}; ${contentTypeNameParam(name)}`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; ${dispositionFilenameParam(name)}`,
          '',
          // contentBytes is already base64 (from the attachment loader); re-wrap.
          wrapBase64(att.contentBytes.replace(/\s+/g, '')),
        ].join('\r\n'),
      );
    }
    parts.push(`--${boundary}--`);
    mime = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
  }

  return Buffer.from(mime, 'utf8');
}

function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * Allow only id-safe characters in the correlation header. A UUID passes
 * untouched; anything with CR/LF, spaces or header punctuation is rejected
 * outright rather than escaped, because there is no legitimate delivery id that
 * needs them. Exported for unit tests.
 */
export function sanitizeCorrelationId(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.trim();
  if (!clean || clean.length > 80) return null;
  return /^[A-Za-z0-9._:-]+$/.test(clean) ? clean : null;
}

function formatAddressList(list: Array<{ email: string; name?: string | null }>): string {
  return list
    .filter((r) => r?.email && r.email.trim())
    .map((r) => formatAddress(r.email.trim(), r.name ?? null))
    .join(', ');
}

function formatAddress(email: string, name: string | null): string {
  // The builder is the header-injection boundary: strip any CR/LF from the
  // address itself so a caller can never smuggle a header through it, no matter
  // how the address was validated (or not) upstream.
  const safeEmail = email.replace(/[\r\n]/g, '');
  if (!name || !name.trim()) return safeEmail;
  return `${encodeDisplayName(name.trim())} <${safeEmail}>`;
}

function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value);
}

/** RFC 2047 encoded-word for non-ASCII header text (e.g. Subject). */
function encodeHeaderValue(value: string): string {
  // Collapse any CR/LF run to a single space so a subject can never inject a
  // second header (e.g. a smuggled `Bcc:`). Non-ASCII is base64 encoded-word,
  // which is inherently newline-free.
  if (isAscii(value)) return value.replace(/[\r\n]+/g, ' ');
  return `=?UTF-8?B?${Buffer.from(value.replace(/[\r\n]+/g, ' '), 'utf8').toString('base64')}?=`;
}

function encodeDisplayName(rawName: string): string {
  // Collapse any CR/LF first so even the plain-ASCII branch below can't emit a
  // newline that would corrupt the header block.
  const name = rawName.replace(/[\r\n]+/g, ' ');
  if (isAscii(name)) {
    if (/[()<>@,;:\\".[\]]/.test(name)) {
      return `"${name.replace(/(["\\])/g, '\\$1')}"`;
    }
    return name;
  }
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
}

function sanitizeHeaderParam(value: string): string {
  return value.replace(/[\r\n"]/g, '_');
}

/**
 * Content-Type `name=` param. ASCII → a quoted string; non-ASCII → an RFC 2047
 * encoded-word (the widely-accepted form for this legacy param).
 */
function contentTypeNameParam(name: string): string {
  const safe = sanitizeHeaderParam(name);
  if (isAscii(safe)) return `name="${safe}"`;
  return `name="=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?="`;
}

/**
 * Content-Disposition `filename` param. ASCII → a quoted string; non-ASCII →
 * an RFC 2231 extended parameter (`filename*=UTF-8''<pct-encoded>`) so accented
 * / CJK filenames render correctly instead of as raw 8-bit mojibake.
 */
function dispositionFilenameParam(name: string): string {
  const safe = sanitizeHeaderParam(name);
  if (isAscii(safe)) return `filename="${safe}"`;
  return `filename*=UTF-8''${encodeRfc2231(safe)}`;
}

function encodeRfc2231(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'))
    .map((byte) => {
      const char = String.fromCharCode(byte);
      // attr-char per RFC 5987 stays literal; everything else is percent-encoded.
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function sanitizeContentType(contentType: string): string {
  // Take the base media type (drop any `; charset=…` params) and strip header
  // control chars, so a stored content type can't break the MIME headers.
  const base = (contentType || 'application/octet-stream').split(';')[0] ?? '';
  const clean = base.replace(/[\r\n"]/g, '').trim();
  return clean || 'application/octet-stream';
}
