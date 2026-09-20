import { resolveUsStateCode } from '@capiro/shared';
import {
  formatFacilityDistrict,
  type ClientFacility,
} from '../../../../pages/clients/facilities-api.js';
import type {
  ClientDistrictNexusV2,
  DistrictNexusDistrictDetail,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import type { RepresentationResult } from '../../../../pages/clients/intelligence-v1/representation-api.js';

export interface RealDistrictModel {
  code: string;
  lat: number;
  lon: number;
  facilityNames: string[];
  employeeCount: number | null;
  totalAmount: number | null;
  awardCount: number | null;
  repName: string | null;
  repParty: string | null;
  repChamber: string | null;
  score: null;
  strength: 'Unscored';
  ui: 'gray';
}

export function buildRepresentationByFacilityId(
  rows: Array<{ facility: { id: string }; representation: RepresentationResult }>,
): Map<string, RepresentationResult> {
  return new Map(rows.map((row) => [row.facility.id, row.representation]));
}

export function buildRealDistricts(
  facilities: ClientFacility[],
  contractByDistrict: ReadonlyMap<string, number>,
  repByFacilityId: ReadonlyMap<string, RepresentationResult>,
): RealDistrictModel[] {
  const byCode = new Map<string, ClientFacility[]>();
  for (const facility of facilities) {
    const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
    if (!code) continue;
    const group = byCode.get(code) ?? [];
    group.push(facility);
    byCode.set(code, group);
  }

  const models: RealDistrictModel[] = [];
  for (const [code, group] of byCode) {
    const geocoded = group.find(
      (facility) => facility.latitude != null && facility.longitude != null,
    );
    if (!geocoded) continue;

    const contractAmount = contractByDistrict.get(code);
    const knownEmployees = group.filter(
      (facility): facility is ClientFacility & { employeeCount: number } =>
        facility.employeeCount != null,
    );

    let repName: string | null = null;
    let repParty: string | null = null;
    let repChamber: string | null = null;
    for (const facility of group) {
      const representation = repByFacilityId.get(facility.id);
      if (representation && !representation.unresolved && representation.federal.house) {
        repName = representation.federal.house.fullName;
        repParty = representation.federal.house.party;
        repChamber = 'House';
        break;
      }
    }

    models.push({
      code,
      lat: geocoded.latitude as number,
      lon: geocoded.longitude as number,
      facilityNames: group.map((facility) => facility.name),
      employeeCount: knownEmployees.length
        ? knownEmployees.reduce((sum, facility) => sum + facility.employeeCount, 0)
        : null,
      totalAmount: contractAmount ?? null,
      awardCount: null,
      repName,
      repParty,
      repChamber,
      score: null,
      strength: 'Unscored',
      ui: 'gray',
    });
  }

  return models.sort((left, right) => {
    const byAmount = (right.totalAmount ?? -1) - (left.totalAmount ?? -1);
    if (byAmount !== 0) return byAmount;
    return (right.employeeCount ?? 0) - (left.employeeCount ?? 0);
  });
}

export function buildRepresentativeByDistrict(
  facilities: ClientFacility[],
  repByFacilityId: ReadonlyMap<string, RepresentationResult>,
): Map<string, { name: string; party: string | null }> {
  const representatives = new Map<string, { name: string; party: string | null }>();
  for (const facility of facilities) {
    const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
    if (!code) continue;
    const [state, district] = code.split('-');
    const key = `${state}-${(district ?? '').padStart(2, '0')}`;
    if (representatives.has(key)) continue;
    const representation = repByFacilityId.get(facility.id);
    if (representation && !representation.unresolved && representation.federal.house) {
      representatives.set(key, {
        name: representation.federal.house.fullName,
        party: representation.federal.house.party,
      });
    }
  }
  return representatives;
}

export function sortV2Districts(
  districts: DistrictNexusDistrictDetail[],
): DistrictNexusDistrictDetail[] {
  return [...districts].sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
}

export function selectV2District(
  sortedDistricts: DistrictNexusDistrictDetail[],
  selected: string | null,
  bestDistrictKey: ClientDistrictNexusV2['bestDistrictKey'],
): { effectiveSelected: string | null; district: DistrictNexusDistrictDetail | null } {
  const effectiveSelected =
    selected && sortedDistricts.some((district) => district.districtKey === selected)
      ? selected
      : (bestDistrictKey ?? sortedDistricts[0]?.districtKey ?? null);
  return {
    effectiveSelected,
    district:
      sortedDistricts.find((district) => district.districtKey === effectiveSelected) ?? null,
  };
}

export function countUngeocodedFacilities(facilities: ClientFacility[]): number {
  return facilities.filter((facility) => facility.latitude == null || facility.longitude == null)
    .length;
}

export function facilityStatus(
  facility: ClientFacility,
  representation: RepresentationResult | undefined,
): { label: string; tone: 'warning' | 'success' } {
  const district = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
  if (!district) return { label: 'U.S. House district missing', tone: 'warning' };
  if (representation && !representation.unresolved && representation.federal.house) {
    const house = representation.federal.house;
    const houseDistrict =
      house.district == null
        ? ''
        : formatFacilityDistrict(resolveUsStateCode(house.state), String(house.district));
    if (houseDistrict !== district) {
      return { label: 'Representation mismatch', tone: 'warning' };
    }
    return { label: 'Matches saved district', tone: 'success' };
  }
  return { label: 'Representative not resolved', tone: 'warning' };
}
