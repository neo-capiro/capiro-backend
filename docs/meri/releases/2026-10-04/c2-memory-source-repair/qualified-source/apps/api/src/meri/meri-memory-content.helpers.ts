import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';

interface ContentCursor {
  version: 1;
  itemId: string;
  scope: string;
  hash: string;
  offset: number;
}

/** A view of a freshly authorized canonical row, never a cached recall source.
 * The cursor grants no access: actor/client identity and current content are
 * rebound after Retrieval V2 has rechecked governance on every request. */
export function projectMemoryContent(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  record: RetrievalRecord,
  input: {
    clientId?: string;
    memoryItemId?: string;
    contentCursor?: string;
    maxJsonChars?: number;
    captureSourceOwner?: boolean;
  },
): RetrievalRecord {
  if (input.memoryItemId && record.recordId !== input.memoryItemId) {
    throw new BadRequestException('Canonical memory selector did not match the returned item');
  }
  const value = typeof record.payload.value === 'string' ? record.payload.value : '';
  const hash = createHash('sha256')
    .update(value)
    .update('\0')
    .update(String(record.provenance?.sourceVersion ?? ''))
    .digest('hex');
  const scope = createHash('sha256')
    .update(JSON.stringify([ctx.tenantId, ctx.userId, input.clientId ?? null]))
    .digest('hex');
  let offset = 0;
  if (input.contentCursor) {
    let cursor: ContentCursor;
    try {
      cursor = JSON.parse(
        Buffer.from(input.contentCursor, 'base64url').toString('utf8'),
      ) as ContentCursor;
    } catch {
      throw new BadRequestException('Invalid memory content cursor');
    }
    if (
      !input.memoryItemId ||
      cursor.version !== 1 ||
      cursor.itemId !== record.recordId ||
      cursor.itemId !== input.memoryItemId ||
      cursor.scope !== scope ||
      cursor.hash !== hash ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > value.length
    ) {
      throw new BadRequestException('Memory content or scope changed; restart this memory read');
    }
    offset = cursor.offset;
  }
  const cursorAt = (position: number) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        itemId: record.recordId,
        scope,
        hash,
        offset: position,
      } satisfies ContentCursor),
    ).toString('base64url');
  const text = (field: unknown, limit: number) =>
    typeof field === 'string' ? field.slice(0, limit) : null;
  const provenance = record.provenance ?? {};
  const build = (length: number): RetrievalRecord => {
    const endOffset = offset + length;
    const truncated = endOffset < value.length;
    const contentCursor = truncated ? cursorAt(endOffset) : null;
    return {
      domain: record.domain,
      recordId: record.recordId,
      entityRef: record.entityRef,
      updatedAt: record.updatedAt,
      retrievalSignals: record.retrievalSignals,
      provenance: {
        source: 'memory_items',
        recordId: record.recordId,
        ...(input.captureSourceOwner ? { canonicalTenantId: provenance.canonicalTenantId ?? null } : {}),
        startOffset: offset,
        endOffset,
        sourceType: provenance.sourceType ?? null,
        sourceId: text(provenance.sourceId, 200),
        sourceRef: text(provenance.sourceRef, 600),
        sourceExcerpt: text(provenance.sourceExcerpt, 400),
        contentHash: provenance.contentHash ?? null,
        sourceVersion: text(provenance.sourceVersion, 200),
        metadataTruncated:
          String(provenance.sourceId ?? '').length > 200 ||
          String(provenance.sourceRef ?? '').length > 600 ||
          String(provenance.sourceExcerpt ?? '').length > 400 ||
          String(provenance.sourceVersion ?? '').length > 200,
      },
      payload: {
        sourceKind: 'governed_memory',
        memoryItemId: record.recordId,
        title: text(record.payload.title ?? record.payload.key, 160),
        titleTruncated: String(record.payload.title ?? record.payload.key ?? '').length > 160,
        type: record.payload.type ?? null,
        scope: record.payload.scope ?? null,
        clientId: record.payload.clientId ?? null,
        governance: record.payload.governance ?? null,
        contentStatus: record.payload.contentStatus ?? (value.trim() ? 'available' : 'empty'),
        contentLimitation: record.payload.contentLimitation ?? null,
        content: {
          hash,
          totalCharacters: value.length,
          offset,
          endOffset,
          truncated,
          nextRead: contentCursor
            ? {
                query: 'Read this approved memory',
                memoryItemId: record.recordId,
                ...(input.clientId ? { clientId: input.clientId } : {}),
                contentCursor,
              }
            : null,
        },
        value: value.slice(offset, endOffset),
      },
    };
  };
  const budget = Math.min(6000, Math.max(1800, input.maxJsonChars ?? 6000));
  let lo = 0;
  let hi = Math.min(value.length - offset, budget, input.memoryItemId ? budget : 500);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(build(mid), null, 2).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  // Avoid splitting a UTF-16 surrogate pair between independently rendered pages.
  if (lo > 0 && /[\uD800-\uDBFF]/.test(value.charAt(offset + lo - 1))) lo -= 1;
  const result = build(lo);
  if ((lo === 0 && offset < value.length) || JSON.stringify(result, null, 2).length > budget) {
    throw new BadRequestException('Memory metadata exceeds the safe content-page budget');
  }
  return result;
}
