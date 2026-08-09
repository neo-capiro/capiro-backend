import { useMemo } from 'react';
import { App as AntApp } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { useIntelFeature } from '../../lib/intel-feature-flags.js';
import { useActionsList } from '../actions/actions-api.js';
import { useMeetings } from '../engagement/meetings/meetings-api.js';
import type { Client, ClientAttachment } from './clientTypes.js';
import type { ClientFacility } from './facilities-api.js';
import { getRelevantPesForClient } from './relevance-api.js';
import { getClientTargets, type ClientTarget } from './targets-api.js';
import { intelTrackerPaths } from './tracker/intel-tracker-api.js';
import { trackerKeys, trackerPaths, type TrackerSummary } from './tracker/tracker-api.js';
import {
  CLOSED_ACTION_STATUSES,
  buildActivityItems,
  buildAttentionItems,
  deadlineValue,
  errorMessage,
  type CapabilityRecord,
  type ClientPerson,
  type KbStatusResponse,
} from './client-profile-crm-model.js';

export function useClientProfileData(client: Client, onClientUpdated: () => void) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const capabilities = useQuery<CapabilityRecord[]>({
    queryKey: ['client-capabilities', client.id],
    queryFn: async () => (await api.get<CapabilityRecord[]>(`/api/clients/${client.id}/capabilities`)).data,
  });
  const people = useQuery<ClientPerson[]>({
    queryKey: ['client-people', client.id],
    queryFn: async () => (await api.get<ClientPerson[]>(`/api/clients/${client.id}/people`)).data,
  });
  const documents = useQuery<ClientAttachment[]>({
    queryKey: ['client-attachments', client.id],
    queryFn: async () =>
      (await api.get<ClientAttachment[]>('/api/engagement/attachments', { params: { clientId: client.id } })).data,
  });
  const facilities = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', client.id],
    queryFn: async () => (await api.get<ClientFacility[]>(`/api/clients/${client.id}/facilities`)).data,
    staleTime: 60_000,
  });
  const targets = useQuery<ClientTarget[]>({
    queryKey: ['client-targets', client.id],
    queryFn: () => getClientTargets(api, client.id),
    staleTime: 60_000,
  });
  const kbStatus = useQuery<KbStatusResponse>({
    queryKey: ['client-kb-status', client.id],
    queryFn: async () => (await api.get<KbStatusResponse>(`/api/clio/kb/${client.id}/status`)).data,
    staleTime: 60_000,
  });
  const peRelevance = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 8 }),
    staleTime: 60_000,
  });

  const { enabled: trackerV2, ready: intelFlagsReady } = useIntelFeature('tracker_v2');
  const trackerSummary = useQuery<TrackerSummary>({
    queryKey: trackerKeys.summary(client.id),
    queryFn: async () =>
      (await api.get<TrackerSummary>(trackerV2 ? intelTrackerPaths.summary(client.id) : trackerPaths.summary(client.id))).data,
    enabled: intelFlagsReady,
    staleTime: 60_000,
  });

  const actionQuery = useActionsList({ clientId: client.id, page: 1, limit: 50, sort: 'priority' });
  const dateRange = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - 120);
    const to = new Date();
    to.setDate(to.getDate() + 45);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);
  const meetings = useMeetings({ clientId: client.id, ...dateRange });

  const openActions = useMemo(
    () =>
      (actionQuery.data?.data ?? [])
        .filter((action) => !CLOSED_ACTION_STATUSES.has(action.status))
        .sort((a, b) => b.priority - a.priority || deadlineValue(a.deadline) - deadlineValue(b.deadline)),
    [actionQuery.data],
  );
  const activities = useMemo(
    () => buildActivityItems(openActions, meetings.data ?? [], documents.data ?? []),
    [openActions, meetings.data, documents.data],
  );
  const attention = useMemo(
    () => buildAttentionItems(client, openActions, meetings.data ?? []),
    [client, openActions, meetings.data],
  );

  const savePerson = useMutation({
    mutationFn: async ({ person, values }: { person: ClientPerson | null; values: Record<string, unknown> }) =>
      person
        ? (await api.patch<ClientPerson>(`/api/clients/${client.id}/people/${person.id}`, values)).data
        : (await api.post<ClientPerson>(`/api/clients/${client.id}/people`, values)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const deletePerson = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/clients/${client.id}/people/${id}`)).data,
    onSuccess: () => {
      message.success('Contact removed');
      void qc.invalidateQueries({ queryKey: ['client-people', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const saveNotes = useMutation({
    mutationFn: async (value: string) => (await api.put(`/api/clients/${client.id}/profile-notes`, { notes: value })).data,
    onSuccess: () => {
      message.success('Account note saved');
      onClientUpdated();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const deleteDocument = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/engagement/attachments/${id}`)).data,
    onSuccess: () => {
      message.success('File removed');
      void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
      void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  async function uploadFiles(files: File[], source?: string) {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB.`);
      const contentType = file.type || 'application/octet-stream';
      const presigned = (
        await api.post<{ url: string; fields: Record<string, string>; s3Key: string }>('/api/engagement/attachments/upload-url', {
          clientId: client.id,
          fileName: file.name,
          contentType,
          contentLength: file.size,
        })
      ).data;
      const form = new FormData();
      Object.entries(presigned.fields).forEach(([key, value]) => form.append(key, String(value)));
      form.append('file', file);
      const response = await fetch(presigned.url, { method: 'POST', body: form });
      if (!response.ok) throw new Error(`Storage upload failed for ${file.name}.`);
      await api.post('/api/engagement/attachments/confirm', {
        clientId: client.id,
        fileName: file.name,
        contentType,
        s3Key: presigned.s3Key,
        ...(source ? { source } : {}),
      });
    }
    void qc.invalidateQueries({ queryKey: ['client-attachments', client.id] });
    void qc.invalidateQueries({ queryKey: ['client-kb-status', client.id] });
  }

  return {
    capabilities,
    people,
    documents,
    facilities,
    targets,
    kbStatus,
    peRelevance,
    trackerSummary,
    openActions,
    activities,
    attention,
    savePerson,
    deletePerson,
    saveNotes,
    deleteDocument,
    uploadFiles,
    refreshCapabilities: () => void qc.invalidateQueries({ queryKey: ['client-capabilities', client.id] }),
  };
}
