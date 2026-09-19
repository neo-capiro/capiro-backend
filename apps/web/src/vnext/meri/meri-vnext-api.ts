import type { AxiosInstance } from 'axios';
import type { MeriContextSection } from './meri-prefs.js';

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
  /** Count of the caller's active chats, from the canonical membership query. */
  threadCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MeriVNextPreference {
  windowChrome: 'undocked' | 'maximized' | 'docked';
  railCollapsed: boolean;
  openSection: MeriContextSection | null;
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

export async function listMeriSavedPrompts(api: AxiosInstance, signal?: AbortSignal): Promise<MeriSavedPrompt[]> {
  const response = await api.get<{ prompts?: MeriSavedPrompt[] }>('/api/clio/vnext/saved-prompts', { signal });
  return Array.isArray(response.data.prompts) ? response.data.prompts : [];
}

export async function createMeriSavedPrompt(
  api: AxiosInstance,
  input: Pick<MeriSavedPrompt, 'title' | 'body'>,
  signal?: AbortSignal,
): Promise<MeriSavedPrompt> {
  return (await api.post<MeriSavedPrompt>('/api/clio/vnext/saved-prompts', input, { signal })).data;
}

export async function deleteMeriSavedPrompt(api: AxiosInstance, promptId: string, signal?: AbortSignal): Promise<void> {
  await api.delete(`/api/clio/vnext/saved-prompts/${encodeURIComponent(promptId)}`, { signal });
}

export async function updateMeriSavedPrompt(
  api: AxiosInstance,
  promptId: string,
  input: Pick<MeriSavedPrompt, 'title' | 'body'>,
  signal?: AbortSignal,
): Promise<MeriSavedPrompt> {
  return (await api.patch<MeriSavedPrompt>(
    `/api/clio/vnext/saved-prompts/${encodeURIComponent(promptId)}`, input, { signal },
  )).data;
}

export async function listMeriWorkspaces(api: AxiosInstance): Promise<MeriWorkspace[]> {
  const response = await api.get<{ workspaces?: MeriWorkspace[] }>('/api/clio/vnext/workspaces');
  return Array.isArray(response.data.workspaces) ? response.data.workspaces : [];
}

export async function createMeriWorkspace(
  api: AxiosInstance,
  input: Pick<MeriWorkspace, 'name' | 'clientId'>,
  signal?: AbortSignal,
): Promise<MeriWorkspace> {
  return (await api.post<MeriWorkspace>('/api/clio/vnext/workspaces', input, { signal })).data;
}

export async function deleteMeriWorkspace(api: AxiosInstance, workspaceId: string, signal?: AbortSignal): Promise<void> {
  await api.delete(`/api/clio/vnext/workspaces/${encodeURIComponent(workspaceId)}`, { signal });
}

export async function assignMeriConversationWorkspace(
  api: AxiosInstance,
  conversationId: string,
  workspaceId: string | null,
  signal?: AbortSignal,
): Promise<{ id: string; workspaceId: string | null }> {
  const response = await api.patch<{ id: string; workspaceId: string | null }>(`/api/clio/vnext/conversations/${encodeURIComponent(conversationId)}/workspace`, {
    workspaceId,
  }, { signal });
  if (response.data?.id !== conversationId || response.data.workspaceId !== workspaceId) {
    throw new Error('The server did not confirm the workspace change. Reload and try again.');
  }
  return response.data;
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
