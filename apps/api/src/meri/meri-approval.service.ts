import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * MeriV2 write-tool approval store (Workstream B4 — apps/api persistence behind
 * the orchestrator's ApprovalStore).
 *
 * The orchestrator's compliance gate holds a WARN write (ApprovalPendingError)
 * until a human approves THAT exact action, identified by its stable
 * `fingerprint` (sha256 over tenant+user+tool+canonicalized input, computed in
 * @capiro/meriv2-core). This service persists/queries those approvals:
 *   - check(): does an approved row exist for (tenant, user, fingerprint)?
 *     Called by the orchestrator's ApiApprovalRepo on every gated write.
 *   - approve(): record an approval (idempotent upsert). Called when the user
 *     approves a proposed action.
 *   - list(): the caller's recent approvals (audit / surface).
 *
 * Tenant-isolated via PrismaService.withTenant (RLS enforced by the
 * meri_action_approval policy). The fingerprint is opaque here — apps/api never
 * recomputes it, so there is no fingerprint-algorithm duplication to drift.
 *
 * POLICY not yet decided (needs Neo): TTL (rows never expire today), WHO may
 * approve (self-approve today — approvedBy = ctx.userId), four-eyes. Those are
 * gates to add HERE later; the table already carries approvedBy for it.
 */
@Injectable()
export class MeriApprovalService {
  constructor(private readonly prisma: PrismaService) {}

  private assertFingerprint(fingerprint: unknown): string {
    // sha256 hex — 64 lowercase hex chars. Reject anything else (defensive; the
    // column is VARCHAR(64) but we never want a partial/garbage key stored).
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new BadRequestException('fingerprint must be a 64-char sha256 hex string');
    }
    return fingerprint;
  }

  /** True when this exact action has an approved row for (tenant, user). */
  async check(ctx: TenantContext, fingerprint: string): Promise<{ approved: boolean }> {
    const fp = this.assertFingerprint(fingerprint);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionApproval.findUnique({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            fingerprint: fp,
          },
        },
        select: { status: true },
      }),
    );
    return { approved: row?.status === 'approved' };
  }

  /** Record an approval for a proposed action (idempotent per fingerprint). */
  async approve(
    ctx: TenantContext,
    input: { fingerprint: string; tool: string },
  ): Promise<{ approved: true; fingerprint: string }> {
    const fp = this.assertFingerprint(input.fingerprint);
    const tool =
      typeof input.tool === 'string' && input.tool.trim() ? input.tool.slice(0, 120) : 'unknown';
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriActionApproval.upsert({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            fingerprint: fp,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          fingerprint: fp,
          tool,
          status: 'approved',
          approvedBy: ctx.userId,
        },
        update: { status: 'approved', approvedBy: ctx.userId },
      }),
    );
    return { approved: true, fingerprint: fp };
  }

  /** The caller's recent approvals (newest first), for audit / a surface. */
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
