import type { AxiosInstance } from 'axios';
import type { R5Fact } from './r5-api.js';

export const DISTRICT_NEXUS_R5_ACTIONS_FEATURE = 'district_nexus_r5_actions';
export interface DistrictAction {
  id: string; districtKey: string | null; actionType: string; issueTitle: string;
  whatChanged: string; whyItMatters: string; recommendedAction: string;
  suggestedArtifactType: string | null; ownerUserId: string | null;
  targetAudience: Array<{ id: string; label: string }>;
  priority: number; confidence: { clientRelevance?: string }; uncertainty: string | null;
  evidence: Array<{ kind: string; note?: string }>; status: string;
}
export type ActionText = Pick<DistrictAction, 'issueTitle' | 'whatChanged' | 'whyItMatters' | 'recommendedAction'>;
export interface DistrictCandidate extends Omit<DistrictAction, 'id' | 'districtKey' | 'status' | 'suggestedArtifactType' | 'ownerUserId'> {
  key: string; suggestedArtifactType: string; ownerUserId: string; facts: R5Fact[];
}
export interface DistrictActionsResult { candidates: DistrictCandidate[]; staged: DistrictAction[] }
export interface ActionScope { clientId: string; state: string; district: string }
const url = '/api/intelligence/district-nexus/r5/actions';
export async function getDistrictActions(api: AxiosInstance, scope: ActionScope): Promise<DistrictActionsResult> {
  return (await api.get<DistrictActionsResult>(url, { params: scope })).data;
}
export async function stageDistrictAction(api: AxiosInstance, scope: ActionScope, key: string, edits: Partial<ActionText>) {
  return (await api.post<DistrictAction>(`${url}/stage`, { ...scope, key, edits })).data;
}
export async function editDistrictAction(api: AxiosInstance, scope: ActionScope, id: string, edits: Partial<ActionText>) {
  return (await api.patch<DistrictAction>(`${url}/${id}`, { ...scope, edits })).data;
}
export async function changeDistrictActionStatus(api: AxiosInstance, scope: ActionScope, id: string, status: string, dismissalReason?: string) {
  return (await api.patch<DistrictAction>(`${url}/${id}/status`, { ...scope, status, dismissalReason })).data;
}
