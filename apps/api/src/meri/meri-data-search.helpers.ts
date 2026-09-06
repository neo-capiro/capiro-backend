import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RETRIEVAL_DOMAINS, type RetrievalDomain, type RetrievalRequest, type RetrievalResponse } from '../retrieval/retrieval-v2.types.js';

export const MERI_DATA_QUERY_CLASSES = [
  'lookup', 'semantic_recall', 'comparison', 'entity_history', 'change_detection', 'exhaustive_search', 'federal_market_analysis',
] as const;

interface DataSearchInput {
  query: string;
  domains: RetrievalDomain[];
  clientId?: string;
  memoryItemId?: string;
  queryClass: (typeof MERI_DATA_QUERY_CLASSES)[number];
  pageSize: number;
  cursors?: Partial<Record<RetrievalDomain, string>>;
  windowStart?: Date;
  windowEnd?: Date;
}

function parseIsoDate(input: unknown, name: string): Date | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || input.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    throw new BadRequestException(`${name} must be an ISO timestamp with a timezone`);
  }
  const value = new Date(input);
  if (!Number.isFinite(value.getTime())) throw new BadRequestException(`${name} is invalid`);
  return value;
}

export function parseCapiroDataSearchInput(input: Record<string, unknown>): DataSearchInput {
  if (typeof input.query !== 'string' || input.query.length > 4000) {
    throw new BadRequestException('query must be a string containing at most 4000 characters');
  }
  if (!Array.isArray(input.domains) || !input.domains.length || input.domains.length > RETRIEVAL_DOMAINS.length ||
      input.domains.some((domain) => !RETRIEVAL_DOMAINS.includes(domain as RetrievalDomain))) {
    throw new BadRequestException('domains must be a nonempty list of supported retrieval domains');
  }
  const domains = [...new Set(input.domains as RetrievalDomain[])];
  const queryClass = input.queryClass ?? 'lookup';
  if (!MERI_DATA_QUERY_CLASSES.includes(queryClass as DataSearchInput['queryClass'])) {
    throw new BadRequestException('Unsupported retrieval queryClass');
  }
  const pageSize = input.pageSize ?? 50;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new BadRequestException('pageSize must be an integer between 1 and 100');
  }
  if (input.clientId !== undefined && (typeof input.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.clientId))) {
    throw new BadRequestException('clientId must be a client UUID');
  }
  if (input.memoryItemId !== undefined && (typeof input.memoryItemId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.memoryItemId) ||
      domains.length !== 1 || domains[0] !== 'institutional_knowledge' ||
      !['lookup', 'semantic_recall'].includes(String(queryClass)))) {
    throw new BadRequestException('memoryItemId requires a canonical UUID and an institutional_knowledge lookup');
  }
  let cursors: DataSearchInput['cursors'];
  if (input.cursors !== undefined) {
    if (!input.cursors || typeof input.cursors !== 'object' || Array.isArray(input.cursors)) {
      throw new BadRequestException('cursors must map requested domains to their returned cursor');
    }
    cursors = {};
    for (const [domain, cursor] of Object.entries(input.cursors)) {
      if (!domains.includes(domain as RetrievalDomain) || typeof cursor !== 'string' || !cursor || cursor.length > 8192) {
        throw new BadRequestException('Each cursor must belong to a requested domain and contain at most 8192 characters');
      }
      cursors[domain as RetrievalDomain] = cursor;
    }
  }
  const windowStart = parseIsoDate(input.windowStart, 'windowStart');
  const windowEnd = parseIsoDate(input.windowEnd, 'windowEnd');
  if (Boolean(windowStart) !== Boolean(windowEnd) || (windowStart && windowEnd && windowEnd <= windowStart)) {
    throw new BadRequestException('Supply both windowStart and windowEnd with end after start');
  }
  return { query: input.query.trim(), domains, clientId: input.clientId as string | undefined,
    memoryItemId: input.memoryItemId as string | undefined,
    queryClass: queryClass as DataSearchInput['queryClass'], pageSize, cursors, windowStart, windowEnd };
}

interface SecurityEnvelope {
  authorizedClientIds: string[];
  authorizedMailboxConnectionIds: string[];
}

/** Thin tool seam over the shared retrieval plane. Scope is recomputed from the
 * authenticated actor on EVERY call, including follow-up pages. Tool input can
 * narrow the subject; it can never create an authorization envelope. */
export async function searchCapiroData(
  ctx: TenantContext,
  rawInput: Record<string, unknown>,
  retrieval?: { retrieve: (request: RetrievalRequest) => Promise<RetrievalResponse> },
  resolveSecurity?: (ctx: TenantContext) => Promise<SecurityEnvelope>,
) {
  const input = parseCapiroDataSearchInput(rawInput);
  if (!retrieval || !resolveSecurity) {
    throw new ServiceUnavailableException('Shared retrieval is unavailable; no data was searched');
  }
  const security = await resolveSecurity(ctx);
  if (input.clientId && !security.authorizedClientIds.includes(input.clientId)) {
    throw new NotFoundException('Client not found');
  }
  const result = await retrieval.retrieve({
    query: input.query || undefined,
    ...(input.memoryItemId ? { memoryItemId: input.memoryItemId } : {}),
    queryClass: input.queryClass,
    requestedDomains: input.domains,
    pageSize: input.pageSize,
    cursors: input.cursors,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    requireComplete: input.queryClass === 'exhaustive_search',
    caller: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      authorizedClientIds: security.authorizedClientIds,
      // Keep an explicit empty envelope: a disconnected mailbox is not license
      // to broaden retrieval. The source reports its availability separately.
      authorizedMailboxConnectionIds: security.authorizedMailboxConnectionIds,
      ...(input.clientId ? { clientIds: [input.clientId] } : {}),
    },
  });
  // Preserve source provenance, cursors and coverage truth verbatim. Do not
  // manufacture completeness from the count or silently discard failed domains.
  const { coverage, ...data } = result;
  return { tool: 'search_capiro_data', coverage, ...data };
}
