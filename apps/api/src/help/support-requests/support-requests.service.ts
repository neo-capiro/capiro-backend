import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CreateSupportRequestDto, ListSupportRequestsDto } from './support-requests.dto.js';

type Tx = Prisma.TransactionClient;
const receiptSelect = {
  id: true,
  tenantId: true,
  submittedByUserId: true,
  summary: true,
  detail: true,
  runReference: true,
  createdAt: true,
} as const;
const listSelect = {
  id: true,
  tenantId: true,
  submittedByUserId: true,
  summary: true,
  createdAt: true,
} as const;
const PAGE_SIZE = 50;

function normalizedText(value: string, limit: number) {
  const text = value.trim();
  if (!text || text.length > limit)
    throw new BadRequestException('Support request text is outside its allowed length');
  return text;
}

/** Immutable internal receipt. Never fetches a run, sends email or copies report content into audit logs. */
@Injectable()
export class SupportRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ctx: TenantContext, input: CreateSupportRequestDto) {
    const summary = normalizedText(input.summary, 200);
    const detail = normalizedText(input.detail, 5000);
    const runReference =
      input.runReference == null ? null : normalizedText(input.runReference, 200);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.requireMember(tx, ctx);
      // ON CONFLICT handles concurrent same-id requests without an aborted transaction.
      await tx.supportRequest.createMany({
        data: [
          {
            id: input.id,
            tenantId: ctx.tenantId,
            submittedByUserId: ctx.userId,
            summary,
            detail,
            runReference,
          },
        ],
        skipDuplicates: true,
      });
      const receipt = await tx.supportRequest.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId, submittedByUserId: ctx.userId },
        select: receiptSelect,
      });
      if (
        !receipt ||
        receipt.summary !== summary ||
        receipt.detail !== detail ||
        receipt.runReference !== runReference
      )
        throw new ConflictException(
          'This request identifier cannot be used for a different report',
        );
      return receipt;
    });
  }

  async ownReceipt(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.requireMember(tx, ctx);
      const receipt = await tx.supportRequest.findFirst({
        where: { id, tenantId: ctx.tenantId, submittedByUserId: ctx.userId },
        select: receiptSelect,
      });
      if (!receipt) throw new NotFoundException('Support request not found');
      return receipt;
    });
  }

  async listForStaff(ctx: TenantContext, query: ListSupportRequestsDto) {
    return this.prisma.withSystem(async (tx) => {
      await this.requireMember(tx, ctx, true);
      if (!(await tx.tenant.findUnique({ where: { id: query.tenantId }, select: { id: true } })))
        throw new NotFoundException('Tenant not found');
      if (
        query.cursor &&
        !(await tx.supportRequest.findFirst({
          where: { id: query.cursor, tenantId: query.tenantId },
          select: { id: true },
        }))
      )
        throw new NotFoundException('Support request page not found');
      const rows = await tx.supportRequest.findMany({
        where: { tenantId: query.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        take: PAGE_SIZE + 1,
        select: listSelect,
      });
      await this.auditStaffRead(tx, ctx, query.tenantId, null);
      return {
        items: rows.slice(0, PAGE_SIZE),
        nextCursor: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.id : null,
      };
    });
  }

  async detailForStaff(ctx: TenantContext, tenantId: string, id: string) {
    return this.prisma.withSystem(async (tx) => {
      await this.requireMember(tx, ctx, true);
      const receipt = await tx.supportRequest.findFirst({
        where: { id, tenantId },
        select: receiptSelect,
      });
      if (!receipt) throw new NotFoundException('Support request not found');
      await this.auditStaffRead(tx, ctx, tenantId, id);
      return receipt;
    });
  }

  private async requireMember(tx: Tx, ctx: TenantContext, staff = false) {
    // Keep revocation stable until this transaction completes, using the existing membership owner.
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${ctx.tenantId}::uuid FOR SHARE`;
    const tenant = await tx.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { status: true },
    });
    if (!tenant || tenant.status !== 'active')
      throw new ForbiddenException('Current tenant does not permit support requests');
    await tx.$queryRaw`SELECT id FROM tenant_memberships
      WHERE tenant_id = ${ctx.tenantId}::uuid AND user_id = ${ctx.userId}::uuid FOR SHARE`;
    const membership = await tx.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
      select: { status: true, role: true },
    });
    if (
      !membership ||
      membership.status !== 'active' ||
      (staff && (ctx.role !== 'capiro_admin' || membership.role !== 'capiro_admin'))
    )
      throw new ForbiddenException('Current membership does not permit this support request');
  }

  private auditStaffRead(tx: Tx, ctx: TenantContext, tenantId: string, id: string | null) {
    return tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: ctx.userId,
        actorRole: 'capiro_admin',
        action: id ? 'support_request.read' : 'support_request.list',
        entityType: 'support_request',
        entityId: id,
      },
    });
  }
}
