/** Bounded reply projection shared by the canonical reader, admission and Gmail adapter. */
export const REPLY_UNAVAILABLE =
  'Native reply is unavailable for this original. Reply from your mailbox.';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const providerId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2048 &&
  !/[\x00-\x20]/.test(value);
const messageId = /^<[^<>\s@\x00-\x1f]+@[^<>\s@\x00-\x1f]+>$/;

// Intentionally supports one unambiguous address. Complex lists are unsupported,
// never partially parsed into a different recipient. No alias identity is inferred.
function address(value: string): string | null {
  const match = /^(?:[^<>@,;\r\n]*<([^<>]+)>|([^<>]+))$/.exec(value.trim());
  const email = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    ? email
    : null;
}

export type GmailReplyIdentity = {
  kind?: 'gmail';
  messageId: string;
  threadId: string;
  inReplyTo: string;
  references: string;
  subject: string;
  toEmail: string;
  fromEmail: string;
};
export type GraphReplyIdentity = {
  kind: 'microsoft_graph';
  immutableId: string;
  conversationId: string;
  changeKey: string;
  subject: string;
  fromEmail: string;
  senderEmail: string;
  toEmail: string;
  replyTo: string[];
  inReplyTo: string;
  references: string;
};
export type MailReplyIdentity = GmailReplyIdentity | GraphReplyIdentity;
export type MailReplyContext =
  | {
      supported: true;
      operation: 'reply';
      originalMessageId: string;
      originalUpdatedAt: string;
      senderConnectionId: string;
      subject: string;
      to: [{ email: string }];
    }
  | { supported: false; reason: string };
export type PreparedMailReply = {
  context: Extract<MailReplyContext, { supported: true }>;
  provider: MailReplyIdentity;
};

/** Only an authenticated GET made with immutable-ID Prefer may supply this detail. */
export function graphReplyIdentity(value: unknown): GraphReplyIdentity | null {
  const raw = object(value);
  if (
    !providerId(raw.id) ||
    !providerId(raw.conversationId) ||
    !providerId(raw.changeKey) ||
    raw.isDraft !== false ||
    !Array.isArray(raw.replyTo) ||
    raw.replyTo.length > 1 ||
    !Array.isArray(raw.internetMessageHeaders) ||
    raw.internetMessageHeaders.length > 200
  )
    return null;
  const email = (v: unknown) => {
    const text = object(object(v).emailAddress).address;
    return typeof text === 'string' ? address(text) : null;
  };
  const fromEmail = email(raw.from),
    senderEmail = email(raw.sender),
    replyTo = raw.replyTo.map(email);
  if (!fromEmail || senderEmail !== fromEmail || replyTo.some((v) => !v)) return null;
  const header = (name: string, optional = false) => {
    const rows = (raw.internetMessageHeaders as unknown[])
      .map(object)
      .filter((h) => typeof h.name === 'string' && h.name.toLowerCase() === name);
    if (!rows.length && optional) return '';
    return rows.length === 1 &&
      typeof rows[0]!.value === 'string' &&
      rows[0]!.value.length <= 8192 &&
      !/[\x00-\x1f\x7f]/.test(rows[0]!.value)
      ? rows[0]!.value.trim()
      : null;
  };
  const parent = header('message-id'),
    refs = header('references', true),
    subject = raw.subject;
  if (
    typeof subject !== 'string' ||
    !subject ||
    subject.length > 300 ||
    /[\x00-\x1f\x7f]/.test(subject) ||
    !parent ||
    parent !== raw.internetMessageId ||
    parent.length > 1024 ||
    !messageId.test(parent) ||
    refs === null
  )
    return null;
  const chain = refs ? refs.split(/ +/) : [];
  if (
    chain.length > 49 ||
    chain.some((v) => v.length > 1024 || !messageId.test(v)) ||
    new Set(chain).size !== chain.length
  )
    return null;
  const references = [...chain.filter((v) => v !== parent), parent].join(' ');
  if (references.length > 8192) return null;
  return {
    kind: 'microsoft_graph',
    immutableId: raw.id,
    conversationId: raw.conversationId,
    changeKey: raw.changeKey,
    subject,
    fromEmail,
    senderEmail,
    toEmail: replyTo[0] ?? fromEmail,
    replyTo: replyTo as string[],
    inReplyTo: parent,
    references,
  };
}

/** Closed server snapshot; never accept a default Graph ID as an immutable identity. */
export function storedGraphReplyIdentity(value: unknown): GraphReplyIdentity | null {
  const row = object(value);
  if (
    Object.keys(row).sort().join(',') !==
      'changeKey,conversationId,fromEmail,immutableId,inReplyTo,kind,references,replyTo,senderEmail,subject,toEmail' ||
    row.kind !== 'microsoft_graph' ||
    !Array.isArray(row.replyTo)
  )
    return null;
  const mailbox = (email: unknown) => ({ emailAddress: { address: email } });
  const projection = graphReplyIdentity({
    id: row.immutableId,
    conversationId: row.conversationId,
    changeKey: row.changeKey,
    isDraft: false,
    subject: row.subject,
    from: mailbox(row.fromEmail),
    sender: mailbox(row.senderEmail),
    replyTo: row.replyTo.map(mailbox),
    internetMessageId: row.inReplyTo,
    internetMessageHeaders: [
      { name: 'Message-ID', value: row.inReplyTo },
      { name: 'References', value: row.references },
    ],
  });
  return projection &&
    Object.keys(projection).every(
      (k) => JSON.stringify(projection[k as keyof GraphReplyIdentity]) === JSON.stringify(row[k]),
    )
    ? projection
    : null;
}

/** Accepted ledger snapshots are server-authored. Source deletion after acceptance cannot revoke the outcome. */
export function hasGraphReplySnapshot(value: unknown, connectionId: string): boolean {
  const snapshot = object(value),
    reply = storedGraphReplyIdentity(snapshot.replyIdentity);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const recipient =
    Array.isArray(snapshot.to) && snapshot.to.length === 1 ? object(snapshot.to[0]).email : null;
  return Boolean(
    reply &&
    snapshot.operation === 'reply' &&
    snapshot.senderConnectionId === connectionId &&
    typeof snapshot.threadId === 'string' &&
    uuid.test(snapshot.threadId) &&
    typeof snapshot.originalMessageId === 'string' &&
    uuid.test(snapshot.originalMessageId) &&
    typeof snapshot.originalUpdatedAt === 'string' &&
    Number.isFinite(Date.parse(snapshot.originalUpdatedAt)) &&
    new Date(snapshot.originalUpdatedAt).toISOString() === snapshot.originalUpdatedAt &&
    snapshot.subject === reply.subject &&
    typeof recipient === 'string' &&
    recipient.toLowerCase() === reply.toEmail &&
    Array.isArray(snapshot.cc) &&
    snapshot.cc.length === 0 &&
    Array.isArray(snapshot.bcc) &&
    snapshot.bcc.length === 0,
  );
}

/** Only authenticated, captured Gmail metadata is an input to this projection. */
export function gmailReplyIdentity(value: unknown): GmailReplyIdentity | null {
  const raw = object(value),
    payload = object(raw.payload);
  if (
    !providerId(raw.id) ||
    !providerId(raw.threadId) ||
    !Array.isArray(raw.labelIds) ||
    raw.labelIds.some(
      (label) => typeof label !== 'string' || ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label),
    ) ||
    !Array.isArray(payload.headers) ||
    payload.headers.length > 200
  )
    return null;
  const headers = payload.headers;
  const header = (name: string, optional = false): string | null => {
    const matches = headers
      .map(object)
      .filter((h) => typeof h.name === 'string' && h.name.toLowerCase() === name);
    if (!matches.length && optional) return '';
    const value = matches[0]?.value;
    return matches.length === 1 &&
      typeof value === 'string' &&
      value.length <= 8192 &&
      !/[\x00-\x1f\x7f]/.test(value)
      ? value.trim()
      : null;
  };
  const subject = header('subject'),
    parent = header('message-id'),
    refs = header('references', true);
  const from = header('from'),
    replyTo = header('reply-to', true);
  if (
    !subject ||
    subject.length > 300 ||
    !parent ||
    parent.length > 1024 ||
    !messageId.test(parent) ||
    refs === null ||
    from === null ||
    replyTo === null
  )
    return null;
  const fromEmail = address(from),
    toEmail = address(replyTo || from);
  const chain = refs ? refs.split(/ +/) : [];
  if (
    !fromEmail ||
    !toEmail ||
    chain.length > 49 ||
    chain.some((id) => id.length > 1024 || !messageId.test(id)) ||
    new Set(chain).size !== chain.length
  )
    return null;
  const references = [...chain.filter((id) => id !== parent), parent].join(' ');
  if (references.length > 8192) return null;
  return {
    messageId: raw.id,
    threadId: raw.threadId,
    inReplyTo: parent,
    references,
    subject,
    toEmail,
    fromEmail,
  };
}

export function prepareMailReply(
  source: {
    id: string;
    threadId: string;
    connectionId: string | null;
    source: string;
    externalId: string | null;
    subject: string | null;
    fromEmail: string | null;
    updatedAt: Date;
    removedAt: Date | null;
    raw: unknown;
  },
  thread: { id: string; connectionId: string | null; source: string; externalId: string | null },
  connection: { id: string; provider: string; status: string; accountEmail: string | null },
  selfEmails: readonly string[],
): PreparedMailReply | null {
  const graph = connection.provider === 'microsoft_365';
  const capture = object(object(source.raw).graphReplySource);
  const provider = graph
    ? storedGraphReplyIdentity(capture.identity)
    : gmailReplyIdentity(source.raw);
  const sourceId = provider?.kind === 'microsoft_graph' ? capture.defaultId : provider?.messageId;
  const conversation =
    provider?.kind === 'microsoft_graph' ? provider.conversationId : provider?.threadId;
  if (
    !provider ||
    (graph && capture.schema !== 'graph-native-reply/1') ||
    source.removedAt !== null ||
    source.source !== (graph ? 'outlook' : 'google') ||
    thread.source !== source.source ||
    connection.provider !== (graph ? 'microsoft_365' : 'google_workspace') ||
    connection.status !== 'connected' ||
    !connection.accountEmail ||
    source.threadId !== thread.id ||
    source.connectionId !== connection.id ||
    thread.connectionId !== connection.id ||
    sourceId !== source.externalId ||
    conversation !== thread.externalId ||
    provider.subject !== source.subject ||
    provider.fromEmail !== source.fromEmail?.toLowerCase() ||
    !(source.updatedAt instanceof Date) ||
    !Number.isFinite(source.updatedAt.getTime()) ||
    [...selfEmails, connection.accountEmail].some(
      (email) =>
        email.toLowerCase() === provider.toEmail || email.toLowerCase() === provider.fromEmail,
    )
  )
    return null;
  return {
    provider,
    context: {
      supported: true,
      operation: 'reply',
      originalMessageId: source.id,
      originalUpdatedAt: source.updatedAt.toISOString(),
      senderConnectionId: connection.id,
      subject: provider.subject,
      to: [{ email: provider.toEmail }],
    },
  };
}
