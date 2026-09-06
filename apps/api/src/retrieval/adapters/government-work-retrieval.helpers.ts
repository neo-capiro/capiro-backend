import type { Prisma } from '@prisma/client';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import type { RetrievalDomain, RetrievalRequest, RetrievalSourceResult } from '../retrieval-v2.types.js';

/** Subject scope never grants access. Recheck the security envelope against current CRM walls. */
export async function visibleGovernmentClients(tx: Prisma.TransactionClient, request: RetrievalRequest) {
  const subject = [...new Set(request.caller.clientIds ?? [])];
  const envelope = [...new Set(request.caller.authorizedClientIds ?? [])];
  const requested = subject.length ? subject : envelope;
  if (subject.some((id) => !envelope.includes(id))) {
    return { ids: [] as string[], requested: subject.length, denied: true, excludedArchived: 0 };
  }
  if (!requested.length) return { ids: [] as string[], requested: 0, denied: false, excludedArchived: 0 };
  const clients = await tx.client.findMany({
    where: {
      tenantId: request.caller.tenantId,
      id: { in: requested },
      OR: [
        { memoryWall: false },
        { memoryAccessGrants: { some: { userId: request.caller.userId } } },
      ],
    },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  });
  const activeClients = clients.filter((client) => client.status !== 'archived');
  return { ids: activeClients.map((client) => client.id), requested: requested.length,
    denied: clients.length !== requested.length, excludedArchived: clients.length - activeClients.length };
}

export function governmentResult(
  domain: RetrievalDomain,
  request: RetrievalRequest,
  overrides: Partial<RetrievalSourceResult> = {},
): RetrievalSourceResult {
  return {
    domain, records: [], returned: 0, hasMore: false, truncated: false,
    sourceStatus: 'unsupported', recordsEvaluated: 0,
    requestedEntityCount: new Set(request.caller.clientIds ?? []).size,
    searchedEntityCount: 0, pagesRead: 0, paginationComplete: false,
    coverageComplete: false, stopReason: 'query_not_supported', ...overrides,
  };
}

export function currentReadError(request: RetrievalRequest): string | undefined {
  if (request.asOf || request.observedThrough) return 'historical_snapshot_not_supported';
  if (request.exactLexical || request.canonicalEntityIds?.length) return 'typed_entity_filter_not_supported';
  if (request.queryClass === 'change_detection' && (!request.windowStart || !request.windowEnd)) {
    return 'window_start_and_end_required';
  }
  if (request.windowStart && request.windowEnd && request.windowEnd <= request.windowStart) {
    return 'invalid_time_window';
  }
  return undefined;
}

export function governmentJson(value: unknown): KnowledgeJsonObject {
  return JSON.parse(JSON.stringify(value)) as KnowledgeJsonObject;
}

export function governmentPageSize(request: RetrievalRequest): number {
  const size = request.pageSize ?? 50;
  return Number.isFinite(size) ? Math.min(100, Math.max(1, Math.floor(size))) : 50;
}
