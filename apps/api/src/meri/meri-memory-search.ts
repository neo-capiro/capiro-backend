import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriContextPlaneService } from './meri-context-plane.service.js';
import { optionalString } from './meri-tool-input.helpers.js';
import { CLIENT_ID_UUID_RE } from './meri-prompt.helpers.js';
import { searchCapiroData } from './meri-data-search.helpers.js';
import { projectMemoryContent } from './meri-memory-content.helpers.js';

/** Canonical memory tool projection. The supplied retrieval owner resolves current
 * access and canonical content; this function preserves coverage and cursors. */
export async function searchGovernedMemory(
  ctx: TenantContext,
  input: Record<string, unknown>,
  contextPlane: Pick<MeriContextPlaneService, 'searchToolData'> | undefined,
) {
  const query = optionalString(input, 'query', 400);
  if (!query) return { error: 'Provide a search query.' };
  const clientId = optionalString(input, 'clientId', 80);
  if (clientId && !CLIENT_ID_UUID_RE.test(clientId)) {
    return { error: 'clientId must be a client UUID — pass the exact id, or omit it.' };
  }
  const kRaw = typeof input.k === 'number' ? input.k : parseInt(String(input.k ?? ''), 10);
  const k = Number.isFinite(kRaw) ? Math.min(15, Math.max(1, Math.floor(kRaw))) : 8;
  let cursor = optionalString(input, 'cursor', 8192);
  const memoryItemId = optionalString(input, 'memoryItemId', 80);
  const contentCursor = optionalString(input, 'contentCursor', 1024);
  if (memoryItemId && !CLIENT_ID_UUID_RE.test(memoryItemId)) {
    throw new BadRequestException('memoryItemId must be the exact canonical memory UUID');
  }
  if (contentCursor && !memoryItemId)
    throw new BadRequestException('contentCursor requires memoryItemId');
  if (memoryItemId && cursor)
    throw new BadRequestException('Use contentCursor for an exact memory read');
  let pageSize = memoryItemId ? 1 : Math.min(k, 3);
  // One canonical recall path for automatic context and explicit search. The
  // shared adapter reads approved memory_items content and checks the current
  // tenant/user/client wall on every page, including when embeddings are down.
  const readPage = () =>
    searchCapiroData(
      ctx,
      {
        query,
        domains: ['institutional_knowledge'],
        queryClass: memoryItemId ? 'lookup' : 'semantic_recall',
        pageSize,
        ...(memoryItemId ? { memoryItemId } : {}),
        ...(clientId ? { clientId } : {}),
        ...(cursor ? { cursors: { institutional_knowledge: cursor } } : {}),
      },
      contextPlane,
    );
  let evidence = await readPage();
  // Visibility/packet projection can leave an empty page with more source rows.
  // Advance only the source's exact cursor, retaining current authorization on
  // every read. Bound automatic work; at the limit the unchanged partial page
  // still exposes its continuation rather than claiming the search is empty.
  const seen = new Set(cursor ? [cursor] : []);
  for (let pages = 1; pages < 3 && evidence.records.length === 0; pages += 1) {
    const source = evidence.coverage.sources.find(
      (entry) => entry.domain === 'institutional_knowledge',
    );
    if (
      !source?.hasMore ||
      !source.nextCursor ||
      !['healthy', 'degraded'].includes(source.sourceStatus)
    )
      break;
    if (seen.has(source.nextCursor))
      throw new ServiceUnavailableException('Memory cursor did not advance');
    cursor = source.nextCursor;
    seen.add(cursor);
    evidence = await readPage();
  }
  const project = () =>
    evidence.records.map((record) =>
      projectMemoryContent(ctx, record, {
        clientId: clientId ?? undefined,
        memoryItemId: memoryItemId ?? undefined,
        contentCursor: contentCursor ?? undefined,
        maxJsonChars: memoryItemId ? 6000 : Math.floor(7200 / Math.max(1, evidence.records.length)),
      }),
    );
  let records;
  try {
    records = project();
  } catch (error) {
    if (
      pageSize <= 1 ||
      !(error instanceof BadRequestException) ||
      error.message !== 'Memory metadata exceeds the safe content-page budget'
    )
      throw error;
    // A metadata-heavy page must not skip rows when it is narrowed. Read the
    // SAME source cursor again with one item so the adapter issues the correct
    // nextCursor and rechecks current authorization.
    pageSize = 1;
    evidence = await readPage();
    records = project();
  }
  const source = evidence.coverage.sources.find(
    (entry) => entry.domain === 'institutional_knowledge',
  );
  const { records: _fullRecords, ...envelope } = evidence;
  return {
    ...envelope,
    tool: 'search_memory',
    summary: records.length
      ? `${records.length} governed memory item(s) returned. Follow content.nextRead for complete approved content; coverage describes the search.`
      : 'No eligible memory was returned. Coverage distinguishes an empty result from unavailable recall.',
    requestedPageSize: k,
    effectivePageSize: pageSize,
    nextCursor: source?.nextCursor ?? null,
    governanceCoverage: {
      searched:
        'Eligible active governed memory, including stale or controlling conflicted records when policy allows',
      excluded:
        'Pending proposals, rejected, withdrawn, revoked, superseded and non-controlling conflicts are not active recall. Their absence here does not establish that no such proposals or historical records exist.',
    },
    factContentUnavailableCount: records.filter(
      (record) => record.payload.contentStatus !== 'available',
    ).length,
    contentStatus: records.length
      ? records.every((record) => record.payload.contentStatus === 'metadata_only')
        ? 'metadata_only'
        : 'available'
      : memoryItemId
        ? 'unavailable_or_ineligible'
        : source?.sourceStatus === 'healthy'
          ? 'empty'
          : 'unavailable',
    contentTruncated: records.some(
      (record) =>
        (record.payload.content as { truncated?: boolean } | undefined)?.truncated === true,
    ),
    results: records.map((record) => ({
      id: record.recordId,
      memoryItemId: record.recordId,
      title: record.payload.title,
      type: record.payload.type,
      clientId: record.payload.clientId,
      relevance: record.retrievalSignals?.semanticSimilarity ?? null,
    })),
    records,
  };
}
