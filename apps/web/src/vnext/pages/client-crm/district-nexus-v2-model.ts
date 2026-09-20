import type {
  ClientDistrictNexusV2,
  DistrictNexusDistrictDetail,
} from '../../../pages/clients/intelligence-v1/district-nexus-api.js';

export interface ClientDistrictContractSummary {
  totalAmount: number | null;
  districtCount: number;
  contractorNames: string[];
  linked: boolean;
}

export function clientDistrictContractSummary(
  nexus: ClientDistrictNexusV2 | null | undefined,
): ClientDistrictContractSummary | null {
  if (!nexus) return null;
  const resolvedAmount = nexus.awarded.contractObligations;
  const unmappedAmount = nexus.unmapped.unmappedContractAmount;
  return {
    totalAmount:
      resolvedAmount == null && unmappedAmount == null
        ? null
        : (resolvedAmount ?? 0) + (unmappedAmount ?? 0),
    districtCount: nexus.districts.filter(
      (district) => district.awarded.contractObligations != null,
    ).length,
    contractorNames: nexus.linkage.contractorNames,
    linked: nexus.linkage.contractingLinked,
  };
}

export function contractAmountByDistrict(
  districts: DistrictNexusDistrictDetail[],
): Map<string, number> {
  return new Map(
    districts.flatMap((district) =>
      district.awarded.contractObligations == null
        ? []
        : [[district.districtKey, district.awarded.contractObligations] as const],
    ),
  );
}
