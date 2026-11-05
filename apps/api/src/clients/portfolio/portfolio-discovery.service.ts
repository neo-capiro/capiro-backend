import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { readApprovedResearchBusinessUnit } from '../profile-capability-discovery-input.js';
import { ClientProfileFillWorkflowService } from '../client-profile-fill-workflow.service.js';
import { PortfolioProposalStore } from './portfolio-proposal.store.js';
import { visiblePortfolioHistory } from './portfolio-source-access.js';
import { discoverySchema, discoveryResultsSchema, parsePortfolio } from './portfolio.contracts.js';

/** Discovery uses the existing request-id, cancellation, source-task and attempt-fencing owner. */
@Injectable()
export class PortfolioDiscoveryService {
  constructor(
    private readonly store: PortfolioProposalStore,
    private readonly workflow: ClientProfileFillWorkflowService,
  ) {}

  async discover(ctx: TenantContext, clientId: string, raw: unknown) {
    const input = parsePortfolio(discoverySchema, raw);
    await this.store.withClient(ctx, clientId, true, async (tx) => {
      if (input.businessUnitId)
        await readApprovedResearchBusinessUnit(tx, ctx, clientId, input.businessUnitId);
    });
    return this.workflow.startRun(ctx, clientId, {
      ...input,
      sources: input.sources ?? ['public_web'],
    });
  }

  results(ctx: TenantContext, clientId: string, raw: unknown) {
    const input = parsePortfolio(discoveryResultsSchema, raw);
    return this.store.withClient(ctx, clientId, false, async (tx) => {
      const scope = {
        tenantId: ctx.tenantId,
        clientId,
        kind: 'capability',
        ...(input.businessUnitId
          ? { payload: { path: ['businessUnitId'], equals: input.businessUnitId } }
          : {}),
      };
      if (
        input.after &&
        !(await tx.clientPortfolioProposal.findFirst({ where: { ...scope, id: input.after } }))
      )
        throw new NotFoundException('Discovery cursor not found');
      const rows = await tx.clientPortfolioProposal.findMany({
        where: scope,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
        take: input.limit + 1,
      });
      const hasMore = rows.length > input.limit;
      const proposals = [];
      for (const row of rows.slice(0, input.limit)) {
        try {
          await this.store.validateEvidence(tx, ctx, clientId, this.store.input(row));
          proposals.push({
            ...row,
            reviewHistory: await visiblePortfolioHistory(tx, ctx, clientId, row.reviewHistory),
          });
        } catch {
          /* Source visibility may have changed since discovery. */
        }
      }
      return { proposals, hasMore, nextCursor: hasMore ? rows[input.limit - 1]!.id : null };
    });
  }
}
