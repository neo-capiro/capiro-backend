import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ChangeResearchPortfolioLifecycleDto,
  CreateResearchPortfolioMemberDto,
  CreateResearchPortfolioClientLinkDto,
  CreateResearchPortfolioDto,
  DecideResearchPortfolioMembersDto,
  PutResearchPortfolioGrantDto,
  ResearchPortfolioClientLinkDto,
  ResearchPortfolioDetailDto,
  ResearchPortfolioEventKind,
  ResearchPortfolioGrantDto,
  ResearchPortfolioGrantRole,
  ResearchPortfolioListResponseDto,
  ResearchPortfolioMutationMetaDto,
  ResearchPortfolioMemberDto,
  ResearchPortfolioMutationOutcomeDto,
  ResearchPortfolioMutationReceiptDto,
  ResearchPortfolioSummaryDto,
  TenantContext,
  ResolveResearchPortfolioMemberDto,
  UpdateResearchPortfolioDto,
} from '@capiro/shared';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readCanonicalResearchTarget } from './research-portfolio-targets.js';

type Tx = Prisma.TransactionClient;
type RequiredRole = 'viewer' | 'editor' | 'owner';

const ROLE_LEVEL: Record<ResearchPortfolioGrantRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function fingerprint(operation: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ operation, payload })))
    .digest('hex');
}

function asIso(value: Date): string {
  return value.toISOString();
}

@Injectable()
export class ResearchPortfoliosService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    ctx: TenantContext,
    cursor: string | null,
    limit: number,
  ): Promise<ResearchPortfolioListResponseDto> {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.researchPortfolio.findMany({
        where: {
          tenantId: ctx.tenantId,
          grants: { some: { principalUserId: ctx.userId } },
        },
        include: {
          grants: { where: { principalUserId: ctx.userId }, take: 1 },
          clientLinks: { select: { clientId: true } },
          _count: { select: { members: true, clientLinks: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: boundedLimit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > boundedLimit;
      const page = hasMore ? rows.slice(0, boundedLimit) : rows;
      return {
        items: await Promise.all(
          page.map(async (row) => {
            const allowedClientCount = (
              await Promise.all(
                row.clientLinks.map((link) =>
                  clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, link.clientId),
                ),
              )
            ).filter(Boolean).length;
            return this.summary(
              { ...row, _count: { ...row._count, clientLinks: allowedClientCount } },
              row.grants[0]!.role as ResearchPortfolioGrantRole,
            );
          }),
        ),
        nextCursor: hasMore ? page.at(-1)!.id : null,
      };
    });
  }

  async detail(ctx: TenantContext, id: string): Promise<ResearchPortfolioDetailDto> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const authorized = await this.loadAuthorized(tx, ctx, id, 'viewer');
      const row = await tx.researchPortfolio.findUniqueOrThrow({
        where: { id },
        include: {
          grants: { orderBy: [{ role: 'asc' }, { createdAt: 'asc' }] },
          clientLinks: {
            include: { client: { select: { name: true } } },
            orderBy: { createdAt: 'asc' },
          },
          members: { orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] },
          events: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 100 },
          _count: { select: { members: true, clientLinks: true } },
        },
      });
      const visibleClientLinks = [];
      const deniedClientIds: string[] = [];
      for (const link of row.clientLinks) {
        if (await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, link.clientId)) {
          visibleClientLinks.push(link);
        } else deniedClientIds.push(link.clientId);
      }
      const visibleEvents = deniedClientIds.length
        ? row.events.filter((event) => {
            const payload = JSON.stringify(event.payload ?? {});
            return !deniedClientIds.some((clientId) => payload.includes(clientId));
          })
        : row.events;
      return {
        ...this.summary(
          { ...row, _count: { ...row._count, clientLinks: visibleClientLinks.length } },
          authorized.role,
        ),
        grants: row.grants.map((grant) => this.grantDto(grant)),
        clientLinks: visibleClientLinks.map((link) => ({
          id: link.id,
          clientId: link.clientId,
          clientName: link.client.name,
          linkedByUserId: link.linkedByUserId,
          createdAt: asIso(link.createdAt),
        })),
        members: row.members.map((member) => this.memberDto(member)),
        recentEvents: visibleEvents.map((event) => ({
          id: event.id,
          eventKind: event.eventKind,
          aggregateRevision: event.aggregateRevision,
          actorUserId: event.actorUserId,
          occurredAt: asIso(event.occurredAt),
          payload: event.payload as Readonly<Record<string, unknown>>,
        })),
      };
    });
  }

  async create(
    ctx: TenantContext,
    input: CreateResearchPortfolioDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    this.validateIdempotencyKey(input.idempotencyKey);
    const name = this.validateName(input.name);
    const operationFingerprint = fingerprint('portfolio.create', { ...input, name });
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
      if (replay) return replay;
      await this.requireActiveTenantMember(tx, ctx.tenantId, ctx.userId);
      const portfolio = await tx.researchPortfolio.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          name,
          purpose: input.purpose?.trim() || null,
          mode: input.mode ?? 'manual',
        },
      });
      const grant = await tx.researchPortfolioGrant.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId: portfolio.id,
          principalUserId: ctx.userId,
          role: 'owner',
          grantedByUserId: ctx.userId,
        },
      });
      return this.recordMutation(tx, ctx, {
        portfolioId: portfolio.id,
        eventKind: 'created',
        resultingRevision: portfolio.revision,
        idempotencyKey: input.idempotencyKey,
        operationFingerprint,
        outcomes: [
          { targetId: portfolio.id, targetType: 'portfolio', status: 'created', id: portfolio.id },
          { targetId: ctx.userId, targetType: 'grant', status: 'created', id: grant.id },
        ],
      });
    });
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateResearchPortfolioDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    const normalized = {
      ...input,
      ...(input.name !== undefined ? { name: this.validateName(input.name) } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose?.trim() || null } : {}),
    };
    return this.mutatePortfolio(
      ctx,
      id,
      'portfolio.update',
      normalized,
      'editor',
      'updated',
      async (tx) => {
        const result = await tx.researchPortfolio.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            lifecycle: 'active',
            revision: input.expectedRevision,
          },
          data: {
            ...(normalized.name !== undefined ? { name: normalized.name } : {}),
            ...(normalized.purpose !== undefined ? { purpose: normalized.purpose } : {}),
            ...(input.mode !== undefined ? { mode: input.mode } : {}),
            revision: { increment: 1 },
          },
        });
        this.assertUpdated(result.count, input.expectedRevision);
        return [
          { targetId: id, targetType: 'portfolio', status: 'updated', id },
        ] satisfies ResearchPortfolioMutationOutcomeDto[];
      },
    );
  }

  archive(ctx: TenantContext, id: string, input: ChangeResearchPortfolioLifecycleDto) {
    return this.changeLifecycle(ctx, id, input, 'archived');
  }

  restore(ctx: TenantContext, id: string, input: ChangeResearchPortfolioLifecycleDto) {
    return this.changeLifecycle(ctx, id, input, 'active');
  }

  async listGrants(ctx: TenantContext, id: string): Promise<readonly ResearchPortfolioGrantDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, id, 'viewer');
      const grants = await tx.researchPortfolioGrant.findMany({
        where: { tenantId: ctx.tenantId, portfolioId: id },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      return grants.map((grant) => this.grantDto(grant));
    });
  }

  async upsertGrant(
    ctx: TenantContext,
    id: string,
    principalUserId: string,
    input: PutResearchPortfolioGrantDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    return this.mutatePortfolio(
      ctx,
      id,
      'grant.upsert',
      { ...input, principalUserId },
      'owner',
      'grant_upserted',
      async (tx) => {
        await this.requireActiveTenantMember(tx, ctx.tenantId, principalUserId);
        const existing = await tx.researchPortfolioGrant.findUnique({
          where: {
            tenantId_portfolioId_principalUserId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              principalUserId,
            },
          },
        });
        if (existing?.role === 'owner' && input.role !== 'owner') {
          await this.assertNotLastOwner(tx, ctx.tenantId, id);
        }
        const grant = await tx.researchPortfolioGrant.upsert({
          where: {
            tenantId_portfolioId_principalUserId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              principalUserId,
            },
          },
          create: {
            tenantId: ctx.tenantId,
            portfolioId: id,
            principalUserId,
            role: input.role,
            grantedByUserId: ctx.userId,
          },
          update: { role: input.role, grantedByUserId: ctx.userId },
        });
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [
          {
            targetId: principalUserId,
            targetType: 'grant',
            status: existing ? 'updated' : 'created',
            id: grant.id,
          },
        ];
      },
    );
  }

  async deleteGrant(
    ctx: TenantContext,
    id: string,
    principalUserId: string,
    input: ResearchPortfolioMutationMetaDto & { expectedRevision: number },
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    return this.mutatePortfolio(
      ctx,
      id,
      'grant.delete',
      { ...input, principalUserId },
      'owner',
      'grant_removed',
      async (tx) => {
        const grant = await tx.researchPortfolioGrant.findUnique({
          where: {
            tenantId_portfolioId_principalUserId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              principalUserId,
            },
          },
        });
        if (!grant) throw new NotFoundException('Portfolio grant not found');
        if (grant.role === 'owner') await this.assertNotLastOwner(tx, ctx.tenantId, id);
        await tx.researchPortfolioGrant.delete({ where: { id: grant.id } });
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [
          { targetId: principalUserId, targetType: 'grant', status: 'deleted', id: grant.id },
        ];
      },
    );
  }

  async listClientLinks(
    ctx: TenantContext,
    id: string,
  ): Promise<readonly ResearchPortfolioClientLinkDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, id, 'viewer');
      const links = await tx.researchPortfolioClientLink.findMany({
        where: { tenantId: ctx.tenantId, portfolioId: id },
        include: { client: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const visibleLinks = [];
      for (const link of links) {
        if (await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, link.clientId)) {
          visibleLinks.push(link);
        }
      }
      return visibleLinks.map((link) => ({
        id: link.id,
        clientId: link.clientId,
        clientName: link.client.name,
        linkedByUserId: link.linkedByUserId,
        createdAt: asIso(link.createdAt),
      }));
    });
  }

  async createClientLink(
    ctx: TenantContext,
    id: string,
    input: CreateResearchPortfolioClientLinkDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    return this.mutatePortfolio(
      ctx,
      id,
      'client-link.create',
      input,
      'editor',
      'client_linked',
      async (tx) => {
        const client = await tx.client.findFirst({
          where: { id: input.clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
          select: { id: true },
        });
        if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, input.clientId))) {
          throw new NotFoundException('Client not found');
        }
        const existing = await tx.researchPortfolioClientLink.findUnique({
          where: {
            tenantId_portfolioId_clientId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              clientId: input.clientId,
            },
          },
        });
        const link =
          existing ??
          (await tx.researchPortfolioClientLink.create({
            data: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              clientId: input.clientId,
              linkedByUserId: ctx.userId,
            },
          }));
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [
          {
            targetId: input.clientId,
            targetType: 'client_link',
            status: existing ? 'unchanged' : 'created',
            id: link.id,
          },
        ];
      },
    );
  }

  async deleteClientLink(
    ctx: TenantContext,
    id: string,
    clientId: string,
    input: ResearchPortfolioMutationMetaDto & { expectedRevision: number },
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    return this.mutatePortfolio(
      ctx,
      id,
      'client-link.delete',
      { ...input, clientId },
      'editor',
      'client_unlinked',
      async (tx) => {
        const link = await tx.researchPortfolioClientLink.findUnique({
          where: {
            tenantId_portfolioId_clientId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              clientId,
            },
          },
        });
        if (!link) throw new NotFoundException('Portfolio client link not found');
        await tx.researchPortfolioClientLink.delete({ where: { id: link.id } });
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [{ targetId: clientId, targetType: 'client_link', status: 'deleted', id: link.id }];
      },
    );
  }

  async listMembers(
    ctx: TenantContext,
    id: string,
  ): Promise<readonly ResearchPortfolioMemberDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadAuthorized(tx, ctx, id, 'viewer');
      const members = await tx.researchPortfolioMember.findMany({
        where: { tenantId: ctx.tenantId, portfolioId: id },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      return members.map((member) => this.memberDto(member));
    });
  }

  async createMember(
    ctx: TenantContext,
    id: string,
    input: CreateResearchPortfolioMemberDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    const targetId = this.validateTargetId(input.targetId);
    return this.mutatePortfolio(
      ctx,
      id,
      'member.create',
      { ...input, targetId },
      'editor',
      'member_added',
      async (tx) => {
        const canonical = input.unresolvedInput
          ? null
          : await readCanonicalResearchTarget(tx, input.targetKind, targetId);
        if (!input.unresolvedInput && !canonical)
          throw new BadRequestException(
            'Typed member target does not resolve to a canonical record; preserve it as unresolved input instead',
          );
        const existing = await tx.researchPortfolioMember.findUnique({
          where: {
            tenantId_portfolioId_targetKind_targetId: {
              tenantId: ctx.tenantId,
              portfolioId: id,
              targetKind: input.targetKind,
              targetId,
            },
          },
        });
        if (existing) {
          throw new ConflictException(
            'That typed member already exists; use a decision to reinstate it',
          );
        }
        const member = await tx.researchPortfolioMember.create({
          data: {
            tenantId: ctx.tenantId,
            portfolioId: id,
            targetKind: input.targetKind,
            targetId,
            label: input.label?.trim() || canonical?.label || null,
            disposition: input.unresolvedInput ? 'unresolved' : 'included',
            unresolvedInput: input.unresolvedInput as Prisma.InputJsonValue | undefined,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
        });
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [{ targetId, targetType: 'member', status: 'created', id: member.id }];
      },
    );
  }

  async decideMembers(
    ctx: TenantContext,
    id: string,
    input: DecideResearchPortfolioMembersDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    if (!input.decisions.length || input.decisions.length > 100) {
      throw new BadRequestException('decisions must contain between 1 and 100 items');
    }
    const decisions = input.decisions.map((decision) => {
      const reason = decision.reason?.trim();
      if (!reason) throw new BadRequestException('Every member decision requires a reason');
      return { ...decision, reason };
    });
    if (new Set(decisions.map(({ memberId }) => memberId)).size !== decisions.length) {
      throw new BadRequestException('Member decisions must not contain duplicate member IDs');
    }
    return this.mutatePortfolio(
      ctx,
      id,
      'member.decide',
      { ...input, decisions },
      'editor',
      'member_decided',
      async (tx) => {
        const rows = await tx.researchPortfolioMember.findMany({
          where: {
            tenantId: ctx.tenantId,
            portfolioId: id,
            id: { in: decisions.map(({ memberId }) => memberId) },
          },
          select: { id: true, targetId: true },
        });
        if (rows.length !== decisions.length)
          throw new NotFoundException('Portfolio member not found');
        const targetById = new Map(rows.map((row) => [row.id, row.targetId]));
        for (const decision of decisions) {
          await tx.researchPortfolioMember.update({
            where: { id: decision.memberId },
            data: {
              disposition: decision.disposition,
              reason: decision.reason,
              updatedByUserId: ctx.userId,
              revision: { increment: 1 },
            },
          });
        }
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return decisions.map((decision) => ({
          targetId: targetById.get(decision.memberId)!,
          targetType: 'member' as const,
          status: 'updated' as const,
          id: decision.memberId,
          message: decision.disposition === 'excluded' ? 'excluded' : 'reinstated',
        }));
      },
    );
  }

  async resolveMember(
    ctx: TenantContext,
    id: string,
    memberId: string,
    input: ResolveResearchPortfolioMemberDto,
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    const targetId = this.validateTargetId(input.targetId);
    return this.mutatePortfolio(
      ctx,
      id,
      'member.resolve',
      { ...input, memberId, targetId },
      'editor',
      'member_resolved',
      async (tx) => {
        const canonical = await readCanonicalResearchTarget(tx, input.targetKind, targetId);
        if (!canonical)
          throw new BadRequestException('Resolved target does not identify a canonical record');
        const member = await tx.researchPortfolioMember.findFirst({
          where: { id: memberId, tenantId: ctx.tenantId, portfolioId: id },
        });
        if (!member) throw new NotFoundException('Portfolio member not found');
        if (member.disposition !== 'unresolved') {
          throw new ConflictException('Only unresolved members can be resolved');
        }
        await tx.researchPortfolioMember.update({
          where: { id: memberId },
          data: {
            targetKind: input.targetKind,
            targetId,
            label: input.label?.trim() || canonical.label,
            disposition: 'included',
            reason: 'Resolved to a canonical typed target',
            unresolvedInput: Prisma.JsonNull,
            resolvedAt: new Date(),
            updatedByUserId: ctx.userId,
            revision: { increment: 1 },
          },
        });
        await this.bumpRevision(tx, ctx.tenantId, id, input.expectedRevision);
        return [{ targetId, targetType: 'member', status: 'updated', id: memberId }];
      },
    );
  }

  private async changeLifecycle(
    ctx: TenantContext,
    id: string,
    input: ChangeResearchPortfolioLifecycleDto,
    lifecycle: 'active' | 'archived',
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    const eventKind = lifecycle === 'archived' ? 'archived' : 'restored';
    return this.mutatePortfolio(
      ctx,
      id,
      `portfolio.${eventKind}`,
      input,
      'owner',
      eventKind,
      async (tx) => {
        const result = await tx.researchPortfolio.updateMany({
          where: {
            id,
            tenantId: ctx.tenantId,
            revision: input.expectedRevision,
            lifecycle: lifecycle === 'archived' ? 'active' : 'archived',
          },
          data: {
            lifecycle,
            archivedAt: lifecycle === 'archived' ? new Date() : null,
            revision: { increment: 1 },
          },
        });
        this.assertUpdated(result.count, input.expectedRevision);
        return [{ targetId: id, targetType: 'portfolio', status: 'updated', id }];
      },
      { allowArchived: lifecycle === 'active' },
    );
  }

  private async mutatePortfolio<
    TInput extends ResearchPortfolioMutationMetaDto & { expectedRevision?: number },
  >(
    ctx: TenantContext,
    id: string,
    operation: string,
    input: TInput,
    role: RequiredRole,
    eventKind: ResearchPortfolioEventKind,
    mutation: (tx: Tx) => Promise<ResearchPortfolioMutationOutcomeDto[]>,
    options: { allowArchived?: boolean } = {},
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    this.validateIdempotencyKey(input.idempotencyKey);
    if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1) {
      throw new BadRequestException('expectedRevision must be a positive integer');
    }
    const operationFingerprint = fingerprint(operation, { portfolioId: id, ...input });
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Serialize grant mutations, then reauthorize after any competing owner change.
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM research_portfolios WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`,
      );
      const authorized = await this.loadAuthorized(tx, ctx, id, role);
      const replay = await this.replay(tx, ctx, input.idempotencyKey, operationFingerprint);
      if (replay) return replay;
      if (!options.allowArchived && authorized.lifecycle === 'archived') {
        throw new ConflictException('Archived portfolios are read-only');
      }
      const outcomes = await mutation(tx);
      const updated = await tx.researchPortfolio.findUniqueOrThrow({
        where: { id },
        select: { revision: true },
      });
      return this.recordMutation(tx, ctx, {
        portfolioId: id,
        eventKind,
        resultingRevision: updated.revision,
        idempotencyKey: input.idempotencyKey,
        operationFingerprint,
        outcomes,
      });
    });
  }

  private async loadAuthorized(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    requiredRole: RequiredRole,
  ): Promise<{
    id: string;
    lifecycle: 'active' | 'archived';
    revision: number;
    role: ResearchPortfolioGrantRole;
  }> {
    const row = await tx.researchPortfolio.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        grants: { some: { principalUserId: ctx.userId } },
      },
      select: {
        id: true,
        lifecycle: true,
        revision: true,
        grants: { where: { principalUserId: ctx.userId }, select: { role: true }, take: 1 },
      },
    });
    if (!row || row.grants.length === 0)
      throw new NotFoundException('Research portfolio not found');
    const role = row.grants[0]!.role as ResearchPortfolioGrantRole;
    if (ROLE_LEVEL[role] < ROLE_LEVEL[requiredRole]) {
      throw new ForbiddenException(`Research portfolio ${requiredRole} access required`);
    }
    return { id: row.id, lifecycle: row.lifecycle, revision: row.revision, role };
  }

  private async requireActiveTenantMember(tx: Tx, tenantId: string, userId: string): Promise<void> {
    const member = await tx.tenantMembership.findFirst({
      where: { tenantId, userId, status: 'active' },
      select: { id: true },
    });
    if (!member)
      throw new BadRequestException('Grant recipients must be active members of this tenant');
  }

  private async assertNotLastOwner(tx: Tx, tenantId: string, portfolioId: string): Promise<void> {
    const owners = await tx.researchPortfolioGrant.count({
      where: { tenantId, portfolioId, role: 'owner' },
    });
    if (owners <= 1)
      throw new BadRequestException('A research portfolio must retain at least one owner');
  }

  private async bumpRevision(tx: Tx, tenantId: string, id: string, expectedRevision: number) {
    const result = await tx.researchPortfolio.updateMany({
      where: { id, tenantId, revision: expectedRevision, lifecycle: 'active' },
      data: { revision: { increment: 1 } },
    });
    this.assertUpdated(result.count, expectedRevision);
  }

  private assertUpdated(count: number, expectedRevision: number): void {
    if (count !== 1) {
      throw new ConflictException(`Research portfolio revision ${expectedRevision} is stale`);
    }
  }

  private async replay(
    tx: Tx,
    ctx: TenantContext,
    idempotencyKey: string,
    operationFingerprint: string,
  ): Promise<ResearchPortfolioMutationReceiptDto | null> {
    const existing = await tx.researchPortfolioEvent.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId, idempotencyKey } },
    });
    if (!existing) return null;
    if (existing.actorUserId !== ctx.userId) {
      throw new ConflictException('This idempotency key was already used by another actor');
    }
    await this.loadAuthorized(tx, ctx, existing.portfolioId, 'viewer');
    if (existing.payloadFingerprint !== operationFingerprint) {
      throw new ConflictException('This idempotency key was already used for different content');
    }
    const payload = existing.payload as {
      outcomes?: readonly ResearchPortfolioMutationOutcomeDto[];
    };
    return {
      portfolioId: existing.portfolioId,
      eventId: existing.id,
      actorUserId: existing.actorUserId,
      occurredAt: asIso(existing.occurredAt),
      resultingRevision: existing.aggregateRevision,
      replayed: true,
      outcomes: payload.outcomes ?? [],
    };
  }

  private async recordMutation(
    tx: Tx,
    ctx: TenantContext,
    input: {
      portfolioId: string;
      eventKind: ResearchPortfolioEventKind;
      resultingRevision: number;
      idempotencyKey: string;
      operationFingerprint: string;
      outcomes: readonly ResearchPortfolioMutationOutcomeDto[];
    },
  ): Promise<ResearchPortfolioMutationReceiptDto> {
    const event = await tx.researchPortfolioEvent.create({
      data: {
        tenantId: ctx.tenantId,
        portfolioId: input.portfolioId,
        eventKind: input.eventKind,
        aggregateRevision: input.resultingRevision,
        actorUserId: ctx.userId,
        idempotencyKey: input.idempotencyKey,
        payloadFingerprint: input.operationFingerprint,
        payload: { outcomes: input.outcomes } as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      portfolioId: input.portfolioId,
      eventId: event.id,
      actorUserId: ctx.userId,
      occurredAt: asIso(event.occurredAt),
      resultingRevision: input.resultingRevision,
      replayed: false,
      outcomes: input.outcomes,
    };
  }

  private summary(row: any, myRole: ResearchPortfolioGrantRole): ResearchPortfolioSummaryDto {
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      mode: row.mode,
      lifecycle: row.lifecycle,
      revision: row.revision,
      ownerUserId: row.ownerUserId,
      memberCount: row._count.members,
      clientLinkCount: row._count.clientLinks,
      myRole,
      archivedAt: row.archivedAt ? asIso(row.archivedAt) : null,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
    };
  }

  private grantDto(grant: any): ResearchPortfolioGrantDto {
    return {
      id: grant.id,
      principalType: 'user',
      principalUserId: grant.principalUserId,
      role: grant.role,
      grantedByUserId: grant.grantedByUserId,
      createdAt: asIso(grant.createdAt),
      updatedAt: asIso(grant.updatedAt),
    };
  }

  private memberDto(member: any): ResearchPortfolioMemberDto {
    return {
      id: member.id,
      targetKind: member.targetKind,
      targetId: member.targetId,
      label: member.label,
      disposition: member.disposition,
      origin: member.origin,
      reason: member.reason,
      unresolvedInput: member.unresolvedInput as Readonly<Record<string, unknown>> | null,
      resolvedAt: member.resolvedAt ? asIso(member.resolvedAt) : null,
      revision: member.revision,
      createdByUserId: member.createdByUserId,
      updatedByUserId: member.updatedByUserId,
      createdAt: asIso(member.createdAt),
      updatedAt: asIso(member.updatedAt),
    };
  }

  private validateName(value: string): string {
    const name = value?.trim();
    if (!name || name.length > 200) {
      throw new BadRequestException('Portfolio name must be between 1 and 200 characters');
    }
    return name;
  }

  private validateIdempotencyKey(value: string): void {
    if (!value || value.length > 128) {
      throw new BadRequestException('idempotencyKey must be between 1 and 128 characters');
    }
  }

  private validateTargetId(value: string): string {
    const targetId = value?.trim();
    if (!targetId || targetId.length > 256) {
      throw new BadRequestException('targetId must be between 1 and 256 characters');
    }
    return targetId;
  }
}
