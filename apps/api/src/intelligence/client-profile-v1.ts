import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { classifyTrajectory } from './trajectory-classifier.model.js';
import type { ProfileV1Context, ProfileV1Ports } from './client-profile-v1.shared.js';
import { collectProfileV1Sources } from './client-profile-v1-sources.js';
import { settleProfileV1Sources } from './client-profile-v1-sources.js';
import { buildProfileV1Snapshot } from './client-profile-v1-snapshot.js';
import {
  buildProfileV1Kanban,
  prepareProfileV1HearingScope,
  readProfileV1CommitteeJurisdiction,
  buildProfileV1Hearings,
} from './client-profile-v1-legislative.js';
import {
  buildProfileV1DistrictRows,
  prepareProfileV1Relationships,
  buildProfileV1ScopedGraph,
  profileV1HeroTruthState,
} from './client-profile-v1-relationships.js';
import {
  buildProfileV1Sections,
  buildProfileV1Envelope,
} from './client-profile-v1-presentation.js';

/** Complete profile-v1 request composition over canonical, late-bound source ports. */
export class IntelligenceClientProfileV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ProfileV1Ports,
  ) {}
  async getClientProfileV1WithinBillDeadline(clientId: string, tenantId: string, userId?: string) {
    const { prisma, ports } = this;
    const client = await prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, name: true, status: true },
      }),
    );
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');
    const context = createProfileV1Context(client, clientId, tenantId, userId);
    const { now } = context;
    const { settled, settledSourceLabels } = await collectProfileV1Sources(prisma, ports, context);
    const values = settleProfileV1Sources(ports, context, settled, settledSourceLabels);
    const { profile, roi, trackedBills, regLinks, mappingRows, clientRelevantRegs } = values;
    const confirmedSources = new Set(mappingRows.filter((m) => m.confirmed).map((m) => m.source));
    const sourceCount = confirmedSources.size;
    const unresolvedMappings = mappingRows.filter((m) => !m.confirmed).length;
    const snapshot = buildProfileV1Snapshot(context, values);
    const kanbanColumns = buildProfileV1Kanban(values);
    const regulatoryLifecycle = ports.buildRegulatoryLifecycle(regLinks, clientRelevantRegs, now);
    const hearingScope = prepareProfileV1HearingScope(values);
    if (hearingScope.trackedBillIdList.length > 0) {
      await readProfileV1CommitteeJurisdiction(prisma, ports, clientId, hearingScope);
    }
    const hearingsList = buildProfileV1Hearings(values, hearingScope);
    const districtRows = buildProfileV1DistrictRows(values);
    const relationships = prepareProfileV1Relationships(values, hearingsList);
    const { trackedBillIdsForRec } = relationships;
    const officeRecommendations = ports.officeRecommender()
      ? await ports.officeRecommender()!.recommend({
          clientId,
          tenantId: tenantId ?? '',
          trackedBillIds: trackedBillIdsForRec,
          trackedBills: trackedBills.bills.map((b) => ({
            identifier: b.identifier,
            subjectNames: b.subjectNames ?? [],
          })),
          issueCodes: trackedBills.issueCodes ?? [],
        })
      : [];
    const scopedGraph = buildProfileV1ScopedGraph(values, relationships, officeRecommendations);
    const heroTruthState = profileV1HeroTruthState(values);
    const quarterRoiSeries = await this.readQuarterRoi(ports, clientId, roi, profile, now);
    const trajectoryModel = classifyTrajectory({
      yearlySpend: profile.lda.yearlySpend,
      growthRate: profile.lobbyIntel.growthRate,
      totalSpending: profile.lobbyIntel.totalSpending,
      sourceLabel: profile.lobbyIntel.trajectory,
    });
    const sections = buildProfileV1Sections(
      {
        context,
        values,
        snapshot,
        kanbanColumns,
        regulatoryLifecycle,
        hearingsList,
        districtRows,
        officeRecommendations,
        scopedGraph,
        heroTruthState,
        quarterRoiSeries,
        trajectoryModel,
      },
      ports,
    );
    return buildProfileV1Envelope(context, values, snapshot, sections, {
      sourceCount,
      unresolvedMappings,
    });
  }

  private async readQuarterRoi(
    ports: ProfileV1Ports,
    clientId: string,
    roi: Awaited<ReturnType<ProfileV1Ports['getLobbyingRoi']>>,
    profile: Awaited<ReturnType<ProfileV1Ports['getClientProfile']>>,
    now: Date,
  ) {
    const quarterRoiSeries = await ports
      .withSourceBudget(
        'roiQuarterSeries',
        clientId,
        ports.buildRoiQuarterSeries({
          mappedLdaClientIds: roi.mappedLdaClientIds,
          lobbyingYearly: profile.lda.yearlySpend,
          obligationsYearly: profile.contracting.yearlySpend,
          now,
        }),
      )
      .catch((err: unknown) => {
        ports.warn(
          `profile-v1 source "roiQuarterSeries" failed for client ${clientId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [] as Array<{ label: string; lobbying: number; obligations: number }>;
      });
    return quarterRoiSeries;
  }
}

function createProfileV1Context(
  client: ProfileV1Context['client'],
  clientId: string,
  tenantId: string,
  userId?: string,
): ProfileV1Context {
  const now = new Date();
  const day14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const day21 = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
  const day7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const day30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const context: ProfileV1Context = {
    client,
    clientId,
    tenantId,
    userId,
    now,
    day14,
    day21,
    day7,
    day30,
  };
  return context;
}
