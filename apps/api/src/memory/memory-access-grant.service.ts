import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from './memory-wall.helpers.js';
import { normalizeGrantPermissions } from './memory-governance-lifecycle.helpers.js';
import type { MemoryPermission } from './memory-authorization.helpers.js';

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
  createdAt: Date;
}

export interface GrantUpsertInput {
  userId: string;
  permissions: unknown;
  reason?: string | null;
  expiresAt?: string | null;
}

/**
 * Write side of `memory_access_grant` — the fine-grained edit/review/approve grant
 * MemoryAuthorizationService already READS but that nothing could create except by
 * hand-written SQL.
 *
 * Two invariants this class exists to hold:
 *
 *  1. A grant must not be a way around the ethical wall. Every mutation is bound
 *     by `clientMemoryAllowed` for the ACTING admin, mirroring
 *     MemoryController.updateSections — the wall binds admins (see
 *     memory-authorization.helpers.spec.ts), so a walled admin cannot grant
 *     themselves, or anyone else, access to a client they are not on.
 *  2. The permission vocabulary is validated in code against MEMORY_PERMISSIONS
 *     before insert, so memory_access_grant_permissions_check
 *     (20260729010000:250-252) is a backstop and not the first line of defence —
 *     a CHECK violation would surface as an opaque 500.
 *
 * Revocation is a status flip (+ revoked_at / revoked_by_user_id), never a DELETE:
 * who held what access when is exactly the question an audit asks.
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
               created_at AS "createdAt"
        FROM memory_access_grant
        WHERE tenant_id = ${ctx.tenantId}::uuid AND client_id = ${clientId}::uuid
        ORDER BY created_at DESC
      `;
    });
  }

  /**
   * Grant (or replace) one user's permissions on one client's governed memory.
   *
   * memory_access_grant_unique_active is a PARTIAL unique index
   * (WHERE status='active'), which Postgres will not accept as an ON CONFLICT
   * arbiter target unless the statement repeats the predicate — and Prisma's
   * `upsert` cannot express a partial index at all. So a replacement is an explicit
   * revoke-then-insert inside ONE transaction: the old row is retained as evidence
   * and the unique index can never see two active rows.
   */
  async grant(
    ctx: TenantContext,
    clientId: string,
    input: GrantUpsertInput,
  ): Promise<{ id: string; permissions: MemoryPermission[] }> {
    const permissions = normalizeGrantPermissions(input.permissions);
    if (!permissions) {
      throw new BadRequestException(
        'permissions must be a non-empty subset of: propose, review, approve, edit, confirm, mark_stale, revoke, resolve_conflict.',
      );
    }
    if (!input.userId || typeof input.userId !== 'string') {
      throw new BadRequestException('userId is required.');
    }
    const expiresAt = parseOptionalDate(input.expiresAt);
    if (input.expiresAt && !expiresAt) {
      throw new BadRequestException('expiresAt must be an ISO-8601 timestamp.');
    }

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.requireWall(tx, ctx, clientId);
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
          ${ctx.userId}::uuid, ${input.reason ?? null}, ${expiresAt}
        )
        RETURNING id::text AS id
      `;
      const id = rows[0]?.id;
      if (!id) throw new Error('memory_access_grant insert returned no row');
      return { id, permissions };
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

  /**
   * Fail-closed wall check on the ACTING user, inside the caller's transaction.
   * `clientMemoryAllowed` also returns false when the client does not resolve in
   * this tenant, so this doubles as tenant-scoping for the :clientId path param.
   */
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
