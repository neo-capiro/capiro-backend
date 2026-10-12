import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';

/** General team memberships retain their own free-text roles. Ordered ownership
 * is read from its canonical table and merged once per user; it grants no
 * additional client or memory access. isOwner remains the legacy Primary flag. */

export interface ClientTeamMember {
  /** `client_team_members.id`, or null for the owner (a `clients` column). */
  id: string | null;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  /** Free text; null = on the team with no stated role. */
  role: string | null;
  /** True for the `clients.account_owner_user_id` row. */
  isOwner: boolean;
  /** Null for the owner row, which has no assignment timestamp of its own. */
  addedAt: string | null;
  ownerRank: number | null;
  ownerAvailable: boolean | null;
}

type TeamRow = {
  id: string | null;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  isOwner: boolean;
  addedAt: Date | null;
  ownerRank: number | null;
  ownerAvailable: boolean | null;
};

@Injectable()
export class ClientTeamService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The client's full roster: the account owner (from `clients`) plus every
   * `client_team_members` row, owner first and then alphabetical.
   *
   * A user who is BOTH the owner and has an explicit membership row appears
   * once, as the owner — carrying the membership row's `role` if it stated one,
   * so a role recorded there is not silently dropped.
   */
  async list(ctx: TenantContext, clientId: string): Promise<ClientTeamMember[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerClient(tx, ctx, clientId);

      const rows = await tx.$queryRaw<TeamRow[]>`
        SELECT
          NULL::text                     AS "id",
          u.id::text                     AS "userId",
          u.email::text                   AS "email",
          u.first_name                   AS "firstName",
          u.last_name                    AS "lastName",
          m.role                         AS "role",
          o.rank=1                       AS "isOwner",
          NULL::timestamptz              AS "addedAt",
          o.rank                         AS "ownerRank",
          EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.tenant_id=c.tenant_id
            AND tm.user_id=u.id AND tm.status::text='active') AS "ownerAvailable"
        FROM clients c
        INNER JOIN client_ordered_owners o ON o.tenant_id=c.tenant_id AND o.client_id=c.id
        INNER JOIN users u ON u.id = o.user_id
        LEFT JOIN client_team_members m
          ON m.tenant_id = c.tenant_id AND m.client_id = c.id AND m.user_id = u.id
        WHERE c.id = CAST(${clientId} AS uuid)
          AND c.tenant_id = CAST(${ctx.tenantId} AS uuid)

        UNION ALL

        SELECT
          m.id::text                     AS "id",
          u.id::text                     AS "userId",
          u.email::text                   AS "email",
          u.first_name                   AS "firstName",
          u.last_name                    AS "lastName",
          m.role                         AS "role",
          false                          AS "isOwner",
          m.created_at                   AS "addedAt",
          NULL::integer                  AS "ownerRank",
          NULL::boolean                  AS "ownerAvailable"
        FROM client_team_members m
        INNER JOIN users u ON u.id = m.user_id
        INNER JOIN clients c ON c.id = m.client_id AND c.tenant_id = m.tenant_id
        WHERE m.client_id = CAST(${clientId} AS uuid)
          AND m.tenant_id = CAST(${ctx.tenantId} AS uuid)
          -- Every ranked owner is emitted by the first branch exactly once.
          AND NOT EXISTS (SELECT 1 FROM client_ordered_owners o
            WHERE o.tenant_id=c.tenant_id AND o.client_id=c.id AND o.user_id=m.user_id)

        ORDER BY "ownerRank" ASC NULLS LAST, "firstName" NULLS LAST, "lastName" NULLS LAST, "email"
      `;

      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        role: row.role,
        isOwner: row.isOwner,
        addedAt: row.addedAt ? row.addedAt.toISOString() : null,
        ownerRank: row.ownerRank ?? null,
        ownerAvailable: row.ownerAvailable ?? null,
      }));
    });
  }

  /**
   * Put a user on the account team, or update the role of someone already on
   * it. Idempotent by (tenant, client, user) — re-adding is a role update, not
   * a duplicate roster entry.
   */
  async add(
    ctx: TenantContext,
    clientId: string,
    userId: string,
    role: string | null,
  ): Promise<ClientTeamMember[]> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerClient(tx, ctx, clientId, true);

      // Same rule the account-owner assignment enforces: only an ACTIVE member
      // of this tenant can be put on one of its accounts. Without this a valid
      // uuid for a user in another tenant would be accepted by the FK and then
      // render as a roster entry nobody in the firm recognises.
      const members = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS "id"
        FROM tenant_memberships
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND user_id = CAST(${userId} AS uuid)
          AND status = 'active'::membership_status
        LIMIT 1
      `;
      if (members.length === 0) {
        throw new BadRequestException('Account team members must be active members of this tenant');
      }

      await tx.$executeRaw`
        INSERT INTO client_team_members (tenant_id, client_id, user_id, role, added_by)
        VALUES (
          CAST(${ctx.tenantId} AS uuid),
          CAST(${clientId} AS uuid),
          CAST(${userId} AS uuid),
          ${role},
          CAST(${ctx.userId} AS uuid)
        )
        ON CONFLICT (tenant_id, client_id, user_id)
        DO UPDATE SET role = EXCLUDED.role
      `;
    });

    return this.list(ctx, clientId);
  }

  /**
   * Take a user off the account team.
   *
   * This removes a `client_team_members` row only. It deliberately does NOT
   * clear `clients.account_owner_user_id`: dropping the account owner is a
   * different, `user_admin`-gated decision that already has its own endpoint,
   * and doing it as a side effect of a roster edit would be a surprise.
   */
  async remove(ctx: TenantContext, clientId: string, userId: string): Promise<ClientTeamMember[]> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerClient(tx, ctx, clientId, true);
      const owners = await tx.$queryRaw<{ id: string }[]>`
        SELECT user_id::text AS "id"
        FROM client_ordered_owners
        WHERE client_id = CAST(${clientId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND user_id = CAST(${userId} AS uuid)
        LIMIT 1
      `;
      if (owners.length > 0) {
        throw new BadRequestException(
          'That user is an account owner. Update ordered account owners before removing them from the team.',
        );
      }
      await tx.$executeRaw`
        DELETE FROM client_team_members
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND client_id = CAST(${clientId} AS uuid)
          AND user_id = CAST(${userId} AS uuid)
      `;
    });

    return this.list(ctx, clientId);
  }
}
