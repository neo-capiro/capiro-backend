import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type { RetrievalRequest, RetrievalSourceResult, SemanticDatasetDescriptor } from '../retrieval-v2.types.js';
import {
  currentReadError, governmentJson, governmentPageSize, governmentResult, visibleGovernmentClients,
} from './government-work-retrieval.helpers.js';

const DOMAIN = 'action_recommendations' as const;
const QUERY_CLASSES = new Set(['lookup', 'change_detection', 'portfolio_scan', 'exhaustive_search', 'comparison']);

/** Read projection of the existing ActionRecommendation cards; the domain remains the only writer. */
@Injectable()
export class ActionRecommendationsRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'action-recommendations';
  readonly domains = [DOMAIN] as const;
  constructor(private readonly prisma: PrismaService) {}

  async retrieve(dataset: SemanticDatasetDescriptor, request: RetrievalRequest, cursor?: string): Promise<RetrievalSourceResult> {
    const invalid = currentReadError(request);
    if (dataset.domain !== DOMAIN || !QUERY_CLASSES.has(request.queryClass) || invalid) {
      return governmentResult(DOMAIN, request, { stopReason: invalid ?? 'query_class_not_supported' });
    }
    if (cursor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor)) {
      return governmentResult(DOMAIN, request, { stopReason: 'invalid_cursor' });
    }
    return this.prisma.withTenantUser(request.caller.tenantId, request.caller.userId, async (tx) => {
      const clients = await visibleGovernmentClients(tx, request);
      if (clients.denied || !clients.ids.length) {
        return governmentResult(DOMAIN, request, {
          sourceStatus: clients.denied ? 'unauthorized' : 'unsupported',
          stopReason: clients.denied ? 'client_wall_or_security_envelope_denied'
            : clients.excludedArchived ? 'archived_client_subjects_excluded' : 'authorized_client_scope_required',
        });
      }
      const pageSize = governmentPageSize(request);
      const query = request.query?.trim();
      const where: Prisma.ActionRecommendationWhereInput = {
        tenantId: request.caller.tenantId,
        clientId: { in: clients.ids },
        ...(cursor ? { id: { gt: cursor } } : {}),
        ...(request.windowStart || request.windowEnd ? {
          updatedAt: { ...(request.windowStart ? { gte: request.windowStart } : {}), ...(request.windowEnd ? { lt: request.windowEnd } : {}) },
        } : {}),
        ...(query ? { OR: ['issueTitle', 'whatChanged', 'whyItMatters', 'recommendedAction', 'peCode'].map((field) => ({ [field]: { contains: query, mode: 'insensitive' } })) } : {}),
      };
      const rows = await tx.actionRecommendation.findMany({
        where, orderBy: { id: 'asc' }, take: pageSize + 1,
        select: {
          id: true, clientId: true, peCode: true, programId: true, deltaId: true,
          actionType: true, issueTitle: true, whatChanged: true, whyItMatters: true,
          recommendedAction: true, targetAudience: true, suggestedArtifactType: true,
          deadline: true, deadlineSource: true, ownerUserId: true, priority: true,
          confidence: true, uncertainty: true, evidence: true, status: true,
          dismissalReason: true, outcome: true, createdAt: true, updatedAt: true,
          client: { select: { name: true } },
        },
      });
      const hasMore = rows.length > pageSize;
      const page = rows.slice(0, pageSize);
      const records = page.map((row) => ({
        domain: DOMAIN, recordId: row.id, occurredAt: row.createdAt, updatedAt: row.updatedAt,
        payload: governmentJson(row),
        provenance: { adapter: this.key, sourceTable: 'action_recommendation', sourceRecordId: row.id, tenantId: request.caller.tenantId, clientId: row.clientId },
      }));
      return governmentResult(DOMAIN, request, {
        records, returned: records.length, hasMore, truncated: hasMore,
        ...(hasMore ? { nextCursor: page[page.length - 1]!.id } : {}),
        sourceStatus: clients.excludedArchived ? 'degraded' : 'healthy', recordsEvaluated: rows.length,
        requestedEntityCount: clients.requested, searchedEntityCount: clients.ids.length,
        pagesRead: 1, paginationComplete: !hasMore, coverageComplete: !hasMore && !clients.excludedArchived,
        stopReason: clients.excludedArchived ? 'archived_client_subjects_excluded'
          : hasMore ? 'page_boundary_reached' : 'current_action_cards_complete',
      });
    });
  }
}
