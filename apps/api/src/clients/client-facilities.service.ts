import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { isValidDistrictForState } from '../common/us-congressional-districts.js';
import { computeFacilityGeocode } from './facility-geocode.util.js';

export interface CreateFacilityInput {
  name: string;
  addressLine?: string;
  city?: string;
  state?: string;
  zip?: string;
  // Bare district number ("12"), state lives in `state`. Evidence strings
  // may print "TX-12" by combining the two; we never store the joined form.
  congressionalDistrict?: string;
  // How the district was determined: 'user' (manually entered) or 'geocoded'
  // (derived from the address). Defaults to 'user' when omitted on create.
  districtSource?: string;
  // District Impact Engine (Phase 1 M1.4) — manual fallback for the two state
  // legislative chambers when the geocoder returns no_match/ambiguous. A
  // future successful geocode overwrites these (geocoded wins, PD1.2).
  stateHouseDistrict?: string;
  stateSenateDistrict?: string;
  employeeCount?: number;
  notes?: string;
}

export type UpdateFacilityInput = Partial<CreateFacilityInput>;

@Injectable()
export class ClientFacilitiesService {
  private readonly logger = new Logger(ClientFacilitiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clientKb: ClientKbService,
  ) {}

  /**
   * District Impact Engine (Phase 1 M1.2) — best-effort, non-blocking geocode
   * on facility create/edit. The row already saved; a geocode failure here
   * never surfaces to the caller (the nightly `geocode-facilities` verb
   * backfills any miss). Re-scopes to the facility's own tenant.
   */
  private geocodeFacilityFireAndForget(tenantId: string, facilityId: string): void {
    void this.prisma
      .withTenant(tenantId, async (tx) => {
        const facility = await tx.clientFacility.findUnique({ where: { id: facilityId } });
        if (!facility) return;
        const outcome = await computeFacilityGeocode(facility);
        if (outcome.discrepancy) {
          this.logger.warn(
            `Geocode discrepancy for facility ${facilityId}: hand="${outcome.discrepancy.handEntered}" geocoded="${outcome.discrepancy.geocoded}"`,
          );
        }
        if (outcome.update) {
          await tx.clientFacility.update({ where: { id: facilityId }, data: outcome.update });
        }
      })
      .catch((err) => this.logger.warn(`Inline geocode failed for facility ${facilityId}: ${err.message}`));
  }

  async listFacilities(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientFacility.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async createFacility(ctx: TenantContext, clientId: string, input: CreateFacilityInput) {
    const facility = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientFacility.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          name: input.name,
          addressLine: input.addressLine ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          zip: input.zip ?? null,
          congressionalDistrict: input.congressionalDistrict ?? null,
          districtSource: input.districtSource ?? 'user',
          stateHouseDistrict: input.stateHouseDistrict ?? null,
          stateSenateDistrict: input.stateSenateDistrict ?? null,
          employeeCount: input.employeeCount ?? null,
          notes: input.notes ?? null,
        },
      });
    });
    // Client KB (F5): keep retrieval in sync with the Facilities tab.
    this.clientKb.indexFacilityFireAndForget(ctx.tenantId, facility.id);
    this.geocodeFacilityFireAndForget(ctx.tenantId, facility.id);
    return facility;
  }

  async updateFacility(
    ctx: TenantContext,
    clientId: string,
    id: string,
    input: UpdateFacilityInput,
  ) {
    const facility = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientFacility.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true, state: true, congressionalDistrict: true },
      });
      if (!existing) throw new NotFoundException('Facility not found');
      // The DTO's cross-field check only sees fields present in the PATCH
      // body, so a single-field update (state-only or district-only) pairs
      // with a stored sibling it was never validated against. Re-check the
      // EFFECTIVE pair — stored values merged with the incoming change —
      // before writing, so e.g. district "52" can't land on a WY row. Only
      // when the PATCH touches one of the pair: a legacy row whose STORED
      // pair predates validation must stay editable on unrelated fields.
      if ('state' in input || 'congressionalDistrict' in input) {
        const effectiveState = 'state' in input ? (input.state ?? null) : existing.state;
        const effectiveDistrict =
          'congressionalDistrict' in input
            ? (input.congressionalDistrict ?? null)
            : existing.congressionalDistrict;
        if (!isValidDistrictForState(effectiveState, effectiveDistrict)) {
          throw new BadRequestException(
            `congressionalDistrict "${effectiveDistrict}" is not a valid district for state ${effectiveState}`,
          );
        }
      }
      return tx.clientFacility.update({
        where: { id },
        data: {
          ...('name' in input ? { name: input.name } : {}),
          ...('addressLine' in input ? { addressLine: input.addressLine ?? null } : {}),
          ...('city' in input ? { city: input.city ?? null } : {}),
          ...('state' in input ? { state: input.state ?? null } : {}),
          ...('zip' in input ? { zip: input.zip ?? null } : {}),
          ...('congressionalDistrict' in input
            ? { congressionalDistrict: input.congressionalDistrict ?? null }
            : {}),
          // A hand-edited district no longer reflects a geocode: when the PATCH
          // touches congressionalDistrict without an explicit districtSource,
          // stamp provenance back to 'user'. Explicit districtSource still wins
          // (the geocoder PATCHes both fields together).
          ...('districtSource' in input
            ? { districtSource: input.districtSource ?? null }
            : 'congressionalDistrict' in input
              ? { districtSource: 'user' }
              : {}),
          ...('stateHouseDistrict' in input
            ? { stateHouseDistrict: input.stateHouseDistrict ?? null }
            : {}),
          ...('stateSenateDistrict' in input
            ? { stateSenateDistrict: input.stateSenateDistrict ?? null }
            : {}),
          ...('employeeCount' in input ? { employeeCount: input.employeeCount ?? null } : {}),
          ...('notes' in input ? { notes: input.notes ?? null } : {}),
        },
      });
    });
    this.clientKb.indexFacilityFireAndForget(ctx.tenantId, facility.id);
    // Only re-geocode when the address itself changed — an unrelated field
    // edit (notes, employeeCount) shouldn't fire a Census API call.
    if (
      'addressLine' in input ||
      'city' in input ||
      'state' in input ||
      'zip' in input
    ) {
      this.geocodeFacilityFireAndForget(ctx.tenantId, facility.id);
    }
    return facility;
  }

  async deleteFacility(ctx: TenantContext, clientId: string, id: string) {
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientFacility.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Facility not found');
      await tx.clientFacility.delete({ where: { id } });
      return { deleted: true };
    });
    this.clientKb.purgeFireAndForget(ctx.tenantId, 'client_facility', id);
    return result;
  }
}
