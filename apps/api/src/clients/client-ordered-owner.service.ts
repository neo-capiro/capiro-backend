import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const replacement = z
  .object({
    expectedVersion: z.number().int().min(0).max(2147483647),
    userIds: z
      .array(uuid)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
const labels = ['Primary', 'Secondary', 'Tertiary', 'Quaternary'] as const;
export interface OrderedOwner {
  userId: string;
  rank: number;
  label: (typeof labels)[number];
  available: boolean;
  person: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
}
type OwnerRow = {
  userId: string;
  rank: number;
  active: boolean;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};
const conflict = (code: string, message: string) =>
  new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });

@Injectable()
export class ClientOrderedOwnerService {
  constructor(private readonly prisma: PrismaService) {}

  async get(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const state = await requireOwnerClient(tx, ctx, clientId);
      return this.view(tx, ctx, clientId, state.version);
    });
  }

  async replace(ctx: TenantContext, clientId: string, raw: unknown) {
    const parsed = replacement.safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Invalid ordered account owners');
    const { userIds, expectedVersion } = parsed.data;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const state = await requireOwnerClient(tx, ctx, clientId, true);
      if (state.version !== expectedVersion)
        throw conflict('owner_version_changed', 'Account owners changed. Reload before saving.');
      await this.validateMembers(tx, ctx, userIds);
      const before = await this.ids(tx, ctx, clientId);
      const version = await this.persist(tx, ctx, clientId, before, userIds, state.version);
      return this.view(tx, ctx, clientId, version);
    });
  }

  /** Versionless legacy writes may change a single assignment, never discard
   * additional ranks. Returns the assignment in the SAME transaction snapshot. */
  async replaceLegacy(ctx: TenantContext, clientId: string, raw: string | null) {
    const parsed = uuid.nullable().safeParse(raw);
    if (!parsed.success) throw new BadRequestException('Invalid account owner');
    const primary = parsed.data;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const state = await requireOwnerClient(tx, ctx, clientId, true);
      const before = await this.ids(tx, ctx, clientId);
      if (before.length > 1 && primary !== before[0])
        throw conflict(
          'ordered_owners_required',
          'Use the ordered account owners editor to change Primary.',
        );
      // An exact legacy no-op does not reassign an inactive historical owner.
      if (primary !== (before[0] ?? null)) {
        const next = primary ? [primary] : [];
        await this.validateMembers(tx, ctx, next);
        await this.persist(tx, ctx, clientId, before, next, state.version);
      }
      const view = await this.view(tx, ctx, clientId, state.version);
      const first = view.owners[0];
      return { accountOwnerUserId: first?.userId ?? null, accountOwner: first?.person ?? null };
    });
  }

  private async ids(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string) {
    const rows = await tx.$queryRaw<Array<{ userId: string }>>`
      SELECT user_id::text AS "userId" FROM client_ordered_owners
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid ORDER BY rank`;
    return rows.map((row) => row.userId);
  }

  private async validateMembers(tx: Prisma.TransactionClient, ctx: TenantContext, ids: string[]) {
    if (!ids.length) return;
    const rows = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
      SELECT user_id::text AS "userId" FROM tenant_memberships
      WHERE tenant_id=${ctx.tenantId}::uuid AND status::text='active'
        AND user_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      FOR SHARE`);
    const active = new Set(rows.map((row) => row.userId));
    if (ids.some((id) => !active.has(id)))
      throw new BadRequestException(
        'Account owners must be distinct active members of this tenant',
      );
  }

  private async persist(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    before: string[],
    after: string[],
    version: number,
  ) {
    if (before.length === after.length && before.every((id, i) => id === after[i])) return version;
    if (version >= 2147483647)
      throw conflict(
        'owner_version_exhausted',
        'Account owner version requires administrator recovery.',
      );
    await tx.$executeRaw`DELETE FROM client_ordered_owners
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid`;
    for (const [index, id] of after.entries()) {
      await tx.$executeRaw`INSERT INTO client_ordered_owners(tenant_id,client_id,rank,user_id)
        VALUES(${ctx.tenantId}::uuid,${clientId}::uuid,${index + 1},${id}::uuid)`;
    }
    await tx.$executeRaw`UPDATE clients SET account_owner_user_id=${after[0] ?? null}::uuid,
      account_owner_version=account_owner_version+1, updated_at=NOW()
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid`;
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action: 'client.account_owners.replace',
        entityType: 'client',
        entityId: clientId,
        before: { version, userIds: before },
        after: { version: version + 1, userIds: after },
      },
    });
    return version + 1;
  }

  private async view(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    version: number,
  ) {
    const rows = await tx.$queryRaw<OwnerRow[]>`
      SELECT o.user_id::text AS "userId", o.rank, tm.status::text='active' AS active,
        u.email::text, u.first_name AS "firstName", u.last_name AS "lastName"
      FROM client_ordered_owners o
      LEFT JOIN tenant_memberships tm ON tm.tenant_id=o.tenant_id AND tm.user_id=o.user_id
      LEFT JOIN users u ON u.id=o.user_id
      WHERE o.tenant_id=${ctx.tenantId}::uuid AND o.client_id=${clientId}::uuid ORDER BY o.rank`;
    return {
      tenantId: ctx.tenantId,
      clientId,
      version,
      owners: rows.map((row): OrderedOwner => ({
        userId: row.userId,
        rank: row.rank,
        label: labels[row.rank - 1]!,
        available: row.active === true && !!row.email,
        person:
          row.active === true && row.email
            ? {
                id: row.userId,
                email: row.email,
                firstName: row.firstName,
                lastName: row.lastName,
              }
            : null,
      })),
    };
  }
}
