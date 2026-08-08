import type { AxiosInstance } from 'axios';

export type FederalMarketTab = 'contracts' | 'subawards' | 'vehicles' | 'forecasts';

export interface FederalMarketPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  source: string;
  asOf: string | null;
  generatedAt: string;
}

export interface FederalContractMarketRow {
  id: string;
  awardId: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  awardingAgency: string | null;
  amount: number | null;
  description: string | null;
  actionDate: string | null;
  state: string | null;
  district: string | null;
  districtKey: string | null;
  source: 'usaspending';
  sourceUpdatedAt: string | null;
}

export interface FederalSubawardMarketRow {
  id: string;
  providerKey: string;
  awardKey: string | null;
  primeRecipientName: string | null;
  primeRecipientUei: string | null;
  subawardeeName: string | null;
  subawardeeUei: string | null;
  awardingAgency: string | null;
  awardingOffice: string | null;
  amount: number | null;
  description: string | null;
  actionDate: string | null;
  fiscalYear: number | null;
  naicsCode: string | null;
  state: string | null;
  district: string | null;
  districtKey: string | null;
  sourceUrl: string | null;
  source: 'tango';
  sourceUpdatedAt: string | null;
}

export interface FederalVehicleMarketRow {
  id: string;
  vehicleId: string;
  name: string | null;
  solicitationIdentifier: string | null;
  vehicleType: string | null;
  agency: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  setAside: string | null;
  lastDateToOrder: string | null;
  awardeeCount: number | null;
  orderCount: number | null;
  totalObligated: number | null;
  relationship: 'self' | 'parent' | null;
  recipientUei: string | null;
  source: 'tango';
  sourceUpdatedAt: string | null;
}

export interface FederalForecastMarketRow {
  id: string;
  forecastId: string;
  title: string;
  description: string | null;
  agency: string | null;
  department: string | null;
  office: string | null;
  anticipatedAwardDate: string | null;
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  naicsCode: string | null;
  pscCode: string | null;
  setAside: string | null;
  contractVehicle: string | null;
  placeOfPerformance: string | null;
  contactName: string | null;
  contactEmail: string | null;
  status: string | null;
  active: boolean | null;
  sourceSystem: string | null;
  sourceUrl: string | null;
  source: 'tango';
  sourceUpdatedAt: string | null;
}

export type FederalMarketRow =
  | FederalContractMarketRow
  | FederalSubawardMarketRow
  | FederalVehicleMarketRow
  | FederalForecastMarketRow;

export interface FederalMarketGeographyResponse {
  districts: Array<{
    districtKey: string;
    state: string;
    district: string;
    contractCount: number;
    contractAmount: number | null;
    subawardCount: number;
    subawardAmount: number | null;
  }>;
  /**
   * Source-backed state place of performance with no defensible district.
   * Optional for compatibility with the prior API revision.
   */
  stateSubawards?: Array<{
    state: string;
    subawardCount: number;
    subawardAmount: number | null;
    geographyBasis: 'source_state_place_of_performance';
  }>;
  futureSignals: Array<{
    id: string;
    source: 'sam_gov' | 'agency_forecast';
    title: string;
    agency: string | null;
    state: string | null;
    districtKey: string | null;
    date: string | null;
    geographyBasis: 'source_place_of_performance' | 'state_text' | 'unresolved';
    sourceUrl: string | null;
  }>;
  awardedMoneyIncludesFutureOpportunities: false;
  warnings: string[];
  generatedAt: string;
}

export interface FederalMarketFilters {
  clientId?: string;
  q?: string;
  agency?: string;
  recipient?: string;
  state?: string;
  district?: string;
  fiscalYear?: number;
  page?: number;
  pageSize?: number;
}

export async function getFederalMarket<T>(
  api: AxiosInstance,
  tab: FederalMarketTab,
  filters: FederalMarketFilters,
): Promise<FederalMarketPage<T>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value));
    }
  }
  return (
    await api.get<FederalMarketPage<T>>(`/api/federal-spending/market/${tab}?${params.toString()}`)
  ).data;
}

export async function getFederalMarketGeography(
  api: AxiosInstance,
  filters: FederalMarketFilters,
): Promise<FederalMarketGeographyResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value));
    }
  }
  return (
    await api.get<FederalMarketGeographyResponse>(
      `/api/federal-spending/market/geography?${params.toString()}`,
    )
  ).data;
}

export function formatMarketMoney(value: number | null): string {
  if (value == null) return 'Not stated';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatMarketDate(value: string | null): string {
  if (!value) return 'Not stated';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleDateString() : 'Not stated';
}
