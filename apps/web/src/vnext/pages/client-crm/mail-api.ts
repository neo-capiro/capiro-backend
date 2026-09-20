import type { AxiosInstance } from 'axios';

/**
 * In-app email — compose/send/rewrite. Mirrors the new routes on
 * apps/api/src/engagement/engagement.controller.ts (`/api/engagement/mail/*`,
 * `/api/engagement/mail-threads*`). Send goes out as the caller's own
 * connected mailbox (Microsoft Graph or Gmail) via the same
 * `EngagementMailSender`/`findCampaignSendConnection` every campaign send
 * already uses — this is the first single-recipient caller of that chain,
 * not a new send mechanism.
 */

export interface MailRecipient {
  email: string;
  name?: string | null;
}

export interface MailParticipant {
  email: string;
  name?: string | null;
  role: 'from' | 'to' | 'cc' | 'bcc';
}

export interface MailMessage {
  id: string;
  threadId: string;
  fromEmail: string | null;
  fromName: string | null;
  /**
   * NOTE: `to_recipients_jsonb` / `cc_recipients_jsonb` / `bcc_recipients_jsonb`
   * are Prisma `Json` columns (apps/api/prisma/schema.prisma, model
   * MailMessage) served straight through with no validation. This declared
   * shape is what the syncs WRITE, not what the column can HOLD — a reader
   * that walks these must guard with `Array.isArray` and a per-entry
   * `typeof entry === 'object'`, exactly as the API's own recipient reader in
   * engagement.service.ts does. An unguarded `for…of` over one of these
   * throws "is not iterable" on any row a provider wrote differently.
   */
  toRecipients: MailRecipient[];
  ccRecipients: MailRecipient[];
  bccRecipients: MailRecipient[];
  subject: string | null;
  bodyText: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface MailThread {
  id: string;
  clientId: string | null;
  subject: string;
  snippet: string | null;
  participants: MailParticipant[];
  lastMessageAt: string | null;
  messages: MailMessage[];
  /**
   * The caller's own connected-mailbox address for this thread, so a reply can
   * be built from the real to/cc/from participants minus "myself".
   *
   * Genuinely `null` in production, though not for the reason the schema's
   * `MailThread.connectionId String?` suggests: `getMailThread` filters on
   * `ownMailThreadWhere(ctx.userId)`, whose `connection: { createdByUserId }`
   * relation filter excludes rows with a NULL FK — a connection-less thread
   * 404s rather than arriving here with a null. The real null case is
   * `IntegrationConnection.accountEmail String?`, which is created null and
   * only conditionally backfilled: both OAuth callbacks write
   * `accountEmail: accountEmail ?? undefined` and Prisma skips an `undefined`
   * field, so a connection whose provider profile yielded no address stays
   * null for good.
   *
   * Consumers must therefore treat `null` as "identity unknown" and say so,
   * NOT as "nothing to exclude" — an is-me test that silently matches nobody
   * is how a reply ends up addressed back to the sender.
   */
  connectionEmail: string | null;
}

export interface EmailSignature {
  html: string | null;
  enabled: boolean;
}

export interface SendSingleMailInput {
  clientId?: string;
  personIds?: string[];
  to: MailRecipient[];
  cc?: MailRecipient[];
  bcc?: MailRecipient[];
  subject: string;
  bodyHtml: string;
  appendSignature?: boolean;
  threadId?: string;
  /** Ids from the existing attachments/upload-url + /confirm flow (CapabilityDrawerVNext's own pattern). */
  attachmentIds?: string[];
}

export interface SendSingleMailResult {
  ok: true;
  threadId: string;
  messageId: string;
  provider: 'microsoft_graph' | 'gmail';
  senderEmail: string | null;
}

export interface RewriteEmailInput {
  rawText: string;
  recipientName?: string;
  recipientTitle?: string;
  clientName?: string;
}

export interface RewriteEmailResult {
  bodyHtml: string;
  verified: boolean;
  unsupportedNumbers: string[];
  unsupportedNames: string[];
  provider: 'openai' | 'anthropic';
}

export function mailThreadsKey(clientId: string, recipientEmail?: string): readonly unknown[] {
  return recipientEmail
    ? (['mail-threads', clientId, recipientEmail] as const)
    : (['mail-threads', clientId] as const);
}

export async function listMailThreads(
  api: AxiosInstance,
  clientId: string,
  recipientEmail?: string,
): Promise<MailThread[]> {
  return (
    await api.get<MailThread[]>('/api/engagement/mail-threads', {
      params: { clientId, ...(recipientEmail ? { recipientEmails: recipientEmail } : {}) },
    })
  ).data;
}

export async function getMailThread(api: AxiosInstance, threadId: string): Promise<MailThread> {
  return (await api.get<MailThread>(`/api/engagement/mail-threads/${encodeURIComponent(threadId)}`)).data;
}

export async function getEmailSignature(api: AxiosInstance): Promise<EmailSignature> {
  return (await api.get<EmailSignature>('/api/me/email-signature')).data;
}

export async function sendSingleMail(
  api: AxiosInstance,
  input: SendSingleMailInput,
): Promise<SendSingleMailResult> {
  const result = (await api.post<SendSingleMailResult>('/api/engagement/mail/send', input)).data;
  if (!result || result.ok !== true || !result.messageId || !result.threadId) {
    throw new Error('The mail provider did not confirm that this email was sent.');
  }
  return result;
}

export async function rewriteEmail(
  api: AxiosInstance,
  input: RewriteEmailInput,
): Promise<RewriteEmailResult> {
  return (await api.post<RewriteEmailResult>('/api/engagement/mail/rewrite', input)).data;
}
