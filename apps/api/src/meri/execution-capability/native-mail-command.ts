import { BadRequestException, ConflictException } from '@nestjs/common';
import type { SendSingleMailInput } from '../../engagement/engagement.service.js';
import { mailReplyAddress } from '../../engagement/mail-reply-recipients.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const invalid = () => new BadRequestException('Review the exact mailbox, original, recipients and files before proposing mail.');
export interface NativeMailArguments extends Record<string, unknown> {
  mode: 'send' | 'reply' | 'reply_all' | 'forward'; clientId: string | null;
  senderConnectionId: string; senderEmail: string; to: string[]; cc: string[]; bcc: string[];
  subject: string; bodyHtml: string; files: Array<{ attachmentId: string; fileName: string; contentType: string; bytes: number; sha256: string }>;
  original: null | { threadId: string; messageId: string; updatedAt: string; bodySha256: string | null };
}

/** Closed command codec. Addresses are explicit and canonical; this never resolves names or defaults a mailbox. */
export function parseNativeMailArguments(raw: unknown): NativeMailArguments {
  try {
    const a = retainedReadObject(raw, ['mode', 'clientId', 'senderConnectionId', 'senderEmail', 'to', 'cc', 'bcc',
      'subject', 'bodyHtml', 'files', 'original']);
    const id = (v: unknown) => typeof v === 'string' && UUID.test(v);
    const email = (v: unknown) => typeof v === 'string' && v.length <= 254 && mailReplyAddress(v) === v;
    if (!['send', 'reply', 'reply_all', 'forward'].includes(String(a.mode)) || !id(a.senderConnectionId) ||
        a.clientId !== null && !id(a.clientId) || !email(a.senderEmail)) throw invalid();
    for (const [key, max] of [['to', 50], ['cc', 10], ['bcc', 10]] as const) {
      if (!Array.isArray(a[key]) || a[key].length > max || key === 'to' && !a[key].length || a[key].some(v => !email(v))) throw invalid();
    }
    const addresses = [...a.to as string[], ...a.cc as string[], ...a.bcc as string[]];
    if (new Set(addresses).size !== addresses.length || typeof a.subject !== 'string' || !a.subject.trim() ||
        a.subject.length > 300 || /[\r\n]/.test(a.subject) || typeof a.bodyHtml !== 'string' || !a.bodyHtml.trim() ||
        a.bodyHtml.length > 50000 || !Array.isArray(a.files) || a.files.length > 5) throw invalid();
    const files = a.files.map(value => retainedReadObject(value, ['attachmentId', 'fileName', 'contentType', 'bytes', 'sha256']));
    if (new Set(files.map(f => f.attachmentId)).size !== files.length || files.some(f => !id(f.attachmentId) ||
        typeof f.fileName !== 'string' || !f.fileName.length || f.fileName.length > 255 || /[\r\n]/.test(f.fileName) ||
        typeof f.contentType !== 'string' || !f.contentType.length || f.contentType.length > 255 || /[\r\n]/.test(f.contentType) ||
        !Number.isSafeInteger(f.bytes) || Number(f.bytes) < 0 || Number(f.bytes) > 3 * 1024 * 1024 ||
        typeof f.sha256 !== 'string' || !SHA.test(f.sha256))) throw invalid();
    if (a.mode === 'send') { if (a.original !== null) throw invalid(); }
    else {
      const o = retainedReadObject(a.original, ['threadId', 'messageId', 'updatedAt', 'bodySha256']);
      if (!id(o.threadId) || !id(o.messageId) || typeof o.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(o.updatedAt)) || new Date(o.updatedAt).toISOString() !== o.updatedAt ||
          (a.mode === 'forward' ? typeof o.bodySha256 !== 'string' || !SHA.test(o.bodySha256) : o.bodySha256 !== null) ||
          (a.bcc as string[]).length) throw invalid();
    }
    return retainedReadSnapshot(a, 262144) as NativeMailArguments;
  } catch { throw invalid(); }
}

export function nativeMailInput(a: NativeMailArguments, requestKey: string): SendSingleMailInput {
  const base = { requestKey, senderConnectionId: a.senderConnectionId, clientId: a.clientId ?? undefined,
    to: a.to.map(email => ({ email })), cc: a.cc.map(email => ({ email })), bcc: a.bcc.map(email => ({ email })),
    subject: a.subject, bodyHtml: a.bodyHtml, attachmentIds: a.files.map(file => file.attachmentId), appendSignature: true };
  if (a.mode === 'send') return base;
  if (!a.original) throw invalid();
  return { ...base, operation: a.mode, threadId: a.original.threadId, originalMessageId: a.original.messageId,
    originalUpdatedAt: a.original.updatedAt, ...(a.mode === 'forward' ? { originalBodySha256: a.original.bodySha256! } : {}) };
}

/** Only committed accepted/failed states are terminal. Accepted without a local receipt stays uncertain. */
export function nativeMailResult(raw: unknown, a: NativeMailArguments, requestKey: string) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (r.requestKey !== requestKey || typeof r.intentId !== 'string' || !UUID.test(r.intentId) || r.retryable !== false)
    throw new ConflictException('Native mail receipt differs from its request');
  const base = { state: r.state, intentId: r.intentId, requestKey, retryable: false as const };
  if (r.state === 'failed') return { ...base, state: 'failed' as const };
  if (['pending', 'sending', 'unknown'].includes(String(r.state)) || r.state === 'accepted' && r.ok !== true) return null;
  if (r.state !== 'accepted' || !['threadId', 'messageId'].every(k => typeof r[k] === 'string' && UUID.test(r[k] as string)) ||
      !['gmail', 'microsoft_graph'].includes(String(r.provider)) || r.senderConnectionId !== a.senderConnectionId ||
      (typeof r.senderEmail !== 'string' || mailReplyAddress(r.senderEmail) !== a.senderEmail) || r.signaturePolicy !== 'actor' || typeof r.signatureAppended !== 'boolean' ||
      (a.mode === 'send' ? r.operation !== undefined : !a.original || r.operation !== a.mode ||
        r.originalMessageId !== a.original.messageId || r.originalThreadId !== a.original.threadId ||
        r.originalUpdatedAt !== a.original.updatedAt || a.mode === 'forward' && r.originalBodySha256 !== a.original.bodySha256) ||
      r.mailboxConfirmation !== undefined && !['pending', 'confirmed'].includes(String(r.mailboxConfirmation)))
    throw new ConflictException('Native mail receipt differs from its request');
  return { ...base, state: 'accepted' as const, threadId: r.threadId as string, messageId: r.messageId as string,
    provider: r.provider as 'gmail' | 'microsoft_graph', senderConnectionId: a.senderConnectionId, senderEmail: a.senderEmail,
    mode: a.mode, original: a.original, signaturePolicy: 'actor' as const, signatureAppended: r.signatureAppended,
    mailboxConfirmation: r.mailboxConfirmation as 'pending' | 'confirmed' | undefined ?? null };
}
