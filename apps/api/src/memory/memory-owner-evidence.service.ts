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
import { ownerAnchorQuery } from './memory-owner-history.queries.js';
import { ownerReadLimit, ownerUuid } from './memory-owner-history.cursor.js';
import {
  committedConversationSource,
  retainedConversationReference,
} from './memory-owner-evidence.sources.js';
import type { OwnerHistoryInput } from './memory-owner-history.contracts.js';

/** Resolve only exact approved/committed provenance; ambiguous legacy sources stay unsupported. */
@Injectable()
export class MemoryOwnerEvidenceService {
  constructor(private readonly prisma: PrismaService) {}
  async list(
    ctx: TenantContext,
    id: string,
    input: OwnerHistoryInput = {},
    authorization?: string,
  ) {
    if (!ownerUuid.test(id) || input.cursor !== undefined)
      throw new BadRequestException('Invalid evidence request.');
    ownerReadLimit(input.limit);
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE))
      throw new ServiceUnavailableException('Memory evidence is unavailable.');
    const snapshot = () =>
      withMemoryConversationRetention(this.prisma, ctx.tenantId, ctx.userId, async (tx) => {
        const anchors = await tx.$queryRaw<Array<{ id: string; revision: string }>>(
          ownerAnchorQuery(ctx, id, input.visibleClientIds),
        );
        if (!anchors[0]) throw new NotFoundException('Memory item is unavailable.');
        const source = await committedConversationSource(tx, ctx, id);
        return { anchor: { kind: 'item' as const, ...anchors[0] }, source };
      });
    const before = await snapshot();
    const base = { schemaVersion: 1 as const, anchor: before.anchor, nextCursor: null };
    if (!before.source)
      return {
        ...base,
        availability: 'unsupported' as const,
        reason: 'source_reader_unbound',
        entries: [],
      };
    // No memory transaction is held while acquiring the runtime conversation
    // lock. This preserves the retention owner's conversation-before-copy order.
    let reference;
    try {
      reference = await retainedConversationReference(
        ctx,
        before.source.conversationId,
        authorization,
        input.visibleClientIds,
      );
    } catch {
      throw new ServiceUnavailableException('Memory source reader is unavailable.');
    }
    const after = await snapshot();
    if (
      after.anchor.revision !== before.anchor.revision ||
      JSON.stringify(after.source) !== JSON.stringify(before.source)
    )
      throw new ConflictException({ code: 'HISTORY_CHANGED' });
    if (!reference)
      return {
        ...base,
        availability: 'unavailable' as const,
        reason: 'source_unavailable',
        entries: [],
      };
    return {
      ...base,
      availability: 'available' as const,
      entries: [{ kind: 'conversation' as const, reference, observedAt: before.source.observedAt }],
    };
  }
}
