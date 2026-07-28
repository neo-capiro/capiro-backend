import { BadRequestException, GoneException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Read-only compatibility facade for the historical fingerprint approval rows.
 *
 * The legacy browser contracts are permanently non-executable: a browser could
 * choose the tool, payload, and fingerprint, so those values can never become
 * trusted authority. Historical rows remain listable for audit. New actions use
 * MeriActionProposalService and approve by opaque server-created proposal id.
 */
@Injectable()
export class MeriApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  private assertFingerprint(fingerprint: unknown): string {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new BadRequestException('fingerprint must be a 64-char sha256 hex string');
    }
    return fingerprint;
  }

  /** Legacy orchestrators fail closed: historical approvals authorize nothing. */
  async check(_ctx: TenantContext, fingerprint: string): Promise<{ approved: false }> {
    this.assertFingerprint(fingerprint);
    return { approved: false };
  }

  async recordPending(
    _ctx: TenantContext,
    _body: { fingerprint: string; tool: string; input: unknown },
  ): Promise<never> {
    throw new GoneException('Legacy approval cards have expired; ask Meri to propose the action again.');
  }

  async approve(
    _ctx: TenantContext,
    _input: { fingerprint: string; tool: string },
  ): Promise<never> {
    throw new GoneException('Legacy approval cards have expired; ask Meri to propose the action again.');
  }

  /** Historical approval rows remain available for audit only. */
  async list(ctx: TenantContext, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionApproval.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        take,
        select: { id: true, fingerprint: true, tool: true, status: true, createdAt: true },
      }),
    );
  }
}
