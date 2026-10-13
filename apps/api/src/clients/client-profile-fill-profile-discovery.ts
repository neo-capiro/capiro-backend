import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { ClientFacility } from '@prisma/client';
import type { IntelligenceService } from '../intelligence/intelligence.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientFacilitiesService } from './client-facilities.service.js';
import type { CompletionFindingInput } from './client-profile-fill-completion-persistence.js';
import { asRecord, asString, stableJson } from './client-profile-fill.helpers.js';

type FacilitySnapshot = Pick<
  ClientFacility,
  'id' | 'name' | 'addressLine' | 'city' | 'state' | 'zip' | 'geocodeStatus' | 'updatedAt'
>;
type AddressedFacility = Pick<
  ClientFacility,
  | 'id'
  | 'name'
  | 'addressLine'
  | 'city'
  | 'state'
  | 'zip'
  | 'congressionalDistrict'
  | 'stateHouseDistrict'
  | 'stateSenateDistrict'
  | 'geocodeStatus'
>;

export interface ProfileDiscoveryPorts {
  persistFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
  ): Promise<boolean>;
  recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ): Promise<void>;
  safeError(error: unknown): string;
}

export class ClientProfileFillProfileDiscovery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intelligence: IntelligenceService,
    private readonly facilities: ClientFacilitiesService,
    private readonly ports: ProfileDiscoveryPorts,
  ) {}

  async gatherFederalMarket(ctx: TenantContext, clientId: string, runId: string): Promise<number> {
    const profile = asRecord(await this.intelligence.getClientProfile(clientId, ctx.tenantId));
    const contracting = asRecord(profile.contracting);
    await this.ports.recordCursor(ctx.tenantId, clientId, 'federal_market', {
      refreshedAt: new Date().toISOString(),
      matched: contracting.matched === true,
    });
    if (contracting.matched !== true) return 0;
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      }),
    );
    const proposedValue = {
      contractorName: contracting.contractorName ?? null,
      totalContracts: contracting.totalContracts ?? null,
      rankByContracts: contracting.rankByContracts ?? null,
      noBidTotal: contracting.noBidTotal ?? null,
      topAgencies: Array.isArray(contracting.topAgencies) ? contracting.topAgencies : [],
      yearlySpend: Array.isArray(contracting.yearlySpend) ? contracting.yearlySpend : [],
      refreshedAt: new Date().toISOString(),
    };
    const currentValue = asRecord(client?.intakeData).federalMarket ?? null;
    return (await this.ports.persistFinding(ctx.tenantId, clientId, runId, {
      kind: 'federal_footprint',
      targetKey: 'federalMarket',
      source: 'federal_market',
      factKind: 'fact',
      currentValue,
      proposedValue,
      confidence: 0.95,
      status: 'pending',
      evidence: [
        {
          label: 'Resolved federal contracting footprint',
          source: 'Capiro Federal Market / USAspending corpus',
          metadata: {
            contractorName: proposedValue.contractorName,
            totalContracts: proposedValue.totalContracts,
          },
        },
      ],
    }))
      ? 1
      : 0;
  }

  async gatherFacilityResolution(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const [facilities, proposedFacilities] = await this.loadFacilitySnapshot(ctx, clientId, runId);
    let count = 0;
    for (const facility of facilities) {
      const missing = missingAddressParts(facility);
      if (!missing.length) continue;
      const inserted = await this.ports.persistFinding(
        ctx.tenantId,
        clientId,
        runId,
        this.facilityResolutionFinding(facility, missing),
      );
      if (inserted) count += 1;
    }
    for (const row of proposedFacilities) {
      const proposal = asRecord(row.proposedValue);
      const missing = missingAddressParts(proposal);
      if (!missing.length) continue;
      const key = createHash('sha256').update(stableJson(proposal)).digest('hex').slice(0, 20);
      const inserted = await this.ports.persistFinding(
        ctx.tenantId,
        clientId,
        runId,
        this.proposedFacilityResolutionFinding(proposal, missing, key),
      );
      if (inserted) count += 1;
    }
    const latest = facilities
      .map((facility) => facility.updatedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    await this.ports.recordCursor(ctx.tenantId, clientId, 'facility_resolution', {
      latestFacilityUpdatedAt: latest?.toISOString() ?? null,
      facilityCount: facilities.length,
    });
    return count;
  }

  async gatherDistrictNexus(ctx: TenantContext, clientId: string, runId: string): Promise<number> {
    const rows = await this.loadAddressedFacilities(ctx, clientId);
    let count = 0;
    for (const facility of rows) {
      try {
        const resolved = await this.facilities.resolveFacilityDistrict(ctx, clientId, facility.id);
        const inserted = await this.ports.persistFinding(
          ctx.tenantId,
          clientId,
          runId,
          this.districtFinding(facility, resolved),
        );
        if (inserted) count += 1;
      } catch (error) {
        const inserted = await this.ports.persistFinding(
          ctx.tenantId,
          clientId,
          runId,
          this.districtFailureFinding(facility, error),
        );
        if (inserted) count += 1;
      }
    }
    await this.ports.recordCursor(ctx.tenantId, clientId, 'district_nexus', {
      resolvedAt: new Date().toISOString(),
      attemptedFacilities: rows.length,
    });
    return count;
  }

  private async loadFacilitySnapshot(ctx: TenantContext, clientId: string, runId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.clientFacility.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          geocodeStatus: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      const pending = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
        `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'facility' AND status = 'pending'`,
        ctx.tenantId,
        clientId,
        runId,
      );
      return [rows, pending] as const;
    });
  }

  private facilityResolutionFinding(
    facility: FacilitySnapshot,
    missing: string[],
  ): CompletionFindingInput {
    return {
      kind: 'facility_resolution',
      targetKey: `facility-resolution:${facility.id}`,
      source: 'facility_resolution',
      factKind: 'fact',
      currentValue: facility,
      proposedValue: {
        facilityId: facility.id,
        facilityName: facility.name,
        status: 'insufficient_address',
        missing,
      },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: `Cannot resolve ${facility.name} until ${missing.join(', ')} is supplied`,
          source: 'Client facility record',
        },
      ],
    };
  }

  private proposedFacilityResolutionFinding(
    proposal: Record<string, unknown>,
    missing: string[],
    key: string,
  ): CompletionFindingInput {
    return {
      kind: 'facility_resolution',
      targetKey: `proposed-facility-resolution:${key}`,
      source: 'facility_resolution',
      factKind: 'fact',
      currentValue: null,
      proposedValue: {
        facilityName: asString(proposal.name) ?? 'Proposed facility',
        status: 'insufficient_address',
        missing,
      },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: `The proposed facility needs ${missing.join(', ')} before District Nexus can resolve it`,
          source: 'Fill with Meri public-web finding',
        },
      ],
    };
  }

  private async loadAddressedFacilities(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          tenantId: ctx.tenantId,
          clientId,
          addressLine: { not: null },
          city: { not: null },
          state: { not: null },
        },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          congressionalDistrict: true,
          stateHouseDistrict: true,
          stateSenateDistrict: true,
          geocodeStatus: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      }),
    );
  }

  private districtFinding(
    facility: AddressedFacility,
    resolved: Awaited<ReturnType<ClientFacilitiesService['resolveFacilityDistrict']>>,
  ): CompletionFindingInput {
    return {
      kind: 'district_nexus',
      targetKey: `district-nexus:${facility.id}`,
      source: 'district_nexus',
      factKind: 'fact',
      currentValue: {
        congressionalDistrict: facility.congressionalDistrict,
        stateHouseDistrict: facility.stateHouseDistrict,
        stateSenateDistrict: facility.stateSenateDistrict,
        geocodeStatus: facility.geocodeStatus,
      },
      proposedValue: {
        facilityId: facility.id,
        facilityName: facility.name,
        congressionalDistrict: resolved.congressionalDistrict,
        stateHouseDistrict: resolved.stateHouseDistrict,
        stateSenateDistrict: resolved.stateSenateDistrict,
        geocodeStatus: resolved.geocodeStatus,
        matchedAddress: resolved.geocodeMatchedAddress,
        districtSource: resolved.districtSource,
      },
      confidence: resolved.geocodeStatus === 'matched' ? 1 : 0.8,
      status: 'informational',
      evidence: [
        {
          label: `Resolved ${facility.name} through the Census-authoritative district pipeline`,
          source: 'U.S. Census Geocoder / TIGER geography',
          metadata: { geocodeStatus: resolved.geocodeStatus },
        },
      ],
    };
  }

  private districtFailureFinding(
    facility: AddressedFacility,
    error: unknown,
  ): CompletionFindingInput {
    return {
      kind: 'facility_resolution',
      targetKey: `district-resolution-failed:${facility.id}`,
      source: 'district_nexus',
      factKind: 'fact',
      currentValue: facility,
      proposedValue: {
        facilityId: facility.id,
        facilityName: facility.name,
        status: 'no_match',
      },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: `District resolution did not produce an authoritative match for ${facility.name}`,
          source: 'Capiro facility geocoder',
          metadata: { error: this.ports.safeError(error) },
        },
      ],
    };
  }
}

function missingAddressParts(
  value:
    | Record<string, unknown>
    | {
        addressLine?: string | null;
        city?: string | null;
        state?: string | null;
      },
) {
  const row = value as Record<string, unknown>;
  const missing: string[] = [];
  if (!asString(row.addressLine)) missing.push('street address');
  if (!asString(row.city)) missing.push('city');
  if (!asString(row.state)) missing.push('state');
  return missing;
}
