import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';

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
 *   - recordPending(): cache the EXACT {tool, input} the moment a WARN fires
 *     (before any approval), keyed by the same fingerprint (B4.1 — see below).
 *   - approve(): record an approval AND, if a cached pending action exists for
 *     the same fingerprint, execute it directly with that exact input.
 *   - list(): the caller's recent approvals (audit / surface).
 *
 * Tenant-isolated via PrismaService.withTenant (RLS enforced by the
 * meri_action_approval / meri_pending_action policies). The fingerprint is
 * opaque here — apps/api never recomputes it, so there is no
 * fingerprint-algorithm duplication to drift.
 *
 * B4.1 fix (2026-07-15): approving a WARN write used to only record this row,
 * then the caller re-ran the WHOLE chat turn by resending the user's ORIGINAL
 * prompt (`mode: 'regenerate'`) and hoping the model re-derived a
 * byte-identical proposal on its own — it never reliably does (it re-researches
 * / rewords), so the fresh proposal hashed to a DIFFERENT fingerprint that was
 * never approved, and the write silently WARNed again. Confirmed live:
 * `update_client_profile` was approved 8 times over a week and never executed
 * once. Fix: `recordPending` captures the exact input at WARN time; `approve`
 * now looks it up by fingerprint and executes it directly — no model
 * round-trip, so nothing can drift between "approved" and "what actually runs".
 *
 * POLICY not yet decided (needs Neo): TTL (rows never expire today), WHO may
 * approve (self-approve today — approvedBy = ctx.userId), four-eyes. Those are
 * gates to add HERE later; the table already carries approvedBy for it.
 */
@Injectable()
export class MeriApprovalService {
  private readonly logger = new Logger(MeriApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: MeriToolsService,
  ) {}

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

  /**
   * Cache the EXACT proposed action behind a fingerprint the moment the
   * compliance gate WARNs — BEFORE any approval. Idempotent upsert (a repeat
   * identical proposal from the model hashes to the SAME fingerprint and just
   * overwrites with the same input; a genuinely different proposal hashes to a
   * different fingerprint and gets its own row). Never overwrites a row that
   * has already been consumed (an approved-and-executed action is immutable).
   */
  async recordPending(
    ctx: TenantContext,
    body: { fingerprint: string; tool: string; input: unknown },
  ): Promise<{ recorded: boolean }> {
    const fp = this.assertFingerprint(body.fingerprint);
    const tool =
      typeof body.tool === 'string' && body.tool.trim() ? body.tool.slice(0, 120) : 'unknown';
    const input = body.input ?? {};
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriPendingAction.findUnique({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            fingerprint: fp,
          },
        },
        select: { consumedAt: true },
      }),
    );
    if (existing?.consumedAt) return { recorded: false }; // already executed — never overwrite
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriPendingAction.upsert({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            fingerprint: fp,
          },
        },
        create: { tenantId: ctx.tenantId, userId: ctx.userId, fingerprint: fp, tool, input },
        update: { tool, input },
      }),
    );
    return { recorded: true };
  }

  /**
   * Record an approval for a proposed action (idempotent per fingerprint),
   * then — if a cached pending action exists for the SAME fingerprint —
   * execute it directly with its exact cached input (B4.1). Atomically claims
   * the pending row first (`consumedAt: null → now`) so a double-click or a
   * repeat approval can never execute the same action twice.
   *
   * `executed: false` (no cached input, or the claim lost a race) means the
   * caller should fall back to its own regenerate/retry path — this action was
   * WARN'd before this fix shipped, or by a caller that doesn't record pending
   * actions yet. `executionError` surfaces a genuine failure (e.g. a stale
   * clientId that 404s) distinctly from "nothing to execute".
   */
  async approve(
    ctx: TenantContext,
    input: { fingerprint: string; tool: string },
  ): Promise<{
    approved: true;
    fingerprint: string;
    executed: boolean;
    result?: unknown;
    executionError?: string;
  }> {
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

    // Atomic claim: only a row with consumedAt still NULL can be claimed, and
    // the update itself sets consumedAt — a concurrent second claim attempt
    // (double-click, or two browser tabs) finds count===0 and backs off.
    const claim = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriPendingAction.updateMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, fingerprint: fp, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    );
    if (claim.count !== 1) {
      return { approved: true, fingerprint: fp, executed: false };
    }
    const pending = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriPendingAction.findUnique({
        where: {
          tenantId_userId_fingerprint: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            fingerprint: fp,
          },
        },
        select: { tool: true, input: true },
      }),
    );
    if (!pending) {
      // Claimed then vanished — should not happen (no deletes on this table),
      // but never silently pretend success.
      return { approved: true, fingerprint: fp, executed: false };
    }
    try {
      const result = await this.tools.executeFromAuthenticatedUser(
        ctx,
        pending.tool,
        pending.input,
      );
      return { approved: true, fingerprint: fp, executed: true, result };
    } catch (e) {
      this.logger.warn(
        `pending-action replay failed for fingerprint ${fp} (tool=${pending.tool}): ${(e as Error).message}`,
      );
      return {
        approved: true,
        fingerprint: fp,
        executed: false,
        executionError: (e as Error).message,
      };
    }
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
