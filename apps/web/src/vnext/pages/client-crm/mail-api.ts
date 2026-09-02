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
}

export interface EmailSignature {
  html: string | null;
  enabled: boolean;
}

export interface SendSingleMailInput {
  clientId?: string;
  personId?: string;
  to: MailRecipient;
  cc?: MailRecipient[];
  bcc?: MailRecipient[];
  subject: string;
  bodyHtml: string;
  appendSignature?: boolean;
  threadId?: string;
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
  return (await api.post<SendSingleMailResult>('/api/engagement/mail/send', input)).data;
}

export async function rewriteEmail(
  api: AxiosInstance,
  input: RewriteEmailInput,
): Promise<RewriteEmailResult> {
  return (await api.post<RewriteEmailResult>('/api/engagement/mail/rewrite', input)).data;
}
