import type { MicrosoftGraphSendMailInput } from './microsoft-graph-sync.service.js';
import { BadRequestException } from '@nestjs/common';
import { buildMailMime } from '../mail-mime.js';
import { REPLY_UNAVAILABLE, storedGraphReplyIdentity } from '../single-mail-reply.js';
import { definiteMailSendRejection } from '../mail-send-result.js';

/** Graph createReply accepts standard base64 MIME as text/plain, not a JSON string. */
export function buildMicrosoftReplyPayload(input: MicrosoftGraphSendMailInput): string {
  const reply = storedGraphReplyIdentity(input.reply);
  if (
    !reply ||
    input.subject !== reply.subject ||
    input.toRecipients.length !== 1 ||
    input.toRecipients[0]?.email.toLowerCase() !== reply.toEmail ||
    input.ccRecipients?.length ||
    input.bccRecipients?.length ||
    (input.attachments?.length ?? 0) > 5 ||
    !sanitizeGraphHeaderValue(input.correlationId)
  )
    throw definiteMailSendRejection(new BadRequestException(REPLY_UNAVAILABLE));
  return buildMailMime(input).toString('base64');
}

/** Strict captured-draft comparison; provider additions/normalization are not silently accepted. */
export function assertMicrosoftReplyDraft(
  input: MicrosoftGraphSendMailInput,
  draft: unknown,
  attachments: unknown,
  identity: { id: string; conversationId: string },
  senderEmail: string,
) {
  const refuse = () => {
    throw definiteMailSendRejection(
      new BadRequestException(
        'Outlook changed the reply draft. No reply was sent. Reopen the original in Outlook.',
      ),
    );
  };
  const object = (value: unknown): Record<string, any> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : null);
  const row = object(draft),
    files = object(attachments),
    reply = storedGraphReplyIdentity(input.reply);
  const emails = (value: unknown) =>
    Array.isArray(value) ? value.map((v) => object(object(v).emailAddress).address) : null;
  const headers = Array.isArray(row.internetMessageHeaders)
    ? row.internetMessageHeaders.map(object)
    : [];
  const header = (name: string, expected: string) => {
    const found = headers.filter(
      (h) => typeof h.name === 'string' && h.name.toLowerCase() === name,
    );
    return found.length === 1 && found[0]!.value === expected;
  };
  if (
    !reply ||
    row.id !== identity.id ||
    row.conversationId !== identity.conversationId ||
    row.isDraft !== true ||
    row.subject !== input.subject ||
    object(row.body).content !== input.body ||
    lower(object(row.body).contentType) !== (input.bodyContentType ?? 'Text').toLowerCase() ||
    JSON.stringify(
      emails(row.toRecipients)?.map((v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)),
    ) !== JSON.stringify([reply.toEmail]) ||
    JSON.stringify(emails(row.ccRecipients)) !== '[]' ||
    JSON.stringify(emails(row.bccRecipients)) !== '[]' ||
    JSON.stringify(emails(row.replyTo)) !== '[]' ||
    lower(object(object(row.from).emailAddress).address) !== senderEmail.toLowerCase() ||
    lower(object(object(row.sender).emailAddress).address) !== senderEmail.toLowerCase() ||
    !header('x-capiro-delivery-id', input.correlationId!) ||
    !header('in-reply-to', reply.inReplyTo) ||
    !header('references', reply.references) ||
    files['@odata.nextLink'] ||
    !Array.isArray(files.value) ||
    files.value.length !== (input.attachments?.length ?? 0) ||
    row.hasAttachments !== Boolean(input.attachments?.length)
  )
    refuse();
  const remaining = [...(input.attachments ?? [])];
  for (const file of files.value) {
    const attachment = object(file);
    if (
      attachment['@odata.type'] !== '#microsoft.graph.fileAttachment' ||
      attachment.isInline !== false ||
      attachment.contentId ||
      typeof attachment.contentBytes !== 'string'
    )
      refuse();
    const index = remaining.findIndex(
      (expected) =>
        expected.name === attachment.name &&
        expected.contentType === attachment.contentType &&
        expected.contentBytes === attachment.contentBytes,
    );
    if (index < 0) refuse();
    remaining.splice(index, 1);
  }
}

/** The same draft body is measured before dispatch and serialized by Graph. */
export function buildMicrosoftSendPayload(input: MicrosoftGraphSendMailInput) {
  const toGraphRecipients = (list: Array<{ email: string; name?: string | null }> | undefined) =>
    (list ?? []).map((recipient) => ({
      emailAddress: {
        address: recipient.email,
        ...(recipient.name ? { name: recipient.name } : {}),
      },
    }));
  const correlationHeader = sanitizeGraphHeaderValue(input.correlationId);
  return {
    subject: input.subject,
    body: {
      contentType: input.bodyContentType ?? 'Text',
      content: input.body,
    },
    toRecipients: toGraphRecipients(input.toRecipients),
    ...(input.ccRecipients?.length ? { ccRecipients: toGraphRecipients(input.ccRecipients) } : {}),
    ...(input.bccRecipients?.length
      ? { bccRecipients: toGraphRecipients(input.bccRecipients) }
      : {}),
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((a) => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: a.name,
            contentType: a.contentType,
            contentBytes: a.contentBytes,
          })),
        }
      : {}),
    ...(correlationHeader
      ? { internetMessageHeaders: [{ name: 'X-Capiro-Delivery-Id', value: correlationHeader }] }
      : {}),
  };
}

/**
 * Allow only id-safe characters in the X-Capiro-Delivery-Id header value. A UUID
 * passes through untouched; anything containing CR/LF or header punctuation is
 * dropped rather than escaped — no legitimate delivery id needs them.
 */
export function sanitizeGraphHeaderValue(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.trim();
  if (!clean || clean.length > 80) return null;
  return /^[A-Za-z0-9._:-]+$/.test(clean) ? clean : null;
}
