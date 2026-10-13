import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Client } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface ListClientsFilter {
  profileStatus?: string;
  sectorTag?: string;
  /** Operational reads hide archived clients unless management opts in. */
  includeArchived?: boolean;
}

type ClientProjection = (client: Client) => Promise<Client & { logoUrl: string | null }>;

/** Canonical client read queries. Production retains its existing logo signer. */
export async function readClients(
  prisma: PrismaService, ctx: TenantContext, filter: ListClientsFilter,
  project: ClientProjection,
) {
  // Explicit predicate remains required even for an owner connection bypassing RLS.
  const where: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (filter.profileStatus) where.profileStatus = filter.profileStatus;
  if (filter.sectorTag) where.sectorTag = filter.sectorTag;
  if (!filter.includeArchived) where.status = { not: 'archived' };
  const clients = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.client.findMany({ where, orderBy: { createdAt: 'desc' } }),
  );
  return Promise.all(clients.map(project));
}

export async function readClient(
  prisma: PrismaService, ctx: TenantContext, id: string, project: ClientProjection,
) {
  const client = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.client.findFirst({ where: { id, tenantId: ctx.tenantId } }),
  );
  if (!client) throw new NotFoundException('Client not found');
  return project(client);
}
