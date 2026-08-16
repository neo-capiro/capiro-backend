import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ClientAccountOwner {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface ClientAccountOwnerAssignment {
  accountOwnerUserId: string | null;
  accountOwner: ClientAccountOwner | null;
}

type OwnerRow = ClientAccountOwner & { accountOwnerUserId?: string | null };

@Injectable()
export class ClientAccountOwnerService {
  constructor(private readonly prisma: PrismaService) {}

  async listOptions(ctx: TenantContext): Promise<ClientAccountOwner[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      return tx.$queryRaw<ClientAccountOwner[]>`
        SELECT
          u.id::text AS "id",
          u.email::text AS "email",
          u.first_name AS "firstName",
          u.last_name AS "lastName"
        FROM tenant_memberships tm
        INNER JOIN users u ON u.id = tm.user_id
        WHERE tm.tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND tm.status = 'active'::membership_status
        ORDER BY COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), u.email
      `;
    });
  }

  async get(ctx: TenantContext, clientId: string): Promise<ClientAccountOwnerAssignment> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<OwnerRow[]>`
        SELECT
          c.account_owner_user_id::text AS "accountOwnerUserId",
          u.id::text AS "id",
          u.email::text AS "email",
          u.first_name AS "firstName",
          u.last_name AS "lastName"
        FROM clients c
        LEFT JOIN users u ON u.id = c.account_owner_user_id
        WHERE c.id = CAST(${clientId} AS uuid)
          AND c.tenant_id = CAST(${ctx.tenantId} AS uuid)
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Client not found');
      return {
        accountOwnerUserId: row.accountOwnerUserId ?? null,
        accountOwner: row.id
          ? { id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName }
          : null,
      };
    });
  }

  async update(
    ctx: TenantContext,
    clientId: string,
    accountOwnerUserId: string | null,
  ): Promise<ClientAccountOwnerAssignment> {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const clients = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS "id"
        FROM clients
        WHERE id = CAST(${clientId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        LIMIT 1
      `;
      if (clients.length === 0) throw new NotFoundException('Client not found');

      if (accountOwnerUserId) {
        const members = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS "id"
          FROM tenant_memberships
          WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
            AND user_id = CAST(${accountOwnerUserId} AS uuid)
            AND status = 'active'::membership_status
          LIMIT 1
        `;
        if (members.length === 0) {
          throw new BadRequestException('Account owner must be an active member of this tenant');
        }
      }

      await tx.$executeRaw`
        UPDATE clients
        SET account_owner_user_id = CAST(${accountOwnerUserId} AS uuid),
            updated_at = NOW()
        WHERE id = CAST(${clientId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
      `;
    });

    return this.get(ctx, clientId);
  }
}
