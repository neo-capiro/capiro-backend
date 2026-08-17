import type { AxiosInstance } from 'axios';

export interface MeriSavedPrompt {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeriWorkspace {
  id: string;
  name: string;
  clientId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeriVNextPreference {
  windowChrome: 'undocked' | 'maximized' | 'docked';
  railCollapsed: boolean;
  openSection: 'context' | 'sources' | 'actions' | null;
}

export interface MeriContextPacketItem {
  id: string;
  label: string;
  type: string;
  scope: 'firm' | 'client' | 'personal';
  authority: string;
  status?: string;
  clientName?: string;
  userScoped: boolean;
  rationale: string | null;
  selection: 'explicit' | 'automatic';
  asOf?: string;
  lastConfirmedAt?: string;
}

export interface MeriContextPacket {
  packetId: string | null;
  persisted: boolean;
  persistenceErrorCode: string | null;
  compiledAt?: string;
  surface: string;
  clientId?: string | null;
  items: MeriContextPacketItem[];
  exclusions: Array<{ id?: string; label: string; type: string; reason: string }>;
  unauthorizedCount: number;
  degraded: boolean;
  degradedReason?: string;
}

export async function listMeriSavedPrompts(api: AxiosInstance): Promise<MeriSavedPrompt[]> {
  const response = await api.get<{ prompts?: MeriSavedPrompt[] }>('/api/clio/vnext/saved-prompts');
  return Array.isArray(response.data.prompts) ? response.data.prompts : [];
}

export async function createMeriSavedPrompt(
  api: AxiosInstance,
  input: Pick<MeriSavedPrompt, 'title' | 'body'>,
): Promise<MeriSavedPrompt> {
  return (await api.post<MeriSavedPrompt>('/api/clio/vnext/saved-prompts', input)).data;
}

export async function deleteMeriSavedPrompt(api: AxiosInstance, promptId: string): Promise<void> {
  await api.delete(`/api/clio/vnext/saved-prompts/${encodeURIComponent(promptId)}`);
}

export async function listMeriWorkspaces(api: AxiosInstance): Promise<MeriWorkspace[]> {
  const response = await api.get<{ workspaces?: MeriWorkspace[] }>('/api/clio/vnext/workspaces');
  return Array.isArray(response.data.workspaces) ? response.data.workspaces : [];
}

export async function createMeriWorkspace(
  api: AxiosInstance,
  input: Pick<MeriWorkspace, 'name' | 'clientId'>,
): Promise<MeriWorkspace> {
  return (await api.post<MeriWorkspace>('/api/clio/vnext/workspaces', input)).data;
}

export async function deleteMeriWorkspace(api: AxiosInstance, workspaceId: string): Promise<void> {
  await api.delete(`/api/clio/vnext/workspaces/${encodeURIComponent(workspaceId)}`);
}

export async function assignMeriConversationWorkspace(
  api: AxiosInstance,
  conversationId: string,
  workspaceId: string | null,
): Promise<void> {
  await api.patch(`/api/clio/vnext/conversations/${encodeURIComponent(conversationId)}/workspace`, {
    workspaceId,
  });
}

export async function getMeriVNextPreferences(api: AxiosInstance): Promise<MeriVNextPreference> {
  return (await api.get<MeriVNextPreference>('/api/clio/vnext/preferences')).data;
}

export async function saveMeriVNextPreferences(
  api: AxiosInstance,
  preference: MeriVNextPreference,
): Promise<MeriVNextPreference> {
  return (await api.put<MeriVNextPreference>('/api/clio/vnext/preferences', preference)).data;
}

export async function fetchMeriContextPacket(
  api: AxiosInstance,
  packetId: string,
): Promise<MeriContextPacket> {
  return (await api.get<MeriContextPacket>(`/api/clio/context-packets/${encodeURIComponent(packetId)}`)).data;
}

export async function fetchLatestMeriContextPacket(
  api: AxiosInstance,
  conversationId: string,
): Promise<MeriContextPacket> {
  return (
    await api.get<MeriContextPacket>(
      `/api/clio/context-packets/conversation/${encodeURIComponent(conversationId)}/latest`,
    )
  ).data;
}

export async function deleteMeriResearch(api: AxiosInstance, researchId: string): Promise<void> {
  await api.delete(`/api/clio/research/${encodeURIComponent(researchId)}`);
}

export async function listMeriToolLabels(api: AxiosInstance): Promise<string[]> {
  const response = await api.get<{ tools?: Array<{ name?: unknown; description?: unknown }> }>('/api/clio/tools');
  return (response.data.tools ?? [])
    .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
    .filter(Boolean);
}
