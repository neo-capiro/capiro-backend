import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { withMemoryConversationRetention } from './conversation-serving/transaction.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import {
  ownerAnchorQuery,
  ownerHistoryQuery,
  type HistoryRow,
} from './memory-owner-history.queries.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  ownerReadBinding,
  ownerReadLimit,
  ownerUuid,
} from './memory-owner-history.cursor.js';
import type {
  OwnerHistoryEntry,
  OwnerHistoryInput,
  OwnerHistoryPage,
} from './memory-owner-history.contracts.js';

const unavailable = () => new ServiceUnavailableException({ code: 'MEMORY_HISTORY_UNAVAILABLE' });
@Injectable()
export class MemoryOwnerHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    ctx: TenantContext,
    id: string,
    input: OwnerHistoryInput = {},
  ): Promise<OwnerHistoryPage> {
    if (!ownerUuid.test(id)) throw new BadRequestException('Invalid memory item.');
    const limit = ownerReadLimit(input.limit);
    const binding = ownerReadBinding([
      'versions',
      ctx.tenantId,
      ctx.userId,
      id,
      'user_private',
      input.visibleClientIds === undefined ? null : [...input.visibleClientIds].sort(),
    ]);
    const seek = decodeHistoryCursor(input.cursor, binding);
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE))
      throw unavailable();
    return withMemoryConversationRetention(this.prisma, ctx.tenantId, ctx.userId, async (tx) => {
      const anchors = await tx.$queryRaw<Array<{ id: string; revision: string }>>(
        ownerAnchorQuery(ctx, id, input.visibleClientIds),
      );
      const anchor = anchors[0];
      if (!anchor) {
        if (seek) {
          const prior = await tx.$queryRaw<Array<{ id: string }>>(
            ownerAnchorQuery(ctx, id, input.visibleClientIds, true),
          );
          if (prior.length) throw new ConflictException({ code: 'HISTORY_CHANGED' });
        }
        throw new NotFoundException('Memory item is unavailable.');
      }
      if (seek && seek.revision !== anchor.revision)
        throw new ConflictException({ code: 'HISTORY_CHANGED' });
      const rows = await tx.$queryRaw<HistoryRow[]>(
        ownerHistoryQuery(ctx, id, input.visibleClientIds),
      );
      assertLineage(rows);
      const visible = rows.filter(
        (row) =>
          row.eligible &&
          (!seek ||
            row.createdAt < seek.createdAt ||
            (row.createdAt === seek.createdAt && row.id < seek.id)),
      );
      const page: OwnerHistoryPage = {
        schemaVersion: 1,
        anchor: { kind: 'item', ...anchor },
        availability: 'available',
        entries: [],
        nextCursor: null,
      };
      let bytes = Buffer.byteLength(JSON.stringify(page));
      for (const row of visible) {
        const entry = historyEntry(row);
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (page.entries.length >= limit || bytes + size > 1024 * 1024 - 1024) break;
        page.entries.push(entry);
        bytes += size + 1;
      }
      const last = page.entries.at(-1);
      if (last && page.entries.length < visible.length)
        page.nextCursor = encodeHistoryCursor(
          { revision: anchor.revision, createdAt: last.createdAt, id: last.id },
          binding,
        );
      const after = await tx.$queryRaw<Array<{ revision: string }>>(
        ownerAnchorQuery(ctx, id, input.visibleClientIds),
      );
      if (!after[0] || after[0].revision !== anchor.revision)
        throw new ConflictException({ code: 'HISTORY_CHANGED' });
      return page;
    });
  }
}

export function assertLineage(rows: HistoryRow[]): void {
  if (!rows.length || rows.length > 1000 || rows.some((row) => row.cycle)) throw unavailable();
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length) throw unavailable();
  for (const row of rows) {
    // A suppressed predecessor is not evidence that the lineage is complete.
    if (
      row.predecessor &&
      (!byId.has(row.predecessor) || byId.get(row.predecessor)!.createdAt > row.createdAt)
    )
      throw unavailable();
  }
  // SQL can stop at the traversal cap before revisiting a cycle's first row.
  // Validate the returned graph independently, including equal-time edges.
  const complete = new Set<string>();
  for (const row of rows) {
    const path = new Set<string>();
    let next: HistoryRow | undefined = row;
    while (next && !complete.has(next.id)) {
      if (path.has(next.id)) throw unavailable();
      path.add(next.id);
      next = next.predecessor ? byId.get(next.predecessor) : undefined;
    }
    for (const id of path) complete.add(id);
  }
}
export function historyEntry(row: HistoryRow): OwnerHistoryEntry {
  const entry: OwnerHistoryEntry = {
    id: row.id,
    revision: row.revision,
    createdAt: row.createdAt,
    title: row.title,
    status: row.current ? 'current' : 'superseded',
    content: { availability: 'unavailable', reason: 'malformed' },
  };
  if (
    Array.isArray(row.sections) &&
    row.sections.every(
      (section) => section && typeof section === 'object' && typeof section.body === 'string',
    )
  ) {
    entry.content = {
      availability: 'available',
      text: row.sections.map((section) => section.body).join('\n\n'),
    };
  }
  if (row.contentOversized || Buffer.byteLength(JSON.stringify(entry)) > 512 * 1024) {
    entry.content = { availability: 'unavailable', reason: 'size_limit' };
    if (Buffer.byteLength(JSON.stringify(entry)) > 512 * 1024) throw unavailable();
  }
  return entry;
}
