import type { PrismaService } from '../prisma/prisma.service.js';
import { NotFoundException } from '@nestjs/common';

export class ClientBriefsV1 {
  constructor(private readonly prisma: PrismaService) {}

  async listClientBriefs(tenantId: string, clientId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          body: true,
          sourceAlertId: true,
          sourceType: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  async addClientBrief(
    tenantId: string,
    clientId: string,
    userId: string,
    input: {
      title: string;
      body: string;
      sourceAlertId?: string | null;
      sourceType?: string | null;
    },
  ) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.create({
        data: {
          tenantId,
          clientId,
          createdBy: userId,
          title: input.title.trim().slice(0, 300),
          body: input.body.trim(),
          sourceAlertId: input.sourceAlertId ?? null,
          sourceType: input.sourceType ?? 'manual',
        },
        select: {
          id: true,
          title: true,
          body: true,
          sourceAlertId: true,
          sourceType: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
  }

  async deleteClientBrief(tenantId: string, clientId: string, briefId: string) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientBrief.deleteMany({ where: { id: briefId, clientId } }),
    );
    return { ok: true };
  }
}
