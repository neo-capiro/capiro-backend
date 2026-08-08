import type { TangoRateMetadata } from './tango.errors.js';

/** Provider-labelled subaward observation. Never blended with prime awards. */
export interface TangoSubaward {
  providerKey: string;
  awardKey: string | null;
  primeAwardKey: string | null;
  piid: string | null;
  subawardNumber: string | null;
  subawardType: string | null;
  subawardAmount: number | null;
  actionDate: string | null;
  fiscalYear: number | null;
  description: string | null;
  naicsCode: string | null;

  primeRecipientUei: string | null;
  primeRecipientName: string | null;
  primeParentUei: string | null;
  primeParentName: string | null;

  subawardeeUei: string | null;
  subawardeeName: string | null;
  subawardeeParentUei: string | null;
  subawardeeParentName: string | null;

  awardingAgency: string | null;
  awardingOffice: string | null;
  fundingAgency: string | null;
  fundingOffice: string | null;

  placeOfPerformance: {
    country: string | null;
    state: string | null;
    city: string | null;
    zip: string | null;
    /** Not part of Tango's documented default shape; populated only if explicitly supplied. */
    congressionalDistrict: string | null;
  } | null;

  sourceUrl: string | null;
  providerModifiedAt: string | null;
  fetchedAt: string;
  contentSha256: string;
  normalized: Record<string, unknown>;
}

/** Only parameters documented by `/api/subawards/` are sent upstream. */
export interface TangoSubawardListOptions {
  page?: number;
  limit?: number;
  fiscalYear?: number;
  primeUei?: string;
  subawardeeUei?: string;
}

export interface TangoSubawardPage {
  items: Array<Record<string, unknown>>;
  totalCount: number | null;
  nextPage: number | null;
  rate: TangoRateMetadata | null;
}

export interface TangoSubawardGateway {
  readonly configured: boolean;
  listSubawards(options?: TangoSubawardListOptions): Promise<TangoSubawardPage>;
}
