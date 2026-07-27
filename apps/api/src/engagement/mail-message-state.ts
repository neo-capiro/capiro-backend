/**
 * Provider-neutral mail-message removal state.
 *
 * Gmail Trash/Spam/delete and Microsoft Graph "@removed" events both need the
 * SAME contract: mark a message removed without ever deleting the row or
 * clearing its body, then recompute the owning thread's snippet/lastMessageAt
 * from whatever active message remains. Centralizing that here (rather than
 * duplicating it per provider) is what lets the timeline and AI evidence
 * queries exclude removed content with one predicate instead of two.
 */
import { Prisma, type EngagementSource } from '@prisma/client';

export type MailRemovalReason = 'deleted' | 'trashed' | 'spam' | 'provider_removed';

function asMetadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export function activeMailMessageWhere(): Prisma.MailMessageWhereInput {
  return { removedAt: null };
}

export function activeMailThreadWhere(): Prisma.MailThreadWhereInput {
  return {
    messages: {
      some: {
        removedAt: null,
      },
    },
  };
}

/**
 * Marks a stored message removed and recomputes its thread. A no-op (rather
 * than an error) when the provider event refers to a message Capiro never
 * persisted, since the provider event is still "handled" either way.
 */
export async function markMailMessageRemovedInTx(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    source: EngagementSource;
    externalId: string;
    reason: MailRemovalReason;
    removedAt: Date;
    providerMetadata: Record<string, unknown>;
  },
): Promise<{ found: boolean; threadId: string | null }> {
  const existing = await tx.mailMessage.findUnique({
    where: {
      tenantId_source_externalId: {
        tenantId: input.tenantId,
        source: input.source,
        externalId: input.externalId,
      },
    },
    select: { id: true, threadId: true, metadata: true },
  });

  if (!existing) {
    return { found: false, threadId: null };
  }

  const mergedMetadata = {
    ...asMetadataObject(existing.metadata),
    ...input.providerMetadata,
  };

  await tx.mailMessage.update({
    where: { id: existing.id },
    data: {
      removedAt: input.removedAt,
      removedReason: input.reason,
      metadata: mergedMetadata as Prisma.InputJsonValue,
    },
  });

  await recomputeMailThreadSummaryInTx(tx, input.tenantId, existing.threadId);

  return { found: true, threadId: existing.threadId };
}

/**
 * Recomputes a thread's snippet/lastMessageAt/subject from its latest active
 * (non-removed) message, or clears them and marks the thread deleted when no
 * active message remains. Never touches clientId, association fields, or
 * participants — those are preserved implicitly by not being in the update.
 */
export async function recomputeMailThreadSummaryInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  threadId: string,
): Promise<void> {
  const activeMessage = await tx.mailMessage.findFirst({
    where: {
      tenantId,
      threadId,
      removedAt: null,
    },
    orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      bodyText: true,
      subject: true,
      receivedAt: true,
      sentAt: true,
      createdAt: true,
    },
  });

  const thread = await tx.mailThread.findUnique({
    where: { id: threadId },
    select: { metadata: true },
  });
  const baseMetadata = asMetadataObject(thread?.metadata);

  if (!activeMessage) {
    await tx.mailThread.update({
      where: { id: threadId },
      data: {
        snippet: null,
        lastMessageAt: null,
        metadata: { ...baseMetadata, deleted: true } as Prisma.InputJsonValue,
      },
    });
    return;
  }

  const trimmedBody = activeMessage.bodyText?.trim();
  const snippet = trimmedBody
    ? normalizeSnippet(activeMessage.bodyText as string)
    : activeMessage.subject ?? null;

  await tx.mailThread.update({
    where: { id: threadId },
    data: {
      lastMessageAt: activeMessage.receivedAt ?? activeMessage.sentAt ?? activeMessage.createdAt,
      snippet,
      ...(activeMessage.subject ? { subject: activeMessage.subject } : {}),
      metadata: { ...baseMetadata, deleted: false } as Prisma.InputJsonValue,
    },
  });
}
