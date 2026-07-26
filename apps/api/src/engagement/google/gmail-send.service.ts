// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Gmail send adapter — the Google Workspace analog of the Microsoft Graph
// sendMail path. It resolves the caller's own OAuth token via the shared
// GoogleTokenService, assembles an RFC 2822 MIME message, and posts it to the
// Gmail users.messages.send endpoint. Do NOT modify the auth/token handling or
// the wire format without EXPLICIT prior approval from Neo.
// ============================================================================
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { GoogleTokenService } from './google-token.service.js';
import type { EngagementSendMailInput } from '../mail-sender.service.js';
import {
  AmbiguousMailSendError,
  isAmbiguousTransportFailure,
  type EngagementMailSendResult,
} from '../mail-send-result.js';

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

@Injectable()
export class GmailSendService {
  private readonly logger = new Logger(GmailSendService.name);

  constructor(private readonly googleToken: GoogleTokenService) {}

  /**
   * Send through the caller's own Gmail mailbox.
   *
   * Phase 0 (§3.e2, change-control approved): the returned message resource is
   * now PARSED and surfaced instead of discarded, so a delivery row can record
   * Gmail's own message/thread ids. Auth, token refresh, scopes, the CR/LF
   * header-injection guards, MIME encoding and attachment handling are unchanged.
   */
  async sendMail(
    ctx: TenantContext,
    connectionId: string,
    input: EngagementSendMailInput,
  ): Promise<EngagementMailSendResult> {
    const { connection, token } = await this.googleToken.loadConnection(ctx.tenantId, connectionId);
    // Defence in depth — resolvers already scope to the caller, but never send
    // through a mailbox the requesting user doesn't own (matches the Microsoft
    // adapter's assertConnectionAccess).
    if (connection.createdByUserId !== ctx.userId) {
      throw new ForbiddenException('You can only send from your own Google account');
    }
    const accessToken = await this.googleToken.getValidAccessToken(
      ctx.tenantId,
      connectionId,
      token,
    );

    const raw = buildGmailRawMessage(input);
    const correlationId = input.correlationId ?? '';

    // The request may die on the wire AFTER the body was transmitted, in which
    // case Gmail may already have accepted the message. That is genuinely
    // ambiguous, not a failure: letting the raw transport error escape would have
    // the send-intent worker record 'failed' and offer the user a retry, which can
    // duplicate a delivered email. Only the fetch itself is guarded — our own
    // HttpExceptions below are thrown after a response was received.
    let response: Response;
    try {
      response = await fetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });
    } catch (err) {
      if (isAmbiguousTransportFailure(err)) {
        throw new AmbiguousMailSendError(
          'The connection to Gmail failed before a result was returned; verify Sent Items before resending.',
          correlationId,
        );
      }
      throw err;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 403 insufficient scope => the connection was granted before gmail.send
      // was added to the scope set; the user must reconnect to re-consent.
      if (
        response.status === 403 &&
        /insufficient|scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)
      ) {
        throw new BadRequestException(
          'Reconnect Google Workspace in Settings to grant Capiro permission to send email on your behalf.',
        );
      }
      if (response.status === 401) {
        throw new BadRequestException(
          'Reconnect Google Workspace in Settings to continue sending email.',
        );
      }
      throw new ServiceUnavailableException(
        `Gmail send failed (${response.status}): ${text.slice(0, 300)}`,
      );
    }

    // HTTP 200 means Gmail ACCEPTED the message. From here on, failing loudly
    // would be wrong: the mail is already gone. A response we cannot read, or one
    // without an id, is genuinely AMBIGUOUS — the caller records the delivery as
    // 'unknown' and never retries it (a retry would duplicate a delivered email).
    let parsed: { id?: unknown; threadId?: unknown } | null = null;
    try {
      parsed = (await response.json()) as { id?: unknown; threadId?: unknown };
    } catch {
      throw new AmbiguousMailSendError(
        'Gmail accepted the message but its response could not be read; verify Sent Items.',
        correlationId,
      );
    }
    const messageId = typeof parsed?.id === 'string' ? parsed.id.trim() : '';
    if (!messageId) {
      throw new AmbiguousMailSendError(
        'Gmail returned success without a message id; verify Sent Items before resending.',
        correlationId,
      );
    }
    const threadId = typeof parsed?.threadId === 'string' ? parsed.threadId.trim() : '';
    return {
      ok: true,
      provider: 'gmail',
      providerMessageId: messageId,
      ...(threadId ? { providerThreadId: threadId } : {}),
      correlationId,
    };
  }
}

// ---- RFC 2822 MIME assembly (module-private, exported for unit tests) --------

/**
 * Build the base64url-encoded `raw` message for Gmail users.messages.send.
 * Bodies and attachments are base64-encoded (line-wrapped at 76 chars) so long
 * HTML lines and 8-bit content never violate SMTP line limits. The `From`
 * header is intentionally omitted — Gmail stamps the authenticated user's own
 * address, which also avoids "From must match a send-as alias" rejections.
 */
export function buildGmailRawMessage(input: EngagementSendMailInput): string {
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

  return Buffer.from(mime, 'utf8').toString('base64url');
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
