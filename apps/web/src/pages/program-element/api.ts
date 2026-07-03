import type { AxiosInstance } from 'axios';
import type {
  ProgramElementBill,
  ProgramElementContractorsResponse,
  ProgramElementDeltaListResponse,
  ProgramElementDetail,
  ProgramElementProject,
  ProcurementLinesResponse,
  ProgramElementSourceItem,
  ProvisionItem,
  OpportunityItem,
  ProgramElementListResponse,
  ProgramElementMarkupMonitorResponse,
  ProgramElementRelatedResponse,
  ProgramTeamPerson,
  PersonCandidateListResponse,
  AcquisitionPersonnelListResponse,
  AcquisitionPersonnelListParams,
  AcquisitionPersonnelDetail,
  EngagementContactListItem,
  ProgramElementSummary,
} from './types.js';
import type { IntelligenceChange } from '../intelligence/types.js';

export async function getProgramElementDetail(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementDetail> {
  return (
    await api.get<ProgramElementDetail>(`/api/program-elements/${encodeURIComponent(peCode)}`)
  ).data;
}

export async function getProgramElementIntelligence(
  api: AxiosInstance,
  peCode: string,
): Promise<import('./IntelligenceChips.js').PeIntelligence> {
  return (
    await api.get<import('./IntelligenceChips.js').PeIntelligence>(
      `/api/program-elements/${encodeURIComponent(peCode)}/intelligence`,
    )
  ).data;
}

export async function getProgramElementBills(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementBill[]> {
  return (
    await api.get<ProgramElementBill[]>(`/api/program-elements/${encodeURIComponent(peCode)}/bills`)
  ).data;
}

export async function getProgramElementContractors(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementContractorsResponse> {
  return (
    await api.get<ProgramElementContractorsResponse>(
      `/api/program-elements/${encodeURIComponent(peCode)}/contractors`,
    )
  ).data;
}

export async function getProgramElementProjects(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementProject[]> {
  return (
    await api.get<ProgramElementProject[]>(
      `/api/program-elements/${encodeURIComponent(peCode)}/projects`,
    )
  ).data;
}

export async function getProgramElementProcurementLines(
  api: AxiosInstance,
  peCode: string,
): Promise<ProcurementLinesResponse> {
  return (
    await api.get<ProcurementLinesResponse>(
      `/api/program-elements/${encodeURIComponent(peCode)}/procurement-lines`,
    )
  ).data;
}

export async function getProgramElementSources(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementSourceItem[]> {
  return (
    await api.get<ProgramElementSourceItem[]>(
      `/api/program-elements/${encodeURIComponent(peCode)}/sources`,
    )
  ).data;
}

export async function getProgramElementProvisions(
  api: AxiosInstance,
  peCode: string,
): Promise<ProvisionItem[]> {
  return (
    await api.get<ProvisionItem[]>(
      `/api/program-elements/${encodeURIComponent(peCode)}/provisions`,
    )
  ).data;
}

export async function getProgramElementOpportunities(
  api: AxiosInstance,
  peCode: string,
): Promise<OpportunityItem[]> {
  return (
    await api.get<OpportunityItem[]>(
      `/api/program-elements/${encodeURIComponent(peCode)}/opportunities`,
    )
  ).data;
}

export async function getProgramElementDeltas(
  api: AxiosInstance,
  peCode: string,
  params: { deltaType?: string; fy?: number; limit?: number } = {},
): Promise<ProgramElementDeltaListResponse> {
  return (
    await api.get<ProgramElementDeltaListResponse>(
      `/api/program-elements/${encodeURIComponent(peCode)}/deltas`,
      { params },
    )
  ).data;
}

export async function getProgramElementPersonnel(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramTeamPerson[]> {
  return (
    await api.get<ProgramTeamPerson[]>(
      `/api/program-elements/${encodeURIComponent(peCode)}/personnel`,
    )
  ).data;
}

export async function getProgramElementRelated(
  api: AxiosInstance,
  peCode: string,
): Promise<ProgramElementRelatedResponse> {
  return (
    await api.get<ProgramElementRelatedResponse>(
      `/api/program-elements/${encodeURIComponent(peCode)}/related`,
    )
  ).data;
}

export async function linkProgramElementPersonToCrm(
  api: AxiosInstance,
  personId: string,
  engagementContactId: string,
): Promise<{ linked: true }> {
  return (
    await api.post<{ linked: true }>(
      `/api/acquisition-personnel/${encodeURIComponent(personId)}/link-crm-contact`,
      {
        engagementContactId,
      },
    )
  ).data;
}

/** Tenant CRM contacts, used by the "link to CRM" picker on the PE program team. */
export async function getEngagementContacts(
  api: AxiosInstance,
  params: { q?: string; limit?: number } = {},
): Promise<EngagementContactListItem[]> {
  return (await api.get<EngagementContactListItem[]>('/api/engagement/contacts', { params })).data;
}

export async function getProgramElementsList(
  api: AxiosInstance,
  params: {
    q?: string;
    service?: string;
    page?: number;
    limit?: number;
    has_data?: 'true' | 'false';
    watched?: 'true' | 'false';
  },
): Promise<ProgramElementListResponse> {
  return (await api.get<ProgramElementListResponse>('/api/program-elements', { params })).data;
}

/** Portfolio aggregates for the finder summary strip (KPI cards + trend + donut). */
export async function getProgramElementSummary(
  api: AxiosInstance,
  params: { service?: string; has_data?: 'true' | 'false' } = {},
): Promise<ProgramElementSummary> {
  return (await api.get<ProgramElementSummary>('/api/program-elements/summary', { params })).data;
}

/**
 * The PE Watchlist signal feed — change events touching a set of watched PE codes.
 * Reuses the intelligence changes inbox endpoint scoped by peCodes (GIN-indexed),
 * newest first. Returns [] when no PEs are watched.
 */
export async function getProgramElementWatchlistFeed(
  api: AxiosInstance,
  peCodes: string[],
): Promise<IntelligenceChange[]> {
  if (peCodes.length === 0) return [];
  return (
    await api.get<IntelligenceChange[]>('/api/intelligence/changes', {
      params: { peCodes: peCodes.join(','), consumed: false },
    })
  ).data;
}

export async function getMarkupMonitor(
  api: AxiosInstance,
  params: { service?: string; divergence_threshold?: number },
): Promise<ProgramElementMarkupMonitorResponse> {
  return (
    await api.get<ProgramElementMarkupMonitorResponse>('/api/program-elements', {
      params: {
        mode: 'markup-monitor',
        ...params,
      },
    })
  ).data;
}

export async function setProgramElementWatching(
  api: AxiosInstance,
  peCode: string,
  watching: boolean,
): Promise<{ peCode: string; watching: boolean }> {
  return (
    await api.post<{ peCode: string; watching: boolean }>(
      `/api/program-elements/${encodeURIComponent(peCode)}/watch`,
      { watching },
    )
  ).data;
}

// ── Person -> PE link candidate review queue (Phase 1b) ───────────────────────

/** capiro_admin: list the person->PE candidate review queue. */
export async function getPersonCandidates(
  api: AxiosInstance,
  params: { status?: string; page?: number; limit?: number } = {},
): Promise<PersonCandidateListResponse> {
  return (
    await api.get<PersonCandidateListResponse>('/api/admin/program-elements/person-candidates', {
      params,
    })
  ).data;
}

/** capiro_admin: confirm (apply link) or reject a candidate. */
export async function resolvePersonCandidate(
  api: AxiosInstance,
  id: string,
  decision: 'confirm' | 'reject',
  notes?: string,
): Promise<{ resolved: true; linked: boolean }> {
  return (
    await api.post<{ resolved: true; linked: boolean }>(
      `/api/admin/program-elements/person-candidates/${encodeURIComponent(id)}/resolve`,
      { decision, notes },
    )
  ).data;
}

/** user_admin: suggest a person they know for a PE (queued for capiro_admin review). */
export async function suggestPersonForPe(
  api: AxiosInstance,
  peCode: string,
  body: { fullName: string; roleTitle?: string; organization?: string; notes?: string },
): Promise<{ suggested: true; candidateId: string }> {
  return (
    await api.post<{ suggested: true; candidateId: string }>(
      `/api/program-elements/${encodeURIComponent(peCode)}/suggest-person`,
      body,
    )
  ).data;
}

// ── DoW Directory (AcquisitionPersonnel) ──────────────────────────────────────

/** List acquisition personnel with optional filters + pagination. */
export async function getAcquisitionPersonnel(
  api: AxiosInstance,
  params: AcquisitionPersonnelListParams = {},
): Promise<AcquisitionPersonnelListResponse> {
  return (await api.get<AcquisitionPersonnelListResponse>('/api/acquisition-personnel', { params }))
    .data;
}

/** Full record for one person, including all source mentions. */
export async function getAcquisitionPersonnelDetail(
  api: AxiosInstance,
  id: string,
): Promise<AcquisitionPersonnelDetail> {
  return (
    await api.get<AcquisitionPersonnelDetail>(
      `/api/acquisition-personnel/${encodeURIComponent(id)}`,
    )
  ).data;
}
