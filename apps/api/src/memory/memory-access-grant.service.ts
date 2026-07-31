import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';
import { normalizeGrantPermissions } from './memory-governance-lifecycle.helpers.js';
import type { MemoryPermission } from './memory-authorization.helpers.js';

const MAX_GRANT_REASON_CHARS = 500;

export interface MemoryAccessGrantRow {
  id: string;
  clientId: string | null;
  userId: string;
  permissions: string[];
  status: string;
  grantedByUserId: string | null;
  reason: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GrantUpsertInput {
  userId: string;
  permissions: unknown;
  reason?: string | null;
  expiresAt?: string | null;
}

/**
 * Write side of `memory_access_grant` — the fine-grained edit/review/approve grant
 * consumed by MemoryAuthorizationService.
 *
 * Client grants are explicit, time-bounded audit records. Every active grant has
 * a validated permission set, non-empty reason, issuing user, future expiration,
 * and a target user with an active membership in this tenant. Replacement and
 * revocation preserve prior rows; there is no destructive grant history path.
 * The acting administrator must already pass the client's ethical wall, so a
 * grant can never be used to grant through a wall the issuer lacks.
 */
@Injectable()
export class MemoryAccessGrantService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, clientId: string): Promise<MemoryAccessGrantRow[]> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.requireWall(tx, ctx, clientId);
      return tx.$queryRaw<MemoryAccessGrantRow[]>`
        SELECT id::text AS id,
               client_id::text AS "clientId",
               user_id::text AS "userId",
               permissions,
               status,
               granted_by_user_id::text AS "grantedByUserId",
               reason,
               expires_at AS "expiresAt",
               revoked_at AS "revokedAt",
               revoked_by_user_id::text AS "revokedByUserId",
               created_at AS "createdAt",
               updated_at AS "updatedAt"
        FROM memory_access_grant
        WHERE tenant_id = ${ctx.tenantId}::uuid AND client_id = ${clientId}::uuid
        ORDER BY created_at DESC
      `;
    });
  }

  /**
   * Grant (or replace) one user's permissions on one client's governed memory.
   *
   * memory_access_grant_unique_active is a partial unique index. A replacement
   * therefore revokes the prior active row and inserts the new auditable grant in
   * one transaction, preserving the full history while preventing two active rows.
   */
  async grant(
    ctx: TenantContext,
    clientId: string,
    input: GrantUpsertInput,
  ): Promise<{ id: string; permissions: MemoryPermission[]; expiresAt: string }> {
    const permissions = normalizeGrantPermissions(input.permissions);
    if (!permissions) {
      throw new BadRequestException(
        'permissions must be a non-empty subset of: propose, review, approve, edit, confirm, mark_stale, revoke, resolve_conflict.',
      );
    }
    if (!input.userId || typeof input.userId !== 'string') {
      throw new BadRequestException('userId is required.');
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new BadRequestException('reason is required for a client memory grant.');
    if (reason.length > MAX_GRANT_REASON_CHARS) {
      throw new BadRequestException(`reason must be ${MAX_GRANT_REASON_CHARS} characters or fewer.`);
    }
    const expiresAt = parseOptionalDate(input.expiresAt);
    if (!expiresAt) {
      throw new BadRequestException('expiresAt is required and must be an ISO-8601 timestamp.');
    }
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future.');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.requireWall(tx, ctx, clientId);
      const memberships = await tx.$queryRaw<Array<{ allowed: boolean }>>`
        SELECT true AS allowed
        FROM tenant_memberships
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND user_id = ${input.userId}::uuid
          AND status = 'active'
        LIMIT 1
      `;
      if (memberships[0]?.allowed !== true) {
        throw new BadRequestException('The grant recipient must be an active member of this tenant.');
      }

      await tx.$executeRaw`
        UPDATE memory_access_grant
        SET status = 'revoked', revoked_at = now(), revoked_by_user_id = ${ctx.userId}::uuid,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND client_id = ${clientId}::uuid
          AND user_id = ${input.userId}::uuid
          AND status = 'active'
      `;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO memory_access_grant (
          tenant_id, client_id, user_id, permissions, status,
          granted_by_user_id, reason, expires_at
        ) VALUES (
          ${ctx.tenantId}::uuid, ${clientId}::uuid, ${input.userId}::uuid,
          ${permissions}::text[], 'active',
          ${ctx.userId}::uuid, ${reason}, ${expiresAt}
        )
        RETURNING id::text AS id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('memory_access_grant insert returned no row');
      return { id, permissions, expiresAt: expiresAt.toISOString() };
    });
  }

  /** Revoke the active grant. Idempotent: revoking an absent grant returns false. */
  async revoke(
    ctx: TenantContext,
    clientId: string,
    userId: string,
  ): Promise<{ revoked: boolean }> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.requireWall(tx, ctx, clientId);
      const affected = await tx.$executeRaw`
        UPDATE memory_access_grant
        SET status = 'revoked', revoked_at = now(), revoked_by_user_id = ${ctx.userId}::uuid,
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND client_id = ${clientId}::uuid
          AND user_id = ${userId}::uuid
          AND status = 'active'
      `;
      return { revoked: affected > 0 };
    });
  }

  private async requireWall(
    tx: Parameters<typeof clientMemoryAllowed>[0],
    ctx: TenantContext,
    clientId: string,
  ): Promise<void> {
    if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))) {
      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');
    }
  }
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
