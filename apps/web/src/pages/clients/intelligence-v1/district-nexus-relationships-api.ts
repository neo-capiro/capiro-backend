import type { AxiosInstance } from 'axios';

export const DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES = [
  'direct_recipient',
  'subrecipient',
  'project_site',
  'research_partner',
  'coalition_partner',
  'beneficiary',
  'matching_contributor',
] as const;

export type DistrictNexusAwardRelationshipType =
  (typeof DISTRICT_NEXUS_AWARD_RELATIONSHIP_TYPES)[number];

export type DistrictNexusRelationshipStatus = 'unverified' | 'verified' | 'rejected';

export interface DistrictNexusFacilityOption {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  congressionalDistrict: string | null;
}

export interface DistrictNexusAssistanceAwardOption {
  id: string;
  awardUniqueId: string;
  fain: string | null;
  recipientName: string | null;
  recipientUei: string | null;
  assistanceListingNumber: string | null;
  assistanceListingTitle: string | null;
  awardingAgency: string | null;
  totalObligatedAmount: number | null;
  totalOutlayedAmount: number | null;
  startDate: string | null;
  endDate: string | null;
  state: string | null;
  congressionalDistrict: string | null;
  geographyBasis: 'place_of_performance' | 'recipient_location' | 'unknown';
}

export interface DistrictNexusRelationshipRecord {
  id: string;
  clientId: string;
  assistanceAwardId: string;
  facilityId: string | null;
  relationshipType: DistrictNexusAwardRelationshipType;
  relationshipDescription: string | null;
  attributableAmount: number | null;
  beneficiaryCount: number | null;
  evidenceSourceType: string;
  evidenceSourceRef: string | null;
  confidence: number;
  verificationStatus: DistrictNexusRelationshipStatus;
  externalUseApproved: boolean;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  createdAt: string;
  updatedAt: string;
  award: DistrictNexusAssistanceAwardOption;
  facility: DistrictNexusFacilityOption | null;
}

export interface DistrictNexusRelationshipListResponse {
  relationships: DistrictNexusRelationshipRecord[];
  facilities: DistrictNexusFacilityOption[];
}

export interface DistrictNexusRelationshipMutation {
  assistanceAwardId: string;
  relationshipType: DistrictNexusAwardRelationshipType;
  facilityId?: string | null;
  relationshipDescription?: string | null;
  attributableAmount?: number | null;
  beneficiaryCount?: number | null;
  evidenceSourceRef?: string | null;
  verificationStatus?: DistrictNexusRelationshipStatus;
  externalUseApproved?: boolean;
  effectiveStart?: string | null;
  effectiveEnd?: string | null;
}

function path(clientId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-relationships`;
}

export async function getDistrictNexusRelationships(
  api: AxiosInstance,
  clientId: string,
): Promise<DistrictNexusRelationshipListResponse> {
  return (await api.get<DistrictNexusRelationshipListResponse>(path(clientId))).data;
}

export async function searchDistrictNexusAssistanceAwards(
  api: AxiosInstance,
  query: string,
): Promise<DistrictNexusAssistanceAwardOption[]> {
  return (
    await api.get<DistrictNexusAssistanceAwardOption[]>(
      '/api/intelligence/district-nexus/assistance-awards/search',
      { params: { q: query } },
    )
  ).data;
}

export async function createDistrictNexusRelationship(
  api: AxiosInstance,
  clientId: string,
  input: DistrictNexusRelationshipMutation,
): Promise<DistrictNexusRelationshipRecord> {
  return (await api.post<DistrictNexusRelationshipRecord>(path(clientId), input)).data;
}

export async function updateDistrictNexusRelationship(
  api: AxiosInstance,
  clientId: string,
  relationshipId: string,
  input: Partial<DistrictNexusRelationshipMutation>,
): Promise<DistrictNexusRelationshipRecord> {
  return (
    await api.patch<DistrictNexusRelationshipRecord>(
      `${path(clientId)}/${encodeURIComponent(relationshipId)}`,
      input,
    )
  ).data;
}

export async function rejectDistrictNexusRelationship(
  api: AxiosInstance,
  clientId: string,
  relationshipId: string,
): Promise<void> {
  await api.delete(`${path(clientId)}/${encodeURIComponent(relationshipId)}`);
}
