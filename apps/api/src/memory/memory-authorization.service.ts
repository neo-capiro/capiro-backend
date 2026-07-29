import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext, TenantRole } from '@capiro/shared';
import type {
  GovernedMemoryScope,
  GovernedMemoryStatus,
  MemoryClass,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';
import {
  evaluateGovernedMemoryAuthorization,
  type MemoryAuthorizationDecision,
  type MemoryAuthorizationSubject,
  type MemoryOperation,
} from './memory-authorization.helpers.js';

export interface GovernedMemorySubjectRow extends MemoryAuthorizationSubject {
  id: string;
  tenantId: string;
  clientId: string | null;
  ownerUserId: string | null;
  clientStatus: string | null;
}

export interface MemoryAuthorizationOptions {
  impersonating?: boolean;
  actorRole?: TenantRole | null;
}

@Injectable()
export class MemoryAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async requireItem(
    ctx: TenantContext,
    itemId: string,
    operation: MemoryOperation,
    options: MemoryAuthorizationOptions = {},
  ): Promise<GovernedMemorySubjectRow> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.loadItemInTx(tx, ctx.tenantId, itemId);
      if (!row) throw new NotFoundException('Memory item not found');
      const decision = await this.evaluateInTx(tx, ctx, row, operation, options);
      if (!decision.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
      }
      return row;
    });
  }

  async requireCandidate(
    ctx: TenantContext,
    candidateId: string,
    operation: MemoryOperation,
    options: MemoryAuthorizationOptions = {},
  ): Promise<GovernedMemorySubjectRow> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const row = await this.loadCandidateInTx(tx, ctx.tenantId, candidateId);
      if (!row) throw new NotFoundException('Memory candidate not found');
      const decision = await this.evaluateInTx(tx, ctx, row, operation, options);
      if (!decision.allowed) {
        throw new ForbiddenException(`Memory operation denied: ${decision.reason}`);
      }
      return row;
    });
  }

  async evaluateInTx(
    tx: Prisma.TransactionClient,
    ctx: Pick<TenantContext, 'tenantId' | 'userId' | 'role'>,
    subject: GovernedMemorySubjectRow,
    operation: MemoryOperation,
    options: MemoryAuthorizationOptions = {},
  ): Promise<MemoryAuthorizationDecision> {
    let ethicalWallAllowed = true;
    let grantPermissions: string[] = [];
    if (subject.clientId) {
      ethicalWallAllowed = await clientMemoryAllowed(
        tx,
        ctx.tenantId,
        ctx.userId,
        subject.clientId,
      );
      const grants = await tx.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
        SELECT permissions
        FROM memory_access_grant
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND client_id = ${subject.clientId}::uuid
          AND user_id = ${ctx.userId}::uuid
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT 1
      `);
      grantPermissions = grants[0]?.permissions ?? [];
    }
    return evaluateGovernedMemoryAuthorization({
      userId: ctx.userId,
      role: ctx.role,
      operation,
      subject,
      ethicalWallAllowed,
      clientStatus: subject.clientStatus,
      grantPermissions,
      impersonating: options.impersonating,
      actorRole: options.actorRole,
    });
  }

  async loadItemInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    itemId: string,
  ): Promise<GovernedMemorySubjectRow | null> {
    const rows = await tx.$queryRaw<Array<GovernedMemorySubjectRow>>(Prisma.sql`
      SELECT mi.id::text AS id,
             mi.tenant_id::text AS "tenantId",
             mi.client_id::text AS "clientId",
             mi.owner_user_id::text AS "ownerUserId",
             mi.memory_class AS "memoryClass",
             mi.memory_scope AS scope,
             mi.governed_status AS status,
             mi.legal_hold AS "legalHold",
             c.status AS "clientStatus"
      FROM memory_items mi
      LEFT JOIN clients c ON c.id = mi.client_id AND c.tenant_id = mi.tenant_id
      WHERE mi.tenant_id = ${tenantId}::uuid AND mi.id = ${itemId}::uuid
      LIMIT 1
    `);
    return normalizeSubject(rows[0]);
  }

  async loadCandidateInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    candidateId: string,
  ): Promise<GovernedMemorySubjectRow | null> {
    const rows = await tx.$queryRaw<Array<GovernedMemorySubjectRow>>(Prisma.sql`
      SELECT mc.id::text AS id,
             mc.tenant_id::text AS "tenantId",
             mc.client_id::text AS "clientId",
             mc.proposed_by::text AS "ownerUserId",
             mc.proposed_by::text AS "proposedByUserId",
             mc.memory_class AS "memoryClass",
             mc.memory_scope AS scope,
             mc.governed_status AS status,
             mc.legal_hold AS "legalHold",
             c.status AS "clientStatus"
      FROM memory_candidate mc
      LEFT JOIN clients c ON c.id = mc.client_id AND c.tenant_id = mc.tenant_id
      WHERE mc.tenant_id = ${tenantId}::uuid AND mc.id = ${candidateId}::uuid
      LIMIT 1
    `);
    return normalizeSubject(rows[0]);
  }
}

function normalizeSubject(
  row: GovernedMemorySubjectRow | undefined,
): GovernedMemorySubjectRow | null {
  if (!row) return null;
  const memoryClass = normalizeClass(row.memoryClass);
  const scope = normalizeScope(row.scope);
  const status = normalizeStatus(row.status);
  return { ...row, memoryClass, scope, status };
}

function normalizeClass(value: unknown): MemoryClass {
  const allowed = [
    'institutional_authoritative',
    'client_steering',
    'user_preference',
    'episodic_working',
    'legacy_unclassified',
  ];
  return allowed.includes(String(value)) ? (value as MemoryClass) : 'legacy_unclassified';
}

function normalizeScope(value: unknown): GovernedMemoryScope {
  return ['firm', 'client', 'user_private'].includes(String(value))
    ? (value as GovernedMemoryScope)
    : 'firm';
}

function normalizeStatus(value: unknown): GovernedMemoryStatus {
  const allowed = [
    'suggested',
    'pending_review',
    'active',
    'stale',
    'conflicted',
    'superseded',
    'revoked',
    'rejected',
    'expired',
  ];
  return allowed.includes(String(value)) ? (value as GovernedMemoryStatus) : 'pending_review';
}
