import type { AxiosInstance } from 'axios';
import type { ClientProfileV1 } from './mappers.js';

export interface ClientRegulatoryProfile {
  clientId: string;
  generatedAt: string;
  partial: boolean;
  sources: Array<{ name: string; status: 'available' | 'unavailable' }>;
  regulatoryLifecycle: ClientProfileV1['sections']['legislativeRegulatory']['regulatoryLifecycle'];
}

export const regulatoryProfileKey = (clientId: string) =>
  ['client-regulatory-profile', clientId] as const;

export async function getClientRegulatoryProfile(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientRegulatoryProfile> {
  return (
    await api.get<ClientRegulatoryProfile>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/regulatory-profile`,
    )
  ).data;
}
