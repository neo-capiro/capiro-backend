import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  OpportunityRecordDecorationV2,
  OpportunitySearchRecordV2,
  OpportunityVisibleScopeV2,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { sourceRecordKeyFor, sourceRecordTypeFor } from './funding-opportunity-identity.js';
import { effectiveStage } from './funding-opportunity-pipeline.js';

/**
 * Bounded, post-pagination workflow/bookmark decoration for v2 records.
 * Callers pass an already-authorized visible scope; this service never expands
 * it by guessing clients or querying one catalog row at a time.
 */
@Injectable()
export class FundingOpportunityV2DecoratorService {
  constructor(private readonly prisma: PrismaService) {}

  async decorate(
    records: OpportunitySearchRecordV2[],
    scope: OpportunityVisibleScopeV2,
  ): Promise<OpportunitySearchRecordV2[]> {
    if (records.length === 0) return records;
    const keys = records.map((record) => ({
      source: record.source,
      sourceRecordId: record.sourceRecordId,
      sourceRecordType: sourceRecordTypeFor(record.source, record.sourceFacts),
    }));
    const identityOr: Prisma.ClientFundingOpportunityWhereInput[] = keys.flatMap((key) => {
      const typed = {
        source: key.source,
        sourceRecordType: key.sourceRecordType,
        sourceRecordKey: sourceRecordKeyFor(key.source, key.sourceRecordId, key.sourceRecordType),
      } satisfies Prisma.ClientFundingOpportunityWhereInput;
      // The generic identity key is the provider id for every source. Record
      // type remains part of the key, so a topic and solicitation sharing an id
      // stay isolated without a dead alternate-key branch.
      return [typed];
    });
    const legacyOr: Prisma.ClientFundingOpportunityWhereInput[] = [];
    for (const key of keys) {
      if (key.source === 'grants_gov') legacyOr.push({ grantOpportunityId: key.sourceRecordId });
      if (key.source === 'sam_gov') legacyOr.push({ samOpportunityId: key.sourceRecordId });
    }
    const bookmarkOr: Prisma.OpportunityBookmarkWhereInput[] = keys.flatMap((key) => {
      const sourceRecordKey = sourceRecordKeyFor(key.source, key.sourceRecordId, key.sourceRecordType);
      return [{ source: key.source, sourceRecordType: key.sourceRecordType, sourceRecordKey }];
    });
    const workflowRows = scope.clientId
      ? await this.prisma.withTenant(scope.tenantId, (tx) => tx.clientFundingOpportunity.findMany({
          where: {
            tenantId: scope.tenantId,
            clientId: scope.clientId as string,
            OR: [...identityOr, ...legacyOr],
          },
          select: {
            id: true, source: true, sourceRecordType: true, sourceRecordKey: true,
            grantOpportunityId: true, samOpportunityId: true, workflowStatus: true,
            humanDecision: true, pipelineStage: true, pipelineStageVersion: true,
            ownerUserId: true, nextAction: true, nextActionDueAt: true,
          },
        }))
      : [];
    const bookmarks = await this.prisma.withTenant(scope.tenantId, (tx) => tx.opportunityBookmark.findMany({
      where: {
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        OR: bookmarkOr,
      },
      select: { id: true, source: true, sourceRecordType: true, sourceRecordKey: true, clientId: true },
    }));

    const ownerIds = [...new Set(workflowRows.map((row) => row.ownerUserId).filter((id): id is string => id != null))];
    const owners = ownerIds.length
      ? await this.prisma.withTenant(scope.tenantId, (tx) => tx.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, firstName: true, lastName: true, email: true } }))
      : [];
    const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
    const workflowKeys = (row: { source: string; sourceRecordType: string | null; sourceRecordKey: string | null; grantOpportunityId: string | null; samOpportunityId: string | null }) => {
      const id = row.sourceRecordKey ?? row.grantOpportunityId ?? row.samOpportunityId;
      if (!id) return [];
      if (row.source === 'sbir_sttr' && !row.sourceRecordType) return [];
      const type = row.sourceRecordType ?? sourceRecordTypeFor(row.source);
      return [`${row.source}:${type}:${sourceRecordKeyFor(row.source, id, type)}`];
    };
    const workflowByKey = new Map(workflowRows.flatMap((row) => workflowKeys(row).map((key) => [key, row] as const)));
    const bookmarkKey = (row: { source: string; sourceRecordType: string; sourceRecordKey: string }) => `${row.source}:${row.sourceRecordType}:${row.sourceRecordKey}`;
    const clientBookmarks = new Map(bookmarks.map((row) => [bookmarkKey(row), row]));

    return records.map((record) => {
      const type = sourceRecordTypeFor(record.source, record.sourceFacts);
      const key = `${record.source}:${type}:${sourceRecordKeyFor(record.source, record.sourceRecordId, type)}`;
      const workflow = workflowByKey.get(key);
      // Client and workspace scopes are intentionally independent. A workspace
      // bookmark must not make a selected client's `saved` toggle appear on.
      const bookmark = clientBookmarks.get(key) ?? null;
      const owner = workflow?.ownerUserId ? ownerById.get(workflow.ownerUserId) : null;
      const resolved = workflow ? effectiveStage({ workflowStatus: workflow.workflowStatus, pipelineStage: workflow.pipelineStage }) : null;
      const capability = record.clientCapability ?? {
        state: 'unknown' as const,
        allowed: record.lifecycle === 'active' && record.isPursuable,
        reason: record.lifecycle === 'active' && record.isPursuable ? 'The source is currently pursuable; client eligibility remains subject to review where facts are incomplete.' : 'The source record is not currently pursuable.',
      };
      const terminal = resolved?.stage === 'won' || resolved?.stage === 'lost' || resolved?.stage === 'passed';
      const decoration: OpportunityRecordDecorationV2 = {
        workflow: {
          available: scope.clientId != null,
          workflowId: workflow?.id ?? null,
          status: workflow?.workflowStatus ?? null,
          humanDecision: workflow?.humanDecision ?? null,
          owner: owner ? { userId: owner.id, name: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null, email: owner.email } : null,
          nextAction: workflow?.nextAction ?? null,
          nextActionDueAt: workflow?.nextActionDueAt?.toISOString() ?? null,
          stage: resolved?.stage ?? null,
          stageBasis: resolved?.basis ?? null,
          version: workflow?.pipelineStageVersion ?? null,
          source: record.source,
          sourceRecordId: record.sourceRecordId,
          sourceRecordType: type,
          publicReference: typeof record.sourceFacts['solicitationNumber'] === 'string' ? record.sourceFacts['solicitationNumber'] : typeof record.sourceFacts['opportunityNumber'] === 'string' ? record.sourceFacts['opportunityNumber'] : null,
          unavailableReason: scope.clientId ? null : 'Select a visible client to view workflow state.',
        },
        bookmark: { saved: bookmark != null, bookmarkId: bookmark?.id ?? null, scope: scope.clientId ? 'client' : 'workspace', clientId: scope.clientId },
        capabilities: { pursue: { allowed: scope.clientId != null && !terminal && capability.allowed, reason: !scope.clientId ? 'Select a visible client before pursuing this opportunity.' : terminal ? 'This workflow is final; record a new pursuit instead of reopening it.' : capability.reason }, save: { allowed: true, reason: 'This source record can be bookmarked independently of workflow.' } },
      };
      return { ...record, decoration };
    });
  }
}