import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, ClientPortfolioProposal } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { requireOwnerClient } from '../client-ordered-owner.access.js';
import { portfolioEvidenceVisible, visiblePortfolioHistory } from './portfolio-source-access.js';
import {
  hasOfficialEvidence,
  parsePortfolio,
  proposalKey,
  proposalSchema,
  type PortfolioProposalInput,
  type PortfolioReview,
} from './portfolio.contracts.js';

export type PortfolioTx = Prisma.TransactionClient;
export const json = (value: unknown) => value as Prisma.InputJsonValue;
export const history = (value: Prisma.JsonValue) => (Array.isArray(value) ? value : []);

/** Shared staging mechanics only. Domain owners apply approved capabilities and offices. */
@Injectable()
export class PortfolioProposalStore {
  constructor(readonly prisma: PrismaService) {}

  withClient<T>(
    ctx: TenantContext,
    clientId: string,
    write: boolean,
    work: (tx: PortfolioTx) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      // Same Core actor/tenant/client/wall owner as profile-build, including revocation after lock waits.
      await requireOwnerClient(tx, ctx, clientId, false, false, write ? 'update' : 'share');
      return work(tx);
    });
  }

  async validateEvidence(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    input: PortfolioProposalInput,
  ) {
    if (
      input.capabilityId &&
      !(await tx.clientCapability.findFirst({
        where: { id: input.capabilityId, tenantId: ctx.tenantId, clientId },
      }))
    )
      throw new NotFoundException('Capability not found');
    if (!(await portfolioEvidenceVisible(tx, ctx, clientId, input.evidence)))
      throw new NotFoundException('Evidence attachment not found');
    if (
      ['statement', 'office_recommendation'].includes(input.kind) &&
      !hasOfficialEvidence(input.evidence)
    )
      throw new BadRequestException(
        'Dated official evidence is required; social-only evidence is insufficient',
      );
    if (input.kind === 'statement' || input.kind === 'office_recommendation') {
      const { memberId, sourceDirectory, officeTerm } = input.payload;
      if (sourceDirectory === 'congress') {
        const match = /^congress:([1-9]\d{0,2})$/.exec(officeTerm);
        const congress = match ? Number(match[1]) : NaN;
        const member = await tx.congressMember.findUnique({ where: { bioguideId: memberId } });
        if (!member || !member.congresses.includes(congress))
          throw new BadRequestException(
            'The office must resolve to the cited Congress in the canonical directory',
          );
        if (input.kind === 'statement') {
          const startYear = 1789 + (congress - 1) * 2;
          const when = Date.parse(input.payload.statementDate);
          if (when < Date.UTC(startYear, 0, 3, 17) || when >= Date.UTC(startYear + 2, 0, 3, 17))
            throw new BadRequestException('Statement date does not belong to the cited Congress');
        }
        if (input.kind === 'office_recommendation') {
          const now = new Date();
          const year = now.getUTCFullYear();
          const serving =
            Math.floor(((now < new Date(Date.UTC(year, 0, 3, 17)) ? year - 1 : year) - 1789) / 2) +
            1;
          if (!member.isCurrent || congress !== serving)
            throw new BadRequestException(
              'Recommendation must identify the currently serving office term',
            );
        }
      } else {
        const member = await tx.stateLegislator.findUnique({ where: { id: memberId } });
        const source = member?.sourceEvidence;
        const term =
          source && typeof source === 'object' && !Array.isArray(source)
            ? source.officeTerm
            : undefined;
        if (!member?.active || term !== officeTerm)
          throw new BadRequestException(
            'State office term evidence is unavailable in the canonical directory',
          );
      }
    }

    if (
      input.kind === 'case_field' &&
      input.payload.facilityId &&
      !(await tx.clientFacility.findFirst({
        where: { id: input.payload.facilityId, tenantId: ctx.tenantId, clientId },
      }))
    )
      throw new NotFoundException('Facility not found');
    if (input.kind === 'statement' && input.payload.pressItemId) {
      const source = await tx.memberPressItem.findFirst({
        where: { id: input.payload.pressItemId, bioguideId: input.payload.memberId },
      });
      if (
        !source ||
        !source.publishedAt ||
        source.publishedAt.toISOString() !== input.payload.statementDate ||
        !input.evidence.some((e) => e.url === source.link)
      )
        throw new BadRequestException('Statement must match its canonical press source and date');
    }
    if (input.kind === 'capability' && input.payload.businessUnitId) {
      const unit = await tx.clientPortfolioProposal.findFirst({
        where: {
          id: input.payload.businessUnitId,
          tenantId: ctx.tenantId,
          clientId,
          kind: 'business_unit',
          status: 'approved',
        },
      });
      if (!unit || !(await portfolioEvidenceVisible(tx, ctx, clientId, unit.evidence)))
        throw new BadRequestException('Select an approved sourced business unit first');
    }
  }

  async propose(tx: PortfolioTx, ctx: TenantContext, clientId: string, raw: unknown) {
    const input = parsePortfolio(proposalSchema, raw);
    await this.validateEvidence(tx, ctx, clientId, input);
    const dedupeKey = proposalKey(input);
    const existing = await tx.clientPortfolioProposal.findUnique({
      where: {
        tenantId_clientId_kind_dedupeKey: {
          tenantId: ctx.tenantId,
          clientId,
          kind: input.kind,
          dedupeKey,
        },
      },
    });
    // Retry/refresh never resurrects rejection, edits an approval or overwrites an in-flight review.
    if (existing) return this.publicProposal(tx, ctx, existing);
    return tx.clientPortfolioProposal.create({
      data: {
        tenantId: ctx.tenantId,
        clientId,
        capabilityId: input.capabilityId ?? null,
        kind: input.kind,
        dedupeKey,
        payload: json(input.payload),
        evidence: json(input.evidence),
        status: input.kind === 'sector_anchor' ? 'draft' : 'proposed',
        reviewHistory: json([
          { action: 'proposed', actorUserId: ctx.userId, at: new Date().toISOString() },
        ]),
      },
    });
  }

  /** Refresh only untouched generated drafts; all human decisions survive source updates. */
  async refreshGeneratedOffice(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    raw: unknown,
    sourceRevision: string,
  ) {
    const input = parsePortfolio(proposalSchema, raw);
    if (input.kind !== 'office_recommendation')
      throw new BadRequestException('Office proposal required');
    await this.validateEvidence(tx, ctx, clientId, input);
    const dedupeKey = proposalKey(input);
    const existing = await tx.clientPortfolioProposal.findUnique({
      where: {
        tenantId_clientId_kind_dedupeKey: {
          tenantId: ctx.tenantId,
          clientId,
          kind: input.kind,
          dedupeKey,
        },
      },
    });
    const event = {
      action: 'source_refreshed',
      sourceRevision,
      actorUserId: ctx.userId,
      at: new Date().toISOString(),
    };
    if (!existing)
      return tx.clientPortfolioProposal.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          capabilityId: input.capabilityId ?? null,
          kind: input.kind,
          dedupeKey,
          payload: json(input.payload),
          evidence: json(input.evidence),
          status: 'proposed',
          reviewHistory: json([event]),
        },
      });
    const events = history(existing.reviewHistory);
    const automated =
      events.length > 0 &&
      events.every(
        (value) =>
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.action === 'source_refreshed',
      );
    const last = events[events.length - 1];
    if (
      existing.status !== 'proposed' ||
      !automated ||
      (last &&
        typeof last === 'object' &&
        !Array.isArray(last) &&
        last.sourceRevision === sourceRevision)
    )
      return this.publicProposal(tx, ctx, existing);
    const updated = await tx.clientPortfolioProposal.updateMany({
      where: {
        id: existing.id,
        tenantId: ctx.tenantId,
        clientId,
        version: existing.version,
        status: 'proposed',
      },
      data: {
        payload: json(input.payload),
        evidence: json(input.evidence),
        version: { increment: 1 },
        reviewHistory: json([...events, event]),
      },
    });
    if (updated.count !== 1)
      throw new ConflictException('Recommendation changed during source refresh');
    return this.requireProposal(tx, ctx, clientId, existing.id, ['office_recommendation']);
  }

  async publicProposal(tx: PortfolioTx, ctx: TenantContext, row: ClientPortfolioProposal) {
    await this.validateEvidence(tx, ctx, row.clientId, this.input(row));
    return {
      ...row,
      reviewHistory: await visiblePortfolioHistory(tx, ctx, row.clientId, row.reviewHistory),
    };
  }

  async requireProposal(
    tx: PortfolioTx,
    ctx: TenantContext,
    clientId: string,
    id: string,
    kinds: readonly string[],
    expectedVersion?: number,
  ) {
    const row = await tx.clientPortfolioProposal.findFirst({
      where: { id, tenantId: ctx.tenantId, clientId, kind: { in: [...kinds] } },
    });
    if (!row) throw new NotFoundException('Proposal not found');
    if (expectedVersion !== undefined && row.version !== expectedVersion)
      throw new ConflictException('Proposal changed; refresh before reviewing');
    return row;
  }

  input(row: ClientPortfolioProposal): PortfolioProposalInput {
    return parsePortfolio(proposalSchema, {
      kind: row.kind,
      ...(row.capabilityId ? { capabilityId: row.capabilityId } : {}),
      payload: row.payload,
      evidence: row.evidence,
    });
  }

  async review(
    tx: PortfolioTx,
    ctx: TenantContext,
    row: ClientPortfolioProposal,
    command: PortfolioReview,
    apply: (input: PortfolioProposalInput) => Promise<void>,
  ) {
    if (row.version !== command.expectedVersion)
      throw new ConflictException('Proposal changed; refresh before reviewing');
    if (command.action === 'restore') {
      if (row.status !== 'rejected')
        throw new ConflictException('Only a rejected proposal can be restored');
    } else if (!['proposed', 'draft'].includes(row.status)) {
      throw new ConflictException('Only pending proposals can be reviewed');
    }
    const input = this.input(row);
    await this.validateEvidence(tx, ctx, row.clientId, input);
    if (command.action === 'approve') {
      if (row.kind === 'sector_anchor')
        throw new BadRequestException(
          'Sector reference review is unavailable. This anchor must remain Draft until its practitioner reference packet is reviewed',
        );
      await apply(input);
    }
    const status =
      command.action === 'approve'
        ? 'approved'
        : command.action === 'reject'
          ? 'rejected'
          : row.kind === 'sector_anchor'
            ? 'draft'
            : 'proposed';
    const now = new Date();
    const result = await tx.clientPortfolioProposal.updateMany({
      where: { id: row.id, tenantId: ctx.tenantId, clientId: row.clientId, version: row.version },
      data: {
        status,
        version: { increment: 1 },
        reviewedByUserId: ctx.userId,
        reviewedAt: now,
        reviewHistory: json([
          ...history(row.reviewHistory),
          {
            action: command.action,
            actorUserId: ctx.userId,
            at: now.toISOString(),
            reason: command.reason ?? null,
          },
        ]),
      },
    });
    if (result.count !== 1)
      throw new ConflictException('Proposal changed; refresh before reviewing');
    return this.publicProposal(tx, ctx, {
      ...row,
      status,
      version: row.version + 1,
      reviewedByUserId: ctx.userId,
      reviewedAt: now,
      reviewHistory: [
        ...history(row.reviewHistory),
        {
          action: command.action,
          actorUserId: ctx.userId,
          at: now.toISOString(),
          reason: command.reason ?? null,
        },
      ],
    });
  }
}
