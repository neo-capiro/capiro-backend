/** Bounded reply projection shared by the canonical reader, admission and Gmail adapter. */
export const REPLY_UNAVAILABLE = 'Native reply is unavailable for this original. Reply from your mailbox.';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const providerId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x20]/.test(value);
const messageId = /^<[^<>\s@\x00-\x1f]+@[^<>\s@\x00-\x1f]+>$/;

// Intentionally supports one unambiguous address. Complex lists are unsupported,
// never partially parsed into a different recipient. No alias identity is inferred.
function address(value: string): string | null {
  const match = /^(?:[^<>@,;\r\n]*<([^<>]+)>|([^<>]+))$/.exec(value.trim());
  const email = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    ? email : null;
}

export type GmailReplyIdentity = {
  messageId: string; threadId: string; inReplyTo: string; references: string;
  subject: string; toEmail: string; fromEmail: string;
};
export type MailReplyContext = {
  supported: true; operation: 'reply'; originalMessageId: string; originalUpdatedAt: string;
  senderConnectionId: string; subject: string; to: [{ email: string }];
} | { supported: false; reason: string };
export type PreparedMailReply = { context: Extract<MailReplyContext, { supported: true }>; provider: GmailReplyIdentity };

/** Only authenticated, captured Gmail metadata is an input to this projection. */
export function gmailReplyIdentity(value: unknown): GmailReplyIdentity | null {
  const raw = object(value), payload = object(raw.payload);
  if (!providerId(raw.id) || !providerId(raw.threadId) || !Array.isArray(raw.labelIds) ||
      raw.labelIds.some(label => typeof label !== 'string' || ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label)) ||
      !Array.isArray(payload.headers) || payload.headers.length > 200) return null;
  const headers = payload.headers;
  const header = (name: string, optional = false): string | null => {
    const matches = headers.map(object).filter(h => typeof h.name === 'string' && h.name.toLowerCase() === name);
    if (!matches.length && optional) return '';
    const value = matches[0]?.value;
    return matches.length === 1 && typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value)
      ? value.trim() : null;
  };
  const subject = header('subject'), parent = header('message-id'), refs = header('references', true);
  const from = header('from'), replyTo = header('reply-to', true);
  if (!subject || subject.length > 300 || !parent || parent.length > 1024 || !messageId.test(parent) ||
      refs === null || from === null || replyTo === null) return null;
  const fromEmail = address(from), toEmail = address(replyTo || from);
  const chain = refs ? refs.split(/ +/) : [];
  if (!fromEmail || !toEmail || chain.length > 49 || chain.some(id => id.length > 1024 || !messageId.test(id)) ||
      new Set(chain).size !== chain.length) return null;
  const references = [...chain.filter(id => id !== parent), parent].join(' ');
  if (references.length > 8192) return null;
  return { messageId: raw.id, threadId: raw.threadId, inReplyTo: parent, references, subject, toEmail, fromEmail };
}

export function prepareMailReply(
  source: { id: string; threadId: string; connectionId: string | null; source: string;
    externalId: string | null; subject: string | null; fromEmail: string | null; updatedAt: Date; removedAt: Date | null; raw: unknown },
  thread: { id: string; connectionId: string | null; source: string; externalId: string | null },
  connection: { id: string; provider: string; status: string; accountEmail: string | null },
  selfEmails: readonly string[],
): PreparedMailReply | null {
  const provider = gmailReplyIdentity(source.raw);
  if (!provider || source.removedAt !== null || source.source !== 'google' || thread.source !== 'google' ||
      connection.provider !== 'google_workspace' || connection.status !== 'connected' || !connection.accountEmail ||
      source.threadId !== thread.id || source.connectionId !== connection.id || thread.connectionId !== connection.id ||
      provider.messageId !== source.externalId || provider.threadId !== thread.externalId ||
      provider.subject !== source.subject || provider.fromEmail !== source.fromEmail?.toLowerCase() ||
      !(source.updatedAt instanceof Date) || !Number.isFinite(source.updatedAt.getTime()) ||
      [...selfEmails, connection.accountEmail].some(email => email.toLowerCase() === provider.toEmail || email.toLowerCase() === provider.fromEmail)) return null;
  return { provider, context: { supported: true, operation: 'reply', originalMessageId: source.id,
    originalUpdatedAt: source.updatedAt.toISOString(), senderConnectionId: connection.id,
    subject: provider.subject, to: [{ email: provider.toEmail }] } };
}
