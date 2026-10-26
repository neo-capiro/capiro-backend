/** Newsletter's existing durable send owner, with current-access readback. No delivery policy. */
import {
  array,
  bool,
  nullable,
  object,
  receive,
  refuse,
  row,
  snapshot,
  text,
  timestamp,
  uuid,
  type ReceiveResult,
  type Rule,
} from './json-receiving.js';

export interface NewsletterSendReceipt {
  intentId: string;
  deduped: boolean;
}
export interface NewsletterDelivery {
  id: string;
  generationKey: string;
  recipientKey: string;
  status: string;
  attempt: number;
  provider: string;
  correlationId: string;
  to: Array<{ email: string; name?: string | null }>;
  cc: string[];
  bcc: string[];
  subject: string;
  providerMessageId: string | null;
  providerThreadId: string | null;
  providerDraftId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  acceptedAt: string | null;
}
export interface NewsletterSendIntent {
  id: string;
  outreachRecordId: string;
  requestKey: string;
  senderConnectionId: string;
  versionIds: string[];
  status: string;
  testMode: boolean;
  totals: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  deliveries: NewsletterDelivery[];
}
export interface NewsletterSendReadback {
  outreachRecordId: string;
  requestKey: string;
  /** Null is a read observation, not proof that an in-flight request cannot commit. */
  intent: NewsletterSendIntent | null;
}
export type NewsletterSendBinding = { recordId: string } & (
  | { requestKey: string; intentId?: string }
  | { intentId: string; requestKey?: string }
) & {
    senderConnectionId?: string;
    versionIds?: string[];
    testMode?: boolean;
  };
const count: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse(path);
};
const requestKey: Rule = (value, path) => {
  text(value, path);
  const key = value as string;
  if (key.length < 8 || key.length > 128 || key !== key.trim()) refuse(path);
};
const versionIds: Rule = (value, path) => {
  array(uuid, 500)(value, path);
  const ids = (value as string[]).map((id) => id.toLowerCase());
  if (!ids.length || new Set(ids).size !== ids.length) refuse(path);
};
const delivery = object({
  id: uuid,
  generationKey: text,
  recipientKey: text,
  status: text,
  attempt: count,
  provider: text,
  correlationId: uuid,
  to: array(object({ email: text }, { name: nullable(text) })),
  cc: array(text),
  bcc: array(text),
  subject: text,
  providerMessageId: nullable(text),
  providerThreadId: nullable(text),
  providerDraftId: nullable(text),
  errorCode: nullable(text),
  errorMessage: nullable(text),
  acceptedAt: nullable(timestamp),
});
const intent = object({
  id: uuid,
  outreachRecordId: uuid,
  requestKey,
  senderConnectionId: uuid,
  versionIds,
  status: text,
  testMode: bool,
  totals: (value, path) => {
    for (const [key, total] of Object.entries(row(value, path))) count(total, `${path}.${key}`);
  },
  error: nullable(text),
  startedAt: nullable(timestamp),
  finishedAt: nullable(timestamp),
  createdAt: timestamp,
  deliveries: array(delivery, 500),
});
/** This reply has no request/record echo; readback binds the resulting intent before use. */
export function parseNewsletterSendReceipt(value: unknown): ReceiveResult<NewsletterSendReceipt> {
  return receive(value, object({ intentId: uuid, deduped: bool }));
}
export function parseNewsletterSendReadback(
  value: unknown,
  expected: NewsletterSendBinding,
): ReceiveResult<NewsletterSendReadback> {
  return receive(
    value,
    object({ outreachRecordId: uuid, requestKey, intent: nullable(intent) }),
    (value) => {
      const binding = row(snapshot(expected), '$expected');
      object(
        { recordId: uuid },
        {
          requestKey,
          intentId: uuid,
          senderConnectionId: uuid,
          versionIds,
          testMode: bool,
        },
      )(binding, '$expected');
      if (!('requestKey' in binding) && !('intentId' in binding)) refuse('$expected');
      const result = row(value, '$');
      const sameId = (left: unknown, right: unknown) =>
        (left as string).toLowerCase() === (right as string).toLowerCase();
      if (!sameId(result.outreachRecordId, binding.recordId))
        refuse('$.outreachRecordId', 'identity_mismatch');
      if ('requestKey' in binding && result.requestKey !== binding.requestKey)
        refuse('$.requestKey', 'identity_mismatch');
      if (result.intent === null) {
        if ('intentId' in binding) refuse('$.intent', 'identity_mismatch');
        return;
      }
      const send = row(result.intent!, '$.intent');
      if (
        !sameId(send.outreachRecordId, result.outreachRecordId) ||
        send.requestKey !== result.requestKey
      )
        refuse('$.intent', 'identity_mismatch');
      for (const [field, expectedField] of [
        ['id', 'intentId'],
        ['senderConnectionId', 'senderConnectionId'],
      ] as const)
        if (expectedField in binding && !sameId(send[field], binding[expectedField]))
          refuse(`$.intent.${field}`, 'identity_mismatch');
      if ('testMode' in binding && send.testMode !== binding.testMode)
        refuse('$.intent.testMode', 'identity_mismatch');
      if ('versionIds' in binding) {
        const canonical = (ids: unknown) =>
          (ids as string[])
            .map((id) => id.toLowerCase())
            .sort()
            .join();
        if (canonical(send.versionIds) !== canonical(binding.versionIds))
          refuse('$.intent.versionIds', 'identity_mismatch');
      }
      const deliveries = send.deliveries as Array<{ id: string }>;
      if (
        deliveries.length !== (send.versionIds as string[]).length ||
        new Set(deliveries.map((item) => item.id.toLowerCase())).size !== deliveries.length
      )
        refuse('$.intent.deliveries');
    },
  );
}
