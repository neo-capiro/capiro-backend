import { EngagementProvider, Prisma } from '@prisma/client';
import { SingleMailLedger } from '../single-mail-ledger.js';
import { lockMailboxConnection } from '../mailbox-oauth-authority.js';
import { MailboxIdentityMismatchError } from '../mailbox-identity-mismatch.js';
import type { EngagementMailSendResult } from '../mail-send-result.js';
import { hasGraphReplySnapshot } from '../single-mail-reply.js';

export const GRAPH_IMMUTABLE_ID_HEADERS = { Prefer: 'IdType="ImmutableId"' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\x00-\x20]/.test(value);
export const metadataObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type GraphMailIdentity = {
  intentId: string;
  immutableId: string;
  conversationId: string;
  observed: boolean;
};

export function graphSendIdentity(result: EngagementMailSendResult): GraphMailIdentity | null {
  return result.provider === 'microsoft_graph' &&
    UUID.test(result.correlationId) &&
    id(result.providerImmutableMessageId) &&
    id(result.providerConversationId)
    ? {
        intentId: result.correlationId,
        immutableId: result.providerImmutableMessageId,
        conversationId: result.providerConversationId,
        observed: false,
      }
    : null;
}

/** Called only with an authenticated GET response requested in immutable-ID format. */
export function graphObservedIdentity(detail: {
  id?: unknown;
  conversationId?: unknown;
  isDraft?: unknown;
  internetMessageHeaders?: unknown;
}): GraphMailIdentity | null {
  if (
    !id(detail.id) ||
    !id(detail.conversationId) ||
    detail.isDraft !== false ||
    !Array.isArray(detail.internetMessageHeaders)
  )
    return null;
  const headers = detail.internetMessageHeaders
    .map(metadataObject)
    .filter(
      (header) =>
        typeof header.name === 'string' && header.name.toLowerCase() === 'x-capiro-delivery-id',
    );
  if (
    headers.length !== 1 ||
    typeof headers[0]!.value !== 'string' ||
    !UUID.test(headers[0]!.value)
  )
    return null;
  return {
    intentId: headers[0]!.value,
    immutableId: detail.id,
    conversationId: detail.conversationId,
    observed: true,
  };
}

export function storedGraphIdentity(metadata: unknown): GraphMailIdentity | null {
  const value = metadataObject(metadataObject(metadata).graphMailIdentity);
  return typeof value.intentId === 'string' &&
    UUID.test(value.intentId) &&
    id(value.immutableId) &&
    id(value.conversationId) &&
    typeof value.observed === 'boolean'
    ? (value as GraphMailIdentity)
    : null;
}

/** Retain only receipt-owned annotations alongside the provider's fresh metadata. */
export function graphReceiptMetadata(metadata: unknown, identity: GraphMailIdentity | null) {
  if (!identity) return {};
  const previous = metadataObject(metadata);
  return {
    graphMailIdentity: identity,
    ...Object.fromEntries(
      ['personIds', 'senderConnectionId', 'signaturePolicy', 'signatureAppended']
        .filter((key) => previous[key] !== undefined)
        .map((key) => [key, previous[key]]),
    ),
  };
}

/** The existing Graph/Google engagement write lock; no network operation may hold it. */
export async function lockMailReceiptWrites(tx: Prisma.TransactionClient, tenantId: string) {
  const key = `engagement-sync:${tenantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** Exact provider identity is evidence, never a grant to a different mailbox or actor. */
export async function acceptedGraphReceiptInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
  identity: GraphMailIdentity,
) {
  const connection = await lockMailboxConnection(tx, tenantId, connectionId);
  const intent = await SingleMailLedger.acceptedInTx(tx, tenantId, connectionId, identity.intentId);
  if (!intent) return null; // In particular, sending/unknown are unchanged.
  const evidence = metadataObject(intent.provider_evidence);
  if (
    evidence.provider !== 'microsoft_graph' ||
    evidence.correlationId !== identity.intentId ||
    evidence.providerImmutableMessageId !== identity.immutableId ||
    evidence.providerConversationId !== identity.conversationId ||
    ((intent.snapshot.threadId || intent.snapshot.operation || intent.snapshot.originalMessageId || intent.snapshot.replyIdentity) &&
      !hasGraphReplySnapshot(intent.snapshot, connectionId))
  )
    return null;
  if (
    connection.provider !== EngagementProvider.microsoft_365 ||
    !['connected', 'error'].includes(connection.status) ||
    connection.createdByUserId !== intent.actor_id ||
    typeof intent.snapshot.senderEmail !== 'string' ||
    connection.accountEmail?.toLowerCase() !== intent.snapshot.senderEmail.toLowerCase()
  ) {
    throw new MailboxIdentityMismatchError();
  }
  return intent;
}

/** At most one existing row may win. Existing ambiguous duplicates are retained. */
export async function graphReceiptMessageInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  connectionId: string,
  identity: GraphMailIdentity,
) {
  const rows = await tx.mailMessage.findMany({
    where: {
      tenantId,
      connectionId,
      AND: [
        { metadata: { path: ['graphMailIdentity', 'intentId'], equals: identity.intentId } },
        { metadata: { path: ['graphMailIdentity', 'immutableId'], equals: identity.immutableId } },
      ],
    },
    include: { thread: true },
    take: 2,
  });
  if (rows.length > 1) throw new MailboxIdentityMismatchError();
  const row = rows[0];
  if (
    row &&
    (row.connectionId !== connectionId ||
      row.thread?.connectionId !== connectionId ||
      !['manual', 'outlook'].includes(row.source) ||
      row.thread.source !== 'outlook' ||
      row.thread.externalId !== identity.conversationId ||
      storedGraphIdentity(row.metadata)?.conversationId !== identity.conversationId)
  ) {
    throw new MailboxIdentityMismatchError();
  }
  return row ?? null;
}
