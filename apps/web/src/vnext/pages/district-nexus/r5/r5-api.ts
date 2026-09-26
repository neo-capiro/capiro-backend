/**
 * R5 District Brief — web-side API client.
 *
 * Mirrors apps/api/src/district-nexus/r5-action-layer/r5-types.ts.
 * API routes: /api/intelligence/district-nexus/r5/brief/*
 */

import type { AxiosInstance } from 'axios';

// ── Types (mirrored from API) ───────────────────────────────────────────────

export type R5FactBasis = 'verified_client_nexus' | 'public_context';

export type R5FactSection =
  | 'footprint'
  | 'economic'
  | 'opportunities'
  | 'representation'
  | 'cpf_cds'
  | 'changes';

export type R5AmountStage =
  | 'requested'
  | 'enacted'
  | 'obligated'
  | 'awarded'
  | 'forecast';

export type R5GeographyScope = 'district' | 'statewide' | 'national';

export type R5Coverage = 'complete' | 'partial' | 'unknown';

export interface R5Fact {
  id: string;
  section: R5FactSection;
  label: string;
  value: string | number | null;
  unit: string | null;
  amountStage: R5AmountStage | null;
  basis: R5FactBasis;
  source: {
    type: string;
    label: string;
    recordId: string | null;
    url: string | null;
  };
  asOf: {
    date: string | null;
    fiscalYear: number | null;
    sourceYear: number | null;
  };
  geography: {
    state: string;
    district: string | null;
    scope: R5GeographyScope;
    basis: string | null;
    boundaryCongress: number | null;
  };
  freshness: {
    lastSyncedAt: string | null;
    stale: boolean;
    unavailable: boolean;
  };
  coverage: R5Coverage;
  caveats: string[];
}

export interface R5Gap {
  section: R5FactSection;
  reason: string;
  source: string | null;
}

export interface SourceFreshness {
  source: string;
  label: string;
  lastSyncedAt: string | null;
  neverSynced: boolean;
  freshnessUnavailable?: boolean;
}

export interface R5BriefSection {
  key: string;
  title: string;
  paragraphs: string[];
  factIds: string[];
}

export interface R5Brief {
  clientId: string;
  clientName: string;
  state: string;
  district: string;
  sections: R5BriefSection[];
  facts: R5Fact[];
  gaps: R5Gap[];
  sourceHealth: SourceFreshness[];
  generatedAt: string;
}

export interface R5BriefSaveResult {
  attachmentId: string;
  fileName: string;
}

export interface R5BriefSaveInput {
  clientId: string;
  state: string;
  district: string;
  sections: Array<{ key: string; title: string; paragraphs: string[] }>;
  factIds: string[];
}

// ── Fetch functions ─────────────────────────────────────────────────────────

export async function getDistrictBrief(
  api: AxiosInstance,
  clientId: string,
  state: string,
  district: string,
): Promise<R5Brief> {
  return (
    await api.get<R5Brief>('/api/intelligence/district-nexus/r5/brief', {
      params: { clientId, state, district },
    })
  ).data;
}

export async function exportDistrictBriefDocx(
  api: AxiosInstance,
  input: R5BriefSaveInput,
): Promise<Blob> {
  const resp = await api.post(
    '/api/intelligence/district-nexus/r5/brief/export',
    input,
    { responseType: 'blob' },
  );
  return resp.data;
}

export async function saveDistrictBrief(
  api: AxiosInstance,
  input: R5BriefSaveInput,
): Promise<R5BriefSaveResult> {
  return (await api.post<R5BriefSaveResult>(
    '/api/intelligence/district-nexus/r5/brief/save',
    input,
  )).data;
}

// ── Flag keys ───────────────────────────────────────────────────────────────

export const DISTRICT_NEXUS_R5_BRIEF_FEATURE = 'district_nexus_r5_brief';
export const DISTRICT_NEXUS_R5_MEETING_PREP_FEATURE = 'district_nexus_r5_meeting_prep';
export const DISTRICT_NEXUS_R5_ALERTS_FEATURE = 'district_nexus_r5_alerts';

// ── R5 Meeting Prep ─────────────────────────────────────────────────────────

const prepPath = '/api/intelligence/district-nexus/r5/meeting-prep';
export interface R5PrepItem { text: string; factIds: string[] }
export interface R5Meeting { id: string; subject: string; startsAt: string; attendees: string[] }
export interface R5MeetingPrep {
  id: string; meetingId: string; status: 'generated' | 'reviewed' | 'approved';
  agenda: R5PrepItem[]; talkingPoints: R5PrepItem[]; followUps: R5PrepItem[];
  risks: R5PrepItem[];
  generatedFrom: { kind: string; clientId: string; state: string; district: string;
    questions: R5PrepItem[]; attendeesTargets: string[]; evidence: R5Fact[]; factIds: string[];
    contextGeneratedAt: string };
}
export async function listDistrictPrepMeetings(api: AxiosInstance, clientId: string): Promise<R5Meeting[]> {
  return (await api.get<R5Meeting[]>(`${prepPath}/meetings`, { params: { clientId } })).data;
}
export async function generateDistrictPrep(api: AxiosInstance, input: { clientId: string; state: string; district: string; meetingId: string }): Promise<R5MeetingPrep> {
  return (await api.post<R5MeetingPrep>(prepPath, input)).data;
}
export async function updateDistrictPrep(api: AxiosInstance, id: string, input: {
  agenda?: R5PrepItem[]; talkingPoints?: R5PrepItem[]; questions?: R5PrepItem[];
  followUps?: R5PrepItem[]; reviewed?: boolean;
}): Promise<R5MeetingPrep> {
  return (await api.patch<R5MeetingPrep>(`${prepPath}/${encodeURIComponent(id)}`, input)).data;
}

// ── R5 District alerts ──────────────────────────────────────────────────────

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
    '/api/intelligence/district-nexus/r5/alerts?' + params.toString(),
  );
  return data;
}

export async function getDistrictAlertPreference(api: AxiosInstance, clientId: string): Promise<boolean> {
  const { data } = await api.get<{ enabled: boolean }>(
    '/api/intelligence/district-nexus/r5/alerts/preference', { params: { clientId } },
  );
  return data.enabled;
}

export async function putDistrictAlertPreference(api: AxiosInstance, clientId: string, enabled: boolean): Promise<boolean> {
  const { data } = await api.put<{ enabled: boolean }>(
    '/api/intelligence/district-nexus/r5/alerts/preference', { clientId, enabled },
  );
  return data.enabled;
}
