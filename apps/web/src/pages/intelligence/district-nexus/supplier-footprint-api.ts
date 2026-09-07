import type { AxiosInstance } from 'axios';

export const DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE = 'district_nexus_supplier_footprint';

/** The economic endpoint owns attribution and availability; React only presents it. */
export interface SupplierFootprintStatus {
  clientId: string;
  status: 'available' | 'not_populated' | 'no_identity' | 'no_matching_records' | 'unavailable';
  available: boolean;
  source: 'federal_market';
  sourcePopulated: boolean;
  totalSubawardRows: number;
  attributableSubawardRows: number;
  clientIdentityBasis: 'confirmed_uei_or_mappings' | 'none';
  confirmedMappingCount: number;
  lastSuccessfulSyncAt: string | null;
  stalenessDays: number | null;
  endpoint: string;
  note: string;
}

export async function getSupplierFootprintStatus(
  api: AxiosInstance,
  clientId: string,
): Promise<SupplierFootprintStatus> {
  return (
    await api.get<SupplierFootprintStatus>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/supplier-footprint/status`,
    )
  ).data;
}

export const SUPPLIER_STATUS_LABEL: Record<SupplierFootprintStatus['status'], string> = {
  available: 'Available',
  not_populated: 'Subaward data not ingested',
  no_identity: 'Client identity needed',
  no_matching_records: 'No matching records',
  unavailable: 'Supplier coverage unavailable',
};
