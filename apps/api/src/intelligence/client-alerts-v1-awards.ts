import type { FederalAward } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  buildDistrictNexusIdentity,
  districtNexusContractorIdsToResolve,
  type DistrictNexusIdentitySeed,
} from '../district-nexus/district-nexus.identity.js';
import type { AlertRow, ClientAwardAlertPorts } from './client-alerts-v1.shared.js';

/** Reviewed contractor attribution and new award alert projection. */
export class ClientAwardAlertsV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientAwardAlertPorts,
  ) {}

  async getContractAwardAlerts(
    clientId: string,
    tenantId: string,
    since: Date,
  ): Promise<AlertRow[]> {
    try {
      const [mapping, client] = await this.prisma.withTenant(tenantId, (tx) =>
        Promise.all([
          tx.clientIntelMapping.findFirst({
            where: {
              clientId,
              source: 'contracting',
              confirmed: true,
              reviewStatus: 'confirmed',
              rollUpAwards: true,
            },
            select: { externalId: true, externalName: true, matchBasis: true, matchTier: true },
          }),
          tx.client.findFirst({ where: { id: clientId }, select: { uei: true } }),
        ]),
      );
      if (!mapping) return [];
      const seed: DistrictNexusIdentitySeed = {
        clientId,
        clientName: '',
        uei: client?.uei ?? null,
        mappings: [
          {
            source: 'contracting',
            externalId: mapping.externalId,
            externalName: mapping.externalName,
            matchBasis: mapping.matchBasis,
            matchTier: mapping.matchTier,
          },
        ],
      };
      const contractorUeis = await this.ports.resolveContractorUeisForAlerts(
        districtNexusContractorIdsToResolve([seed]),
      );
      const identity = buildDistrictNexusIdentity(seed, contractorUeis);
      if (identity.contract.basis === 'none') return [];
      const awards = await this.prisma.federalAward.findMany({
        where:
          identity.contract.basis === 'exact_uei'
            ? { recipientUei: { in: identity.contract.ueis }, awardedAt: { gte: since } }
            : {
                contractorName: { in: identity.contract.fallbackNames, mode: 'insensitive' },
                awardedAt: { gte: since },
              },
        orderBy: { awardedAt: 'desc' },
        take: 10,
      });
      return this.projectAwards(clientId, awards);
    } catch (err) {
      this.ports
        .logger()
        .warn(
          `getContractAwardAlerts failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      return [];
    }
  }

  private projectAwards(clientId: string, awards: FederalAward[]) {
    const out: AlertRow[] = [];
    for (const a of awards) {
      if (!a.awardedAt) continue;
      const amount = a.amount ? Number(a.amount) : 0;
      out.push({
        id: `award:${a.id}`,
        type: 'contract_award',
        severity: 'notable',
        title: `New federal award${amount > 0 ? `: $${Math.round(amount).toLocaleString('en-US')}` : ''}`,
        subtitle: `${a.awardingAgency ?? 'Federal agency'}${a.description ? ` · ${a.description.slice(0, 60)}` : ''}`,
        when: a.awardedAt.toISOString(),
        countdownDays: null,
        countdownLabel: null,
        href: `/intelligence/changes?clientId=${encodeURIComponent(clientId)}&source=contract_award`,
        _urgencyScore: 25,
        _typeRank: 1,
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  async resolveContractorUeisForAlerts(
    contractorIds: string[],
  ): Promise<Map<string, string | null>> {
    if (!contractorIds.length) return new Map();
    const rows = await this.prisma.federalContractor.findMany({
      where: { id: { in: contractorIds } },
      select: { id: true, uei: true },
    });
    return new Map(rows.map((r) => [r.id, r.uei]));
  }
}
