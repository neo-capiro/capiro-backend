import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ownerUuid } from './memory-owner-history.cursor.js';

export interface CommittedConversationSource {
  conversationId: string;
  observedAt: string;
}
/** Identity only: an approved proposal must point to this exact committed item.
 * Neither a source label nor the overloaded memory_items.source_id is a join. */
export async function committedConversationSource(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  itemId: string,
): Promise<CommittedConversationSource | null> {
  const rows = await tx.$queryRaw<CommittedConversationSource[]>(Prisma.sql`
    SELECT mc.provenance_jsonb->'origin'->>'conversationId' AS "conversationId",
      to_char(mc.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt"
    FROM memory_candidate mc JOIN memory_items mi ON mi.tenant_id=mc.tenant_id
      AND mi.id=mc.committed_memory_item_id AND mi.source_version='candidate:'||mc.id::text
    WHERE mi.tenant_id=${ctx.tenantId}::uuid AND mi.id=${itemId}::uuid
      AND mi.owner_user_id=${ctx.userId}::uuid AND mi.memory_scope='user_private'
      AND mc.proposed_by=${ctx.userId}::uuid AND mc.scope='personal'
      AND mc.status='approved' AND mc.decided_at IS NOT NULL AND mc.legal_hold IS FALSE
      AND mc.source_type='meri' AND mc.source_id=mc.id::text
      AND mc.provenance_jsonb->>'tool'='meri_memory_review'
      AND mc.provenance_jsonb->>'meriCandidateId'=mc.id::text
      AND mc.provenance_jsonb->'origin'->>'kind'='conversation'
    LIMIT 2`);
  if (rows.length !== 1 || !ownerUuid.test(rows[0]!.conversationId)) return null;
  return rows[0]!;
}

const unavailable = () =>
  new ServiceUnavailableException({ code: 'MEMORY_SOURCE_READER_UNAVAILABLE' });
/** Reuse Meri's existing product transcript reader. That owner acquires the
 * canonical conversation lock, checks native membership/Core scope, and fences
 * response publication with retention.withRelease. Do not replace it with the
 * Core metadata helper (which requires an already-held runtime lock).
 * A single bounded event may be read by that owner; no transcript data escapes
 * this function. Opening the reference uses the same authenticated reader again.
 */
export async function retainedConversationReference(
  ctx: TenantContext,
  conversationId: string,
  authorization: string | undefined,
  visibleClientIds?: readonly string[],
  options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {},
) {
  const env = options.env ?? process.env;
  let origin: URL, frontend: URL;
  try {
    origin = new URL(env.MERI_API_BASE_URL ?? '');
    frontend = new URL(env.CAPIRO_REQUEST_ORIGIN ?? '');
    if (
      [origin, frontend].some(
        (url) =>
          url.protocol !== 'https:' ||
          url.pathname !== '/' ||
          url.search ||
          url.hash ||
          url.username ||
          url.password,
      )
    )
      throw Error();
  } catch {
    throw unavailable();
  }
  if (!authorization || !/^Bearer [A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(authorization))
    throw unavailable();
  const response = await (options.fetcher ?? fetch)(
    `${origin.origin}/api/conversations/transcript`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: authorization,
        Origin: frontend.origin,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'Accept-Encoding': 'identity',
      },
      body: JSON.stringify({ conversationId, after: 0, limit: 1 }),
    },
  );
  try {
    if ([401, 403, 404, 410].includes(response.status)) return null;
    if (
      !response.ok ||
      response.redirected ||
      response.headers.has('content-encoding') ||
      !response.body
    )
      throw unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw unavailable();
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const conversation = value?.conversation;
    if (
      value?.schema !== 'meri.conversation-transcript/1' ||
      conversation?.conversationId !== conversationId ||
      conversation?.owner?.tenantId !== ctx.tenantId ||
      conversation?.owner?.actorId !== ctx.userId ||
      !Array.isArray(conversation.scopes) ||
      conversation.scopes.length !== 1
    )
      throw unavailable();
    const clients: string[] = [];
    for (const scope of conversation.scopes) {
      if (scope?.tenantId !== ctx.tenantId) throw unavailable();
      if (scope.kind === 'client') {
        if (typeof scope.resourceId !== 'string' || !ownerUuid.test(scope.resourceId))
          throw unavailable();
        if (visibleClientIds !== undefined && !visibleClientIds.includes(scope.resourceId))
          return null;
        clients.push(scope.resourceId);
      } else if (scope.kind !== 'private-user' || scope.resourceId !== ctx.userId)
        throw unavailable();
    }
    if (clients.length > 1) throw unavailable();
    return { kind: 'conversation' as const, id: conversationId, clientId: clients[0] ?? null };
  } finally {
    if (!response.bodyUsed) void response.body?.cancel().catch(() => undefined);
  }
}
