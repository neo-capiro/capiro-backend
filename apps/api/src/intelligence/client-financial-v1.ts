import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientFinancialLobbyingPorts } from './client-financial-v1.types.js';

/** Reviewed LDA and contractor attribution for the client's lobbying ROI. */
export class ClientFinancialV1Lobbying {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientFinancialLobbyingPorts,
  ) {}

  async getLobbyingRoi(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, name: true, ldaClientIds: true },
      }),
    );

    if (!client) {
      return {
        clientId,
        clientName: null,
        mappedLdaClientId: null,
        mappedLdaClientIds: [] as number[],
        mappedContractorId: null,
        lobbySpend: 0,
        contractWins: 0,
        roi: null,
        gap: 0,
      };
    }

    const [ldaMappings, contractingMapping] = await this.readReviewedMappings(clientId, tenantId);

    const ldaClientIds = this.ports.pickLdaClientIds(
      client.ldaClientIds,
      ldaMappings.map((m) => m.externalId),
    );

    let lobbySpend = 0;

    let contractWins = 0;

    if (ldaClientIds.length) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COALESCE(SUM(income), 0)::float AS total
        FROM lda_filing
        WHERE client_id = ANY(${ldaClientIds}::int[])
      `;
      lobbySpend = rows[0]?.total ?? 0;
    }

    if (contractingMapping) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COALESCE(total_contracts, 0)::float AS total
        FROM federal_contractor
        WHERE id = ${contractingMapping.externalId}::uuid
      `;
      contractWins = rows[0]?.total ?? 0;
    }

    const roi = lobbySpend > 0 ? contractWins / lobbySpend : null;

    return {
      clientId,
      clientName: client.name,
      mappedLdaClientId: ldaClientIds[0] ?? null, // representative scalar (back-compat)
      mappedLdaClientIds: ldaClientIds,
      mappedContractorId: contractingMapping?.externalId ?? null,
      lobbySpend,
      contractWins,
      roi,
      gap: contractWins - lobbySpend,
    };
  }

  private readReviewedMappings(clientId: string, tenantId: string) {
    return Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: { clientId, source: 'lda', confirmed: true },
          select: { externalId: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findFirst({
          where: {
            clientId,
            source: 'contracting',
            confirmed: true,
            reviewStatus: 'confirmed',
            rollUpAwards: true,
          },
        }),
      ),
    ]);
  }
}
