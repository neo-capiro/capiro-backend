import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { fetchDeniedClientIds } from '../../memory/memory-wall.helpers.js';
import { PortfolioProposalStore, history, json } from './portfolio-proposal.store.js';
import { visiblePortfolioHistory, visibleCapabilityProvenance } from './portfolio-source-access.js';
import {
  CASE_FIELDS,
  parsePortfolio,
  proposalSchema,
  reviewSchema,
} from './portfolio.contracts.js';

@Injectable()
export class PortfolioCaseService {
  constructor(private readonly store: PortfolioProposalStore) {}

  propose(
    ctx: TenantContext,
    clientId: string,
    raw: unknown,
    kind: 'case_field' | 'sector_anchor',
  ) {
    const input = parsePortfolio(proposalSchema, raw);
    if (input.kind !== kind) throw new BadRequestException('Invalid case or sector proposal');
    return this.store.withClient(ctx, clientId, true, (tx) =>
      this.store.propose(tx, ctx, clientId, input),
    );
  }

  review(
    ctx: TenantContext,
    clientId: string,
    id: string,
    raw: unknown,
    kind: 'case_field' | 'sector_anchor',
  ) {
    const input = parsePortfolio(reviewSchema, raw);
    return this.store.withClient(ctx, clientId, true, async (tx) => {
      const row = await this.store.requireProposal(
        tx,
        ctx,
        clientId,
        id,
        [kind],
        input.expectedVersion,
      );
      return this.store.review(tx, ctx, row, input, async (proposal) => {
        if (proposal.kind !== 'case_field') return;
        const active = await tx.clientPortfolioProposal.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            capabilityId: row.capabilityId,
            kind: 'case_field',
            status: 'approved',
          },
        });
        const same = active.filter((prior) => {
          const parsed = this.store.input(prior);
          return (
            parsed.kind === 'case_field' &&
            parsed.payload.field === proposal.payload.field &&
            parsed.payload.memberId === proposal.payload.memberId &&
            parsed.payload.facilityId === proposal.payload.facilityId &&
            parsed.payload.officeTerm === proposal.payload.officeTerm &&
            parsed.payload.sourceDirectory === proposal.payload.sourceDirectory
          );
        });
        if (
          same.length &&
          (same.length !== 1 || proposal.payload.supersedesProposalId !== same[0]!.id)
        )
          throw new ConflictException(
            'This field already has an approved value. Explicitly identify the current proposal to replace it',
          );
        if (
          proposal.payload.supersedesProposalId &&
          (!same.length || same[0]!.id !== proposal.payload.supersedesProposalId)
        )
          throw new ConflictException(
            'The previous approved field changed; refresh before replacing it',
          );
        for (const prior of same)
          await tx.clientPortfolioProposal.update({
            where: { id: prior.id },
            data: {
              status: 'superseded',
              version: { increment: 1 },
              reviewHistory: json([
                ...history(prior.reviewHistory),
                {
                  action: 'superseded',
                  byProposalId: id,
                  actorUserId: ctx.userId,
                  at: new Date().toISOString(),
                },
              ]),
            },
          });
      });
    });
  }

  depth(
    ctx: TenantContext,
    clientId: string,
    filter: {
      capabilityId?: string;
      memberId?: string;
      sourceDirectory?: string;
      officeTerm?: string;
    } = {},
  ) {
    if (filter.memberId && (!filter.sourceDirectory || !filter.officeTerm))
      throw new BadRequestException('Member view requires sourceDirectory and officeTerm');
    return this.store.withClient(ctx, clientId, false, async (tx) => {
      const scope = { tenantId: ctx.tenantId, clientId };
      const [capabilities, allProposals, terms, tracking, relationships, supports] =
        await Promise.all([
          tx.clientCapability.findMany({
            where: scope,
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          }),
          tx.clientPortfolioProposal.findMany({ where: scope, orderBy: { createdAt: 'asc' } }),
          tx.clientCapabilityTerm.findMany({ where: scope }),
          tx.clientCapabilityTracking.findMany({ where: scope }),
          tx.clientTarget.findMany({ where: scope, orderBy: { addedAt: 'asc' } }),
          tx.clientTargetSupport.findMany({ where: scope }),
        ]);
      // Do not leak excerpts if an attachment was subsequently restricted/deleted.
      const proposals = [];
      for (const proposal of allProposals) {
        try {
          await this.store.validateEvidence(tx, ctx, clientId, this.store.input(proposal));
          proposals.push({
            ...proposal,
            reviewHistory: await visiblePortfolioHistory(tx, ctx, clientId, proposal.reviewHistory),
          });
        } catch {
          /* An unavailable source is a gap, never stale permission to show its text. */
        }
      }
      const visibleTerms = [];
      for (const term of terms) {
        try {
          await this.store.validateEvidence(
            tx,
            ctx,
            clientId,
            parsePortfolio(proposalSchema, {
              kind: 'case_field',
              capabilityId: term.capabilityId,
              payload: { field: 'priorities', text: term.value },
              evidence: term.evidence,
            }),
          );
          visibleTerms.push(term);
        } catch {
          /* Preserve source visibility. */
        }
      }
      const visibleSupports = [];
      for (const support of supports) {
        try {
          await this.store.validateEvidence(
            tx,
            ctx,
            clientId,
            parsePortfolio(proposalSchema, {
              kind: 'case_field',
              capabilityId: support.capabilityId,
              payload: { field: 'backing', text: support.stance },
              evidence: support.evidence,
            }),
          );
          visibleSupports.push({
            ...support,
            history: await visiblePortfolioHistory(tx, ctx, clientId, support.history),
          });
        } catch {
          /* Preserve source visibility. */
        }
      }
      const fields = proposals.filter((row) => {
        if (
          row.kind !== 'case_field' ||
          row.status !== 'approved' ||
          (filter.capabilityId && row.capabilityId !== filter.capabilityId)
        )
          return false;
        const input = this.store.input(row);
        return (
          input.kind === 'case_field' &&
          (!input.payload.memberId ||
            (input.payload.memberId === filter.memberId &&
              input.payload.sourceDirectory === filter.sourceDirectory &&
              input.payload.officeTerm === filter.officeTerm))
        );
      });
      const present = new Set(
        fields
          .map((row) => this.store.input(row))
          .flatMap((row) => (row.kind === 'case_field' ? [row.payload.field] : [])),
      );
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const peers = relationships.length
        ? await tx.clientTarget.findMany({
            where: {
              tenantId: ctx.tenantId,
              clientId: { notIn: [clientId, ...denied] },
              memberId: { in: relationships.map((row) => row.memberId) },
              client: { status: { not: 'archived' } },
            },
            include: { client: { select: { id: true, name: true } } },
          })
        : [];
      const relationshipConflicts = relationships.flatMap((target) =>
        peers
          .filter(
            (peer) =>
              peer.memberId === target.memberId &&
              peer.sourceDirectory === target.sourceDirectory &&
              peer.officeTerm === target.officeTerm &&
              ((target.stance === 'declined' && ['supportive', 'champion'].includes(peer.stance)) ||
                (peer.stance === 'declined' && ['supportive', 'champion'].includes(target.stance))),
          )
          .map((peer) => ({
            targetId: target.id,
            otherClientId: peer.client.id,
            otherClientName: peer.client.name,
            stance: peer.stance,
            reason:
              'Opposing recorded stances at the same office; review the relationship before outreach.',
          })),
      );

      const visibleCapabilities = await Promise.all(
        capabilities.map(async (row) => ({
          ...row,
          provenance: await visibleCapabilityProvenance(tx, ctx, clientId, row.provenance),
        })),
      );
      const visibleRelationships = await Promise.all(
        relationships.map(async (row) => ({
          ...row,
          history: await visiblePortfolioHistory(tx, ctx, clientId, row.history),
        })),
      );
      return {
        capabilities: visibleCapabilities,
        proposals,
        terms: visibleTerms,
        tracking,
        relationships: visibleRelationships,
        supports: visibleSupports,
        relationshipConflicts,
        memberView: { fields, gaps: CASE_FIELDS.filter((field) => !present.has(field)) },
        sectorAnchors: proposals.filter((row) => row.kind === 'sector_anchor'),
        businessUnits: proposals.filter((row) => row.kind === 'business_unit'),
        relationshipGaps: {
          officesWithoutCapabilities: relationships
            .filter((row) => !supports.some((support) => support.targetId === row.id))
            .map((row) => row.id),
          capabilitiesWithoutOffices: capabilities
            .filter((row) => !supports.some((support) => support.capabilityId === row.id))
            .map((row) => row.id),
        },
        referenceReview: {
          status: 'draft',
          reason:
            'Healthcare drafts and practitioner interview packets were not supplied; sector anchors remain Draft.',
        },
      };
    });
  }
}
