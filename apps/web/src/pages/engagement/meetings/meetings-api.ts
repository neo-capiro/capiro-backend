/**
 * React-query hooks for the Meetings & Meri v2 module. Wraps the engagement
 * endpoints (all tenant-scoped via `useApi`). Mutations invalidate the meetings
 * list + the affected meeting's debriefs/notetaker so the UI stays consistent.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  Meeting,
  MeetingBotSession,
  MeetingDebrief,
  MeetingDebriefDraft,
  MeetingLibraryResponse,
} from './meetings-types.js';

const BASE = '/api/engagement';

export const meetingsListKey = 'meetings-v2';
export const libraryKey = 'meetings-v2-library';
export const sharedMeetingsKey = 'meetings-v2-shared';

export interface MeetingsRangeParams {
  from?: string;
  to?: string;
  clientId?: string;
}

/** GET /api/engagement/meetings — the decorated list for the calendar body. */
export function useMeetings(params: MeetingsRangeParams, enabled = true) {
  const api = useApi();
  return useQuery<Meeting[]>({
    queryKey: [meetingsListKey, params.from, params.to, params.clientId ?? null],
    queryFn: async () =>
      (
        await api.get<Meeting[]>(`${BASE}/meetings`, {
          params: {
            ...(params.from ? { from: params.from } : {}),
            ...(params.to ? { to: params.to } : {}),
            ...(params.clientId ? { clientId: params.clientId } : {}),
          },
        })
      ).data,
    enabled,
    staleTime: 30_000,
  });
}

export interface LibraryParams {
  clientId?: string;
  artifactType?: 'prep' | 'notes' | 'debrief';
  visibility?: 'shared' | 'private';
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/** GET /api/engagement/meetings/library — paginated approved-material archive. */
export function useMeetingLibrary(params: LibraryParams, enabled = true) {
  const api = useApi();
  return useQuery<MeetingLibraryResponse>({
    queryKey: [libraryKey, params],
    queryFn: async () =>
      (
        await api.get<MeetingLibraryResponse>(`${BASE}/meetings/library`, {
          params: {
            ...(params.clientId ? { clientId: params.clientId } : {}),
            ...(params.artifactType ? { artifactType: params.artifactType } : {}),
            ...(params.visibility ? { visibility: params.visibility } : {}),
            ...(params.from ? { from: params.from } : {}),
            ...(params.to ? { to: params.to } : {}),
            ...(params.page ? { page: params.page } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
        })
      ).data,
    enabled,
    staleTime: 30_000,
  });
}

/** GET /api/engagement/shared-meetings?clientId= — the client Documents feed. */
export function useSharedMeetings(clientId: string, enabled = true) {
  const api = useApi();
  return useQuery<Meeting[]>({
    queryKey: [sharedMeetingsKey, clientId],
    queryFn: async () =>
      (await api.get<Meeting[]>(`${BASE}/shared-meetings`, { params: { clientId } })).data,
    enabled: enabled && Boolean(clientId),
    staleTime: 30_000,
  });
}

/** GET /api/engagement/meetings/:id/debriefs — full (decrypted) debrief bodies. */
export function useMeetingDebriefs(meetingId: string | null) {
  const api = useApi();
  return useQuery<MeetingDebrief[]>({
    queryKey: ['meetings-v2-debriefs', meetingId],
    queryFn: async () =>
      (await api.get<MeetingDebrief[]>(`${BASE}/meetings/${meetingId}/debriefs`)).data,
    enabled: Boolean(meetingId),
    staleTime: 15_000,
  });
}

/** GET /api/engagement/meetings/:id/notetaker — the latest bot session, if any. */
export function useNotetakerSession(meetingId: string | null) {
  const api = useApi();
  return useQuery<MeetingBotSession | null>({
    queryKey: ['meetings-v2-notetaker', meetingId],
    queryFn: async () =>
      (await api.get<MeetingBotSession | null>(`${BASE}/meetings/${meetingId}/notetaker`)).data,
    enabled: Boolean(meetingId),
    // Poll while a bot is active so "Meri Attending" advances to notes.
    refetchInterval: 20_000,
  });
}

/** Invalidate every meetings-v2 query (list, library, shared feed, detail). */
export function useInvalidateMeetings() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [meetingsListKey] });
    void qc.invalidateQueries({ queryKey: [libraryKey] });
    void qc.invalidateQueries({ queryKey: [sharedMeetingsKey] });
  };
}

export interface ClientOption {
  id: string;
  name: string;
  status?: string;
}

/** GET /api/clients — the tenant's clients, for the meeting client-assign picker. */
export function useClientOptions(enabled = true) {
  const api = useApi();
  return useQuery<ClientOption[]>({
    queryKey: ['clients-for-assign'],
    queryFn: async () => (await api.get<ClientOption[]>('/api/clients')).data,
    enabled,
    staleTime: 60_000,
    select: (rows) => rows.filter((c) => c.status !== 'archived'),
  });
}

/** PUT /api/engagement/meetings/:id — assign / override the meeting's client. */
export function useAssignMeetingClient() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, { meetingId: string; clientId: string | null }>({
    mutationFn: async ({ meetingId, clientId }) =>
      (await api.put<Meeting>(`${BASE}/meetings/${meetingId}`, { clientId })).data,
    onSuccess: invalidate,
  });
}

export function useShareMeeting() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, string>({
    mutationFn: async (meetingId) =>
      (await api.post<Meeting>(`${BASE}/meetings/${meetingId}/share`)).data,
    onSuccess: invalidate,
  });
}

export function useUnshareMeeting() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, string>({
    mutationFn: async (meetingId) =>
      (await api.post<Meeting>(`${BASE}/meetings/${meetingId}/unshare`)).data,
    onSuccess: invalidate,
  });
}

export function useGeneratePrep() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<unknown, Error, { meetingId: string; additionalContext?: string }>({
    mutationFn: async ({ meetingId, additionalContext }) =>
      (
        await api.post(`${BASE}/meetings/${meetingId}/prep`, {
          ...(additionalContext ? { additionalContext } : {}),
        })
      ).data,
    onSuccess: invalidate,
  });
}

export interface UpdatePrepInput {
  prepId: string;
  summary?: string | null;
  agenda?: string[];
  talkingPoints?: string[];
  risks?: string[];
  followUps?: string[];
  emailEvidence?: string[];
}

export function useUpdatePrep() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<unknown, Error, UpdatePrepInput>({
    mutationFn: async ({ prepId, ...body }) =>
      (await api.patch(`${BASE}/meeting-preps/${prepId}`, body)).data,
    onSuccess: invalidate,
  });
}

export function useApprovePrep() {
  const api = useApi();
  const invalidate = useInvalidateMeetings();
  return useMutation<unknown, Error, string>({
    mutationFn: async (prepId) => (await api.post(`${BASE}/meeting-preps/${prepId}/approve`)).data,
    onSuccess: invalidate,
  });
}

export function useGenerateDebriefDraft() {
  const api = useApi();
  return useMutation<
    MeetingDebriefDraft,
    Error,
    { meetingId: string; method: 'upload' | 'manual' | 'voice'; sourceText: string }
  >({
    mutationFn: async ({ meetingId, method, sourceText }) =>
      (
        await api.post<MeetingDebriefDraft>(`${BASE}/meetings/${meetingId}/debrief-draft`, {
          method,
          sourceText,
        })
      ).data,
  });
}

export interface SaveDebriefInput {
  meetingId: string;
  debriefId?: string;
  body: string;
  confidential?: boolean;
  accessLevel?: string;
}

export function useSaveDebrief() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<unknown, Error, SaveDebriefInput>({
    mutationFn: async ({ meetingId, debriefId, ...body }) =>
      debriefId
        ? (await api.patch(`${BASE}/meetings/${meetingId}/debriefs/${debriefId}`, body)).data
        : (await api.post(`${BASE}/meetings/${meetingId}/debriefs`, body)).data,
    onSuccess: (_data, vars) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['meetings-v2-debriefs', vars.meetingId] });
    },
  });
}

export function useApproveDebrief() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<unknown, Error, { meetingId: string; debriefId: string }>({
    mutationFn: async ({ meetingId, debriefId }) =>
      (await api.post(`${BASE}/meetings/${meetingId}/debriefs/${debriefId}/approve`)).data,
    onSuccess: (_data, vars) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['meetings-v2-debriefs', vars.meetingId] });
    },
  });
}

export interface DispatchNotetakerInput {
  meetingId: string;
  meetingUrl: string;
  authorizedToRecord: boolean;
  allPartiesWillBeNotified: boolean;
  /** ISO8601 join-later time; omit to join now (spec §4.2). */
  joinAt?: string;
}

export function useDispatchNotetaker() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<MeetingBotSession, Error, DispatchNotetakerInput>({
    mutationFn: async ({ meetingId, ...body }) =>
      (await api.post<MeetingBotSession>(`${BASE}/meetings/${meetingId}/notetaker`, body)).data,
    onSuccess: (_data, vars) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['meetings-v2-notetaker', vars.meetingId] });
    },
  });
}

export function useCancelNotetaker() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<MeetingBotSession, Error, string>({
    mutationFn: async (meetingId) =>
      (await api.delete<MeetingBotSession>(`${BASE}/meetings/${meetingId}/notetaker`)).data,
    onSuccess: (_data, meetingId) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['meetings-v2-notetaker', meetingId] });
    },
  });
}

interface UploadUrlResponse {
  url: string;
  fields: Record<string, string>;
  s3Key: string;
}

/**
 * Upload a recording/transcript file for a meeting and return its extracted
 * text — the debrief source pipeline: presigned S3 POST → confirm → extract-text
 * (audio/video is transcribed server-side). Mirrors the proven Engagement flow.
 */
export function useUploadAndExtract() {
  const api = useApi();
  return useMutation<string, Error, { meetingId: string; clientId?: string | null; file: File }>({
    mutationFn: async ({ meetingId, clientId, file }) => {
      const contentType = file.type || 'application/octet-stream';
      const upload = (
        await api.post<UploadUrlResponse>(`${BASE}/attachments/upload-url`, {
          meetingId,
          clientId: clientId ?? undefined,
          fileName: file.name,
          contentType,
          contentLength: file.size,
        })
      ).data;
      const form = new FormData();
      Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
      form.append('file', file);
      const res = await fetch(upload.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      const attachment = (
        await api.post<{ id: string }>(`${BASE}/attachments/confirm`, {
          meetingId,
          clientId: clientId ?? undefined,
          fileName: file.name,
          contentType,
          s3Key: upload.s3Key,
        })
      ).data;
      const extraction = (
        await api.post<{ text: string }>(`${BASE}/attachments/${attachment.id}/extract-text`)
      ).data;
      return extraction.text;
    },
  });
}
