/** Stable source-backed profile contracts shared by read-time Funding surfaces. */
export const SAM_RELEVANCE_SIGNALS = [
  'naicsExact',
  'pscExact',
  'programElement',
  'agencyHistory',
  'placeOfPerformanceSite',
  'setAsideSelfReported',
  'naicsIndustryGroup',
  'pscCategory',
  'capabilityKeyword',
  'officeHistory',
  'facilityState',
  'sector',
  'genericTopical',
] as const;
export type SamRelevanceSignalKey = (typeof SAM_RELEVANCE_SIGNALS)[number];
export type SignalStrength = 'strong' | 'moderate' | 'weak';
export const SAM_SIGNAL_STRENGTH: Readonly<Record<SamRelevanceSignalKey, SignalStrength>> =
  Object.freeze({
    naicsExact: 'strong',
    pscExact: 'strong',
    programElement: 'strong',
    agencyHistory: 'strong',
    placeOfPerformanceSite: 'strong',
    setAsideSelfReported: 'strong',
    naicsIndustryGroup: 'moderate',
    pscCategory: 'moderate',
    capabilityKeyword: 'moderate',
    officeHistory: 'moderate',
    facilityState: 'moderate',
    sector: 'weak',
    genericTopical: 'weak',
  });
export interface SamClientProfile {
  naicsCodes: string[];
  pscCodes: string[];
  capabilityKeywords: string[];
  fundingPriorities?: string[];
  programElementCodes: string[];
  priorAgencies: string[];
  priorOffices: string[];
  facilityStates: string[];
  facilitySites: Array<{ city: string | null; state: string | null; zip: string | null }>;
  setAsideCertifications: string[];
  sector: string | null;
  applicantTypes: string[];
}
