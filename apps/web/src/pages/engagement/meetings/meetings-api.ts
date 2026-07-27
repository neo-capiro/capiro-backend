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
  MeetingNote,
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

/** Meri states that can still change on their own — i.e. a notetaker is either
 *  in the call or has just left it and is summarizing. 'scheduled' (not yet
 *  sent) and 'done' (fully settled) never self-transition, so they don't need
 *  polling. */
function hasLiveNotetaker(meetings: Meeting[] | undefined): boolean {
  return (meetings ?? []).some((m) => m.meri === 'attending' || m.meri === 'attended');
}

/** GET /api/engagement/meetings — the decorated list for the calendar body.
 *  Polls while any meeting in view has a notetaker in flight, so a detail panel
 *  left open sees "Meri Attending" -> "Meri Attended" -> notes-summarized
 *  transitions live instead of only on the next remount/staleTime refetch
 *  (mirrors EngagementPage's legacy notetakerSession dynamic-poll pattern). */
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
    refetchInterval: (query) => (hasLiveNotetaker(query.state.data) ? 10_000 : false),
  });
}

/** GET /api/engagement/meetings/:id — a single decorated meeting, used as a
 *  fallback when the selected meeting isn't present in the currently fetched
 *  calendar range (e.g. a deep link to a meeting outside the visible window).
 *  Mirrors the pattern already used for the legacy page's selectedMeetingQuery. */
export function useMeeting(meetingId: string | null) {
  const api = useApi();
  return useQuery<Meeting>({
    queryKey: ['meetings-v2-detail', meetingId],
    queryFn: async () => (await api.get<Meeting>(`${BASE}/meetings/${meetingId}`)).data,
    enabled: Boolean(meetingId),
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

/** GET /api/engagement/meetings/:id/notes — full (decrypted) note bodies. In the
 *  notes-first flow Meri's summary lands here; poll while Meri is summarizing so
 *  it appears as soon as it's written. */
export function useMeetingNotes(meetingId: string | null, active = false) {
  const api = useApi();
  return useQuery<MeetingNote[]>({
    queryKey: ['meetings-v2-notes', meetingId],
    queryFn: async () => (await api.get<MeetingNote[]>(`${BASE}/meetings/${meetingId}/notes`)).data,
    enabled: Boolean(meetingId),
    staleTime: 15_000,
    // While the meeting is over and Meri is still summarizing, poll so the
    // summary shows up without a manual refresh.
    refetchInterval: active ? 15_000 : false,
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

// ── Phase 2 §3.e — artifact-selective approval/sharing ──────────────────────
// Each mutation returns the freshly decorated Meeting (same shape useMeeting
// reads), so onSuccess writes it straight into the detail cache instead of
// waiting on a refetch, then invalidates the list/library/shared feeds too
// (approval/share state affects what those show).

export function useUpdateNote() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<MeetingNote, Error, { meetingId: string; noteId: string; body: string }>({
    mutationFn: async ({ meetingId, noteId, body }) =>
      (await api.patch<MeetingNote>(`${BASE}/meetings/${meetingId}/notes/${noteId}`, { body })).data,
    onSuccess: (_data, { meetingId }) => {
      void qc.invalidateQueries({ queryKey: ['meetings-v2-notes', meetingId] });
      invalidate();
    },
  });
}

export function useApproveNote() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<MeetingNote, Error, { meetingId: string; noteId: string }>({
    mutationFn: async ({ meetingId, noteId }) =>
      (await api.post<MeetingNote>(`${BASE}/meetings/${meetingId}/notes/${noteId}/approve`)).data,
    onSuccess: (_data, { meetingId }) => {
      void qc.invalidateQueries({ queryKey: ['meetings-v2-notes', meetingId] });
      invalidate();
    },
  });
}

export function useApproveAttachment() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, { meetingId: string; attachmentId: string }>({
    mutationFn: async ({ meetingId, attachmentId }) =>
      (
        await api.post<Meeting>(
          `${BASE}/meetings/${meetingId}/attachments/${attachmentId}/approve`,
        )
      ).data,
    onSuccess: (data, { meetingId }) => {
      qc.setQueryData(['meetings-v2-detail', meetingId], data);
      invalidate();
    },
  });
}

export interface ShareArtifactRef {
  type: 'prep' | 'note' | 'debrief' | 'attachment';
  id: string;
}

export function useShareArtifacts() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, { meetingId: string; artifacts: ShareArtifactRef[] }>({
    mutationFn: async ({ meetingId, artifacts }) =>
      (await api.post<Meeting>(`${BASE}/meetings/${meetingId}/artifacts/share`, { artifacts })).data,
    onSuccess: (data, { meetingId }) => {
      qc.setQueryData(['meetings-v2-detail', meetingId], data);
      invalidate();
    },
  });
}

export function useUnshareArtifacts() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useInvalidateMeetings();
  return useMutation<Meeting, Error, { meetingId: string; artifacts: ShareArtifactRef[] }>({
    mutationFn: async ({ meetingId, artifacts }) =>
      (await api.post<Meeting>(`${BASE}/meetings/${meetingId}/artifacts/unshare`, { artifacts }))
        .data,
    onSuccess: (data, { meetingId }) => {
      qc.setQueryData(['meetings-v2-detail', meetingId], data);
      invalidate();
    },
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
