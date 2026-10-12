import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientOrderedOwnerService } from './client-ordered-owner.service.js';
import { requireOwnerActor } from './client-ordered-owner.access.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';

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

type OwnerRow = {
  accountOwnerUserId: string | null;
  id: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

@Injectable()
export class ClientAccountOwnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordered: ClientOrderedOwnerService,
  ) {}

  async listOptions(ctx: TenantContext): Promise<ClientAccountOwner[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerActor(tx, ctx);
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
    const view = await this.ordered.get(ctx, clientId);
    const first = view.owners[0];
    return { accountOwnerUserId: first?.userId ?? null, accountOwner: first?.person ?? null };
  }

  /**
   * Batch lookup: returns account owner assignments for ALL clients in the
   * tenant in one query. Used by the portfolio index to avoid N+1 per-client
   * calls to `get`. (Wire-audit "3 Compose extend" item 1.)
   */
  async listAll(ctx: TenantContext): Promise<Record<string, ClientAccountOwnerAssignment>> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await requireOwnerActor(tx, ctx);
      const rows = await tx.$queryRaw<Array<{ clientId: string } & OwnerRow>>`
        SELECT
          c.id::text AS "clientId",
          c.account_owner_user_id::text AS "accountOwnerUserId",
          u.id::text AS "id",
          u.email::text AS "email",
          u.first_name AS "firstName",
          u.last_name AS "lastName"
        FROM clients c
        LEFT JOIN tenant_memberships tm ON tm.tenant_id=c.tenant_id
          AND tm.user_id=c.account_owner_user_id AND tm.status::text='active'
        LEFT JOIN users u ON u.id = tm.user_id
        WHERE c.tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND c.status != 'archived'
      `;
      const denied = new Set(await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId));
      const map: Record<string, ClientAccountOwnerAssignment> = {};
      for (const row of rows) {
        if (denied.has(row.clientId)) continue;
        map[row.clientId] = {
          accountOwnerUserId: row.accountOwnerUserId,
          accountOwner:
            row.id && row.email
              ? { id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName }
              : null,
        };
      }
      return map;
    });
  }

  async update(
    ctx: TenantContext,
    clientId: string,
    accountOwnerUserId: string | null,
  ): Promise<ClientAccountOwnerAssignment> {
    return this.ordered.replaceLegacy(ctx, clientId, accountOwnerUserId);
  }
}
