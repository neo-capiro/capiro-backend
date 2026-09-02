/**
 * Hill Day module — API client.
 *
 * Every read and write goes to the workspace engine's Hill Day family,
 * `/workspace-api/hillday/*` (requirements §6), over the Clerk-authed shared
 * axios instance (`useApi()`), exactly like the Strategies vNext data layer.
 * Nothing here is fixture-backed: a source that fails arrives as a named
 * `unavailable` / `partial` status block and is rendered as such.
 */
import { useMemo } from 'react';
import type { AxiosInstance } from 'axios';
import { useApi } from '../../../../lib/use-api.js';
import { unbridgedFetch } from '../api/transport-bridge.js';
import type {
  Blueprint,
  CalendarResponse,
  ClientsResponse,
  CorrectionBody,
  CreatedDocument,
  DocumentResolution,
  ExportView,
  HillDayDocumentView,
  JobEvent,
  JobStatus,
  LibraryRow,
  MeetingContextCandidates,
  MeetingResolution,
  Page,
  PutContextBody,
  QualityResponse,
  SetMeetingsResponse,
  StafferHit,
  SourceStatusBlock,
  OfficeRef,
} from './types.js';

export const HILLDAY_BASE = '/workspace-api/hillday';
export const HILL_DAY_BLUEPRINT_ID = 'bp_hill_day_schedule';

export interface HillDayClient {
  listBlueprints(): Promise<Blueprint[]>;
  listDocuments(params?: { clientId?: string; status?: string; cursor?: string; limit?: number }): Promise<Page<LibraryRow>>;
  createDocument(body: { blueprintId: string; clientId: string; name: string; lookbackDays?: number; timeZone?: string }): Promise<CreatedDocument>;
  listClients(q?: string): Promise<ClientsResponse>;
  calendar(clientId: string, from: string, to: string, timeZone: string): Promise<CalendarResponse>;
  setMeetings(docId: string, body: { eventIds: string[]; weekStart?: string; timeZone?: string }): Promise<SetMeetingsResponse>;
  runResolution(docId: string): Promise<DocumentResolution>;
  getResolution(docId: string): Promise<DocumentResolution>;
  correct(docId: string, meetingId: string, body: CorrectionBody): Promise<MeetingResolution>;
  searchStaffers(q: string): Promise<{ staffers: StafferHit[]; sources: SourceStatusBlock[] }>;
  searchMembers(q: string): Promise<{ members: OfficeRef[]; sources: SourceStatusBlock[] }>;
  getContext(docId: string, meetingId: string, lookbackDays?: number): Promise<MeetingContextCandidates>;
  putContext(docId: string, meetingId: string, body: PutContextBody): Promise<{ record: MeetingContextCandidates['record']; sourceCount: number }>;
  generate(docId: string): Promise<{ jobId: string; status: string }>;
  jobStatus(docId: string, jobId: string): Promise<JobStatus>;
  regenerate(docId: string, sectionId: string): Promise<unknown>;
  getDocument(docId: string): Promise<HillDayDocumentView>;
  patchDocument(
    docId: string,
    body: { name?: string; status?: 'draft' | 'delivered'; lookbackDays?: number; section?: { sectionId: string; focus?: string; background?: string } },
  ): Promise<HillDayDocumentView>;
  quality(docId: string): Promise<QualityResponse>;
  createExport(docId: string, pageSize?: 'letter' | 'a4'): Promise<ExportView>;
}

export function createHillDayClient(api: AxiosInstance): HillDayClient {
  const d = (id: string) => `${HILLDAY_BASE}/documents/${encodeURIComponent(id)}`;
  return {
    listBlueprints: async () => (await api.get<{ blueprints: Blueprint[] }>(`${HILLDAY_BASE}/blueprints`)).data.blueprints,
    listDocuments: async (params = {}) =>
      (await api.get<Page<LibraryRow>>(`${HILLDAY_BASE}/documents`, { params: { ...params, limit: params.limit ?? 25 } })).data,
    createDocument: async (body) => (await api.post<CreatedDocument>(`${HILLDAY_BASE}/documents`, body)).data,
    listClients: async (q) =>
      (await api.get<ClientsResponse>(`${HILLDAY_BASE}/clients`, { params: q ? { q, limit: 50 } : { limit: 50 } })).data,
    calendar: async (clientId, from, to, timeZone) =>
      (
        await api.get<CalendarResponse>(`${HILLDAY_BASE}/clients/${encodeURIComponent(clientId)}/calendar`, {
          params: { from, to, timeZone },
        })
      ).data,
    setMeetings: async (docId, body) => (await api.put<SetMeetingsResponse>(`${d(docId)}/meetings`, body)).data,
    runResolution: async (docId) => (await api.post<DocumentResolution>(`${d(docId)}/resolution`, {})).data,
    getResolution: async (docId) => (await api.get<DocumentResolution>(`${d(docId)}/resolution`)).data,
    correct: async (docId, meetingId, body) =>
      (await api.patch<MeetingResolution>(`${d(docId)}/resolution/${encodeURIComponent(meetingId)}`, body)).data,
    searchStaffers: async (q) =>
      (await api.get<{ staffers: StafferHit[]; sources: SourceStatusBlock[] }>(`${HILLDAY_BASE}/directory/staffers`, { params: { q } })).data,
    searchMembers: async (q) =>
      (await api.get<{ members: OfficeRef[]; sources: SourceStatusBlock[] }>(`${HILLDAY_BASE}/directory/members`, { params: { q } })).data,
    getContext: async (docId, meetingId, lookbackDays) =>
      (
        await api.get<MeetingContextCandidates>(`${d(docId)}/meetings/${encodeURIComponent(meetingId)}/context`, {
          params: lookbackDays ? { lookbackDays } : {},
        })
      ).data,
    putContext: async (docId, meetingId, body) =>
      (await api.put<{ record: MeetingContextCandidates['record']; sourceCount: number }>(`${d(docId)}/meetings/${encodeURIComponent(meetingId)}/context`, body)).data,
    generate: async (docId) => (await api.post<{ jobId: string; status: string }>(`${d(docId)}/generate`, {})).data,
    jobStatus: async (docId, jobId) => (await api.get<JobStatus>(`${d(docId)}/generate/${encodeURIComponent(jobId)}`)).data,
    regenerate: async (docId, sectionId) => (await api.post(`${d(docId)}/sections/${encodeURIComponent(sectionId)}/regenerate`, {})).data,
    getDocument: async (docId) => (await api.get<HillDayDocumentView>(d(docId))).data,
    patchDocument: async (docId, body) => (await api.patch<HillDayDocumentView>(d(docId), body)).data,
    quality: async (docId) => (await api.get<QualityResponse>(`${d(docId)}/quality`)).data,
    createExport: async (docId, pageSize = 'letter') => (await api.post<ExportView>(`${d(docId)}/exports`, { pageSize })).data,
  };
}

/** The Hill Day client bound to the current session (memoised per axios instance). */
export function useHillDayApi(): HillDayClient {
  const api = useApi();
  return useMemo(() => createHillDayClient(api), [api]);
}

/** Parse one `event:`/`data:`/`id:` SSE frame. */
export function parseSseFrame(raw: string): JobEvent | null {
  let event = '';
  let id = 0;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx >= 0 ? line.slice(0, idx) : line;
    const value = idx >= 0 ? line.slice(idx + 1).replace(/^ /, '') : '';
    if (field === 'event') event = value;
    else if (field === 'id') id = Number.parseInt(value, 10) || 0;
    else if (field === 'data') dataLines.push(value);
  }
  if (!event) return null;
  let data: Record<string, unknown> = {};
  try {
    data = dataLines.length ? (JSON.parse(dataLines.join('\n')) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (event !== 'unit' && event !== 'complete' && event !== 'failed') return null;
  return { seq: id, event, data };
}

/**
 * Consume the generation SSE stream with fetch (EventSource cannot carry the
 * Authorization header). Uses the UN-bridged fetch: the Workspace transport
 * bridge routes same-origin `/workspace-api/*` fetches through axios and
 * re-wraps them as JSON, which would buffer the whole stream. Resolves with
 * the terminal outcome, or `closed` when the stream ended without one — the
 * caller then falls back to polling.
 */
export async function streamJobEvents(params: {
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
  docId: string;
  jobId: string;
  after: number;
  onEvent: (event: JobEvent) => void;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<'complete' | 'failed' | 'closed'> {
  const token = await params.getToken();
  const doFetch = params.fetchImpl ?? unbridgedFetch();
  const url = `${params.apiBaseUrl}${HILLDAY_BASE}/documents/${encodeURIComponent(params.docId)}/generate/${encodeURIComponent(
    params.jobId,
  )}/events?after=${params.after}`;
  const res = await doFetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'text/event-stream',
    },
    signal: params.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Progress stream failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outcome: 'complete' | 'failed' | 'closed' = 'closed';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseFrame(frame);
      if (parsed) {
        params.onEvent(parsed);
        if (parsed.event === 'complete') outcome = 'complete';
        if (parsed.event === 'failed') outcome = 'failed';
      }
      idx = buffer.indexOf('\n\n');
    }
  }
  return outcome;
}
