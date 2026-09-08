import type { AxiosInstance } from 'axios';

export const DISTRICT_NEXUS_SUPPLIER_FOOTPRINT_FEATURE = 'district_nexus_supplier_footprint';

/**
 * Source completeness of the subaward corpus, derived by the API ONLY from the
 * unfiltered whole-corpus walk's persisted checkpoint — separate from client
 * matching. A completed FILTERED run never upgrades this to 'complete', and an
 * absent checkpoint stays 'unknown' rather than silently becoming either.
 */
export type SupplierSourceCompleteness = 'complete' | 'in_progress' | 'unknown';

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
  /** Corpus completeness, independent of whether THIS client matched. */
  sourceCompleteness: SupplierSourceCompleteness;
  /** Human sentence qualifying matches against corpus completeness. */
  sourceCoverageNote: string;
  /** Last provider-reported catalog total the walk observed; null when never reported. */
  providerTotalRecords: number | null;
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

/**
 * The visible label, qualified by corpus completeness. Partial coverage must be
 * explicit EVEN WHEN matches exist: "No matches in records ingested so far."
 * is honest for an unmatched client, while a complete corpus keeps the plain
 * label because the empty result is then real.
 */
export function supplierStatusLabel(
  status: SupplierFootprintStatus['status'] | undefined,
  completeness: SupplierSourceCompleteness | undefined,
): string {
  if (!status) return 'Checking supplier coverage';
  if (status === 'no_matching_records' && completeness !== 'complete') {
    return 'No matches in records ingested so far';
  }
  if (status === 'available' && completeness === 'in_progress') {
    return 'Matches in records ingested so far';
  }
  return SUPPLIER_STATUS_LABEL[status];
}
