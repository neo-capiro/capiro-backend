import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TangoStoreService, computeFilterFingerprint } from '../external/tango/tango-store.service.js';
import { TANGO_GATEWAY, type TangoGateway } from '../external/tango/tango.types.js';
import {
  AcquisitionPositionService,
  type AcquisitionPosition,
  type AcquisitionPositionReader,
} from './acquisition-position.js';

/** Canonical client-level vehicle posture used by forecast and opportunity reads. */
@Injectable()
export class FundingOpportunityAcquisitionPositionService {
  private readonly position: AcquisitionPositionService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tangoStore: TangoStoreService,
    @Inject(TANGO_GATEWAY) private readonly tangoGateway: TangoGateway,
  ) {
    this.position = new AcquisitionPositionService(this.reader());
  }

  getPosition(tenantId: string, clientId: string): Promise<AcquisitionPosition> {
    return this.position.getPosition(tenantId, clientId);
  }

  private reader(): AcquisitionPositionReader {
    const filterFingerprint = computeFilterFingerprint({});
    return {
      isConfigured: () => this.tangoGateway.configured,
      getSyncStatus: async () => {
        const checkpoint = await this.tangoStore.readCheckpoint('sync-tango-vehicles', 'vehicle', filterFingerprint);
        return {
          neverSynced: checkpoint == null,
          lastSyncedAt: checkpoint?.lastRunAt?.toISOString() ?? null,
        };
      },
      listRelevantVehicles: (tenantId, clientId) => this.prisma.withTenant(tenantId, (tx) =>
        tx.clientRelevantVehicle.findMany({
          where: { clientId },
          select: {
            tangoVehicleId: true,
            vehicleName: true,
            vehicleType: true,
            relationship: true,
            recipientUei: true,
            orderCount: true,
            idvObligations: true,
            idvContractsValue: true,
            lastSyncedAt: true,
          },
        }),
      ),
      getVehicleSnapshot: async (tangoVehicleId) => {
        const snapshot = await this.tangoStore.getActiveSnapshot('vehicle', tangoVehicleId);
        if (!snapshot) return null;
        const normalized = snapshot.normalizedJsonb as { lastDateToOrder?: string | null } | null;
        return { lastDateToOrder: normalized?.lastDateToOrder ?? null };
      },
    };
  }
}
