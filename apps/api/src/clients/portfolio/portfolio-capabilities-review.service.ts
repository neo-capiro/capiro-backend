import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { lookupProfileBuildReferenceCode } from '../profile-build-reference-catalog.js';
import { ClientCapabilityFitService } from '../client-capability-fit.service.js';
import { ClientCapabilitiesService } from '../client-capabilities.service.js';
import {
  PortfolioProposalStore,
  history,
  json,
  type PortfolioTx,
} from './portfolio-proposal.store.js';
import {
  parsePortfolio,
  proposalSchema,
  reviewSchema,
  editSchema,
  mergeSchema,
  splitSchema,
  bulkAlignmentSchema,
  normalized,
  proposalKey,
  type PortfolioProposalInput,
} from './portfolio.contracts.js';

@Injectable()
export class PortfolioCapabilitiesReviewService {
  constructor(
    private readonly store: PortfolioProposalStore,
    private readonly capabilities: ClientCapabilitiesService,
    private readonly fit: ClientCapabilityFitService,
  ) {}

  /** The existing worker invokes this within its attempt-fenced transaction; never a second inference. */
  async stageExtractedCapabilitiesInTransaction(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    inputs: PortfolioProposalInput[],
  ) {
    if (
      inputs.length > 120 ||
      inputs.some((input) => !['capability', 'business_unit', 'alignment'].includes(input.kind))
    )
      throw new BadRequestException('Invalid extracted capability batch');
    const staged = [];
    for (const input of inputs) staged.push(await this.store.propose(tx, ctx, clientId, input));
    return staged;
  }

  propose(ctx: TenantContext, clientId: string, raw: unknown, capabilityId?: string) {
    const input = parsePortfolio(proposalSchema, raw);
    if (
      capabilityId
        ? input.kind !== 'alignment' || input.capabilityId !== capabilityId
        : !['capability', 'business_unit'].includes(input.kind)
    )
      throw new BadRequestException('Proposal does not match this capability operation');
    return this.store.withClient(ctx, clientId, true, (tx) =>
      this.store.propose(tx, ctx, clientId, input),
    );
  }

  edit(ctx: TenantContext, clientId: string, id: string, raw: unknown) {
    const { expectedVersion, proposal } = parsePortfolio(editSchema, raw);
    if (!['capability', 'business_unit', 'alignment'].includes(proposal.kind))
      throw new BadRequestException('Invalid capability proposal');
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const row = await this.store.requireProposal(
        tx,
        ctx,
        clientId,
        id,
        [proposal.kind],
        expectedVersion,
      );
      if (!['proposed', 'draft'].includes(row.status))
        throw new ConflictException('Only a pending proposal can be edited');
      if (row.capabilityId !== (proposal.capabilityId ?? null))
        throw new BadRequestException('Capability binding cannot change');
      await this.store.validateEvidence(tx, ctx, clientId, proposal);
      const key = proposalKey(proposal);
      const duplicate = await tx.clientPortfolioProposal.findFirst({
        where: {
          tenantId: ctx.tenantId,
          clientId,
          kind: proposal.kind,
          dedupeKey: key,
          id: { not: id },
        },
      });
      if (duplicate)
        throw new ConflictException(
          'A proposal with this identity already exists; merge pending duplicates or restore its rejection',
        );
      const saved = await tx.clientPortfolioProposal.update({
        where: { id },
        data: {
          payload: json(proposal.payload),
          evidence: json(proposal.evidence),
          dedupeKey: key,
          version: { increment: 1 },
          reviewHistory: json([
            ...history(row.reviewHistory),
            {
              action: 'edited',
              actorUserId: ctx.userId,
              at: new Date().toISOString(),
              previousPayload: row.payload,
              previousEvidence: row.evidence,
            },
          ]),
        },
      });
      return this.store.publicProposal(tx, ctx, saved);
    });
  }

  async review(
    ctx: TenantContext,
    clientId: string,
    id: string,
    raw: unknown,
    capabilityId?: string,
  ) {
    const command = parsePortfolio(reviewSchema, raw);
    const result = await this.store.withClient(ctx, clientId, true, async (tx) => {
      const row = await this.store.requireProposal(
        tx,
        ctx,
        clientId,
        id,
        capabilityId ? ['alignment'] : ['capability', 'business_unit'],
        command.expectedVersion,
      );
      if (capabilityId && row.capabilityId !== capabilityId)
        throw new BadRequestException('Alignment belongs to a different capability');
      let created:
        Awaited<ReturnType<ClientCapabilitiesService['createCapabilityInTransaction']>> | undefined;
      const proposal = await this.store.review(tx, ctx, row, command, async (input) => {
        if (input.kind === 'capability') {
          // Bound document enrichment updates the canonical capability only after explicit versioned review.
          if (input.capabilityId) {
            const current = await tx.clientCapability.findFirst({
              where: { id: input.capabilityId, tenantId: ctx.tenantId, clientId },
            });
            if (
              !current ||
              !input.payload.expectedCapabilityVersion ||
              current.version !== input.payload.expectedCapabilityVersion
            )
              throw new ConflictException(
                'Capability changed since this sourced update was proposed; research it again',
              );
            created = await this.capabilities.updateCapabilityInTransaction(
              tx,
              ctx,
              clientId,
              current.id,
              {
                name: input.payload.name,
                type: input.payload.type,
                lifecycle: input.payload.lifecycle,
                description: input.payload.description,
                tags: input.payload.tags,
              },
              json(
                input.evidence.map((e) => ({
                  ...e,
                  origin: 'research_reviewed',
                  approvedByUserId: ctx.userId,
                  approvedAt: new Date().toISOString(),
                  proposalId: id,
                })),
              ),
            );
            return;
          }
          // Provenance and approval are committed with the canonical capability, never before review.
          const duplicate = await tx.clientCapability.findFirst({
            where: {
              tenantId: ctx.tenantId,
              clientId,
              name: { equals: input.payload.name, mode: 'insensitive' },
            },
          });
          if (duplicate)
            throw new ConflictException(
              'A capability with this name already exists; review the duplicate',
            );
          created = await this.capabilities.createCapabilityInTransaction(
            tx,
            ctx,
            clientId,
            input.payload,
            json(
              input.evidence.map((e) => ({
                ...e,
                origin: 'research_reviewed',
                approvedByUserId: ctx.userId,
                approvedAt: new Date().toISOString(),
                proposalId: id,
              })),
            ),
          );
        } else if (input.kind === 'alignment') await this.applyAlignment(tx, ctx, clientId, input);
      });
      return { proposal, created };
    });
    if (result.created) this.capabilities.afterCapabilityCreated(ctx, result.created);
    return capabilityId && command.action === 'approve'
      ? { ...result.proposal, trackingRefresh: await this.refreshTracking(ctx, clientId) }
      : result.proposal;
  }

  private async applyAlignment(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    input: Extract<PortfolioProposalInput, { kind: 'alignment' }>,
  ) {
    const { targetType, value } = input.payload;
    // Classifications remain classifications. They never enter watch terms.
    if (targetType === 'naics' || targetType === 'psc') {
      const reference = lookupProfileBuildReferenceCode(targetType, value);
      if (reference.status !== 'valid')
        throw new BadRequestException(
          `Classification requires an active authoritative reference code (${reference.status})`,
        );
      return;
    }
    const kind = targetType === 'tag' ? 'keyword' : targetType;
    await tx.clientCapabilityTerm.upsert({
      where: {
        tenantId_clientId_capabilityId_kind_value: {
          tenantId: ctx.tenantId,
          clientId,
          capabilityId: input.capabilityId,
          kind,
          value: normalized(value),
        },
      },
      create: {
        tenantId: ctx.tenantId,
        clientId,
        capabilityId: input.capabilityId,
        kind,
        value: normalized(value),
        evidence: json(input.evidence),
        approvedByUserId: ctx.userId,
        approvedAt: new Date(),
      },
      update: {},
    });
    const cap = await tx.clientCapability.findFirstOrThrow({
      where: { id: input.capabilityId, tenantId: ctx.tenantId, clientId },
    });
    await tx.clientCapability.update({
      where: { id: cap.id },
      data: {
        version: { increment: 1 },
        ...(targetType === 'pe'
          ? { peNumbers: [...new Set([...cap.peNumbers, value])] }
          : targetType === 'keyword' || targetType === 'tag'
            ? { keywords: [...new Set([...cap.keywords, value])] }
            : {}),
      },
    });
    // Existing fan-in is invalidated immediately; its explicit refresh remains the scoring owner.
    await tx.clientCapabilityFitRecommendation.deleteMany({
      where: { tenantId: ctx.tenantId, clientId },
    });
  }

  async bulkApprove(ctx: TenantContext, clientId: string, capabilityId: string, raw: unknown) {
    const { items } = parsePortfolio(bulkAlignmentSchema, raw);
    const reviewed = await this.store.withClient(ctx, clientId, true, async (tx) => {
      const rows = await Promise.all(
        items.map((item) =>
          this.store.requireProposal(
            tx,
            ctx,
            clientId,
            item.id,
            ['alignment'],
            item.expectedVersion,
          ),
        ),
      );
      const inputs = rows.map((row) => this.store.input(row));
      if (
        new Set(items.map((item) => item.id)).size !== items.length ||
        inputs.some(
          (input) =>
            input.kind !== 'alignment' ||
            input.capabilityId !== capabilityId ||
            !['tag', 'keyword'].includes(input.payload.targetType) ||
            (input.payload.score ?? 0) <= 85,
        )
      )
        throw new BadRequestException(
          'Bulk approval accepts only distinct tags and keywords scored above 85. Program and PE lines require individual approval',
        );
      const reviewed = [];
      for (let index = 0; index < rows.length; index++)
        reviewed.push(
          await this.store.review(
            tx,
            ctx,
            rows[index]!,
            { expectedVersion: items[index]!.expectedVersion, action: 'approve' },
            async (input) => {
              if (input.kind === 'alignment') await this.applyAlignment(tx, ctx, clientId, input);
            },
          ),
        );
      return reviewed;
    });
    return { proposals: reviewed, trackingRefresh: await this.refreshTracking(ctx, clientId) };
  }

  private async refreshTracking(ctx: TenantContext, clientId: string) {
    try {
      await this.store.withClient(ctx, clientId, false, async () => undefined);
      const result = await this.fit.getFit(ctx, clientId, { refresh: true });
      await this.store.withClient(ctx, clientId, false, async () => undefined);
      return ['partial', 'unavailable'].includes(result.status) ? 'unavailable' : 'ready';
    } catch {
      // Source failure does not undo an already-committed human approval.
      return 'unavailable';
    }
  }

  merge(ctx: TenantContext, clientId: string, raw: unknown) {
    const input = parsePortfolio(mergeSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const rows = await Promise.all(
        input.ids.map((id, index) =>
          this.store.requireProposal(
            tx,
            ctx,
            clientId,
            id,
            ['capability'],
            input.expectedVersions[index],
          ),
        ),
      );
      if (rows.some((row) => row.status !== 'proposed'))
        throw new ConflictException('Only pending capabilities can be merged');
      const proposals = rows
        .map((row) => this.store.input(row))
        .filter(
          (row): row is Extract<PortfolioProposalInput, { kind: 'capability' }> =>
            row.kind === 'capability',
        );
      for (const proposal of proposals)
        await this.store.validateEvidence(tx, ctx, clientId, proposal);
      const first = proposals[0]!;
      const evidence = [
        ...new Map(
          proposals.flatMap((p) => p.evidence).map((e) => [JSON.stringify(e), e]),
        ).values(),
      ];
      const merged: PortfolioProposalInput = {
        kind: 'capability',
        payload: {
          ...first.payload,
          name: input.name,
          tags: [...new Set(proposals.flatMap((p) => p.payload.tags))],
        },
        evidence: evidence.slice(0, 24),
      };
      const existingId = rows.find((row) => row.dedupeKey === proposalKey(merged))?.id;
      const destination = await tx.clientPortfolioProposal.findUnique({
        where: {
          tenantId_clientId_kind_dedupeKey: {
            tenantId: ctx.tenantId,
            clientId,
            kind: 'capability',
            dedupeKey: proposalKey(merged),
          },
        },
      });
      if (destination && !input.ids.includes(destination.id))
        throw new ConflictException(
          'Include the existing destination capability proposal in this merge so all source evidence is retained',
        );
      const result = existingId
        ? await tx.clientPortfolioProposal.update({
            where: { id: existingId },
            data: {
              payload: json(merged.payload),
              evidence: json(merged.evidence),
              version: { increment: 1 },
              reviewHistory: json([
                ...history(rows.find((r) => r.id === existingId)!.reviewHistory),
                {
                  action: 'merged',
                  sourceProposalIds: input.ids,
                  actorUserId: ctx.userId,
                  at: new Date().toISOString(),
                },
              ]),
            },
          })
        : await this.store.propose(tx, ctx, clientId, merged);
      if (result.status !== 'proposed')
        throw new ConflictException(
          'Merged identity has already been reviewed; restore it explicitly',
        );
      for (const row of rows.filter((row) => row.id !== result.id))
        await tx.clientPortfolioProposal.update({
          where: { id: row.id },
          data: {
            status: 'merged',
            version: { increment: 1 },
            reviewHistory: json([
              ...history(row.reviewHistory),
              {
                action: 'merged',
                into: result.id,
                actorUserId: ctx.userId,
                at: new Date().toISOString(),
              },
            ]),
          },
        });
      return this.store.publicProposal(tx, ctx, result);
    });
  }

  split(ctx: TenantContext, clientId: string, id: string, raw: unknown) {
    const command = parsePortfolio(splitSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const row = await this.store.requireProposal(
        tx,
        ctx,
        clientId,
        id,
        ['capability'],
        command.expectedVersion,
      );
      if (row.status !== 'proposed')
        throw new ConflictException('Only a pending capability can be split');
      const original = this.store.input(row);
      if (
        new Set(command.parts.map((part) => normalized(part.name))).size !== command.parts.length ||
        command.parts.some(
          (part) =>
            proposalKey({ kind: 'capability', payload: part, evidence: original.evidence }) ===
            row.dedupeKey,
        )
      )
        throw new BadRequestException(
          'Split parts must have distinct names different from the original',
        );
      const children = [];
      for (const part of command.parts) {
        const child = await this.store.propose(tx, ctx, clientId, {
          kind: 'capability',
          payload: part,
          evidence: original.evidence,
        });
        if (child.status !== 'proposed')
          throw new ConflictException(
            'A split identity was already reviewed; restore it explicitly',
          );
        children.push(child);
      }
      await tx.clientPortfolioProposal.update({
        where: { id },
        data: {
          status: 'split',
          version: { increment: 1 },
          reviewHistory: json([
            ...history(row.reviewHistory),
            {
              action: 'split',
              childProposalIds: children.map((child) => child.id),
              actorUserId: ctx.userId,
              at: new Date().toISOString(),
            },
          ]),
        },
      });
      return children;
    });
  }
}
