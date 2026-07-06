import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** One gate decision to persist as a compliance_check audit row. */
export interface ComplianceAuditRecord {
  /** The tool whose invocation triggered the gate (e.g. 'send_email'). */
  trigger: string;
  /** The gate outcome. */
  decision: 'PASS' | 'WARN' | 'BLOCK';
  /** Human-readable reason (the rule's reason / description). */
  reason: string;
  /** The rule id that produced the decision, if any (audit traceability). */
  ruleSource?: string | null;
  /** True when the decision required (or is awaiting) human approval. */
  requiredApproval?: boolean;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * MeriV2 compliance audit store (Workstream B2/SC2.3 — the system-of-record
 * write the gate always OWED but never made). The orchestrator's
 * PolicyApprovalGate decides PASS/WARN/BLOCK on every side-effecting tool; this
 * service persists each decision to `compliance_check` so there is a durable,
 * tenant-scoped audit trail of what Meri was asked to do and how policy ruled —
 * independent of the approval store (which only records human approvals).
 *
 * Tenant-isolated via PrismaService.withTenant (RLS enforced by the
 * compliance_check policy). Callers treat the write as FAIL-OPEN: an audit
 * failure must never block or crash a Meri turn — see recordSafe().
 */
@Injectable()
export class MeriComplianceAuditService {
  private readonly logger = new Logger(MeriComplianceAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persist one gate decision. Throws on DB error (use recordSafe from turns). */
  async record(ctx: TenantContext, rec: ComplianceAuditRecord): Promise<{ id: string }> {
    const decision =
      rec.decision === 'PASS' || rec.decision === 'WARN' || rec.decision === 'BLOCK'
        ? rec.decision
        : 'WARN';
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.complianceCheck.create({
        data: {
          tenantId: ctx.tenantId,
          trigger: String(rec.trigger || 'unknown').slice(0, 120),
          decision,
          reason: String(rec.reason || '').slice(0, 4000),
          ruleSource: rec.ruleSource ? String(rec.ruleSource).slice(0, 120) : null,
          requiredApproval: rec.requiredApproval ?? decision !== 'PASS',
          actorUserId: ctx.userId ?? null,
          entityType: rec.entityType ? String(rec.entityType).slice(0, 60) : null,
          entityId: rec.entityId ? String(rec.entityId).slice(0, 200) : null,
        },
        select: { id: true },
      }),
    );
    return { id: row.id };
  }

  /** Fail-open wrapper for the request hot path — logs and swallows any error. */
  async recordSafe(ctx: TenantContext, rec: ComplianceAuditRecord): Promise<void> {
    try {
      await this.record(ctx, rec);
    } catch (e) {
      this.logger.warn(`compliance audit write failed (non-blocking): ${(e as Error).message}`);
    }
  }

  /** Recent decisions for this tenant (newest first), for an audit surface. */
  async list(ctx: TenantContext, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.complianceCheck.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { occurredAt: 'desc' },
        take,
        select: {
          id: true,
          trigger: true,
          decision: true,
          reason: true,
          ruleSource: true,
          requiredApproval: true,
          actorUserId: true,
          occurredAt: true,
        },
      }),
    );
  }
}
