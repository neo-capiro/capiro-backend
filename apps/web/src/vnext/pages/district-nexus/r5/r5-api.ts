/** District Nexus R5 - Alerts API client. */
import type { AxiosInstance } from 'axios';

export const DISTRICT_NEXUS_R5_ALERTS_FEATURE = 'district_nexus_r5_alerts';

export interface DistrictAlertPayload {
  changeId: string;
  title: string;
  districtLabel: string;
  sourceLabel: string;
  eventTime: string | null;
  detectedTime: string;
  severity: string;
  freshness: string;
  caveats: string[];
  deepLink: string;
  changeKind: string;
  oldState: string | null;
  newState: string | null;
}

export async function getDistrictNexusAlerts(
  api: AxiosInstance,
  clientId: string,
  state?: string,
  district?: string,
): Promise<DistrictAlertPayload[]> {
  const params = new URLSearchParams({ clientId });
  if (state) params.set('state', state);
  if (district) params.set('district', district);
  const { data } = await api.get<DistrictAlertPayload[]>(
    '/intelligence/district-nexus/r5/alerts?' + params.toString(),
  );
  return data;
}