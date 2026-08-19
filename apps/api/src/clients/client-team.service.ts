import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Client account teams — which of the firm's own users work a given client.
 *
 * Before this, Capiro stored exactly ONE person per client
 * (`clients.account_owner_user_id`), so the client profile's "Account team"
 * had no record behind it and the UI showed "No roster" with no way to add
 * anyone.
 *
 * The owner is NOT duplicated into `client_team_members`. It stays a column on
 * `clients`, and `list` merges the two so a caller gets one roster with the
 * owner marked — storing the owner twice would let the two drift, and every
 * existing owner read path would have to learn about the new table.
 */

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
      await this.assertClient(tx, ctx.tenantId, clientId);

      const rows = await tx.$queryRaw<TeamRow[]>`
        SELECT
          NULL::text                     AS "id",
          u.id::text                     AS "userId",
          u.email::text                   AS "email",
          u.first_name                   AS "firstName",
          u.last_name                    AS "lastName",
          m.role                         AS "role",
          true                           AS "isOwner",
          NULL::timestamptz              AS "addedAt"
        FROM clients c
        INNER JOIN users u ON u.id = c.account_owner_user_id
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
          m.created_at                   AS "addedAt"
        FROM client_team_members m
        INNER JOIN users u ON u.id = m.user_id
        INNER JOIN clients c ON c.id = m.client_id AND c.tenant_id = m.tenant_id
        WHERE m.client_id = CAST(${clientId} AS uuid)
          AND m.tenant_id = CAST(${ctx.tenantId} AS uuid)
          -- The owner is emitted by the first branch; skip the duplicate.
          AND (c.account_owner_user_id IS NULL OR m.user_id <> c.account_owner_user_id)

        ORDER BY "isOwner" DESC, "firstName" NULLS LAST, "lastName" NULLS LAST, "email"
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
      await this.assertClient(tx, ctx.tenantId, clientId);

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
      await this.assertClient(tx, ctx.tenantId, clientId);
      const owners = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS "id"
        FROM clients
        WHERE id = CAST(${clientId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND account_owner_user_id = CAST(${userId} AS uuid)
        LIMIT 1
      `;
      if (owners.length > 0) {
        throw new BadRequestException(
          'That user is the account owner. Reassign the account owner instead of removing them from the team.',
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

  /** 404 rather than an empty roster when the client is not this tenant's. */
  private async assertClient(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
  ): Promise<void> {
    const clients = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS "id"
      FROM clients
      WHERE id = CAST(${clientId} AS uuid)
        AND tenant_id = CAST(${tenantId} AS uuid)
      LIMIT 1
    `;
    if (clients.length === 0) throw new NotFoundException('Client not found');
  }
}
