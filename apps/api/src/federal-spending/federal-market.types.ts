export interface FederalMarketQuery {
  clientId?: string;
  q?: string;
  agency?: string;
  recipient?: string;
  state?: string;
  district?: string;
  fiscalYear?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

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

export interface FederalMarketDistrictRow {
  districtKey: string;
  state: string;
  district: string;
  contractCount: number;
  contractAmount: number | null;
  subawardCount: number;
  subawardAmount: number | null;
}

/**
 * Subaward place-of-performance that is source-backed to a state but not to a
 * congressional district. It is deliberately not folded into a district row.
 */
export interface FederalMarketStateSubawardRow {
  state: string;
  subawardCount: number;
  subawardAmount: number | null;
  geographyBasis: 'source_state_place_of_performance';
}

export interface FederalMarketFutureSignal {
  id: string;
  source: 'sam_gov' | 'agency_forecast';
  title: string;
  agency: string | null;
  state: string | null;
  districtKey: string | null;
  date: string | null;
  geographyBasis: 'source_place_of_performance' | 'state_text' | 'unresolved';
  sourceUrl: string | null;
}

export interface FederalMarketGeographyResponse {
  districts: FederalMarketDistrictRow[];
  /**
   * State-backed subawards that cannot honestly be assigned to a district.
   * Optional for rolling compatibility with the prior API revision; the public
   * composer always emits it and new clients treat absence as an empty rail.
   */
  stateSubawards?: FederalMarketStateSubawardRow[];
  futureSignals: FederalMarketFutureSignal[];
  /** Future opportunities and forecasts are never included in awarded-dollar totals. */
  awardedMoneyIncludesFutureOpportunities: false;
  /** Independent rail failures. A healthy rail still renders when another one fails. */
  warnings: string[];
  generatedAt: string;
}
