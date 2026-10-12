import { createHash } from 'node:crypto';
import { Prisma, type ClientFacility } from '@prisma/client';

/** Every semantic field protected by chooseGeocodeCandidate's database CAS. */
export type FacilityCandidateSnapshot = Pick<
  ClientFacility,
  | 'id'
  | 'tenantId'
  | 'clientId'
  | 'addressLine'
  | 'city'
  | 'state'
  | 'zip'
  | 'geocodeCandidates'
  | 'geocodeStatus'
  | 'geocodeAttemptCount'
  | 'geocodeInputHash'
  | 'congressionalDistrict'
  | 'congressionalDistrictCongress'
  | 'districtSource'
  | 'stateHouseDistrict'
  | 'stateSenateDistrict'
  | 'latitude'
  | 'longitude'
>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

/** Public deterministic digest, not authorization. JSONB keys may reorder; arrays may not. */
export function facilityGeocodeCandidateRevision(facility: FacilityCandidateSnapshot): string {
  const snapshot = {
    id: facility.id,
    tenantId: facility.tenantId,
    clientId: facility.clientId,
    addressLine: facility.addressLine,
    city: facility.city,
    state: facility.state,
    zip: facility.zip,
    geocodeCandidates: facility.geocodeCandidates,
    geocodeStatus: facility.geocodeStatus,
    geocodeAttemptCount: facility.geocodeAttemptCount,
    geocodeInputHash: facility.geocodeInputHash,
    congressionalDistrict: facility.congressionalDistrict,
    congressionalDistrictCongress: facility.congressionalDistrictCongress,
    districtSource: facility.districtSource,
    stateHouseDistrict: facility.stateHouseDistrict,
    stateSenateDistrict: facility.stateSenateDistrict,
    latitude: facility.latitude,
    longitude: facility.longitude,
  };
  return `v1:${createHash('sha256')
    .update(JSON.stringify(canonicalValue(snapshot)))
    .digest('hex')}`;
}

export function isFacilityCandidateRevision(value: unknown): value is string {
  return typeof value === 'string' && /^v1:[0-9a-f]{64}$/.test(value);
}

/** Append an opaque precondition; public callers never reconstruct internal inputs. */
export function facilityWithCandidateRevision<T extends FacilityCandidateSnapshot>(
  facility: T,
): T & { geocodeCandidateRevision: string } {
  return { ...facility, geocodeCandidateRevision: facilityGeocodeCandidateRevision(facility) };
}

/** Shared by interactive selection and both asynchronous geocode writers. */
export function facilityGeocodeCandidateGuard(
  facility: FacilityCandidateSnapshot,
): Prisma.ClientFacilityWhereInput {
  return {
    id: facility.id,
    tenantId: facility.tenantId,
    clientId: facility.clientId,
    addressLine: facility.addressLine,
    city: facility.city,
    state: facility.state,
    zip: facility.zip,
    geocodeCandidates: {
      equals: facility.geocodeCandidates === null ? Prisma.AnyNull : facility.geocodeCandidates,
    },
    geocodeStatus: facility.geocodeStatus,
    geocodeAttemptCount: facility.geocodeAttemptCount,
    geocodeInputHash: facility.geocodeInputHash,
    congressionalDistrict: facility.congressionalDistrict,
    congressionalDistrictCongress: facility.congressionalDistrictCongress,
    districtSource: facility.districtSource,
    stateHouseDistrict: facility.stateHouseDistrict,
    stateSenateDistrict: facility.stateSenateDistrict,
    latitude: facility.latitude,
    longitude: facility.longitude,
  };
}

/** Both background writers commit through this boundary after provider I/O. Zero means stale. */
export function persistFacilityGeocodeSnapshot(
  tx: Pick<Prisma.TransactionClient, 'clientFacility'>,
  facility: FacilityCandidateSnapshot,
  data: Prisma.ClientFacilityUpdateManyMutationInput,
): Promise<Prisma.BatchPayload> {
  return tx.clientFacility.updateMany({ where: facilityGeocodeCandidateGuard(facility), data });
}
