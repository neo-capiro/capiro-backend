import { Injectable } from '@nestjs/common';
import { sha256Text } from '../knowledge.helpers.js';
import type {
  MailboxMessageRecord,
  MailboxRecipient,
  NormalizedMailboxMessage,
} from './mailbox-knowledge.types.js';

const MAX_SOURCE_CHARS = 10_000_000;
const QUOTED_REPLY_PATTERNS = [
  /^on\s.+wrote:\s*$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^_{8,}\s*$/,
  /^from:\s.+$/i,
];
const CONFIDENTIALITY_PATTERNS = [
  /confidentiality notice/i,
  /this (?:e-?mail|message)(?: and any attachments)? (?:is|are) intended only/i,
  /if you are not the intended recipient/i,
  /privileged and confidential/i,
  /unauthorized (?:review|use|disclosure|distribution)/i,
];
const SIGNOFF_PATTERN = /^(?:best|best regards|kind regards|regards|sincerely|thanks|thank you|warmly|respectfully)[,!]?$/i;
const CONTACT_DETAIL_PATTERN = /(?:@|\+?\d[\d\s().-]{7,}|www\.|https?:\/\/|director|manager|partner|president|chief|capiro)/i;

/**
 * Produces two deterministic representations:
 * - authoritativeText: canonical provider text used for SHA-256 and evidence offsets;
 * - normalizedText: signatures, quoted history, notices, and boilerplate removed for
 *   relevance/extraction. It is never used as the Phase 3 evidence hash.
 */
@Injectable()
export class MailboxNormalizerService {
  normalize(message: MailboxMessageRecord): NormalizedMailboxMessage {
    const source = (message.bodyText ?? '').slice(0, MAX_SOURCE_CHARS);
    const html = looksLikeHtml(source);
    const authoritativeText = canonicalizeText(html ? htmlToText(source) : source);
    const cleaned = cleanInstitutionalText(authoritativeText);

    return {
      authoritativeText,
      normalizedText: cleaned.text,
      authoritativeContentHash: sha256Text(authoritativeText),
      normalizedContentHash: sha256Text(cleaned.text),
      subject: canonicalizeText(message.subject ?? ''),
      sender: normalizeRecipient(
        message.fromEmail ? { email: message.fromEmail, name: message.fromName } : null,
      ),
      toRecipients: normalizeRecipients(message.toRecipients),
      ccRecipients: normalizeRecipients(message.ccRecipients),
      bccRecipients: normalizeRecipients(message.bccRecipients),
      stripped: {
        html,
        quotedHistory: cleaned.quotedHistory,
        signature: cleaned.signature,
        confidentialityNotice: cleaned.confidentialityNotice,
      },
      lengths: {
        source: source.length,
        authoritative: authoritativeText.length,
        normalized: cleaned.text.length,
      },
    };
  }
}

export function canonicalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  const withoutInvisible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg|canvas|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withoutInvisible);
}

export function cleanInstitutionalText(value: string): {
  text: string;
  quotedHistory: boolean;
  signature: boolean;
  confidentialityNotice: boolean;
} {
  let lines = canonicalizeText(value).split('\n');
  let quotedHistory = false;
  let signature = false;
  let confidentialityNotice = false;

  const quoteIndex = findQuotedHistoryStart(lines);
  if (quoteIndex >= 0) {
    lines = lines.slice(0, quoteIndex);
    quotedHistory = true;
  }

  const noticeIndex = lines.findIndex((line) =>
    CONFIDENTIALITY_PATTERNS.some((pattern) => pattern.test(line.trim())),
  );
  if (noticeIndex >= 0) {
    lines = lines.slice(0, noticeIndex);
    confidentialityNotice = true;
  }

  const signatureIndex = findSignatureStart(lines);
  if (signatureIndex >= 0) {
    lines = lines.slice(0, signatureIndex);
    signature = true;
  }

  const text = canonicalizeText(
    lines
      .filter((line) => !/^>/.test(line.trimStart()))
      .join('\n'),
  );
  if (text.length > 0) {
    return { text, quotedHistory, signature, confidentialityNotice };
  }

  // Fail useful, not imaginative: if every line was classified as boilerplate,
  // preserve the canonical provider text for relevance to mark insufficient.
  return {
    text: canonicalizeText(value),
    quotedHistory,
    signature,
    confidentialityNotice,
  };
}

function findQuotedHistoryStart(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (/^>/.test(line)) return index;
    if (!QUOTED_REPLY_PATTERNS.some((pattern) => pattern.test(line))) continue;

    // A normal sentence may begin with "From:". Treat it as an Outlook header
    // only when nearby lines also look like Sent/To/Cc/Subject headers.
    if (/^from:/i.test(line)) {
      const headerWindow = lines.slice(index, index + 6).join('\n');
      if (!/^sent:|^to:|^cc:|^subject:/im.test(headerWindow)) continue;
    }
    return index;
  }
  return -1;
}

function findSignatureStart(lines: string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (/^--\s*$/.test(lines[index] ?? '')) return index;
  }

  const start = Math.max(0, lines.length - 12);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!SIGNOFF_PATTERN.test(line)) continue;
    const tail = lines.slice(index + 1).join(' ');
    if (tail.length === 0 || CONTACT_DETAIL_PATTERN.test(tail)) return index;
  }
  return -1;
}

function normalizeRecipients(values: MailboxRecipient[]): MailboxRecipient[] {
  const seen = new Set<string>();
  const normalized: MailboxRecipient[] = [];
  for (const value of values ?? []) {
    const recipient = normalizeRecipient(value);
    if (!recipient || seen.has(recipient.email)) continue;
    seen.add(recipient.email);
    normalized.push(recipient);
  }
  return normalized;
}

function normalizeRecipient(value: MailboxRecipient | null): MailboxRecipient | null {
  const email = value?.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = value?.name?.trim() || null;
  return { email, name };
}

function looksLikeHtml(value: string): boolean {
  return /<\/?(?:html|body|div|p|br|table|span|blockquote|a)\b/i.test(value);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hexadecimal = entity[1]?.toLowerCase() === 'x';
      const digits = entity.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}
