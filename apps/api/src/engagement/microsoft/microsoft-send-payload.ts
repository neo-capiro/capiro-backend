import type { MicrosoftGraphSendMailInput } from './microsoft-graph-sync.service.js';

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
