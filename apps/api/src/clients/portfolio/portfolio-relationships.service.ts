import { EmbeddingsService } from '../../embeddings/embeddings.service.js';
import { requireOwnerClient } from '../client-ordered-owner.access.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { assertFillExecution } from '../client-profile-fill-execution.js';
import { refreshSourcedOffices } from './portfolio-office-refresh.js';
import { ClientTargetsService } from '../client-targets.service.js';
import { ClientTargetRecommendationsService } from '../client-target-recommendations.service.js';
import {
  PortfolioProposalStore,
  history,
  json,
  type PortfolioTx,
} from './portfolio-proposal.store.js';
import { visiblePortfolioHistory } from './portfolio-source-access.js';
import {
  parsePortfolio,
  proposalSchema,
  reviewSchema,
  relationshipSchema,
  supportSchema,
  recommendSchema,
  type PortfolioEvidence,
} from './portfolio.contracts.js';

@Injectable()
export class PortfolioRelationshipsService {
  constructor(
    private readonly store: PortfolioProposalStore,
    private readonly targets: ClientTargetsService,
    private readonly recommender: ClientTargetRecommendationsService,
    @Optional() private readonly embeddings?: EmbeddingsService,
  ) {}

  propose(ctx: TenantContext, clientId: string, raw: unknown) {
    const input = parsePortfolio(proposalSchema, raw);
    if (!['office_recommendation', 'statement'].includes(input.kind))
      throw new BadRequestException('Invalid relationship proposal');
    return this.store.withClient(ctx, clientId, true, (tx) =>
      this.store.propose(tx, ctx, clientId, input),
    );
  }

  review(ctx: TenantContext, clientId: string, id: string, raw: unknown) {
    const command = parsePortfolio(reviewSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const row = await this.store.requireProposal(
        tx,
        ctx,
        clientId,
        id,
        ['office_recommendation', 'statement'],
        command.expectedVersion,
      );
      return this.store.review(tx, ctx, row, command, async (input) => {
        if (input.kind !== 'office_recommendation') return;
        const owner = input.payload.suggestedOwnerUserId;
        await this.requireOwner(tx, ctx, owner);
        const target = await this.targets.addTargetInTransaction(tx, ctx, clientId, {
          ...input.payload,
          source: 'meri',
        });
        // No target/support can commit if either side fails validation.
        if (target.relationshipStatus === 'uncontacted')
          await tx.clientTarget.update({
            where: { id: target.id },
            data: {
              relationshipStatus: 'planned',
              ownerUserId: owner ?? null,
              version: { increment: 1 },
              history: json([
                ...history(target.history),
                {
                  action: 'recommendation_approved',
                  proposalId: id,
                  actorUserId: ctx.userId,
                  at: new Date().toISOString(),
                },
              ]),
            },
          });
        if (input.capabilityId)
          await this.saveSupport(tx, ctx, clientId, target.id, {
            capabilityId: input.capabilityId,
            stance: input.payload.stance,
            evidence: input.evidence,
          });
      });
    });
  }

  private async requireOwner(tx: PortfolioTx, ctx: TenantContext, userId?: string | null) {
    if (
      userId &&
      !(await tx.tenantMembership.findFirst({
        where: { tenantId: ctx.tenantId, userId, status: 'active' },
      }))
    )
      throw new BadRequestException('Relationship owner must be an active tenant member');
  }

  updateRelationship(ctx: TenantContext, clientId: string, targetId: string, raw: unknown) {
    const { expectedVersion, termEvidence, ...input } = parsePortfolio(relationshipSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const target = await tx.clientTarget.findFirst({
        where: { id: targetId, tenantId: ctx.tenantId, clientId },
      });
      if (!target) throw new NotFoundException('Relationship not found');
      if (target.version !== expectedVersion)
        throw new ConflictException('Relationship changed; refresh before saving');
      await this.requireOwner(tx, ctx, input.ownerUserId);
      if (input.officeTerm) {
        if (input.officeTerm !== target.officeTerm) {
          const historicalSupport = await tx.clientTargetSupport.findFirst({
            where: { tenantId: ctx.tenantId, clientId, targetId },
          });
          if (target.officeTerm !== 'unknown' || historicalSupport)
            throw new ConflictException(
              'Create a relationship for the new office term; historical support must retain its original term',
            );
        }
        if (!termEvidence || !['congress', 'state'].includes(target.sourceDirectory))
          throw new BadRequestException('A serving office term requires official evidence');
        await this.store.validateEvidence(tx, ctx, clientId, {
          kind: 'office_recommendation',
          payload: {
            memberId: target.memberId,
            sourceDirectory: target.sourceDirectory as 'congress' | 'state',
            officeTerm: input.officeTerm,
            rationale: 'Person-reviewed office term',
            entryPoint: 'Existing relationship',
            whyNot: 'Term confirmation does not imply support',
            stance: 'interested',
          },
          evidence: termEvidence,
        });
      }

      const saved = await tx.clientTarget.update({
        where: { id: targetId },
        data: {
          ...input,
          lastContactAt:
            input.lastContactAt === undefined
              ? undefined
              : input.lastContactAt === null
                ? null
                : new Date(input.lastContactAt),
          version: { increment: 1 },
          history: json([
            ...history(target.history),
            {
              action: 'edited',
              actorUserId: ctx.userId,
              at: new Date().toISOString(),
              ...(termEvidence ? { termEvidence } : {}),
              previous: {
                officeTerm: target.officeTerm,
                relationshipStatus: target.relationshipStatus,
                ownerUserId: target.ownerUserId,
                lastContactAt: target.lastContactAt?.toISOString() ?? null,
                nextStep: target.nextStep,
                stance: target.stance,
              },
            },
          ]),
        },
      });
      return { ...saved, history: await visiblePortfolioHistory(tx, ctx, clientId, saved.history) };
    });
  }

  support(ctx: TenantContext, clientId: string, targetId: string, raw: unknown) {
    const input = parsePortfolio(supportSchema, raw);
    return this.store.withClient(ctx, clientId, true, (tx) =>
      this.saveSupport(tx, ctx, clientId, targetId, input),
    );
  }

  private async saveSupport(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    targetId: string,
    input: {
      capabilityId: string;
      stance: string;
      evidence: PortfolioEvidence[];
      expectedVersion?: number;
    },
  ) {
    const [target, capability] = await Promise.all([
      tx.clientTarget.findFirst({ where: { id: targetId, tenantId: ctx.tenantId, clientId } }),
      tx.clientCapability.findFirst({
        where: { id: input.capabilityId, tenantId: ctx.tenantId, clientId },
      }),
    ]);
    if (!target || !capability) throw new NotFoundException('Relationship or capability not found');
    await this.store.validateEvidence(tx, ctx, clientId, {
      kind: 'case_field',
      capabilityId: input.capabilityId,
      payload: { field: 'backing', text: input.stance },
      evidence: input.evidence,
    });
    const existing = await tx.clientTargetSupport.findUnique({
      where: { targetId_capabilityId: { targetId, capabilityId: input.capabilityId } },
    });
    if (existing && input.expectedVersion !== existing.version)
      throw new ConflictException('Support changed; refresh and supply its version');
    const now = new Date();
    const event = {
      stance: input.stance,
      previousStance: existing?.stance ?? null,
      evidence: input.evidence,
      actorUserId: ctx.userId,
      at: now.toISOString(),
    };
    const data = {
      stance: input.stance,
      evidence: json(input.evidence),
      approvedByUserId: ctx.userId,
      approvedAt: now,
      history: json([...history(existing?.history ?? []), event]),
    };
    const saved = await (existing
      ? tx.clientTargetSupport.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        })
      : tx.clientTargetSupport.create({
          data: {
            tenantId: ctx.tenantId,
            clientId,
            targetId,
            capabilityId: input.capabilityId,
            ...data,
          },
        }));
    return { ...saved, history: await visiblePortfolioHistory(tx, ctx, clientId, saved.history) };
  }

  /** Same durable task refreshes the client and its established capability scopes. */
  async refreshAutomatically(ctx: TenantContext, clientId: string): Promise<number> {
    const scopes = await this.store.withClient(ctx, clientId, false, async (tx) => {
      await assertFillExecution(tx, ctx.tenantId, clientId);
      return tx.clientCapabilityTerm.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: { capabilityId: true },
        distinct: ['capabilityId'],
      });
    });
    const ranked = await this.recommender.getRecommendations(ctx, clientId, {
      refresh: true,
      beforeWrite: async (tx) => {
        await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
        await assertFillExecution(tx, ctx.tenantId, clientId);
      },
    });
    let count = 0;
    for (const capabilityId of [undefined, ...scopes.map((row) => row.capabilityId)]) {
      const result = await this.store.withClient(ctx, clientId, true, async (tx) => {
        await assertFillExecution(tx, ctx.tenantId, clientId);
        const refreshed = await refreshSourcedOffices(
          tx,
          this.store,
          ctx,
          clientId,
          ranked.recommendations,
          capabilityId,
        );
        await assertFillExecution(tx, ctx.tenantId, clientId);
        return refreshed;
      });
      await this.embedStatements(ctx, clientId, result.statementProposals);
      count += result.proposals.length + result.statementProposals.length;
    }
    return count;
  }

  /** Refresh is an explicit command or a fenced durable task, never a render side effect. */
  async refreshRecommendations(ctx: TenantContext, clientId: string, raw: unknown) {
    const { capabilityId } = parsePortfolio(recommendSchema, raw);
    await this.store.withClient(ctx, clientId, false, async (tx) => {
      if (
        capabilityId &&
        !(await tx.clientCapability.findFirst({
          where: { id: capabilityId, tenantId: ctx.tenantId, clientId },
        }))
      )
        throw new NotFoundException('Capability not found');
    });
    const ranked = await this.recommender.getRecommendations(ctx, clientId, {
      refresh: true,
      beforeWrite: async (tx) => {
        await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
        await assertFillExecution(tx, ctx.tenantId, clientId);
      },
    });
    const result = await this.store.withClient(ctx, clientId, true, async (tx) => {
      await assertFillExecution(tx, ctx.tenantId, clientId);
      const refreshed = await refreshSourcedOffices(
        tx,
        this.store,
        ctx,
        clientId,
        ranked.recommendations,
        capabilityId,
      );
      await assertFillExecution(tx, ctx.tenantId, clientId);
      return refreshed;
    });
    await this.embedStatements(ctx, clientId, result.statementProposals);
    return result;
  }

  private async embedStatements(
    ctx: TenantContext,
    clientId: string,
    rows: Parameters<PortfolioProposalStore['input']>[0][],
  ) {
    if (!this.embeddings) return;
    const ids = new Set<string>();
    for (const row of rows) {
      const input = this.store.input(row);
      if (input.kind === 'statement' && input.payload.pressItemId)
        ids.add(input.payload.pressItemId);
    }
    for (const id of ids)
      await this.embeddings.embedMemberStatementImmediate(id, async (tx) => {
        await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
        await assertFillExecution(tx, ctx.tenantId, clientId);
      });
  }
}
