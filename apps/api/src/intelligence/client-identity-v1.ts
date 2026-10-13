import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RelevantBillsResult } from './intelligence-bill-discovery.shared.js';
import type {
  ClientIdentityProfilePorts,
  ClientIdentityCrmClient,
  ClientIdentityCapability,
  ClientIdentityMapping,
  ClientIdentityLda,
  ClientIdentityContractor,
  ClientIdentityLobbyIntel,
  ClientIdentityRegulations,
  ClientIdentityCompetitors,
} from './client-identity-v1.types.js';

/** Confirmed/fuzzy external identity resolution and the complete base client profile. */
export class ClientIdentityV1Profile {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientIdentityProfilePorts,
  ) {}

  async getClientProfile(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        include: { capabilities: true },
      }),
    );

    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');

    const clientName = client.name;

    const capabilityRefs = (client.capabilities ?? []).map((c) => ({
      name: c.name,
      sector: c.sector ?? null,
      tags: Array.isArray(c.tags)
        ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    }));

    const existingMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId },
        orderBy: { confidence: 'desc' },
      }),
    );

    const confirmedBySource = new Map<string, string>();

    for (const m of existingMappings) {
      const identityMayAttributeAwards =
        m.source !== 'contracting' || (m.reviewStatus === 'confirmed' && m.rollUpAwards === true);
      if (m.confirmed && identityMayAttributeAwards && !confirmedBySource.has(m.source)) {
        confirmedBySource.set(m.source, m.externalId);
      }
    }

    const confirmedLdaExternalIds = existingMappings
      .filter((m) => m.source === 'lda' && m.confirmed)
      .map((m) => m.externalId);

    const ldaClientIds = this.ports.pickLdaClientIds(client.ldaClientIds, confirmedLdaExternalIds);

    const [ldaMatch, contractorMatch, lobbyMatch] = await Promise.all([
      ldaClientIds.length
        ? this.ports.fetchLdaByIds(ldaClientIds)
        : this.ports.fuzzyMatchLda(clientName),
      confirmedBySource.has('contracting')
        ? this.ports.fetchContractorById(confirmedBySource.get('contracting')!)
        : this.ports.fuzzyMatchContractor(clientName),
      confirmedBySource.has('lobby_intel')
        ? this.ports.fetchLobbyIntelById(confirmedBySource.get('lobby_intel')!)
        : this.ports.fuzzyMatchLobbyIntel(clientName),
    ]);

    const issueCodes: string[] = ldaMatch?.issueCodes ?? [];

    const capabilityFallbackTerms = issueCodes.length
      ? []
      : await this.ports.capabilityFallbackTerms(tenantId, clientId);

    const [relevantBills, activeRegulations, competitors] = await Promise.all([
      this.ports.findRelevantBills(issueCodes, capabilityFallbackTerms),
      this.ports.findActiveRegulations(issueCodes, capabilityFallbackTerms),
      this.ports.findCompetitors(clientName, issueCodes, ldaClientIds),
    ]);
    return this.projectProfile(
      client,
      capabilityRefs,
      existingMappings,
      ldaMatch,
      contractorMatch,
      lobbyMatch,
      relevantBills,
      activeRegulations,
      competitors,
    );
  }

  private projectProfile(
    client: ClientIdentityCrmClient,
    capabilityRefs: ClientIdentityCapability[],
    existingMappings: ClientIdentityMapping[],
    ldaMatch: ClientIdentityLda | null,
    contractorMatch: ClientIdentityContractor | null,
    lobbyMatch: ClientIdentityLobbyIntel | null,
    relevantBills: RelevantBillsResult,
    activeRegulations: ClientIdentityRegulations,
    competitors: ClientIdentityCompetitors,
  ) {
    return {
      client: {
        id: client.id,
        name: client.name,
        description: client.description,
        sectorTag: client.sectorTag,
        submissionTracks: client.submissionTracks ?? [],
        capabilities: capabilityRefs,
      },
      mappings: existingMappings,
      lda: ldaMatch ?? {
        matched: false,
        ldaClientId: null,
        ldaClientIds: [],
        confidence: 0,
        totalFilings: 0,
        totalSpending: null,
        issueCodes: [],
        recentFilings: [],
        yearlySpend: [],
      },
      contracting: contractorMatch ?? {
        matched: false,
        contractorName: null,
        totalContracts: null,
        rankByContracts: null,
        noBidTotal: null,
        topAgencies: [],
        yearlySpend: [],
      },
      lobbyIntel: lobbyMatch ?? {
        matched: false,
        trajectory: null,
        growthRate: null,
        totalSpending: null,
      },
      relevantBills,
      activeRegulations,
      competitors,
      aiSummary: null, // Populated by Phase 4
      lastUpdated: new Date().toISOString(),
    };
  }
}
