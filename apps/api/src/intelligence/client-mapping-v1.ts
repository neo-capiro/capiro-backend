import type { PrismaService } from '../prisma/prisma.service.js';
import { NotFoundException } from '@nestjs/common';

type MappingCandidate = Array<{
  source: string;
  externalId: string;
  externalName: string;
  confidence: number;
}>;

export class ClientMappingV1 {
  constructor(private readonly prisma: PrismaService) {}

  async getMappings(clientId: string, tenantId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientIntelMapping.findMany({
        where: { clientId },
        orderBy: { confidence: 'desc' },
      });
    });
  }

  async resolveMapping(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId } }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const clientName = client.name;
    const results: Array<{
      source: string;
      externalId: string;
      externalName: string;
      confidence: number;
    }> = [];

    // Match against each source
    const ldaRows = await this.prisma.$queryRaw<
      Array<{ id: number; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM lda_client WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of ldaRows) {
      results.push({
        source: 'lda',
        externalId: String(r.id),
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    const contractorRows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM federal_contractor WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of contractorRows) {
      results.push({
        source: 'contracting',
        externalId: r.id,
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    const lobbyRows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; similarity: number }>
    >`
      SELECT id, name, similarity(name, ${clientName}) as similarity
      FROM lobby_intel_mv WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC LIMIT 3
    `;
    for (const r of lobbyRows) {
      results.push({
        source: 'lobby_intel',
        externalId: r.id,
        externalName: r.name,
        confidence: r.similarity,
      });
    }

    // Upsert mappings (one tenant-scoped transaction for the whole loop)
    const mappings = await this.persistResolvedMappings(clientId, tenantId, results);

    return mappings;
  }

  async getAllMappingsForTenant(tenantId: string) {
    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      // Exclude soft-archived ("deleted") clients from the mappings admin view.
      tx.client.findMany({
        where: { status: { not: 'archived' } },
        select: { id: true, name: true },
      }),
    );

    const clientIds = clients.map((c) => c.id);
    if (!clientIds.length) return [];

    const mappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId: { in: clientIds } },
        orderBy: { confidence: 'desc' },
      }),
    );

    const clientMap = new Map(clients.map((c) => [c.id, c.name]));
    return mappings.map((m) => ({ ...m, clientName: clientMap.get(m.clientId) ?? '' }));
  }

  private persistResolvedMappings(clientId: string, tenantId: string, results: MappingCandidate) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const out = [];
      for (const r of results) {
        const mapping = await tx.clientIntelMapping.upsert({
          where: {
            clientId_source_externalId: {
              clientId,
              source: r.source,
              externalId: r.externalId,
            },
          },
          update: {
            externalName: r.externalName,
            confidence: r.confidence,
          },
          create: {
            tenantId,
            clientId,
            source: r.source,
            externalId: r.externalId,
            externalName: r.externalName,
            confidence: r.confidence,
            // NEVER auto-confirmed. See this method's docblock: `confidence` here
            // is a bare trigram similarity, and a name is not an identity.
            confirmed: false,
            matchBasis: 'fuzzy_name',
            matchTier: 4,
          },
        });
        out.push(mapping);
      }
      return out;
    });
  }
}
